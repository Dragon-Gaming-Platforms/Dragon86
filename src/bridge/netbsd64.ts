/**
 * The disk-image OSes for the ARM machines. (The file keeps its first
 * name, netbsd64 — NetBSD on ARM64 was the one of these that existed
 * when it was written.)
 *
 *   arm64 → NetBSD 11.0 evbarm-aarch64, public/netbsd64/
 *           (built by .github/workflows/build-netbsd64.yml)
 *   arm32 → Alpine Linux armv7, public/alpine32/
 *           (built by .github/workflows/build-alpine32.yml; NetBSD cannot
 *           run here — v64's 32-bit virt board is GICv3-only and
 *           NetBSD/armv7 only drives GICv2, found the hard way with
 *           tools/vm/boot-arm.mjs)
 *
 * These OSes are nothing like the Linux distros in /: those unpack their
 * userland into ZenFS `/` and the guest mounts it over 9p. A disk-image
 * OS boots from a real disk image, built and boot-tested by its workflow
 * from official release artifacts — its files live INSIDE that image, in
 * its own filesystem (FFS / ext4), and the Files app cannot see them.
 * That is the honest truth of a foreign filesystem, and the App Store
 * entries say so.
 *
 * Where the disk lives: the browser's private storage (OPFS), at
 * `dragon86-disks/netbsd64.img` (or alpine32.img). The emulator opens it
 * as a browser disk (`opfs:` url, disk_option "read_write") and writes the
 * guest's changes straight back into it through a sync access handle —
 * which only exists in workers, which is why the ARM machines run with
 * `cpu_worker: true` (an ordinary dedicated worker; no cross-origin
 * isolation anywhere).
 *
 * The install streams the split root.img.gz.NN parts through one gzip
 * decompressor straight into the OPFS file: the raw image never sits in
 * memory, not here and not while the machine runs.
 */

import { logInfo, logWarn } from "../core/log";
import { humanMB } from "../core/download";

/** The two architectures NetBSD ships for. A subset of MachineArch. */
export type NetbsdArch = "arm64" | "arm32";

export interface NetbsdManifest {
  os: string;
  version: string;
  arch: string;
  kernel: { file: string; gzBytes: number; rawBytes: number; sha256: string };
  /** Alpine only: the initramfs, shipped byte for byte (a compressed cpio
      the kernel inflates itself — fetched whole, passed whole). */
  initrd?: { file: string; bytes: number; sha256: string };
  root: {
    parts: { file: string; bytes: number; sha256: string }[];
    gzBytes: number;
    rawBytes: number;
    rawSha256: string;
    rootArg: string;
    /** Extra kernel arguments after root= (Alpine: rw, rootfstype, console). */
    extraCmdline?: string;
  };
}

/** OPFS directory both machines' disks live in. */
const OPFS_DIR = "dragon86-disks";

interface Target {
  /** public/<dir>/ — where the build workflow put the pack. */
  dir: string;
  /** The disk image's file name inside dragon86-disks/. */
  disk: string;
  /** The machine's name in user-facing messages. */
  label: string;
  /** The OS name in user-facing messages (what the App Store entry is called). */
  os: string;
  /** Disk files earlier builds of this target used — swept on install and
      uninstall, so an abandoned image does not sit invisibly in OPFS. */
  legacy: string[];
}

const TARGETS: Record<NetbsdArch, Target> = {
  arm64: { dir: "netbsd64", disk: "netbsd64.img", label: "ARM64", os: "NetBSD (ARM64)", legacy: [] },
  /* netbsd32.img: the short-lived NetBSD (ARM32) build (PR #89) that v64's
     GICv3-only board can never boot — delete it when found. */
  arm32: { dir: "alpine32", disk: "alpine32.img", label: "ARM32", os: "Alpine Linux (ARM32)", legacy: ["netbsd32.img", "netbsd32.json"] },
};

/** The OS an arch's App Store entry installs — for user-facing messages. */
export function netbsdOsLabel(arch: NetbsdArch): string {
  return TARGETS[arch].os;
}

export function netbsdBase(arch: NetbsdArch): string {
  return `${import.meta.env.BASE_URL}${TARGETS[arch].dir}/`;
}

/** The emulator's name for the disk (src/opfs_disk.js upstream). */
export function netbsdDiskUrl(arch: NetbsdArch): string {
  return `opfs:${OPFS_DIR}/${TARGETS[arch].disk}`;
}

/** The machine's name in user-facing copy ("ARM64" / "ARM32"). */
export function netbsdMachineLabel(arch: NetbsdArch): string {
  return TARGETS[arch].label;
}

const manifestPromises = new Map<NetbsdArch, Promise<NetbsdManifest>>();

/** public/<dir>/manifest.json — written by the build workflow. */
export function netbsdManifest(arch: NetbsdArch): Promise<NetbsdManifest> {
  let p = manifestPromises.get(arch);
  if (!p) {
    p = (async () => {
      const res = await fetch(`${netbsdBase(arch)}manifest.json`);
      if (!res.ok) {
        throw new Error(
          `NetBSD's manifest is not deployed (HTTP ${res.status} for ${TARGETS[arch].dir}/manifest.json) — the build workflow has not produced it yet`,
        );
      }
      return (await res.json()) as NetbsdManifest;
    })();
    p.catch(() => manifestPromises.delete(arch));
    manifestPromises.set(arch, p);
  }
  return p;
}

