/**
 * The RISC-V 64 machine — the rv64.js emulator backend.
 *
 * A sibling of bridge/v86.ts, not an extension of it: rv64.js
 * (justwasm/rv64.js, vendored under public/rv64/ by the build-rv64
 * workflow) has a completely different API — `RV64.create({...})` with a
 * promise-style 9p handler — and a different machine: virtio-mmio devices,
 * a serial console, and *no display adapter at all*. That last part is why
 * the Terminal does not offer the Engine Viewer for this machine: there is
 * no screen to show, and pretending otherwise would be a drawing, not a
 * display.
 *
 * Everything that matters is the same shape as the x86 machines:
 *
 *  - the guest's `/` IS the OS filesystem: ZenFS `/` served over virtio-9p
 *    by the same src/bridge/p9.ts server (rv64.js asks `handle(req) →
 *    Promise<reply>`, p9.ts answers `(req, reply)` — a two-line adapter)
 *  - the distro (Alpine Linux riscv64, an App Store entry) is unpacked
 *    into `/` by guest-root.ts from public/rv64/initrd.gz, and the kernel
 *    boots that same initramfs to reach the 9p root
 *  - the shell arrives on the serial console, which is what the Terminal
 *    shows
 *
 * Networking: rv64.js's `fetch` backend — guest HTTP(S) egresses through
 * the host browser's fetch(), via an in-emulator proxy at 10.0.2.2:8080
 * whose per-VM CA the guest installs at boot (see tools/guest-init/
 * init-rv64). Alpine's git is a full build with real HTTPS support, so
 * `git clone https://…` works natively — proven headlessly by
 * tools/vm/boot-rv64.mjs. No relay is required for destinations that
 * answer CORS; GitHub's git endpoints do.
 *
 * No saved state: rv64.js has no snapshot API, so this backend has no
 * saveState and the Terminal hides the button instead of faking one.
 */

import * as vfs from "../core/vfs";
import { ensureDir } from "../core/vfs";
import { createP9Handler } from "./p9";
import { ensureGuestRoot, installedDistro, DISTROS } from "./guest-root";
import { createDirectFs, unionAsPromises } from "./union-fs";
import { logInfo, logWarn } from "../core/log";
import type { BackendHandlers, TerminalBackend } from "./engine";

/** The subset of rv64.js's facade this backend drives (see rv64.d.ts). */
interface RV64Vm {
  readonly running: boolean;
  readonly console: { send(data: string | Uint8Array): void };
  resize(cols: number, rows: number): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
}

interface RV64Module {
  RV64: {
    create(options: Record<string, unknown>): Promise<RV64Vm>;
  };
}

const BASE = `${import.meta.env.BASE_URL}rv64/`;

/** One import of the engine module per page (it is an ESM file we serve). */
let modPromise: Promise<RV64Module> | null = null;
function loadEngine(): Promise<RV64Module> {
  if (!modPromise) {
    const url = new URL(`${BASE}rv64.js`, document.baseURI).href;
    modPromise = import(/* @vite-ignore */ url) as Promise<RV64Module>;
    modPromise.catch(() => (modPromise = null));
  }
  return modPromise;
}

