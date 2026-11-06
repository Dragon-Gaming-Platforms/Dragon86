/**
 * Export the filesystem — a downloadable snapshot of the ZenFS state.
 *
 * Walks `/` (the IndexedDB-backed system root, which includes /home and
 * everything an installed distro put there) and writes a standard
 * `.tar.gz`: plain ustar headers, GNU @LongLink entries for paths longer
 * than tar's 100-byte name field (an Arch tree is full of those), symlinks
 * kept as symlinks, permission bits kept as they are on disk. The result
 * opens with `tar -xzf`, 7-Zip, Finder — anything that reads tar.
 *
 * `/tmp` is skipped on purpose: it is the in-memory scratch mount and is
 * empty again on every reload — snapshotting it would be snapshotting air.
 *
 * Compression is the browser's native CompressionStream (gzip), streamed
 * entry by entry so the uncompressed tar never exists in memory whole.
 */

import { fs } from "@zenfs/core";

export interface ExportProgress {
  files: number;
  bytes: number;
  /** The entry being packed right now. */
  path: string;
}

export interface ExportResult {
  blob: Blob;
  files: number;
  bytes: number;
}

const enc = new TextEncoder();

/** Mounts never worth snapshotting (in-memory scratch). */
const SKIP = new Set(["/tmp"]);

/* ---------- tar writing ---------- */

function writeOctal(block: Uint8Array, at: number, len: number, value: number): void {
  /* len-1 octal digits, NUL terminated — the classic format. */
  const s = Math.max(0, Math.floor(value)).toString(8).padStart(len - 1, "0").slice(-(len - 1));
  block.set(enc.encode(s), at);
  block[at + len - 1] = 0;
}

function writeString(block: Uint8Array, at: number, len: number, value: string): void {
  const bytes = enc.encode(value);
  block.set(bytes.subarray(0, len), at);
}

interface TarEntryMeta {
  /** Path inside the archive — no leading slash, directories end in "/". */
  name: string;
  mode: number;
  size: number;
  mtimeSec: number;
  /** "0" file · "2" symlink · "5" directory · "L"/"K" GNU long name/link. */
  type: "0" | "2" | "5" | "L" | "K";
  link?: string;
}

function tarHeader(meta: TarEntryMeta): Uint8Array {
  const block = new Uint8Array(512);
  writeString(block, 0, 100, meta.name);
  writeOctal(block, 100, 8, meta.mode & 0o7777);
  writeOctal(block, 108, 8, 0); /* uid  — root, as a distro tree expects */
  writeOctal(block, 116, 8, 0); /* gid */
  writeOctal(block, 124, 12, meta.size);
  writeOctal(block, 136, 12, meta.mtimeSec);
  block[156] = meta.type.charCodeAt(0);
  if (meta.link) writeString(block, 157, 100, meta.link);
  writeString(block, 257, 6, "ustar");
  block[262] = 0;
  block[263] = 0x30; /* version "00" */
  block[264] = 0x30;
  writeString(block, 265, 32, "root");
  writeString(block, 297, 32, "root");
  /* checksum: computed over the header with the checksum field as spaces */
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of block) sum += b;
  const chk = sum.toString(8).padStart(6, "0");
  block.set(enc.encode(chk), 148);
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

function pad512(size: number): Uint8Array | null {
  const rem = size % 512;
  return rem === 0 ? null : new Uint8Array(512 - rem);
}

/** A GNU @LongLink entry carrying a name/link too long for the header. */
function longEntry(type: "L" | "K", value: string): Uint8Array[] {
  const data = enc.encode(`${value}\0`);
  const parts: Uint8Array[] = [
    tarHeader({ name: "././@LongLink", mode: 0o644, size: data.byteLength, mtimeSec: 0, type }),
    data,
  ];
  const pad = pad512(data.byteLength);
  if (pad) parts.push(pad);
  return parts;
}

