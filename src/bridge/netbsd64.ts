/**
 * NetBSD (ARM64) — the disk-image OS for the ARM64 machine.
 *
 * This OS is nothing like the Linux distros: those unpack their userland
 * into ZenFS `/` and the guest mounts it over 9p. NetBSD boots from a real
 * disk — a GPT image with one FFS partition (label `d86root`), built and
 * boot-tested by .github/workflows/build-netbsd64.yml from the official
 * NetBSD 11.0 release — so its files live INSIDE that image, not in the OS
 * filesystem, and the Files app cannot see them. That is the honest truth
 * of a foreign filesystem (FFS), and the App Store entry says so.
 *
 * Where the disk lives: the browser's private storage (OPFS), at
 * `dragon86-disks/netbsd64.img`. The emulator opens it as a browser disk
 * (`opfs:` url, disk_option "read_write") and writes the guest's changes
 * straight back into it through a sync access handle — which only exists
 * in workers, which is why the ARM64 machine runs with `cpu_worker: true`
 * (an ordinary dedicated worker; no cross-origin isolation anywhere).
 *
 * The install streams the split root.img.gz.NN parts through one gzip
 * decompressor straight into the OPFS file: the raw image never sits in
 * memory, not here and not while the machine runs.
 */

import { logInfo, logWarn } from "../core/log";
import { humanMB } from "../core/download";

export interface Netbsd64Manifest {
  os: string;
  version: string;
  arch: string;
  kernel: { file: string; gzBytes: number; rawBytes: number; sha256: string };
  root: {
    parts: { file: string; bytes: number; sha256: string }[];
    gzBytes: number;
    rawBytes: number;
    rawSha256: string;
    rootArg: string;
  };
}

export const NETBSD_BASE = `${import.meta.env.BASE_URL}netbsd64/`;

/** OPFS directory and file the machine's disk lives in. */
const OPFS_DIR = "dragon86-disks";
const DISK_FILE = "netbsd64.img";

/** The emulator's name for the disk (src/opfs_disk.js upstream). */
export const NETBSD_DISK_URL = `opfs:${OPFS_DIR}/${DISK_FILE}`;

let manifestPromise: Promise<Netbsd64Manifest> | null = null;

/** public/netbsd64/manifest.json — written by the build workflow. */
export function netbsd64Manifest(): Promise<Netbsd64Manifest> {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const res = await fetch(`${NETBSD_BASE}manifest.json`);
      if (!res.ok) {
        throw new Error(
          `NetBSD's manifest is not deployed (HTTP ${res.status} for netbsd64/manifest.json) — the build workflow has not produced it yet`,
        );
      }
      return (await res.json()) as Netbsd64Manifest;
    })();
    manifestPromise.catch(() => (manifestPromise = null));
  }
  return manifestPromise;
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  const storage = navigator?.storage;
  if (!storage?.getDirectory) {
    throw new Error("this browser has no private file storage (OPFS) — the ARM64 machine's disk needs it");
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
async function diskDir(create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await opfsRoot();
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
 * Both paths hold an exclusive lock, so a running ARM64 machine makes
 * this fail — the error says to close the Terminal first.
 */
async function openDiskWritable(handle: FileSystemFileHandle): Promise<WritableStream<Uint8Array>> {
  if (typeof handle.createWritable === "function") {
    try {
      return (await handle.createWritable()) as unknown as WritableStream<Uint8Array>;
    } catch (err) {
      throw diskLockHint(err);
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
    await call({ type: "open", dir: OPFS_DIR, file: DISK_FILE });
  } catch (err) {
    worker.terminate();
    throw diskLockHint(err);
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
function diskLockHint(err: unknown): Error {
  const name = (err as DOMException)?.name ?? "";
  const msg = (err as Error)?.message ?? String(err);
  if (name === "NoModificationAllowedError" || name === "InvalidStateError" || /lock|access handle/i.test(msg)) {
    return new Error(
      `the disk file is locked — if the ARM64 machine is running, close its Terminal first, then install again (${msg})`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

/** Size of the installed disk image in OPFS, or null when there is none. */
export async function netbsd64DiskSize(): Promise<number | null> {
  try {
    const dir = await diskDir(false);
    const file = await (await dir.getFileHandle(DISK_FILE)).getFile();
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
export async function netbsd64Installed(): Promise<boolean> {
  const size = await netbsd64DiskSize();
  if (size === null) return false;
  try {
    const man = await netbsd64Manifest();
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
export async function installNetbsd64(onStatus?: (text: string) => void): Promise<void> {
  const man = await netbsd64Manifest();
  const dir = await diskDir(true);
  const handle = await dir.getFileHandle(DISK_FILE, { create: true });
  const writable = await openDiskWritable(handle);
  const gunzip = new DecompressionStream("gzip");
  const pump = gunzip.readable.pipeTo(writable);
  const writer = gunzip.writable.getWriter();
  let got = 0;
  try {
    for (const part of man.root.parts) {
      const res = await fetch(new URL(part.file, NETBSD_BASE).href);
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
    await dir.removeEntry(DISK_FILE).catch(() => {});
    throw err;
  }
  const written = (await handle.getFile()).size;
  if (written !== man.root.rawBytes) {
    await dir.removeEntry(DISK_FILE).catch(() => {});
    throw new Error(
      `the unpacked disk is ${written} bytes, the manifest says ${man.root.rawBytes} — download corrupted, nothing was kept`,
    );
  }
  logInfo("netbsd64", `disk image installed in OPFS: ${humanMB(written)} raw (${humanMB(man.root.gzBytes)} downloaded)`);
}

/**
 * Delete the disk image — and with it everything saved inside NetBSD.
 * Fails honestly while the machine holds the disk open (the sync access
 * handle is exclusive): close the Terminal first.
 */
export async function uninstallNetbsd64(): Promise<void> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await diskDir(false);
  } catch {
    return; /* no disks folder — nothing to delete */
  }
  try {
    await dir.removeEntry(DISK_FILE);
  } catch (err) {
    if ((err as DOMException)?.name === "NotFoundError") return;
    throw new Error(
      "the disk image could not be deleted — if the ARM64 machine is running, close its Terminal (the disk is locked while it is open) and try again",
    );
  }
  /* The emulator keeps a small record beside the image (identity and
     generation, see upstream src/opfs_disk.js). Sweep the likely names. */
  for (const record of [`${DISK_FILE}.json`, DISK_FILE.replace(/\.img$/, ".json")]) {
    await dir.removeEntry(record).catch(() => {});
  }
  logInfo("netbsd64", "disk image removed from OPFS");
}

/** The kernel, decompressed — v64 boots it directly (Linux boot header). */
export async function netbsd64Kernel(): Promise<Uint8Array> {
  const man = await netbsd64Manifest();
  const res = await fetch(new URL(man.kernel.file, NETBSD_BASE).href);
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
