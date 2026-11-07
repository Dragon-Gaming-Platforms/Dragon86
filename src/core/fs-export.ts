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
/* The .ts extension keeps this module loadable by Node's strip-types test
   runner too (tools/test-fs-import.mjs) — Vite and tsc both accept it. */
import { logWarn } from "./log.ts";

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

/* ====================================================================== */
/* Import — the other direction: restore a snapshot .tar.gz into ZenFS.  */
/* ====================================================================== */

export interface ImportResult {
  files: number;
  bytes: number;
  /** Entries the import refused or could not place (with the reason logged). */
  skipped: number;
}

/**
 * Reads exact byte counts out of a ReadableStream without ever holding
 * more than one file's worth of data — a distro snapshot decompresses to
 * hundreds of MB, and "gunzip it all, then parse" would double that.
 */
class ByteReader {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private done = false;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  /** Exactly `n` bytes, or null at a clean end-of-stream (0 bytes left). */
  async take(n: number): Promise<Uint8Array | null> {
    while (this.buffered < n && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) this.done = true;
      else if (value.byteLength) {
        this.chunks.push(value);
        this.buffered += value.byteLength;
      }
    }
    if (this.buffered === 0 && this.done) return null;
    if (this.buffered < n) throw new Error(`archive ends mid-entry (${this.buffered} of ${n} bytes)`);
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const head = this.chunks[0];
      const want = n - off;
      if (head.byteLength <= want) {
        out.set(head, off);
        off += head.byteLength;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, want), off);
        this.chunks[0] = head.subarray(want);
        off += want;
      }
    }
    this.buffered -= n;
    return out;
  }
}

const dec = new TextDecoder();

function cstr(block: Uint8Array, at: number, len: number): string {
  const slice = block.subarray(at, at + len);
  const nul = slice.indexOf(0);
  return dec.decode(nul === -1 ? slice : slice.subarray(0, nul));
}

function octalField(block: Uint8Array, at: number, len: number): number {
  const s = cstr(block, at, len).trim();
  return s ? parseInt(s, 8) || 0 : 0;
}

/** pax extended header payload: a series of "LEN key=value\n" records. */
function parsePax(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let off = 0;
  while (off < data.byteLength) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const len = Number(dec.decode(data.subarray(off, sp)));
    if (!Number.isFinite(len) || len <= 0) break;
    const record = dec.decode(data.subarray(sp + 1, off + len - 1)); /* strip \n */
    const eq = record.indexOf("=");
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    off += len;
  }
  return out;
}

/**
 * "etc/../usr" must not climb out of the tree, and tar's various path
 * spellings all normalise to one absolute ZenFS path. Null = refuse.
 */