function headersFor(meta: TarEntryMeta): Uint8Array[] {
  const parts: Uint8Array[] = [];
  if (enc.encode(meta.name).byteLength > 100) parts.push(...longEntry("L", meta.name));
  if (meta.link && enc.encode(meta.link).byteLength > 100) parts.push(...longEntry("K", meta.link));
  parts.push(tarHeader(meta));
  return parts;
}

/* ---------- the walk ---------- */

/** The slice of ZenFS Stats the export needs (number flavour, not bigint). */
interface StatsLike {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFile(): boolean;
  mode: number;
  mtimeMs: number;
}

async function* walk(dir: string): AsyncGenerator<{ path: string; stats: StatsLike }> {
  let names: string[];
  try {
    names = (await fs.promises.readdir(dir)) as string[];
  } catch {
    return;
  }
  names.sort();
  for (const name of names) {
    const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
    if (SKIP.has(path)) continue;
    let stats: StatsLike;
    try {
      stats = (await fs.promises.lstat(path)) as unknown as StatsLike;
    } catch {
      continue; /* raced with a deletion — the snapshot just moves on */
    }
    yield { path, stats };
    if (stats.isDirectory()) yield* walk(path);
  }
}

/* ---------- the export ---------- */

/**
 * Pack the whole ZenFS state (minus /tmp) into a gzipped tar and hand back
 * the Blob. Progress fires per entry, with real byte counts.
 */
export async function exportFsSnapshot(onProgress?: (p: ExportProgress) => void): Promise<ExportResult> {
  const gzip = new CompressionStream("gzip");
  const rawWriter = gzip.writable.getWriter();
  /* TS's BufferSource wants ArrayBuffer-backed views; every array here is
     one, the lib types are just stricter than the runtime. */
  const writer = { write: (b: Uint8Array) => rawWriter.write(b as unknown as BufferSource), close: () => rawWriter.close() };
  const chunks: Uint8Array[] = [];
  /* Drain the compressed side while the tar side is still being written —
     without this pump the pipe fills and write() deadlocks. */
  const drained = (async () => {
    const reader = gzip.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();

  let files = 0;
  let bytes = 0;
  for await (const { path, stats } of walk("/")) {
    const rel = path.slice(1); /* tar paths are relative */
    const mtimeSec = Math.max(0, Math.floor(stats.mtimeMs / 1000));
    if (stats.isDirectory()) {
      for (const part of headersFor({ name: `${rel}/`, mode: stats.mode, size: 0, mtimeSec, type: "5" })) {
        await writer.write(part);
      }
    } else if (stats.isSymbolicLink()) {
      let link: string;
      try {
        link = String(await fs.promises.readlink(path));
      } catch {
        continue;
      }
      for (const part of headersFor({ name: rel, mode: 0o777, size: 0, mtimeSec, type: "2", link })) {
        await writer.write(part);
      }
    } else if (stats.isFile()) {
      let data: Uint8Array;
      try {
        data = new Uint8Array(await fs.promises.readFile(path));
      } catch {
        continue;
      }
      for (const part of headersFor({ name: rel, mode: stats.mode, size: data.byteLength, mtimeSec, type: "0" })) {
        await writer.write(part);
      }
      await writer.write(data);
      const pad = pad512(data.byteLength);
      if (pad) await writer.write(pad);
      bytes += data.byteLength;
    } else {
      continue; /* nothing else lives in ZenFS */
    }
    files++;
    if (files % 50 === 0) onProgress?.({ files, bytes, path });
  }
  /* End-of-archive: two zero blocks. */
  await writer.write(new Uint8Array(1024));
  await writer.close();
  await drained;
  onProgress?.({ files, bytes, path: "" });
  return { blob: new Blob(chunks as BlobPart[], { type: "application/gzip" }), files, bytes };
}

/** Name the snapshot after the moment it was taken. */
export function snapshotFilename(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `dragon86-fs-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.tar.gz`;
}

/** Hand a Blob to the browser as a download. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  /* Give the click a tick to grab the URL before it goes away. */
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
