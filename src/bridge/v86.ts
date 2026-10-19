/**
 * v86 backend — the Terminal's compatibility engine.
 *
 * Runs the vendored v86 emulator (public/v86/: npm `v86`, SeaBIOS, Alpine
 * 6.12 kernel + our busybox initrd) directly in this page. Unlike CheerpX
 * it needs no cross-origin isolation and no service worker, so it works in
 * Android WebView and other locked-down browsers where the
 * coi-serviceworker trick can't.
 *
 * VFS wiring: Dragon86's /home/user IS the guest's /shared. At boot the OS
 * pushes its files into v86's 9p filesystem (guest mkdirs first, then
 * create_file); the guest mounts that share read-write; guest writes come
 * back on "9p-write-end" events and are read into the VFS. Not synced:
 * guest deletions/renames, and OS edits made while the engine runs (they
 * land on next boot/Reconnect).
 */

import * as vfs from "../core/vfs";
import { logInfo, logWarn } from "../core/log";
import type { BackendHandlers, TerminalBackend } from "./hoster";

interface V86Emulator {
  add_listener(event: string, cb: (arg: number | string) => void): void;
  destroy(): void;
  serial0_send(data: string): void;
  create_file(file: string, data: Uint8Array): Promise<void>;
  read_file(file: string): Promise<Uint8Array>;
}

type V86Ctor = new (opts: Record<string, unknown>) => V86Emulator;

const BASE = `${import.meta.env.BASE_URL}v86/`;
const MAX_PUSH_FILE = 2 * 1024 * 1024; // skip giant OS files at boot push
const MAX_PUSH_FILES = 400;

let libPromise: Promise<V86Ctor> | null = null;

