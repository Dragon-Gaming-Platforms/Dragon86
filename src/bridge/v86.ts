/**
 * v86 backend — the Terminal's compatibility engine.
 *
 * Runs the vendored v86 emulator (public/v86/: npm `v86`, SeaBIOS, Arch
 * Linux 32 6.12 kernel + initrd with Arch's GNU bash/coreutils) directly
 * in this page. Unlike
 * CheerpX it needs no cross-origin isolation and no service worker, so it
 * works in Android WebView and other locked-down browsers.
 *
 * Files: the guest's /shared is not a copy or a sync — it *is* the OS
 * filesystem. src/bridge/p9.ts speaks 9p2000.L straight to ZenFS via
 * v86's `handle9p`, so guest and OS see the same live files (creates,
 * deletes, renames included). Nothing is typed into the guest to set
 * this up; the serial line carries only the user's shell session (its
 * size is passed on the kernel cmdline, since serial has no winsize
 * channel — see the guest /init).
 *
 * State: "Save State" (Terminal toolbar) snapshots the whole machine
 * (v86 save_state) into IndexedDB, gzip-compressed — far beyond
 * localStorage's ~5 MB, so IndexedDB is the on-device store used. On
 * the next v86 start the snapshot is passed as initial_state and the
 * session resumes where it left off; the 9p server treats unknown fids
 * as the share root, so the restored guest's mount heals itself.
 */

import * as vfs from "../core/vfs";
import { createP9Handler } from "./p9";
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

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await stateDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("kv", "readwrite").objectStore("kv").put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

interface SavedState { gzip: boolean; data: ArrayBuffer; savedAt: number }

async function loadSavedState(): Promise<ArrayBuffer | null> {
  try {
    const rec = (await idbGet(STATE_KEY)) as SavedState | undefined;
    if (!rec) return null;
    if (!rec.gzip) return rec.data;
    const stream = new Blob([rec.data]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).arrayBuffer();
  } catch (err) {
    logWarn("v86", "saved state unreadable; cold-booting:", err);
    return null;
  }
}

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

  constructor(private handlers: BackendHandlers) {}

  connect(): void {
    /* The guest's serial size rides the kernel cmdline, so give the
       terminal a beat to report its real size before we construct. */
    this.startTimer = setTimeout(() => void this.start(), 300);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = setTimeout(() => void this.start(), 200);
    }
  }

  private async start(): Promise<void> {
    this.startTimer = null;
    try {
      const [V86, saved] = await Promise.all([loadLib(), loadSavedState()]);
      if (this.disposed) return;
      const opts: Record<string, unknown> = {
        wasm_path: `${BASE}v86.wasm`,
        memory_size: 128 * 1024 * 1024,
        bios: { url: `${BASE}bios/seabios.bin` },
        vga_bios: { url: `${BASE}bios/vgabios.bin` },
        filesystem: { handle9p: createP9Handler(vfs.HOME) },
        autostart: true,
        disable_keyboard: true,
        disable_mouse: true,
        disable_speaker: true,
      };
      if (saved) {
        opts.initial_state = { buffer: saved };
        logInfo("v86", "resuming from saved state");
      } else {
        opts.bzimage = { url: `${BASE}bzImage` };
        opts.initrd = { url: `${BASE}initrd.gz` };
        opts.cmdline = `console=ttyS0 tsc=reliable d86cols=${this.cols} d86rows=${this.rows}`;
        logInfo("v86", "cold-booting guest");
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
          logInfo("v86", "guest shell ready (/shared is the OS filesystem)");
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
    const rec: SavedState = { gzip, data, savedAt: Date.now() };
    await idbPut(STATE_KEY, rec);
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

export function getV86Backend(handlers: BackendHandlers): TerminalBackend {
  return new V86Backend(handlers);
}