async function opfsRoot(arch: NetbsdArch): Promise<FileSystemDirectoryHandle> {
  const storage = navigator?.storage;
  if (!storage?.getDirectory) {
    throw new Error(
      `this browser has no private file storage (OPFS) — the ${TARGETS[arch].label} machine's disk needs it`,
    );
  }
  try {
    return await storage.getDirectory();
  } catch (err) {
    /* Keep the browser's own reason — "denied" has many distinct causes
       (private browsing, storage pressure, a managed profile) and hiding
       it behind one guess helps nobody. */
    throw new Error(`the browser refused its private file storage (OPFS): ${(err as Error)?.message ?? err}`);
  }
}

/** The disks folder in OPFS. Throws with the browser's reason; `probe`
    callers that only want "is there a disk?" catch it themselves. */
async function diskDir(arch: NetbsdArch, create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await opfsRoot(arch);
  try {
    return await root.getDirectoryHandle(OPFS_DIR, { create });
  } catch (err) {
    throw new Error(`could not open the ${OPFS_DIR}/ folder in browser storage: ${(err as Error)?.message ?? err}`);
  }
}

/**
 * A WritableStream into the disk file. Two ways, same stream either way:
 *  - createWritable() where the browser has it — writes go to a swap file
 *    that is committed on close.
 *  - Safari before 18.4 has OPFS but no createWritable(); there the bytes
 *    go through a small worker holding a sync access handle (worker-only
 *    API, same one the running machine uses). Each chunk is acknowledged,
 *    so pipeTo() backpressure still works.
 * Both paths hold an exclusive lock, so a running ARM machine makes
 * this fail — the error says to close the Terminal first.
 */
async function openDiskWritable(arch: NetbsdArch, handle: FileSystemFileHandle): Promise<WritableStream<Uint8Array>> {
  if (typeof handle.createWritable === "function") {
    try {
      return (await handle.createWritable()) as unknown as WritableStream<Uint8Array>;
    } catch (err) {
      throw diskLockHint(arch, err);
    }
  }
  /* Safari ≤ 18.3: worker + sync access handle. */
  logInfo("netbsd64", "no createWritable() in this browser — writing the disk through a worker sync access handle");
  const worker = new Worker(new URL("./opfs-write.worker.ts", import.meta.url), { type: "module" });
  let nextId = 0;
  const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve();
    else p.reject(new Error(e.data.error ?? "OPFS worker write failed"));
  };
  worker.onerror = (e) => {
    const err = new Error(`OPFS worker failed: ${e.message || "unknown error"}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  const call = (msg: Record<string, unknown>, transfer: Transferable[] = []) =>
    new Promise<void>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id }, transfer);
    });
  try {
    await call({ type: "open", dir: OPFS_DIR, file: TARGETS[arch].disk });
  } catch (err) {
    worker.terminate();
    throw diskLockHint(arch, err);
  }
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      /* The chunk is copied into its own transferable buffer: gzip reuses
         its output buffer, and a view into it must not be detached. */
      const buf = chunk.slice().buffer as ArrayBuffer;
      await call({ type: "write", buf }, [buf]);
    },
    async close() {
      await call({ type: "close" });
      worker.terminate();
    },
    async abort() {
      await call({ type: "abort" }).catch(() => {});
      worker.terminate();
    },
  });
}

/** Lock failures get actionable advice; everything else passes through. */
function diskLockHint(arch: NetbsdArch, err: unknown): Error {
  const name = (err as DOMException)?.name ?? "";
  const msg = (err as Error)?.message ?? String(err);
  if (name === "NoModificationAllowedError" || name === "InvalidStateError" || /lock|access handle/i.test(msg)) {
    return new Error(
      `the disk file is locked — if the ${TARGETS[arch].label} machine is running, close its Terminal first, then install again (${msg})`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

/** Size of the installed disk image in OPFS, or null when there is none. */
export async function netbsdDiskSize(arch: NetbsdArch): Promise<number | null> {
  try {
    const dir = await diskDir(arch, false);
    const file = await (await dir.getFileHandle(TARGETS[arch].disk)).getFile();
    return file.size;
  } catch {
    return null;
  }
}

/**
 * Installed = the image exists and is exactly the size the manifest says.
 * A partial download (a closed tab mid-install) fails this test and the
 * store offers Install again, which re-downloads — honest and safe, since
 * a half-written image must never boot.
 */
export async function netbsdInstalled(arch: NetbsdArch): Promise<boolean> {
  const size = await netbsdDiskSize(arch);
  if (size === null) return false;
  try {
    const man = await netbsdManifest(arch);
    return size === man.root.rawBytes;
  } catch {
    /* Manifest unreachable (offline?) — a full-looking image counts. */
    return size > 0;
  }
}

/**
 * Download the split, gzipped root image and stream it into OPFS.
 * Sequential parts → one DecompressionStream → the OPFS writable; memory
 * stays at stream-chunk size the whole way.
 */
export async function installNetbsd(arch: NetbsdArch, onStatus?: (text: string) => void): Promise<void> {
  const man = await netbsdManifest(arch);
  const dir = await diskDir(arch, true);
  await sweepLegacy(arch, dir);
  const handle = await dir.getFileHandle(TARGETS[arch].disk, { create: true });
  const writable = await openDiskWritable(arch, handle);
  const gunzip = new DecompressionStream("gzip");
  const pump = gunzip.readable.pipeTo(writable);
  const writer = gunzip.writable.getWriter();
  let got = 0;
  try {
    for (const part of man.root.parts) {
      const res = await fetch(new URL(part.file, netbsdBase(arch)).href);
      if (!res.ok || !res.body) {
        throw new Error(`${part.file}: HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.byteLength;
        await writer.write(value);
        onStatus?.(`downloading the NetBSD disk — ${humanMB(got)} of ${humanMB(man.root.gzBytes)}`);
      }
    }
    onStatus?.("finishing the disk image");
    await writer.close();
    await pump;
  } catch (err) {
    try {
      await writer.abort((err as Error).message);
    } catch {
      /* the pipe already failed */
    }
    await dir.removeEntry(TARGETS[arch].disk).catch(() => {});
    throw err;
  }
  const written = (await handle.getFile()).size;
  if (written !== man.root.rawBytes) {
    await dir.removeEntry(TARGETS[arch].disk).catch(() => {});
    throw new Error(
      `the unpacked disk is ${written} bytes, the manifest says ${man.root.rawBytes} — download corrupted, nothing was kept`,
    );
  }
  logInfo("netbsd64", `${arch} disk image installed in OPFS: ${humanMB(written)} raw (${humanMB(man.root.gzBytes)} downloaded)`);
}