function loadLib(): Promise<V86Ctor> {
  if (libPromise) return libPromise;
  libPromise = new Promise((resolve, reject) => {
    const w = window as unknown as { V86?: V86Ctor };
    if (w.V86) return resolve(w.V86);
    const s = document.createElement("script");
    s.src = `${BASE}libv86.js`;
    s.onload = () => (w.V86 ? resolve(w.V86) : reject(new Error("V86 global missing")));
    s.onerror = () => reject(new Error("failed to load libv86.js"));
    document.head.append(s);
  });
  libPromise.catch(() => { libPromise = null; });
  return libPromise;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class V86Backend implements TerminalBackend {
  private emu: V86Emulator | null = null;
  private decoder = new TextDecoder();
  private byteBuf: number[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private tail = ""; // rolling output tail for prompt detection
  private booted = false;
  private disposed = false;
  private pendingInput = "";
  private cols = 80;
  private rows = 24;
  private pullTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private handlers: BackendHandlers) {}

  connect(): void {
    void this.start();
  }

  private async start(): Promise<void> {
    try {
      const V86 = await loadLib();
      if (this.disposed) return;
      const emu = new V86({
        wasm_path: `${BASE}v86.wasm`,
        memory_size: 128 * 1024 * 1024,
        bios: { url: `${BASE}bios/seabios.bin` },
        vga_bios: { url: `${BASE}bios/vgabios.bin` },
        bzimage: { url: `${BASE}bzImage` },
        initrd: { url: `${BASE}initrd.gz` },
        filesystem: {},
        cmdline: "console=ttyS0 tsc=reliable",
        autostart: true,
        disable_keyboard: true,
        disable_mouse: true,
        disable_speaker: true,
      });
      this.emu = emu;
      emu.add_listener("serial0-output-byte", (b) => this.onByte(b as number));
      emu.add_listener("9p-write-end", (name) => this.onGuestWrite(name as string));
      logInfo("v86", "emulator started; waiting for guest shell prompt");
      /* If no prompt in 90 s, report offline (terminal shows its
         "still booting" state); a late prompt still completes below. */
      setTimeout(() => {
        if (!this.booted && !this.disposed) this.handlers.onStatus("offline");
      }, 90_000);
    } catch (err) {
      logWarn("v86", "failed to start:", err);
      this.handlers.onStatus("offline");
    }
  }

  private onByte(b: number): void {
    this.byteBuf.push(b);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const text = this.decoder.decode(new Uint8Array(this.byteBuf));
      this.byteBuf = [];
      if (this.disposed) return;
      this.handlers.onData(text);
      this.tail = (this.tail + text).slice(-512);
      if (!this.booted && this.tail.includes("dragon86:")) {
        this.booted = true;
        void this.finishBoot();
      }
    }, 8);
  }

  /** Prompt is up: size the guest tty, push the OS files, then go ready. */
  private async finishBoot(): Promise<void> {
    try {
      await this.pushVfs();
    } catch (err) {
      logWarn("v86", "VFS push failed (guest still usable):", err);
    }
    if (this.disposed) return;
    this.emu?.serial0_send(`stty rows ${this.rows} cols ${this.cols}\n`);
    if (this.pendingInput) {
      this.emu?.serial0_send(this.pendingInput);
      this.pendingInput = "";
    }
    logInfo("v86", "guest ready; /shared is the OS filesystem");
    this.handlers.onStatus("ready");
  }

  /**
   * OS → guest: create the OS directory tree inside the share (via the
   * guest shell — the host API can only create files in existing dirs),
   * then write every OS file into it. Files land relative to /shared,
   * which the guest has mounted from this same 9p filesystem.
   */
  private async pushVfs(): Promise<void> {
    const emu = this.emu;
    if (!emu) return;
    const dirs: string[] = [];
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await vfs.listDir(dir)) {
        const rel = e.path.slice(vfs.HOME.length + 1);
        if (e.isDirectory) {
          dirs.push(rel);
          await walk(e.path);
        } else if (files.length < MAX_PUSH_FILES) {
          files.push(rel);
        }
      }
    };
    await walk(vfs.HOME);
    if (dirs.length) {
      const quoted = dirs.map((d) => `'/shared/${d.replace(/'/g, "'\\''")}'`).join(" ");
      emu.serial0_send(`stty -echo; mkdir -p ${quoted}; stty echo\n`);
      await sleep(500); // let the guest create them before create_file
    }
    let pushed = 0;
    for (const rel of files) {
      try {
        const data = await vfs.readBytes(`${vfs.HOME}/${rel}`);
        if (data.length > MAX_PUSH_FILE) continue;
        await emu.create_file(rel, data);
        pushed++;
      } catch {
        /* unreadable/vanished file — skip, guest still gets the rest */
      }
    }
    logInfo("v86", `pushed ${pushed}/${files.length} OS files into /shared`);
  }

  /** Guest → OS: a file was written in the guest; pull it into the VFS. */
  private onGuestWrite(name: string): void {
    const rel = name.replace(/^\/+/, "");
    if (!rel) return;
    const old = this.pullTimers.get(rel);
    if (old) clearTimeout(old);
    this.pullTimers.set(
      rel,
      setTimeout(() => {
        this.pullTimers.delete(rel);
        void (async () => {
          try {
            const data = await this.emu?.read_file(rel);
            if (!data || this.disposed) return;
            await vfs.writeBytes(`${vfs.HOME}/${rel}`, data);
            logInfo("v86", `pulled guest write: /shared/${rel} (${data.length} B)`);
          } catch {
            /* deleted between event and read, or a directory — ignore */
          }
        })();
      }, 200),
    );
  }

  write(data: string): void {
    if (!this.booted) {
      this.pendingInput += data;
      return;
    }
    this.emu?.serial0_send(data);
  }

  resize(cols: number, rows: number): void {
    /* Serial has no winsize channel; finishBoot applies the size once the
       prompt is up (the terminal re-sends its size when we report ready). */
    this.cols = cols;
    this.rows = rows;
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.pullTimers.values()) clearTimeout(t);
    this.pullTimers.clear();
    try {
      this.emu?.destroy();
    } catch {
      /* already gone */
    }
    this.emu = null;
  }
}

export function getV86Backend(handlers: BackendHandlers): TerminalBackend {
  return new V86Backend(handlers);
}
