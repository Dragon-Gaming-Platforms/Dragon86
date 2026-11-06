/**
 * The v86 guest's root filesystem, living in the OS filesystem.
 *
 * The guest boots a vendored Arch kernel plus a small initramfs, and its
 * `/` is not a disk image: it is the OS filesystem's own `/` in ZenFS, served to the
 * guest over 9p. So the whole distribution — `/bin/bash`, `/usr/bin/awk`,
 * `/etc/profile`, everything — is a normal file in Dragon86, visible in
 * Files, editable with the Text Editor, writable from inside the guest.
 *
 * Where the files come from: the installed distro's initramfs (see DISTROS —
 * `public/v86/initrd.gz` for the 32-bit build, `public/arch64/initrd.gz` for
 * Arch's own x86_64 build) already
 * contains the hand-built userland (busybox + Arch bash + coreutils + glibc +
 * kernel modules). Installing Arch Linux from the App Store unpacks it once
 * into ZenFS `/`, and every boot runs from that copy. The initramfs is still what the *kernel* is given — it has to be,
 * since it is what mounts the 9p root — but inside it the only thing that
 * matters is `/init`, which mounts our ZenFS root and switches to it.
 *
 * Why unpack instead of shipping a second copy of the files: one artifact to
 * keep correct, and the unpacked tree is exactly what the guest runs, so
 * editing a file in Files changes what the guest executes.
 */

import { fs } from "@zenfs/core";
import { logInfo, logWarn } from "../core/log";

/**
 * The operating systems the App Store can put at `/`. One of them is
 * installed at a time — they both dump their userland into the same root,
 * so installing one over the other replaces the OS (the files the new
 * initramfs carries win; files the guest created stay).
 *
 *  - arch32: Arch Linux 32 userland, boots on both x86 machines (a 32-bit
 *    OS runs on a 64-bit CPU, exactly like real hardware).
 *  - arch64: Arch's own x86_64 build (linux-lts kernel, 64-bit userland,
 *    static 64-bit git) — needs the x86_64 machine; a 32-bit CPU cannot
 *    run it, and the Terminal says so instead of pretending.
 *  - alpine-rv64: official Alpine Linux riscv64 (bash, Alpine's own git
 *    with real HTTPS, openssl) — needs the RISC-V 64 machine
 *    (bridge/rv64.ts); an x86 CPU cannot run it, and the Terminal says so.
 */
export type DistroId = "arch32" | "arch64" | "alpine-rv64";

export interface Distro {
  id: DistroId;
  /** public/ directory the boot artifacts are fetched from. */
  base: string;
  name: string;
  /** Catalog id in public/store.json. */
  storeId: string;
  /** Machine architectures (Settings → Machine) whose CPU can run it. */
  runsOn: readonly string[];
  /** The kernel's filename under `base` (x86 ships bzImage; riscv64 Image). */
  kernel: string;
}

export const DISTROS: Record<DistroId, Distro> = {
  arch32: {
    id: "arch32",
    base: "v86/",
    name: "Arch Linux (x86)",
    storeId: "arch-linux",
    runsOn: ["x86_32", "x86_64"],
    kernel: "bzImage",
  },
  arch64: {
    id: "arch64",
    base: "arch64/",
    name: "Arch Linux (x86-64)",
    storeId: "arch-linux-64",
    runsOn: ["x86_64"],
    kernel: "bzImage",
  },
  "alpine-rv64": {
    id: "alpine-rv64",
    base: "rv64/",
    name: "Alpine Linux (RISC-V 64)",
    storeId: "alpine-linux-riscv64",
    runsOn: ["riscv64"],
    kernel: "Image",
  },
};

const baseFor = (distro: DistroId): string => `${import.meta.env.BASE_URL}${DISTROS[distro].base}`;

/**
 * Bump when the seeding rules change (not when the initramfs changes — that
 * is detected by size and hash). Forces a re-seed on the next boot.
 */
const SEED_VERSION = 2;

const MARKER = ".dragon86-root.json";

export interface GuestRoot {
  /** ZenFS directory that *is* the guest's `/`. */
  root: string;
  kernel: Uint8Array;
  initrd: Uint8Array;
  /** True when the tree already existed and nothing was unpacked. */
  reused: boolean;
  /** Which OS this root now holds. */
  distro: DistroId;
}

interface Marker {
  v: number;
  at: number;
  /** Which distro the root was unpacked from. Markers written before the
      64-bit build existed carry no field — those roots are arch32. */
  distro?: DistroId;
  initrdBytes: number;
  /** FNV-1a of the initramfs the root was unpacked from. Markers written
      before this field existed fail the check once and re-seed — which is
      wanted: those roots may hold an init older than the app's. */
  initrdHash?: number;
  files: number;
}

