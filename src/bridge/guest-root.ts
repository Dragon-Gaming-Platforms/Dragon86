/**
 * The v86 guest's root filesystem, living in the OS filesystem.
 *
 * The guest boots a vendored Arch 32 kernel plus a small initramfs, and its
 * `/` is not a disk image: it is `/home/user/v86` in ZenFS, served to the
 * guest over 9p. So the whole distribution — `/bin/bash`, `/usr/bin/awk`,
 * `/etc/profile`, everything — is a normal file in Dragon86, visible in
 * Files, editable with the Text Editor, writable from inside the guest.
 *
 * Where the files come from: the initramfs (`public/v86/initrd.gz`) already
 * contains the hand-built userland (busybox + Arch bash + coreutils + glibc +
 * kernel modules). On first boot we unpack it once into ZenFS and boot from
 * that copy. The initramfs is still what the *kernel* is given — it has to be,
 * since it is what mounts the 9p root — but inside it the only thing that
 * matters is `/init`, which mounts our ZenFS root and switches to it.
 *
 * Why unpack instead of shipping a second copy of the files: one artifact to
 * keep correct, and the unpacked tree is exactly what the guest runs, so
 * editing a file in Files changes what the guest executes.
 */

import { fs } from "@zenfs/core";
import { logInfo, logWarn } from "../core/log";

const BASE = `${import.meta.env.BASE_URL}v86/`;

/**
 * Bump when the seeding rules change (not when the initramfs changes — that
 * is detected by size). Forces a re-seed on the next boot.
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
}

interface Marker {
  v: number;
  at: number;
  initrdBytes: number;
  files: number;
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
    return JSON.parse(await fs.promises.readFile(`${root}/${MARKER}`, "utf8")) as Marker;
  } catch {
    return null;
  }
}

/** Fetch a boot artifact from the app, unless ZenFS already has it. */
async function ensureArtifact(root: string, name: string, url: string): Promise<Uint8Array> {
  const path = `${root}/boot/${name}`;
  if (await exists(path)) {
    const data = new Uint8Array(await fs.promises.readFile(path));
    if (data.byteLength > 1024) return data;
  }
  /* `no-cache` = revalidate, not "don't cache": GitHub Pages answers 304
     when nothing changed (cheap) and fresh bytes when the image was
     rebuilt. Without this, a browser happily kept serving the previous
     initrd aloud — which is how a fixed guest can look unfixed. */
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  await ensureDir(`${root}/boot`);
  await fs.promises.writeFile(path, data);
  logInfo("guest", `${name} copied into the OS filesystem (${(data.byteLength / 1048576).toFixed(1)} MB)`);
  return data;
}

/**
 * Make sure `~/v86` is a bootable Arch root and hand back the kernel and
 * initramfs to boot it with. Cheap when it has already been done.
 */
export async function ensureGuestRoot(
  root: string,
  opts: { status?: (text: string) => void; force?: boolean } = {},
): Promise<GuestRoot> {
  const say = opts.status ?? (() => {});
  await ensureDir(root);
  await ensureDir(`${root}/boot`);

  const kernel = await ensureArtifact(root, "vmlinuz", `${BASE}bzImage`);
  const initrd = await ensureArtifact(root, "initrd.gz", `${BASE}initrd.gz`);

  const marker = await readMarker(root);
  const seeded = marker?.v === SEED_VERSION && marker.initrdBytes === initrd.byteLength;
  if (seeded && !opts.force && (await exists(`${root}/bin/bash`))) {
    logInfo("guest", `running the distro already in the OS filesystem (${marker?.files ?? "?"} files)`);
    await repairModes(root);
    return { root, kernel, initrd, reused: true };
  }

  say("unpacking the distro into your filesystem (one time)…");
  const started = Date.now();
  const raw = await gunzip(initrd);
  const entries = parseCpio(raw);
  if (entries.length === 0) throw new Error("the initramfs did not unpack — no cpio entries found");

  /* Directories first: a file cannot be created before its parent exists. */
  const dirs = entries.filter((e) => (e.mode & 0o170000) === 0o040000);
  const rest = entries.filter((e) => (e.mode & 0o170000) !== 0o040000);
  for (const d of dirs) await ensureDir(`${root}/${d.name}`);

  let files = 0;
  let bytes = 0;
  let noMode = 0;
  for (const e of rest) {
    const target = `${root}/${e.name}`;
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
    await ensureDir(`${root}/${dir}`);
  }

  /* The initramfs keeps everything in /usr/bin and has bare /bin, /sbin and
     /lib directories. A normal Arch root has those as symlinks, and plenty of
     scripts (and kernel module loading) assume /bin/sh and /lib/modules
     resolve — so make them symlinks, but only while the directories are
     empty, so a guest that has since put files there is left alone. */
  for (const [link, target] of [["bin", "usr/bin"], ["sbin", "usr/bin"], ["lib", "usr/lib"]] as const) {
    const path = `${root}/${link}`;
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
    `${root}/${MARKER}`,
    JSON.stringify({ v: SEED_VERSION, at: Date.now(), initrdBytes: initrd.byteLength, files } satisfies Marker),
  );

  say(
    `distro unpacked: ${files} files, ${(bytes / 1048576).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  logInfo("guest", `guest root ready at ${root}: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
  return { root, kernel, initrd, reused: false };
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
  const must = [`${root}/usr/bin/bash`, `${root}/usr/bin/setsid`, `${root}/usr/bin/ls`];
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

/** Drop the marker so the next boot re-unpacks over the existing tree. */
export async function resetGuestRoot(root: string): Promise<void> {
  await fs.promises.unlink(`${root}/${MARKER}`).catch(() => {});
}
