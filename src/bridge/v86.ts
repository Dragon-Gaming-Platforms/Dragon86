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
import type { BackendHandlers, EngineScreen, TerminalBackend } from "./hoster";
import { textScreenFrom } from "./v86-screen";

interface V86Emulator {
  add_listener(event: string, cb: (arg: number) => void): void;
  destroy(): void;
  serial0_send(data: string): void;
  save_state(): Promise<ArrayBuffer>;
  /**
   * libv86 keeps the VGA text buffer in its screen adapter and assigns it a
   * few milliseconds after construction — see bridge/v86-screen.ts.
   */
  screen_adapter?: { get_text_screen?: () => string[] };
  /**
   * Raw PS/2 scancodes into the emulated keyboard controller. Public API, and
   * it does not need the keyboard adapter (which the machine disables so it
   * cannot capture the whole page's keystrokes).
   */
  keyboard_send_scancodes?: (codes: number[]) => Promise<void> | void;
  /** Forwarded by some builds; not present in the vendored one. */
  get_text_screen?: () => string[];
  screen?: { get_text_screen?: () => string[] };
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
  private screenWarned = false;
  /** v86's own screen: the element its adapter draws the display into. */
  private screenHost: HTMLDivElement | null = null;
  /** Set by connect(): this backend has been asked to run a machine. */
  private started = false;

  constructor(
    private handlers: BackendHandlers,
    private freshBoot = false,
  ) {}

  connect(): void {
    this.started = true;
    /* The guest's serial size rides the kernel cmdline, so give the
       terminal a beat to report its real size before we construct. */
    this.startTimer = setTimeout(() => void this.start(), 300);
  }

  /**
   * The machine's VGA text screen, as it is right now — null when there is
   * nothing to read (no machine, or it has not finished constructing).
   * bridge/v86-screen.ts knows where libv86 keeps it and why.
   */
  getScreen(): EngineScreen | null {
    const screen = textScreenFrom(this.emu);
    if (screen === null && this.emu && !this.disposed) {
      /* Once, not every frame: an adapter that never appears is worth a line
         in the log, but not one per 140 ms. */
      if (!this.screenWarned) {
        this.screenWarned = true;
        logInfo("v86", "the machine has no readable text screen yet (still constructing?)");
      }
    }
    return screen;
  }

  /**
   * Keys pressed in the Engine Viewer, as PS/2 scancodes (bridge/v86-keys.ts
   * builds them). Straight to the emulated controller: the guest's own
   * keyboard driver decodes them, so Shift/Caps/layout all behave, and the
   * VGA console's shell on tty1 is the thing that receives them.
   *
   * The machine is built with `disable_keyboard: true` — that flag turns off
   * v86's *capture* of page-wide key events, not the keyboard itself. An OS
   * window must not forward every keystroke in every app to a guest.
   */
  sendScancodes(codes: number[]): void {
    if (!this.emu || this.disposed || !codes.length) return;
    try {
      void this.emu.keyboard_send_scancodes?.(codes);
    } catch (err) {
      logWarn("v86", "could not send keys to the machine:", err);
    }
  }

  /**
   * The element v86's screen adapter draws into. Created here (before the
   * machine starts, because the constructor needs it) but kept out of the
   * document: the Terminal shows the serial console, and only the Engine
   * Viewer mounts this.
   */
  screenElement(): HTMLElement | null {
    return this.screenHost;
  }

  private ensureScreenHost(): HTMLDivElement {
    if (this.screenHost) return this.screenHost;
    /* v86 looks for a div and a canvas inside the container and creates them
       if they are missing (copy.sh's page ships them for the same reason).
       Creating them here means they can be styled by class instead of by the
       ids that page happens to use — and two machines on one page must not
       share ids. */
    const host = document.createElement("div");
    host.className = "engine-screen-host";
    const text = document.createElement("div");
    text.className = "engine-screen-text";
    const canvas = document.createElement("canvas");
    canvas.className = "engine-screen-canvas";
    host.append(text, canvas);
    /* Focusable, so the viewer can give it the keyboard: keys go to the
       machine only while this element (or the window around it) has focus. */
    host.tabIndex = 0;
    host.setAttribute("role", "application");
    host.setAttribute("aria-label", "The v86 machine's console");
    this.screenHost = host;
    return host;
  }