/**
 * Delete the disk image — and with it everything saved inside NetBSD.
 * Fails honestly while the machine holds the disk open (the sync access
 * handle is exclusive): close the Terminal first.
 */
export async function uninstallNetbsd(arch: NetbsdArch): Promise<void> {
  const diskFile = TARGETS[arch].disk;
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await diskDir(arch, false);
  } catch {
    return; /* no disks folder — nothing to delete */
  }
  try {
    await dir.removeEntry(diskFile);
  } catch (err) {
    if ((err as DOMException)?.name === "NotFoundError") return;
    throw new Error(
      `the disk image could not be deleted — if the ${TARGETS[arch].label} machine is running, close its Terminal (the disk is locked while it is open) and try again`,
    );
  }
  /* The emulator keeps a small record beside the image (identity and
     generation, see upstream src/opfs_disk.js). Sweep the likely names. */
  for (const record of [`${diskFile}.json`, diskFile.replace(/\.img$/, ".json")]) {
    await dir.removeEntry(record).catch(() => {});
  }
  await sweepLegacy(arch, dir);
  logInfo("netbsd64", `${arch} disk image removed from OPFS`);
}

/** Delete disk files earlier builds of this target left behind — best
    effort (a locked or missing file is fine), but logged when found. */
async function sweepLegacy(arch: NetbsdArch, dir: FileSystemDirectoryHandle): Promise<void> {
  for (const name of TARGETS[arch].legacy) {
    try {
      await dir.removeEntry(name);
      logInfo("netbsd64", `removed the abandoned ${name} from browser storage`);
    } catch {
      /* not there (the common case) or locked — nothing to do */
    }
  }
}

/** The initramfs, when the pack has one — fetched whole, passed whole:
    it is a compressed cpio and the KERNEL inflates it, not us. */
export async function netbsdInitrd(arch: NetbsdArch): Promise<Uint8Array | null> {
  const man = await netbsdManifest(arch);
  if (!man.initrd) return null;
  const res = await fetch(new URL(man.initrd.file, netbsdBase(arch)).href);
  if (!res.ok) throw new Error(`${man.initrd.file}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength !== man.initrd.bytes) {
    throw new Error(`${man.initrd.file} is ${bytes.byteLength} bytes, the manifest says ${man.initrd.bytes}`);
  }
  return bytes;
}

/** The kernel, decompressed — v64 boots it directly (Linux boot header). */
export async function netbsdKernel(arch: NetbsdArch): Promise<Uint8Array> {
  const man = await netbsdManifest(arch);
  const res = await fetch(new URL(man.kernel.file, netbsdBase(arch)).href);
  if (!res.ok) throw new Error(`${man.kernel.file}: HTTP ${res.status}`);
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!DS) throw new Error("this browser has no DecompressionStream");
  const stream = (await res.blob()).stream().pipeThrough(new DS("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  if (bytes.byteLength !== man.kernel.rawBytes) {
    logWarn("netbsd64", `kernel is ${bytes.byteLength} bytes, manifest says ${man.kernel.rawBytes}`);
  }
  return bytes;
}
