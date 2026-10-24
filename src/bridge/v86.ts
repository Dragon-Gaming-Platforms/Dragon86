/**
 * v86 backend — the Terminal's compatibility engine.
 *
 * Runs the vendored v86 emulator (public/v86/: npm `v86`, SeaBIOS, the
 * vendored Arch 32 kernel and initramfs with Arch's GNU bash/coreutils)
 * directly in this page. Unlike CheerpX it needs no cross-origin isolation
 * and no service worker, so it works in Android WebView and other locked-down
 * browsers.
 *
 * The guest's root filesystem is *the OS filesystem*. There is no disk image
 * and no copy to keep in sync: `~/v86` in ZenFS is what the guest mounts as
 * `/` over 9p (src/bridge/p9.ts speaks 9p2000.L straight to ZenFS through
 * v86's `handle9p`). So `/bin/bash`, `/etc/profile` and everything else the
 * distro runs are ordinary files in Dragon86 — visible in Files, editable in
 * the Text Editor, and writable from inside the guest. Your home folders are
 * grafted in at `/Downloads`, `/Documents` and `/Desktop`, so the guest and
 * the Files app are looking at the same directories.
 *
 * The distro itself is unpacked into `~/v86` on first boot from the vendored
 * initramfs (src/bridge/guest-root.ts) — one artifact to keep correct, and
 * what the guest runs is exactly what you can edit.
 *
 * State: "Save State" (Terminal toolbar) snapshots the whole machine
 * (v86 save_state) into IndexedDB, gzip-compressed. A normal start resumes
 * from it; Reconnect deliberately boots fresh.
 */

import { fs } from "@zenfs/core";
import * as vfs from "../core/vfs";
import { ensureDir } from "../core/vfs";
import { getSettings } from "../core/settings";
import { createP9Handler } from "./p9";
import { ensureGuestRoot } from "./guest-root";
import { createDirectFs, unionAsPromises, withSubmount } from "./union-fs";
import { logInfo, logWarn } from "../core/log";
import type { BackendHandlers, TerminalBackend } from "./hoster";

interface V86Emulator {
  add_listener(event: string, cb: (arg: number) => void): void;
  destroy(): void;
  serial0_send(data: string): void;
  save_state(): Promise<ArrayBuffer>;
}

type V86Ctor = new (opts: Record<string, unknown>) => V86Emulator;

const BASE = `${import.meta.env.BASE_URL}v86/`;
const STATE_DB = "dragon86-v86state";
const STATE_KEY = "latest";

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

/* ---------- saved-state store (IndexedDB; see header) ---------- */

function stateDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(STATE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<unknown> {
  const db = await stateDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("kv").objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await stateDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("kv", "readwrite").objectStore("kv").delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Forget the snapshot (used when the guest root it belongs to was re-unpacked). */
async function clearSavedState(): Promise<void> {
  await idbDelete(STATE_KEY);
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await stateDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("kv", "readwrite").objectStore("kv").put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

interface SavedState {
  gzip: boolean;
  data: ArrayBuffer;
  savedAt: number;
  /** Emulator ACPI layout used when the snapshot was taken. Snapshots
      predate this field and were all taken with ACPI disabled; restoring
      one with a different layout crashes v86's state loader. */
  acpi?: boolean;
  /** Kept for snapshots written by older builds, which could also run a
      second (image-store) guest. Anything not "dragon" is ignored. */
  guest?: string;
}

interface LoadedState { buffer: ArrayBuffer; acpi: boolean }

async function loadSavedState(): Promise<LoadedState | null> {
  try {
    const rec = (await idbGet(STATE_KEY)) as SavedState | undefined;
    if (!rec) return null;
    if (rec.guest && rec.guest !== "dragon") {
      logInfo("v86", "saved state belongs to a guest this build no longer has; booting fresh");
      return null;
    }
    const acpi = rec.acpi === true;
    if (!rec.gzip) return { buffer: rec.data, acpi };
    const stream = new Blob([rec.data]).stream().pipeThrough(new DecompressionStream("gzip"));
    return { buffer: await new Response(stream).arrayBuffer(), acpi };
  } catch (err) {
    logWarn("v86", "saved state unreadable; cold-booting:", err);
    return null;
  }
}

/* Set once this page has taken a snapshot. A snapshot is only meaningful
   inside the page that took it: it stores the guest's open files, and those
   are fids in a 9p server (and handles in ZenFS) that are recreated on every
   page load. Resuming one after a reload found the guest staring at fids
   that point at nothing — bash exited at once and the terminal filled with
   "Session ended … Respawning in 2s". Since every write already lands in
   ZenFS, a cold boot loses nothing worth the crash. */
let savedThisSession = false;

/* ---------- backend ---------- */

class V86Backend implements TerminalBackend {
  private emu: V86Emulator | null = null;
  private decoder = new TextDecoder();
  private byteBuf: number[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private tail = "";
  private booted = false;
  private disposed = false;
  private pendingInput = "";
  private cols = 80;
  private rows = 24;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private nudgeTimer: ReturnType<typeof setInterval> | null = null;
  private acpiEnabled = false;

  constructor(
    private handlers: BackendHandlers,
    private freshBoot = false,
  ) {}

  connect(): void {
    /* The guest's serial size rides the kernel cmdline, so give the
       terminal a beat to report its real size before we construct. */
    this.startTimer = setTimeout(() => void this.start(), 300);
  }

  /**
   * The guest boots straight to bash on the serial console, so nothing runs
   * a login. This types the few harmless lines a login would have done —
   * mounts that already exist become no-ops — and brings the network up.
   * Sent only when the user clicks the Terminal's "Prepare Shell" button.
   */
  prepareShell(): void {
    if (!this.emu) return;
    const lines = [
      "mount -t devtmpfs devtmpfs /dev 2>/dev/null; " +
        "mount -t proc proc /proc 2>/dev/null; " +
        "mount -t sysfs sysfs /sys 2>/dev/null; " +
        "mount -t devpts devpts /dev/pts 2>/dev/null",
      "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "export TERM=xterm-256color HOME=/root",
      "cd /root 2>/dev/null || cd /",
      "echo '[dragon86] /dev, /proc, /sys mounted'",
      "[ -x /networking.sh ] && /networking.sh",
    ];
    for (const line of lines) this.emu.serial0_send(line + "\n");
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = setTimeout(() => void this.start(), 200);
    }
  }

  /** Relay URL for v86's network backend, or "" when networking is off. */
  private netDeviceUrl(): string {
    const raw = (getSettings().v86Network || "").trim();
    if (!raw || raw.toLowerCase() === "off" || raw.toLowerCase() === "none") return "";
    return raw;
  }

  /** Progress line for the Terminal (kind of quiet: it is a chatty boot). */
  private status(text: string): void {
    logInfo("v86", text);
    this.handlers.onNotice?.(text);
  }

  /**
   * Put the guest's networking script where both guests can see it: in the
   * OS filesystem, so it is editable in Files and shows up in the Arch
   * guest's own root (the image has no such script of its own once we serve
   * it — copy.sh's image ships one at /root, and ours does too).
   */
  private async installNetworkingScript(root: string): Promise<void> {
    try {
      const src = await fetch(`${BASE}scripts/networking.sh`);
      if (!src.ok) return;
      const body = await src.text();
      const dest = `${root}/networking.sh`;
      const existing = await fs.promises.readFile(dest, "utf8").catch(() => null);
      if (existing !== body) {
        await fs.promises.writeFile(dest, body);
        logInfo("v86", `networking.sh installed at ${dest}`);
      }
      await fs.promises.chmod(dest, 0o755).catch(() => {});
    } catch (err) {
      logWarn("v86", "could not install networking.sh:", err);
    }
  }

  private async start(): Promise<void> {
    this.startTimer = null;
    try {
      const wantSaved = !this.freshBoot;
      const [V86, loaded] = await Promise.all([loadLib(), wantSaved ? loadSavedState() : Promise.resolve(null)]);
      let saved = loaded;
      if (this.disposed) return;
      if (saved && !savedThisSession) {
        logInfo("v86", "saved state is from an earlier page load; booting fresh instead of resuming");
        await clearSavedState().catch(() => {});
        saved = null;
      }
      /* Fresh boots get ACPI (see below). A restored snapshot must keep the
         layout it was created with — v86's state format embeds it. */
      this.acpiEnabled = saved ? saved.acpi : true;

      const opts: Record<string, unknown> = {
        wasm_path: `${BASE}v86.wasm`,
        memory_size: 128 * 1024 * 1024,
        bios: { url: `${BASE}bios/seabios.bin` },
        vga_bios: { url: `${BASE}bios/vgabios.bin` },
        /* Give fresh guests v86's ACPI tables. Without them, SeaBIOS
           leaves the Arch kernel to fall back to a bogus MP table,
           producing harmless-but-alarming RSDP/APIC/IOAPIC errors. */
        acpi: this.acpiEnabled,
        /* The emulated NIC is the emulator's job, not the guest's: v86
           provides the card and the backend behind it (a wsproxy/wisp relay,
           or the in-page stack), including DHCP. The guest only loads its
           driver and asks for a lease — see /networking.sh. Setting the
           field to "off" gives the guest loopback only. */
        ...(this.netDeviceUrl()
          ? { net_device: { type: "virtio", relay_url: this.netDeviceUrl() } }
          : {}),
        autostart: true,
        disable_keyboard: true,
        disable_mouse: true,
        disable_speaker: true,
      };

      const net = this.netDeviceUrl();
      logInfo(
        "v86",
        net
          ? `network: virtio-net via ${net} (DHCP served by the backend)`
          : "network: off — the guest gets loopback only",
      );

      const root = vfs.ENGINE_ROOT.v86;
      await ensureDir(root);
      /* The script sits at the top of the guest root, so the guest sees it at
         /networking.sh and you can edit it in Files. */
      void this.installNetworkingScript(root);

      /* Guest / = ~/v86 (ZenFS). The kernel and initramfs are read from there
         too, so everything the machine runs is a file in the OS filesystem;
         they are unpacked/copied in on first boot. */
      const guestRoot = await ensureGuestRoot(root, { status: (t) => this.status(t) });
      if (this.disposed) return;
      /* A snapshot belongs to one particular root: it holds the guest's
         inodes (modes, qids) for files that were re-unpacked underneath it.
         Resuming into a freshly seeded root gives "permission denied" on
         files that look fine, so throw the snapshot away instead. */
      if (saved && !guestRoot.reused) {
        logInfo("v86", "the guest root was re-unpacked; discarding the saved state");
        await clearSavedState().catch(() => {});
        saved = null;
        this.acpiEnabled = true;
        opts.acpi = true;
      }
      this.status(
        guestRoot.reused
          ? "booting the distro from your filesystem (~/v86)"
          : "booting the freshly unpacked distro from your filesystem (~/v86)",
      );
      opts.bzimage = { buffer: guestRoot.kernel.buffer.slice(0) };
      opts.initrd = { buffer: guestRoot.initrd.buffer.slice(0) };

      /* One 9p share, mounted by the guest at /. Your home folders are
         grafted straight into it, so /Downloads, /Documents and /Desktop
         inside the guest are the same directories the Files app shows —
         read and write, no copy, no separate "shared" folder. */
      let rootFs = createDirectFs(root);
      for (const name of [...vfs.HOME_DIRS, "system"]) {
        await ensureDir(`${vfs.HOME}/${name}`);
        rootFs = withSubmount(rootFs, `/${name}`, createDirectFs(`${vfs.HOME}/${name}`));
      }
      opts.filesystem = { handle9p: createP9Handler(root, unionAsPromises(rootFs) as never) };

      if (saved) {
        opts.initial_state = { buffer: saved.buffer };
        logInfo("v86", "resuming from saved state");
      } else {
        /* v86's CPU has no machine-check hardware; skip only that dead
           initcall so the kernel does not report an MCE device failure. */
        opts.cmdline = `console=ttyS0 tsc=reliable initcall_blacklist=mcheck_init_device d86cols=${this.cols} d86rows=${this.rows}`;
        logInfo("v86", this.freshBoot ? "cold-booting guest from the OS filesystem (Reconnect)" : "cold-booting guest");
      }

      const emu = new V86(opts);
      this.emu = emu;
      emu.add_listener("serial0-output-byte", (b) => this.onByte(b));
      if (saved) {
        /* A restored machine is already at a prompt but prints nothing;
           nudge it until the prompt shows up. */
        this.nudgeTimer = setInterval(() => {
          if (this.booted || this.disposed) {
            if (this.nudgeTimer) clearInterval(this.nudgeTimer);
            this.nudgeTimer = null;
            return;
          }
          this.emu?.serial0_send("\n");
        }, 2500);
      }
      setTimeout(() => {
        if (!this.booted && !this.disposed) this.handlers.onStatus("offline");
      }, 90_000);
    } catch (err) {
      logWarn("v86", "failed to start:", err);
      this.status(`could not start the guest: ${(err as Error).message}`);
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
      if (!this.booted) {
        this.tail = (this.tail + text).slice(-512);
        if (this.tail.includes("dragon86:")) {
          this.booted = true;
          if (this.nudgeTimer) clearInterval(this.nudgeTimer);
          this.nudgeTimer = null;
          if (this.pendingInput) {
            this.emu?.serial0_send(this.pendingInput);
            this.pendingInput = "";
          }
          logInfo("v86", "guest shell ready (its / is the OS filesystem)");
          this.handlers.onStatus("ready");
        }
      }
    }, 8);
  }

  write(data: string): void {
    if (!this.booted) {
      this.pendingInput += data;
      return;
    }
    this.emu?.serial0_send(data);
  }

  /** Snapshot the machine into IndexedDB (gzip; see header). */
  async saveState(): Promise<void> {
    if (!this.emu) throw new Error("engine not running");
    const raw = await this.emu.save_state();
    let data = raw;
    let gzip = false;
    try {
      const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"));
      data = await new Response(stream).arrayBuffer();
      gzip = true;
    } catch {
      /* CompressionStream unavailable — store raw. */
    }
    const rec: SavedState = {
      gzip,
      data,
      savedAt: Date.now(),
      acpi: this.acpiEnabled,
      guest: "dragon",
    };
    await idbPut(STATE_KEY, rec);
    savedThisSession = true;
    logInfo(
      "v86",
      `state saved: ${(raw.byteLength / 1048576).toFixed(1)} MB raw → ${(data.byteLength / 1048576).toFixed(1)} MB stored`,
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.nudgeTimer) clearInterval(this.nudgeTimer);
    try {
      this.emu?.destroy();
    } catch {
      /* already gone */
    }
    this.emu = null;
  }
}

export function getV86Backend(
  handlers: BackendHandlers,
  freshBoot = false,
): TerminalBackend {
  return new V86Backend(handlers, freshBoot);
}