function importTarget(rawName: string): string | null {
  const parts: string[] = [];
  for (const part of rawName.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  if (!parts.length) return null;
  if (parts[0] === "tmp") return null; /* in-memory scratch — never imported */
  return `/${parts.join("/")}`;
}

/**
 * Restore a snapshot into ZenFS: every entry in the archive is written
 * over the current filesystem (same-path files replaced, everything else
 * left alone). Takes the .tar.gz the export produces, but also plain
 * .tar, GNU-format and pax/POSIX-format archives made by real tar —
 * long names via ustar prefix, GNU @LongLink and pax path= all work.
 */
export async function importFsSnapshot(blob: Blob, onProgress?: (p: ExportProgress) => void): Promise<ImportResult> {
  /* gzip or bare tar? The magic bytes say. */
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gzipped = head.byteLength === 2 && head[0] === 0x1f && head[1] === 0x8b;
  const stream = gzipped
    ? blob.stream().pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
    : blob.stream();
  const r = new ByteReader(stream.getReader() as ReadableStreamDefaultReader<Uint8Array>);

  /* Each directory is created exactly once, parents strictly first —
     memoised promises instead of racing concurrent mkdir -p calls. */
  const dirMade = new Map<string, Promise<void>>();
  const ensureDirOnce = (path: string): Promise<void> => {
    if (path === "/" || path === "") return Promise.resolve();
    let p = dirMade.get(path);
    if (!p) {
      p = (async () => {
        await ensureDirOnce(path.slice(0, path.lastIndexOf("/")));
        await fs.promises.mkdir(path).catch((err: { code?: string }) => {
          if (err?.code !== "EEXIST") throw err;
        });
      })();
      dirMade.set(path, p);
    }
    return p;
  };

  /* Writes overlap (IndexedDB round-trips dominate), bounded in flight. */
  const inFlight = new Set<Promise<void>>();
  const schedule = async (work: () => Promise<void>) => {
    const p = work().finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (inFlight.size >= 16) await Promise.race(inFlight);
  };

  let files = 0;
  let bytes = 0;
  let skipped = 0;
  /* State fed by GNU @LongLink / pax entries into the NEXT real header. */
  let pendingName: string | null = null;
  let pendingLink: string | null = null;
  let zeroBlocks = 0;
  let sawEntry = false;

  for (;;) {
    const block = await r.take(512);
    if (block === null) break;
    if (block.every((b) => b === 0)) {
      if (++zeroBlocks >= 2) break;
      continue;
    }
    zeroBlocks = 0;
    const size = octalField(block, 124, 12);
    const padded = Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(block[156] || 0x30);
    const readData = async () => {
      const data = size > 0 ? await r.take(padded) : new Uint8Array(0);
      if (!data && size > 0) throw new Error("archive ends mid-file");
      return (data ?? new Uint8Array(0)).subarray(0, size);
    };

    /* Metadata entries that describe the next real one. */
    if (type === "L") {
      pendingName = dec.decode(await readData()).replace(/\0+$/, "");
      continue;
    }
    if (type === "K") {
      pendingLink = dec.decode(await readData()).replace(/\0+$/, "");
      continue;
    }
    if (type === "x") {
      const pax = parsePax(await readData());
      pendingName = pax.get("path") ?? pendingName;
      pendingLink = pax.get("linkpath") ?? pendingLink;
      continue;
    }
    if (type === "g") {
      await readData(); /* global pax defaults — nothing we honour */
      continue;
    }

    const prefix = cstr(block, 345, 155);
    let name = pendingName ?? (prefix ? `${prefix}/${cstr(block, 0, 100)}` : cstr(block, 0, 100));
    let link = pendingLink ?? cstr(block, 157, 100);
    pendingName = null;
    pendingLink = null;
    const mode = octalField(block, 100, 8) & 0o7777;
    const mtimeSec = octalField(block, 136, 12);
    sawEntry = true;

    const target = importTarget(name);
    if (!target) {
      if (size > 0) await readData();
      const parts = name.split("/").filter((p) => p !== "" && p !== ".");
      if (parts.length === 0) continue; /* the archive's "./" root — / already exists */
      if (parts[0] !== "tmp") logWarn("os", `import: refused path "${name}"`); /* tmp/ is skipped silently by design */
      skipped++;
      continue;
    }

    if (type === "5" || name.endsWith("/")) {
      await ensureDirOnce(target);
      await fs.promises.chmod(target, mode || 0o755).catch(() => {});
      files++;
    } else if (type === "2") {
      await ensureDirOnce(target.slice(0, target.lastIndexOf("/")));
      await schedule(async () => {
        await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
        await fs.promises.symlink(link, target);
      });
      files++;
    } else if (type === "1") {
      /* Hardlink: tar guarantees the source came earlier — settle the
         queue, then copy its bytes. */
      await Promise.all([...inFlight]);
      const srcPath = importTarget(link);
      try {
        if (!srcPath) throw new Error("bad link target");
        const data = new Uint8Array(await fs.promises.readFile(srcPath));
        await ensureDirOnce(target.slice(0, target.lastIndexOf("/")));
        await fs.promises.writeFile(target, data);
        await fs.promises.chmod(target, mode || 0o644).catch(() => {});
        bytes += data.byteLength;
        files++;
      } catch {
        logWarn("os", `import: skipped hardlink ${name} → ${link}`);
        skipped++;
      }
    } else if (type === "0" || type === "7") { /* "7" = contiguous, same as a plain file */
      const data = await readData();
      const copy = new Uint8Array(data); /* readData's view aliases the taken block */
      await ensureDirOnce(target.slice(0, target.lastIndexOf("/")));
      await schedule(async () => {
        await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
        await fs.promises.writeFile(target, copy);
        await fs.promises.chmod(target, mode || 0o644).catch(() => {});
        await fs.promises.utimes(target, mtimeSec, mtimeSec).catch(() => {});
      });
      bytes += copy.byteLength;
      files++;
    } else {
      /* character/block devices, fifos — nothing ZenFS can hold */
      if (size > 0) await readData();
      logWarn("os", `import: skipped unsupported entry type "${type}" for ${name}`);
      skipped++;
      continue;
    }
    if (files % 50 === 0) onProgress?.({ files, bytes, path: target });
  }

  await Promise.all([...inFlight]);
  if (!sawEntry) throw new Error("that file is not a tar archive (no entries found)");
  onProgress?.({ files, bytes, path: "" });
  return { files, bytes, skipped };
}
