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
 * localStorage's ~5 MB, so IndexedDB is the on-device store used. A
 * normal v86 start passes the snapshot as initial_state and resumes
 * where it left off; the 9p server treats unknown fids as the share
 * root, so the restored guest's mount heals itself. The Terminal's
 * Reconnect button deliberately requests a fresh boot from the guest
 * image instead, leaving any saved snapshot untouched for a later
 * normal start. Snapshots record the emulator ACPI layout they were
 * created with (pre-ACPI snapshots default to disabled), because v86's
 * state format embeds that layout and restoring across layouts fails.
 */

import { fs } from "@zenfs/core";
import * as vfs from "../core/vfs";
import { ensureDir } from "../core/vfs";
import { getSettings } from "../core/settings";
import { createP9Handler } from "./p9";
import { normalizeImageBase } from "./v86-image";
import { ImageStore } from "./image-store";
import { createUnionFs, unionAsPromises, withSubmount, zenfsBase } from "./union-fs";
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

interface SavedState {
  gzip: boolean;
  data: ArrayBuffer;
  savedAt: number;
  /** Emulator ACPI layout used when the snapshot was taken. Snapshots
      predate this field and were all taken with ACPI disabled; restoring
      one with a different layout crashes v86's state loader. */
  acpi?: boolean;
  /** Which guest image the snapshot belongs to. Legacy snapshots are all
      from the mini guest. A snapshot is only restorable into the same
      guest: the full Arch guest's root filesystem is served over HTTP by
      v86 and is NOT part of save_state, so restoring one would hand the
      resumed machine an empty root. */
  guest?: "dragon" | "arch";
}

interface LoadedState { buffer: ArrayBuffer; acpi: boolean }