/** FNV-1a, 32-bit — cheap and good enough to tell two initramfs builds apart. */
export function fnv1a(data: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* ---------- gzip ---------- */

/** Inflate a gzip stream with the platform API. */
async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!DS) throw new Error("this browser has no DecompressionStream (needs Safari 16.4+, Chrome 80+)");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ---------- cpio (newc "070701") ---------- */

export interface CpioEntry {
  name: string;
  mode: number;
  /** Regular file contents; empty for directories and symlinks. */
  data: Uint8Array;
  /** Symlink target, when the entry is a symlink. */
  link?: string;
}

const hex = (b: Uint8Array, off: number): number =>
  parseInt(String.fromCharCode(...b.subarray(off, off + 8)), 16) || 0;

/**
 * Parse a newc cpio archive — what the kernel's initramfs is and what our
 * `initrd.gz` unpacks to. Exported for the tests: it is the one piece here
 * that can silently corrupt a distribution.
 */
export function parseCpio(buf: Uint8Array): CpioEntry[] {
  const out: CpioEntry[] = [];
  let off = 0;
  while (off + 110 <= buf.byteLength) {
    const magic = String.fromCharCode(...buf.subarray(off, off + 6));
    if (magic !== "070701" && magic !== "070702") break;
    const mode = hex(buf, off + 14);
    const fileSize = hex(buf, off + 54);
    const nameSize = hex(buf, off + 94);
    const nameStart = off + 110;
    let name = new TextDecoder().decode(buf.subarray(nameStart, nameStart + nameSize - 1));
    let p = nameStart + nameSize;
    p = (p + 3) & ~3;
    const data = buf.subarray(p, p + fileSize);
    p += fileSize;
    off = (p + 3) & ~3;

    if (name === "TRAILER!!!") break;
    /* The kernel's own initramfs prefixes paths with "./"; ours does not. */
    name = name.replace(/^\.?\/*/, "");
    if (!name || name.endsWith("/")) {
      if (name) out.push({ name: name.replace(/\/$/, ""), mode, data: new Uint8Array(0) });
      continue;
    }
    const type = mode & 0o170000;
    if (type === 0o120000) {
      out.push({ name, mode, data: new Uint8Array(0), link: new TextDecoder().decode(data) });
    } else if (type === 0o100000) {
      out.push({ name, mode, data });
    } else if (type === 0o040000) {
      out.push({ name, mode, data: new Uint8Array(0) });
    }
    /* device nodes, fifos and sockets have no place in a 9p share */
  }
  return out;
}

/* ---------- seeding ---------- */

/** `root`-relative path, tolerating root = "/" (no double slashes). */
export function at(root: string, rel: string): string {
  return `${root}/${rel}`.replace(/\/{2,}/g, "/");
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.promises.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(path: string): Promise<void> {
  await fs.promises.mkdir(path, { recursive: true }).catch(() => {});
}

async function readMarker(root: string): Promise<Marker | null> {
  try {
    return JSON.parse(await fs.promises.readFile(at(root, MARKER), "utf8")) as Marker;
  } catch {
    return null;
  }
}

/** Byte-for-byte equality (sizes first; a full compare of ~15 MB is milliseconds). */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The boot artifact the app currently ships, kept in sync in ZenFS.
 *
 * The copy in `/boot` is *checked against the app on every boot*, not
 * trusted forever: an earlier version returned the ZenFS copy unseen, so a
 * root seeded by an old deployment kept booting the old initramfs — and an
 * old init means no keyboard modules and no tty1 shell, which is exactly "the
 * Engine Viewer shows the screen but typing does nothing".
 *
 * `no-cache` = revalidate, not "don't cache": GitHub Pages answers 304 when
 * nothing changed (the bytes then come from the browser's HTTP cache) and
 * fresh bytes when the image was rebuilt. When the network is down and a
 * copy exists, the copy boots — with a log line saying it was not checked.
 */
async function ensureArtifact(root: string, name: string, url: string): Promise<Uint8Array> {
  const path = at(root, `boot/${name}`);
  let local: Uint8Array | null = null;
  if (await exists(path)) {
    const data = new Uint8Array(await fs.promises.readFile(path));
    if (data.byteLength > 1024) local = data;
  }
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const fresh = new Uint8Array(await res.arrayBuffer());
    if (fresh.byteLength <= 1024) throw new Error(`${url}: implausibly small (${fresh.byteLength} bytes)`);
    if (local && sameBytes(local, fresh)) return local;
    await ensureDir(at(root, "boot"));
    await fs.promises.writeFile(path, fresh);
    logInfo(
      "guest",
      local
        ? `${name}: the app ships a different build — replaced the copy in /boot (${(fresh.byteLength / 1048576).toFixed(1)} MB)`
        : `${name} copied into the OS filesystem (${(fresh.byteLength / 1048576).toFixed(1)} MB)`,
    );
    return fresh;
  } catch (err) {
    if (local) {
      logWarn("guest", `${name}: could not check the app's copy (offline?) — booting the one already in /boot`, err);
      return local;
    }
    throw err;
  }
}

/**
 * Is there an operating system at this root? True once the distro has been
 * installed (App Store → Arch Linux) — a valid seed marker plus a shell.
 * A marker from an older initramfs still counts: that is an installed OS
 * that will be updated on the next boot, not a missing one.
 */
export async function distroInstalled(root: string): Promise<boolean> {
  const marker = await readMarker(root);
  if (!marker) return false;
  return (await exists(at(root, "bin/bash"))) || (await exists(at(root, "usr/bin/bash")));
}

/**
 * Which OS is installed at this root, or null when none is. Roots seeded
 * before the 64-bit build existed have no distro field in their marker —
 * they are arch32 roots.
 */
export async function installedDistro(root: string): Promise<DistroId | null> {
  if (!(await distroInstalled(root))) return null;
  const marker = await readMarker(root);
  return marker?.distro ?? "arch32";
}

/**
 * Make sure the system root (`/` in ZenFS) is a bootable Arch root and hand back the kernel and
 * initramfs to boot it with. Cheap when it has already been done.
 *
 * First-time installation is the App Store's job (the Arch Linux listing,
 * whose app-manifest.json dumps the distro at `/`): a boot with no OS
 * installed throws instead of quietly installing one. `install: true` is
 * how the store (and Settings' re-unpack) actually performs the dump.
 * An installed root whose initramfs is older than the app's still updates
 * itself on boot — that is an update, not an install.
 */
export async function ensureGuestRoot(
  root: string,
  opts: { status?: (text: string) => void; force?: boolean; install?: boolean; distro?: DistroId } = {},
): Promise<GuestRoot> {
  const say = opts.status ?? (() => {});
  if (!opts.install && !opts.force && !(await distroInstalled(root))) {
    throw new Error(
      "no operating system is installed — open the App Store and install Arch Linux",
    );
  }
  await ensureDir(root);
  await ensureDir(at(root, "boot"));

  /* Which OS this root should hold: the caller's word (an install from the
     store), else whatever is already installed, else the 32-bit default. */
  const marker0 = await readMarker(root);
  const distro: DistroId = opts.distro ?? marker0?.distro ?? "arch32";
  const BASE = baseFor(distro);

  const kernel = await ensureArtifact(root, "vmlinuz", `${BASE}${DISTROS[distro].kernel}`);
  const initrd = await ensureArtifact(root, "initrd.gz", `${BASE}initrd.gz`);

  const marker = marker0;
  const initrdHash = fnv1a(initrd);
  /* Same version, same distro, same size *and* same hash: a root unpacked
     from exactly this initramfs. Markers from before the hash existed fail
     here once and the tree is re-unpacked — those roots may carry an older
     init than the app (the artifact check above used to trust the ZenFS
     copy unseen). Installing the other distro fails this too (different
     bytes) and replaces the userland in place. */
  const seeded =
    marker?.v === SEED_VERSION &&
    (marker.distro ?? "arch32") === distro &&
    marker.initrdBytes === initrd.byteLength &&
    marker.initrdHash === initrdHash;
  if (seeded && !opts.force && (await exists(at(root, "bin/bash")))) {
    logInfo("guest", `running the distro already in the OS filesystem (${marker?.files ?? "?"} files)`);
    await repairModes(root);
    return { root, kernel, initrd, reused: true, distro };
  }
  if (marker && !seeded && !opts.force) {
    logInfo("guest", "the guest root was unpacked from a different initramfs — re-unpacking the distro");
  }

  say("unpacking the distro into your filesystem (one time)…");
  const started = Date.now();
  const raw = await gunzip(initrd);
  const entries = parseCpio(raw);
  if (entries.length === 0) throw new Error("the initramfs did not unpack — no cpio entries found");

  /* Directories first: a file cannot be created before its parent exists. */
  const dirs = entries.filter((e) => (e.mode & 0o170000) === 0o040000);
  const rest = entries.filter((e) => (e.mode & 0o170000) !== 0o040000);
  for (const d of dirs) await ensureDir(at(root, d.name));

  let files = 0;
  let bytes = 0;
  let noMode = 0;
  for (const e of rest) {
    const target = at(root, e.name);
    try {
      if (e.link !== undefined) {
        await ensureDir(target.slice(0, target.lastIndexOf("/")));
        await fs.promises.unlink(target).catch(() => {});
        await fs.promises.symlink(e.link, target);
      } else {
        await ensureDir(target.slice(0, target.lastIndexOf("/")));
        await fs.promises.writeFile(target, e.data);
        await fs.promises.chmod(target, e.mode & 0o7777).catch(() => { noMode++; });
        bytes += e.data.byteLength;
      }
      files++;
    } catch (err) {
      logWarn("guest", `could not unpack /${e.name}:`, err);
    }
    if (files % 100 === 0) say(`unpacking the distro… ${files}/${rest.length}`);
  }

  /* Things a 9p root needs that an initramfs never carried. */
  for (const dir of ["root", "tmp", "proc", "sys", "dev", "home", "mnt", "run"]) {
    await ensureDir(at(root, dir));
  }

  /* Older initramfs builds shipped empty directories (/shared, /usr/local/…,
     /etc/modprobe.d) and every seed left them in / as permanent clutter.
     The archives no longer carry them (tools/clean-initrd.py), but an
     unpack only ever writes — so sweep the known ones out of roots seeded
     before. rmdir refuses a non-empty directory, so anything a user put
     inside survives; and a distro whose archive still ships the path is
     left alone. */
  const shipped = new Set(entries.map((e) => e.name));
  for (const legacy of [
    "shared",
    "usr/local/bin",
    "usr/local/sbin",
    "usr/local/lib",
    "usr/local",
    "etc/modprobe.d",
  ]) {
    if (shipped.has(legacy)) continue;
    await fs.promises.rmdir(at(root, legacy)).then(
      () => logInfo("guest", `swept the empty legacy directory /${legacy}`),
      () => {} /* not there, or not empty — both are fine */,
    );
  }

  /* The initramfs keeps everything in /usr/bin and has bare /bin, /sbin and
     /lib directories. A normal Arch root has those as symlinks, and plenty of
     scripts (and kernel module loading) assume /bin/sh and /lib/modules
     resolve — so make them symlinks, but only while the directories are
     empty, so a guest that has since put files there is left alone. */
  for (const [link, target] of [["bin", "usr/bin"], ["sbin", "usr/bin"], ["lib", "usr/lib"]] as const) {
    const path = at(root, link);
    try {
      const st = await fs.promises.stat(path);
      if (!st.isDirectory()) continue;
      const names = await fs.promises.readdir(path);
      if (names.length > 0) continue;
      await fs.promises.rmdir(path);
      await fs.promises.symlink(target, path);
      logInfo("guest", `/${link} → ${target}`);
    } catch {
      /* already a symlink, or something is in the way — leave it */
    }
  }

  /* A backend that refuses chmod would leave every binary 0644 and nothing
     would run — say so loudly instead of presenting a dead console. */
  if (noMode > 0) {
    logWarn(
      "guest",
      `${noMode} files could not keep their permission bits; the guest may refuse to run them`,
    );
    say(`warning: ${noMode} files lost their permission bits`);
  }

  await repairModes(root);

  await fs.promises.writeFile(
    at(root, MARKER),
    JSON.stringify({ v: SEED_VERSION, at: Date.now(), distro, initrdBytes: initrd.byteLength, initrdHash, files } satisfies Marker),
  );

  say(
    `distro unpacked: ${files} files, ${(bytes / 1048576).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  logInfo("guest", `guest root ready at ${root}: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
  return { root, kernel, initrd, reused: false, distro };
}

/**
 * Make sure the few files the guest cannot boot without are executable.
 *
 * A file written through 9p starts life 0644, and an initramfs entry whose
 * mode did not survive (a backend without chmod, an interrupted first
 * unpack) leaves a distro that looks complete but answers every command with
 * "Permission denied". Two stats per boot is a cheap price for not shipping
 * a broken console; anything else that lost its bits is the guest's problem.
 */
async function repairModes(root: string): Promise<void> {
  const must = [at(root, "usr/bin/bash"), at(root, "usr/bin/setsid"), at(root, "usr/bin/ls")];
  for (const path of must) {
    try {
      const st = await fs.promises.stat(path);
      if ((st.mode & 0o111) === 0) {
        await fs.promises.chmod(path, (st.mode & 0o170000) | 0o755);
        logInfo("guest", `${path} was not executable — fixed its mode`);
      }
    } catch {
      /* not there; the unpack check handles that */
    }
  }
}

/** What the seeding left behind, for Settings. */
export async function guestRootInfo(root: string): Promise<Marker | null> {
  return readMarker(root);
}

/**
 * Drop the marker. With install-from-the-store semantics this alone would
 * leave the machine "not installed", so the only caller (Settings'
 * re-unpack) follows it with ensureGuestRoot(root, { force: true }).
 */
export async function resetGuestRoot(root: string): Promise<void> {
  await fs.promises.unlink(at(root, MARKER)).catch(() => {});
}