  /**
   * True from the moment the Terminal asks this backend to start until it is
   * disposed — including the gap before the emulator object exists, which is
   * why it is not simply `Boolean(this.emu)`: a machine that is still starting
   * is not a machine that has stopped.
   */
  isRunning(): boolean {
    return !this.disposed && (Boolean(this.emu) || this.started);
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
   * Copy one of public/v86/scripts/ into the guest root. The guest root is
   * the OS filesystem, so these are ordinary files in Files: editable, and
   * the same text the guest runs.
   *
   * Every write is idempotent — the boot after a page reload puts the same
   * content back, so a re-seed or a half-finished write heals itself, and an
   * edit made in Files survives until the next boot replaces the file.
   */
  private async installHostFile(asset: string, dest: string, mode = 0o644): Promise<boolean> {
    try {
      const src = await fetch(`${BASE}scripts/${asset}`);
      if (!src.ok) {
        logWarn("v86", `${asset}: HTTP ${src.status} from ${BASE}scripts/`);
        return false;
      }
      const body = await src.text();
      const existing = await fs.promises.readFile(dest, "utf8").catch(() => null);
      if (existing !== body) {
        await fs.promises.writeFile(dest, body);
        logInfo("v86", `${asset} installed at ${dest}`);
      }
      await fs.promises.chmod(dest, mode).catch(() => {});
      return true;
    } catch (err) {
      logWarn("v86", `could not install ${asset}:`, err);
      return false;
    }
  }

  /**
   * Copy a binary asset from public/v86/ into the guest root, inflating it if
   * the asset is gzipped (the same format the initramfs uses, so the repo
   * keeps the compressed copy and the guest gets the real bytes).
   *
   * Unlike the scripts this is a multi-megabyte write, so it is skipped when
   * the destination is already the right size: only a first boot (or a new
   * build of the binary) pays for it.
   */
  private async installHostBinary(asset: string, dest: string, mode = 0o755): Promise<boolean> {
    try {
      const res = await fetch(`${BASE}${asset}`);
      if (!res.ok) {
        logWarn("v86", `${asset}: HTTP ${res.status} from ${BASE}`);
        return false;
      }
      let bytes = new Uint8Array(await res.arrayBuffer());
      if (asset.endsWith(".gz")) {
        const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream })
          .DecompressionStream;
        if (!DS) throw new Error("this browser has no DecompressionStream");
        const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DS("gzip"));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      }
      const existing = await fs.promises.stat(dest).catch(() => null);
      if (!existing || existing.size !== bytes.byteLength) {
        await ensureDir(dest.slice(0, dest.lastIndexOf("/")));
        await fs.promises.writeFile(dest, bytes);
        await fs.promises.chmod(dest, mode).catch(() => {});
        logInfo("v86", `${asset} installed at ${dest} (${bytes.byteLength} bytes)`);
      }
      return true;
    } catch (err) {
      logWarn("v86", `could not install ${asset}:`, err);
      return false;
    }
  }

  /**
   * Guest-side scripts and the profile hook that makes them usable.
   *
   * - /networking.sh          — bring the emulated card up (copy.sh's job too)
   * - /usr/bin/d86-clone      — fetch a GitHub snapshot without git (fallback)
   * - /usr/bin/d86-net        — check DNS/TLS for real, since ping is emulated
   * - /usr/lib/git-core/…     — git's HTTPS transport (see installGitTransport)
   * - /usr/share/d86/         — helpers.sh (sourced from /etc/profile) + a note
   *
   * /etc/profile is where login shells look, so the helper functions are
   * sourced from there rather than relying on executable bits landing on a
   * 9p-backed file. The marked block is rewritten every boot, so a stale copy
   * cannot keep pointing at a script that has moved.
   */
  private async installGuestTools(root: string): Promise<void> {
    const PROFILE_BEGIN = "# >>> dragon86 guest helpers";
    const PROFILE_END = "# <<< dragon86 guest helpers";
    try {
      await this.installHostFile("networking.sh", `${root}/networking.sh`, 0o755);
      await ensureDir(`${root}/usr/bin`);
      await ensureDir(`${root}/usr/share/d86`);
      await this.installHostFile("d86-clone.sh", `${root}/usr/bin/d86-clone`, 0o755);
      await this.installHostFile("d86-net.sh", `${root}/usr/bin/d86-net`, 0o755);
      await this.installHostFile("guest-readme.txt", `${root}/usr/share/d86/README.guest`);
      await this.installGitTransport(root);
      const helpers = await this.installHostFile(
        "guest-helpers.sh",
        `${root}/usr/share/d86/helpers.sh`,
      );
      if (!helpers) return;

      const profilePath = `${root}/etc/profile`;
      const current = await fs.promises.readFile(profilePath, "utf8").catch(() => null);
      if (current === null) return; /* root not unpacked yet; next boot */
      const block = [
        PROFILE_BEGIN,
        "# Written by Dragon86 at boot: sources the guest helpers (d86-clone,",
        "# d86-net) and points git's HTTPS helper at the CA bundle.",
        "[ -r /usr/share/d86/helpers.sh ] && . /usr/share/d86/helpers.sh",
        PROFILE_END,
        "",
      ].join("\n");
      const stripped = current
        .replace(new RegExp(`${PROFILE_BEGIN}[\\s\\S]*?${PROFILE_END}\\n?`, "m"), "")
        .replace(/\n*$/, "\n");
      const next = `${stripped}${stripped.endsWith("\n") ? "" : "\n"}\n${block}`;
      if (next !== current) {
        await fs.promises.writeFile(profilePath, next);
        logInfo("v86", "guest helpers hooked into /etc/profile");
      }
    } catch (err) {
      logWarn("v86", "could not install the guest tools:", err);
    }
  }

  /**
   * git's HTTPS transport, and the CA bundle it needs.
   *
   * The guest's git is a static build configured without curl, so it has no
   * HTTP transport of its own — `git clone https://…` fails with "unable to
   * find remote helper" before a packet is sent. git expects those transports
   * to be separate programs (`git-remote-http`, with `git-remote-https` as an
   * alias) found through its exec path, so that is exactly what ships here:
   * a self-contained static binary built from git 2.49.1 + libcurl + mbedTLS
   * (see public/v86/VENDORED.md and tools/build-git-remote-http.sh), written
   * into the guest's /usr/lib/git-core — the path this git was built with.
   *
   * The certificates go where the binary was compiled to look for them, so
   * a clone verifies github.com against the same roots a browser would.
   */
  private async installGitTransport(root: string): Promise<void> {
    const dir = `${root}/usr/lib/git-core`;
    const ok = await this.installHostBinary("git-remote-http.gz", `${dir}/git-remote-http`, 0o755);
    if (!ok) return;
    const target = `${dir}/git-remote-https`;
    const existing = await fs.promises.readlink(target).catch(() => null);
    if (existing !== "git-remote-http") {
      /* git runs whichever of the two names matches the URL scheme; a symlink
         is what upstream ships, and it costs nothing. A backend that will not
         take a symlink gets a second copy of the same bytes instead. */
      await fs.promises.rmdir(target).catch(() => {});
      await fs.promises
        .symlink("git-remote-http", target)
        .catch(() => this.installHostBinary("git-remote-http.gz", target, 0o755));
    }
    await this.installHostBinary("ca-certificates.crt", `${root}/etc/ssl/certs/ca-certificates.crt`, 0o644);
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
        /* v86's own screen, in a container of ours (see ensureScreenHost):
           this is how copy.sh/v86 shows a machine — the emulator renders the
           text console as coloured rows in a div, and a canvas underneath for
           graphical modes. Handing it a container is what makes the Engine
           Viewer show the machine's real display instead of a drawing of it.
           The container stays out of the document until the viewer opens, and
           v86 draws into it regardless. */
        screen: { container: this.ensureScreenHost() },
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

      /* Guest / = ~/v86 (ZenFS). The kernel and initramfs are read from there
         too, so everything the machine runs is a file in the OS filesystem;
         they are unpacked/copied in on first boot. */
      const guestRoot = await ensureGuestRoot(root, { status: (t) => this.status(t) });
      /* Scripts and the profile hook go in *after* the distro tree exists —
         a first boot that unpacked over the top of them would lose them —
         and before the machine starts, because the guest reads /etc/profile
         on its very first login. */
      await this.installGuestTools(root);
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
        opts.cmdline = `console=tty0 console=ttyS0 tsc=reliable initcall_blacklist=mcheck_init_device d86cols=${this.cols} d86rows=${this.rows}`;
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