async function loadSavedState(guest: "dragon" | "arch"): Promise<LoadedState | null> {
  try {
    const rec = (await idbGet(STATE_KEY)) as SavedState | undefined;
    if (!rec) return null;
    const recGuest = rec.guest ?? "dragon";
    if (recGuest !== guest) {
      logInfo("v86", `saved state belongs to the ${recGuest} guest; booting ${guest} fresh`);
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

/* ---------- backend ---------- */

/**
 * The mini guest's /shared: your Files folder (ZenFS, read-only floor) with
 * changes written into ~/v86/shared. Same layout as the full Arch guest, so
 * switching guests never moves where your files appear.
 */
function miniSharedFs() {
  return createUnionFs(vfs.SHARED_DIR.v86, zenfsBase(vfs.HOME, ["v86", "CheerpX"]));
}

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
  private guest: "dragon" | "arch" = "dragon";

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
   * Full Arch boots with `init=/bin/bash` (serial console, no VGA screen),
   * so the distro's own boot scripts never run. This types the handful of
   * lines a login would normally have done for us. Sent only when the user
   * clicks the Terminal's "Prepare Shell" button.
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
   * Create the image's directory tree (and symlinks) under ~/v86 so the whole
   * Arch layout is visible in the Files app from the first boot. File
   * contents stay lazy: a blob is fetched the first time something reads it,
   * and lands in ZenFS then (see union-fs.ts). Skip the walk when the tree
   * for this image base is already there.
   */
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

  private async materializeSkeleton(store: ImageStore, root: string): Promise<void> {
    const marker = `${root}/.dragon86-image.json`;
    try {
      const prev = JSON.parse(await fs.promises.readFile(marker, "utf8")) as { base?: string };
      if (prev.base === store.baseUrl) {
        logInfo("v86", "image tree already materialised; not walking it again");
        return;
      }
    } catch {
      /* first time */
    }
    const started = Date.now();
    let made = 0;
    for (const path of store.paths()) {
      if (this.disposed) return;
      const target = `${root}${path}`;
      try {
        const st = await store.stat(path);
        if (!st) continue;
        if (st.isDirectory()) {
          await fs.promises.mkdir(target, { recursive: true });
          made++;
        } else if (st.isSymbolicLink()) {
          const link = await store.readlink(path);
          if (!link) continue;
          try {
            await fs.promises.symlink(link, target);
            made++;
          } catch {
            /* already there, or ZenFS has no symlinks */
          }
        }
      } catch {
        /* a single unreadable path must not abort the walk */
      }
    }
    await fs.promises.writeFile(
      marker,
      JSON.stringify({ base: store.baseUrl, blobs: store.blobCount, at: Date.now(), dirs: made }),
    );
    this.status(`image tree ready: ${made} entries under ${root} (${Date.now() - started} ms)`);
  }

  private async start(): Promise<void> {
    this.startTimer = null;
    try {
      const guest = getSettings().v86Guest === "arch" ? "arch" : "dragon";
      this.guest = guest;
      const imageBase = normalizeImageBase(getSettings().v86ImageBase);
      /* Save/restore only exists for the mini guest: the full Arch root
         filesystem lives in v86's HTTP-backed 9p store, which is not part
         of save_state (see SavedState.guest). */
      const wantSaved = !this.freshBoot && guest === "dragon";
      const [V86, saved] = await Promise.all([
        loadLib(),
        wantSaved ? loadSavedState(guest) : Promise.resolve(null),
      ]);
      if (this.disposed) return;
      /* Fresh boots get ACPI (see below). A restored snapshot must keep
         the layout it was created with — v86's state format embeds it. */
      this.acpiEnabled = saved ? saved.acpi : true;

      /* 128 MB is plenty for the mini guest. The full Arch root filesystem
         runs a real distro userland (pacman, glibc, sshd-sized binaries), so
         it gets upstream's 512 MB — trimmed on touch devices, where browsers
         are stingy about large WebAssembly heaps. */
      const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
      const memoryMB = guest === "arch" ? (coarse ? 320 : 512) : 128;

      const opts: Record<string, unknown> = {
        wasm_path: `${BASE}v86.wasm`,
        memory_size: memoryMB * 1024 * 1024,
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

      if (guest === "arch") {
        /* The full Arch image, but *through us*: the root filesystem is an
           overlay — copy.sh's read-only image underneath, ZenFS on top — so
           the guest's whole root is browsable and editable at ~/v86 in the
           OS, and anything the guest writes persists in IndexedDB. This is
           why we no longer hand v86 `baseurl`/`basefs`: that path is v86's
           own private store, invisible to Dragon86. */
        this.status("reading the Arch image index…");
        const store = await ImageStore.load(imageBase, {
          root: vfs.ENGINE_ROOT.v86,
          fallbackBase: getSettings().v86ImageFallback,
          /* The upstream store only answers copy.sh's own referer, so blobs
             come from the mirror; say so in the Terminal instead of leaving a
             silent difference between browsers. */
          onNotice: (text) => this.status(text),
        });
        const root = vfs.ENGINE_ROOT.v86;
        await ensureDir(root);
        await ensureDir(vfs.SHARED_DIR.v86);

        /* The script sits at the top of the image tree, so the guest sees it
           at /networking.sh and you can edit it in Files. */
        void this.installNetworkingScript(root);
        const imageFs = createUnionFs(root, store);
        /* Guest /shared = your Files folder (ZenFS floor) with changes kept
           in ~/v86/shared — the same layout as the mini guest. */
        const sharedFs = createUnionFs(
          vfs.SHARED_DIR.v86,
          zenfsBase(vfs.HOME, ["v86", "CheerpX"]),
        );
        const rootFs = withSubmount(imageFs, vfs.SHARED_DIR.v86, sharedFs);

        /* Kernel + initrd come out of the image, the way upstream does it. */
        const { kernel, initrd } = store.findKernel();
        if (!kernel || !initrd) {
          throw new Error(`no kernel/initrd found inside ${imageBase} (looked for vmlinuz/bzimage and initrd/initramfs)`);
        }
        this.status(`fetching kernel + initrd (${(store.blobCount || 0).toLocaleString()} blobs available)…`);
        const [kImg, iImg] = await Promise.all([
          store.readFile(kernel),
          store.readFile(initrd),
        ]);
        if (!kImg || !iImg) {
          throw new Error(`could not read ${kernel} / ${initrd} from the image store`);
        }
        logInfo("v86", `arch image: ${kernel} (${(kImg.byteLength / 1048576).toFixed(1)} MB), ${initrd} (${(iImg.byteLength / 1048576).toFixed(1)} MB)`);

        opts.filesystem = {
          handle9p: createP9Handler(root, unionAsPromises(rootFs) as never),
        };
        opts.vga_memory_size = 8 * 1024 * 1024;
        opts.bzimage = { buffer: kImg.buffer.slice(0) };
        opts.initrd = { buffer: iImg.buffer.slice(0) };
        opts.cmdline = [
          "rw console=ttyS0 tsc=reliable",
          "root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose",
          "mitigations=off audit=0 random.trust_cpu=on nowatchdog",
          "init=/bin/bash",
          `d86cols=${this.cols} d86rows=${this.rows}`,
        ].join(" ");
        logInfo("v86", `cold-booting full Arch from ${imageBase} with the root at ${root}`);

        /* Show the tree in Files immediately (directories + symlinks only;
           file contents stay lazy, and copy themselves into ZenFS the first
           time anything touches them). Runs in the background: boot should
           not wait on thousands of mkdirs. */
        void this.materializeSkeleton(store, root);
      } else if (saved) {
        opts.filesystem = { handle9p: createP9Handler(vfs.SHARED_DIR.v86, unionAsPromises(miniSharedFs()) as never) };
        opts.initial_state = { buffer: saved.buffer };
        logInfo("v86", "resuming from saved state");
      } else {
        opts.filesystem = { handle9p: createP9Handler(vfs.SHARED_DIR.v86, unionAsPromises(miniSharedFs()) as never) };
        opts.bzimage = { url: `${BASE}bzImage` };
        opts.initrd = { url: `${BASE}initrd.gz` };
        /* v86's CPU has no machine-check hardware; skip only that dead
           initcall so the kernel does not report an MCE device failure. */
        opts.cmdline = `console=ttyS0 tsc=reliable initcall_blacklist=mcheck_init_device d86cols=${this.cols} d86rows=${this.rows}`;
        logInfo("v86", this.freshBoot ? "cold-booting guest from image (Reconnect)" : "cold-booting guest");
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
    if (this.guest === "arch") {
      throw new Error(
        "the full Arch guest boots its root filesystem over HTTP, which a " +
          "snapshot cannot contain — save state is only available for the " +
          "Dragon86 mini guest",
      );
    }
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
      guest: this.guest,
    };
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

export function getV86Backend(
  handlers: BackendHandlers,
  freshBoot = false,
): TerminalBackend {
  return new V86Backend(handlers, freshBoot);
}