class RV64Backend implements TerminalBackend {
  private vm: RV64Vm | null = null;
  private decoder = new TextDecoder();
  private tail = "";
  private booted = false;
  private disposed = false;
  private started = false;
  private pendingInput = "";
  private cols = 80;
  private rows = 24;
  private startTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private handlers: BackendHandlers) {}

  connect(): void {
    this.started = true;
    /* The guest's serial size rides the kernel cmdline, so give the
       terminal a beat to report its real size before we construct. */
    this.startTimer = setTimeout(() => void this.start(), 300);
  }

  isRunning(): boolean {
    return !this.disposed && (Boolean(this.vm) || this.started);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = setTimeout(() => void this.start(), 200);
      return;
    }
    /* Live resize: rv64.js forwards it to the console device. The 8250
       serial line itself has no winsize channel — the in-band cmdline size
       from boot still governs the guest's stty — so this is best-effort. */
    try {
      this.vm?.resize(cols, rows);
    } catch {
      /* a machine mid-construction has nowhere to put this */
    }
  }

  private status(text: string): void {
    logInfo("rv64", text);
    this.handlers.onNotice?.(text);
  }

  private async start(): Promise<void> {
    this.startTimer = null;
    try {
      const root = vfs.GUEST_ROOT;
      await ensureDir(root);

      /* Same honest rule as the x86 bridge, the other way around: an x86
         OS cannot run on a RISC-V CPU. The Terminal checks this before
         constructing a backend; this repeats it for any other caller. */
      const installed = await installedDistro(root);
      if (installed && !DISTROS[installed].runsOn.includes("riscv64")) {
        throw new Error(
          `${DISTROS[installed].name} is installed, and a RISC-V 64 CPU cannot run it — ` +
            `switch Settings → Machine back, or install ${DISTROS["alpine-rv64"].name} from the App Store`,
        );
      }

      /* Guest / = ZenFS / — throws honestly when no OS is installed
         (first-time installation is the App Store's job). */
      const guestRoot = await ensureGuestRoot(root, { status: (t) => this.status(t) });
      if (this.disposed) return;
      this.status(
        guestRoot.reused
          ? "booting the distro from your filesystem (/)"
          : "booting the freshly unpacked distro from your filesystem (/)",
      );

      const { RV64 } = await loadEngine();
      if (this.disposed) return;

      for (const name of vfs.HOME_DIRS) await ensureDir(`${vfs.HOME}/${name}`);
      await ensureDir(`${vfs.HOME}/system`);

      /* src/bridge/p9.ts answers (req, reply); rv64.js asks handle(req) →
         bytes. Same 9p2000.L frames either way. */
      const rawHandler = createP9Handler(root, unionAsPromises(createDirectFs(root)) as never);
      const handle = (req: Uint8Array): Promise<Uint8Array> =>
        new Promise((resolve) => rawHandler(req, resolve));

      /* rv64.network=fetch on the cmdline is how the guest knows which
         network story it lives in (static 10.0.2.15 + the proxy env in
         /etc/profile.d/rv64-proxy.sh) — keep it in step with the `network`
         option below. */
      const cmdline = `console=ttyS0 rv64.network=fetch d86cols=${this.cols} d86rows=${this.rows}`;

      const vm = await RV64.create({
        wasm: { url: new URL(`${BASE}rv64_wasm.wasm`, document.baseURI).href },
        /* Proven in tools/vm/boot-rv64.mjs: 256 MB boots Alpine with room
           for the initramfs; the kernel itself is under 5 MB. */
        memoryMB: 256,
        boot: {
          mode: "linux-direct",
          /* Copies: the emulator stages these into wasm memory, and the
             originals are also what guest-root hands other callers. */
          kernel: guestRoot.kernel.slice(),
          initrd: guestRoot.initrd.slice(),
          cmdline,
          p9: { tag: "host9p", handle },
        },
        network: { mode: "fetch" },
        events: {
          console: (bytes: Uint8Array) => this.onBytes(bytes),
          error: (err: unknown) => {
            logWarn("rv64", "emulator error:", err);
            this.status(`machine error: ${(err as Error)?.message ?? String(err)}`);
            this.handlers.onStatus("offline");
          },
          stop: ({ reason }: { reason: string }) => {
            if (!this.disposed) logInfo("rv64", `machine stopped (${reason})`);
          },
        },
      });
      if (this.disposed) {
        void vm.destroy();
        return;
      }
      this.vm = vm;
      logInfo("rv64", "network: fetch backend (guest HTTP(S) through the browser's fetch; proxy CA installed by the guest init)");
      void vm.start();

      setTimeout(() => {
        if (!this.booted && !this.disposed) this.handlers.onStatus("offline");
      }, 90_000);
    } catch (err) {
      logWarn("rv64", "failed to start:", err);
      this.status(`could not start the guest: ${(err as Error).message}`);
      this.handlers.onStatus("offline");
    }
  }

  private onBytes(bytes: Uint8Array): void {
    if (this.disposed) return;
    const text = this.decoder.decode(bytes, { stream: true });
    if (!text) return;
    this.handlers.onData(text);
    if (!this.booted) {
      this.tail = (this.tail + text).slice(-512);
      if (this.tail.includes("dragon86:")) {
        this.booted = true;
        if (this.pendingInput) {
          this.vm?.console.send(this.pendingInput);
          this.pendingInput = "";
        }
        logInfo("rv64", "guest shell ready (its / is the OS filesystem)");
        this.handlers.onStatus("ready");
      }
    }
  }

  write(data: string): void {
    if (!this.booted) {
      this.pendingInput += data;
      return;
    }
    this.vm?.console.send(data);
  }

  dispose(): void {
    this.disposed = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    const vm = this.vm;
    this.vm = null;
    if (vm) {
      void vm
        .stop()
        .catch(() => {})
        .then(() => vm.destroy())
        .catch(() => {});
    }
  }
}

export function getRV64Backend(handlers: BackendHandlers): TerminalBackend {
  return new RV64Backend(handlers);
}
