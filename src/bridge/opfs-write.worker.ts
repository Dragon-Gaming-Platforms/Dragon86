/**
 * OPFS writer worker — the fallback install path for browsers whose
 * FileSystemFileHandle has no createWritable() (Safari before 18.4).
 * Sync access handles exist in every browser that has OPFS at all, but
 * only inside workers — the same reason the ARM64 machine itself runs
 * its CPU in a worker. The main thread streams chunks here; each one is
 * acknowledged, so backpressure works and memory stays at chunk size.
 */

/* Minimal typings: tsconfig compiles this file with the DOM lib, which
   leaves out the worker-only OPFS surface. */
interface SyncAccessHandle {
  write(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}
interface FileHandleWithSync extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
}

type WriterRequest =
  | { id: number; type: "open"; dir: string; file: string }
  | { id: number; type: "write"; buf: ArrayBuffer }
  | { id: number; type: "close" }
  | { id: number; type: "abort" };

let handle: SyncAccessHandle | null = null;
let offset = 0;

self.onmessage = async (e: MessageEvent<WriterRequest>) => {
  const m = e.data;
  try {
    if (m.type === "open") {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(m.dir, { create: true });
      const fh = (await dir.getFileHandle(m.file, { create: true })) as FileHandleWithSync;
      handle = await fh.createSyncAccessHandle();
      handle.truncate(0);
      offset = 0;
    } else if (m.type === "write") {
      if (!handle) throw new Error("write before open");
      const bytes = new Uint8Array(m.buf);
      let done = 0;
      while (done < bytes.byteLength) {
        done += handle.write(done ? bytes.subarray(done) : bytes, { at: offset + done });
      }
      offset += bytes.byteLength;
    } else if (m.type === "close") {
      if (handle) {
        handle.flush();
        handle.close();
        handle = null;
      }
    } else if (m.type === "abort") {
      /* Close without flushing pretenses — the caller deletes the file. */
      try {
        handle?.close();
      } catch {
        /* already broken */
      }
      handle = null;
    }
    (self as unknown as Worker).postMessage({ id: m.id, ok: true });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: m.id, ok: false, error: (err as Error)?.message ?? String(err) });
  }
};
