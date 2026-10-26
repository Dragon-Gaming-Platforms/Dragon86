/**
 * Archives — reading .zip, .tar and .gz without a library.
 *
 * The browser already knows how to decompress: `DecompressionStream` is the
 * same code path the platform uses for `Content-Encoding: gzip`. So the only
 * work here is the *containers* — where a zip records its file names, how a
 * tar packs its blocks, what a gzip header looks like — and that is a few
 * hundred lines of offsets, not a dependency.
 *
 * This module is deliberately free of DOM and of the filesystem: it takes
 * bytes, gives back entries and bytes. `core/archive-fs.ts` is what writes
 * them into ZenFS. That split is what makes it testable in Node
 * (tools/test-archive.mjs) against archives built by real tools.
 */

export type ArchiveKind = "zip" | "tar" | "gzip";

export interface ArchiveEntry {
  /** Path inside the archive, with no leading slash. Directories end in "/". */
  path: string;
  isDirectory: boolean;
  /** Uncompressed size in bytes (0 for directories, or when the archive lies). */
  size: number;
  /** Where the bytes are, for readEntry(). */
  headerOffset: number;
  /** Zip only: 0 = stored, 8 = deflate. Tar and gzip are always 0 here. */
  method: number;
  /** Bytes this entry occupies in the container (its compressed length). */
  compressedSize: number;
  /** True when the entry came out of a compressed container (deflate/gzip). */
  compressed: boolean;
}

export class ArchiveError extends Error {}

/**
 * An archive that has been unwrapped far enough to read: a zip, a tar, or a
 * .gz. A `.tar.gz` is gunzipped once here and then parsed as a tar, so the
 * bytes every entry points into are `bytes` — not the file on disk.
 */
export interface OpenedArchive {
  /** What the entries are indexed against. */
  container: "zip" | "tar" | "gzip";
  /** The bytes entry offsets refer to (the decompressed tar, for a .tar.gz). */
  bytes: Uint8Array;
  /** True when the file itself was gzip-compressed. */
  gzipped: boolean;
  entries: ArchiveEntry[];
  /** A plain .gz holds one file and no index: this is that file's content. */
  single?: Uint8Array;
}

/* ---------- what kind of file is this? ---------- */

/**
 * `photos.zip` → "zip", `backup.tar.gz` → "gzip" (the tar inside is detected
 * after decompressing), `notes.gz` → "gzip". Anything else → null.
 */
export function detectArchiveKind(name: string): ArchiveKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar")) return "tar";
  if (/\.(gz|gzip|tgz)$/.test(lower)) return "gzip";
  return null;
}

/** True for a name this module can open. Used by Files and the viewer. */
export function isArchiveName(name: string): boolean {
  return detectArchiveKind(name) !== null;
}

/** `backup.tar.gz` → `backup`; `photos.zip` → `photos`. */
export function archiveBaseName(name: string): string {
  return name
    .replace(/\.(zip|tar|tgz|gzip|gz)$/i, "")
    .replace(/\.tar$/i, "")
    .replace(/^\s+|\s+$/g, "");
}

/* ---------- byte helpers ---------- */

function need(bytes: Uint8Array, at: number, len: number, what: string): void {
  if (at < 0 || at + len > bytes.length) {
    throw new ArchiveError(`${what}: the archive ends early (needs ${len} bytes at ${at})`);
  }
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

function u64(bytes: Uint8Array, at: number): number {
  const lo = u32(bytes, at);
  const hi = u32(bytes, at + 4);
  return hi * 0x100000000 + lo;
}

const utf8 = new TextDecoder("utf-8");
const latin1 = new TextDecoder("latin1");

/** Zip names are UTF-8 when the flag says so, CP437 otherwise (we fall back to latin1). */
function zipName(bytes: Uint8Array): string {
  const text = utf8.decode(bytes);
  /* A name that decodes to replacement characters was not UTF-8. */
  return text.includes("\uFFFD") ? latin1.decode(bytes) : text;
}

/**
 * Decompress with the platform's own codec. `deflate-raw` is a bare DEFLATE
 * stream (a zip entry); `gzip` is a gzip member (a .gz file).
 */
export async function decompress(data: Uint8Array, format: "deflate-raw" | "gzip"): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new ArchiveError(
      "this browser has no DecompressionStream, so archives cannot be unpacked here",
    );
  }
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  try {
    const out = await new Response(stream).arrayBuffer();
    return new Uint8Array(out);
  } catch (err) {
    throw new ArchiveError(
      `could not decompress ${format === "gzip" ? "gzip" : "deflate"} data: ${(err as Error).message}`,
    );
  }
}

/* ---------- zip ---------- */

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const ZIP_EOCD64 = 0x06064b50;
const ZIP_EOCD64_LOCATOR = 0x07064b50;

interface ZipDir {
  count: number;
  offset: number;
}

/** Find the end-of-central-directory record, which is the way in. */
function findEocd(bytes: Uint8Array): number {
  /* The record is 22 bytes plus a comment of up to 64 KB, so it is near the
     end — but scan back rather than assume it is exactly last. */
  const stop = Math.max(0, bytes.length - 66_000);
  for (let at = bytes.length - 22; at >= stop; at--) {
    if (u32(bytes, at) === ZIP_EOCD) return at;
  }
  throw new ArchiveError("not a zip file: no end-of-central-directory record");
}

function readZipDirectory(bytes: Uint8Array): ZipDir {
  const eocd = findEocd(bytes);
  need(bytes, eocd, 22, "zip end of central directory");
  let count = u16(bytes, eocd + 10);
  let offset = u32(bytes, eocd + 16);

  /* zip64: when a field does not fit, it is 0xFFFF/0xFFFFFFFF and the real
     value lives in the zip64 record the locator points at. */
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && u32(bytes, locator) === ZIP_EOCD64_LOCATOR) {
      const at = u64(bytes, locator + 8);
      need(bytes, at, 56, "zip64 end of central directory");
      if (u32(bytes, at) === ZIP_EOCD64) {
        count = u64(bytes, at + 32);
        offset = u64(bytes, at + 48);
      }
    }
  }
  return { count, offset };
}

function parseZip(bytes: Uint8Array): ArchiveEntry[] {
  const dir = readZipDirectory(bytes);
  const entries: ArchiveEntry[] = [];
  let at = dir.offset;

  for (let n = 0; n < dir.count; n++) {
    need(bytes, at, 46, "zip central directory entry");
    if (u32(bytes, at) !== ZIP_CENTRAL) {
      throw new ArchiveError(`zip central directory is damaged at entry ${n + 1}`);
    }
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const compressedSize = u32(bytes, at + 20);
    const size = u32(bytes, at + 24);
    const nameLen = u16(bytes, at + 28);
    const extraLen = u16(bytes, at + 30);
    const commentLen = u16(bytes, at + 32);
    const localOffset = u32(bytes, at + 42);
    need(bytes, at + 46, nameLen, "zip file name");
    const name = zipName(bytes.subarray(at + 46, at + 46 + nameLen));

    if (flags & 1) {
      throw new ArchiveError(`"${name}" is encrypted — Dragon86 cannot open password-protected zips`);
    }
    if (method !== 0 && method !== 8) {
      throw new ArchiveError(`"${name}" uses compression method ${method}; only stored and deflate are supported`);
    }

    /* zip64 sizes live in the extra field (0x0001). */
    let realSize = size;
    let realCompressed = compressedSize;
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let extra = at + 46 + nameLen;
      const end = extra + extraLen;
      while (extra + 4 <= end) {
        const id = u16(bytes, extra);
        const len = u16(bytes, extra + 2);
        if (id === 0x0001) {
          let field = extra + 4;
          if (size === 0xffffffff) {
            realSize = u64(bytes, field);
            field += 8;
          }
          if (compressedSize === 0xffffffff) {
            realCompressed = u64(bytes, field);
            field += 8;
          }
          break;
        }
        extra += 4 + len;
      }
    }
    entries.push({
      path: name,
      isDirectory: name.endsWith("/"),
      size: realSize,
      compressedSize: realCompressed,
      headerOffset: localOffset,
      method,
      compressed: method !== 0,
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* ---------- tar ---------- */

function tarNumber(block: Uint8Array, at: number, len: number): number {
  /* Base-256 encoding: the high bit of the first byte means "big number". */
  if (block[at] & 0x80) {
    let value = 0;
    for (let i = at + 1; i < at + len; i++) value = value * 256 + block[i];
    return value;
  }
  let text = "";
  for (let i = at; i < at + len; i++) {
    const ch = block[i];
    if (ch === 0 || ch === 0x20) {
      if (text) break;
      continue;
    }
    text += String.fromCharCode(ch);
  }
  const value = parseInt(text || "0", 8);
  return Number.isFinite(value) ? value : 0;
}

function tarString(block: Uint8Array, at: number, len: number): string {
  let end = at;
  while (end < at + len && block[end] !== 0) end++;
  return utf8.decode(block.subarray(at, end));
}

function isTar(bytes: Uint8Array): boolean {
  if (bytes.length < 512) return false;
  /* A tar header carries "ustar" at 257 — check that, or fall back to a
     plausible-looking header (old v7 tars have neither). */
  const magic = tarString(bytes, 257, 5);
  if (magic.startsWith("ustar")) return true;
  const name = tarString(bytes, 0, 100);
  const checksum = tarNumber(bytes, 148, 8);
  if (!name || !checksum) return false;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : bytes[i];
  return sum === checksum;
}

function parseTar(bytes: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let at = 0;
  let longName: string | null = null;

  while (at + 512 <= bytes.length) {
    const block = bytes.subarray(at, at + 512);
    /* Two zero blocks end the archive; one is enough to stop. */
    if (block.every((b) => b === 0)) break;

    const headerOffset = at;
    let name = longName ?? tarString(block, 0, 100);
    const prefix = tarString(block, 345, 155);
    longName = null;
    if (prefix) name = `${prefix}/${name}`;
    const size = tarNumber(block, 124, 12);
    const type = String.fromCharCode(block[156] || 0x30);
    const dataStart = at + 512;
    const dataBlocks = Math.ceil(size / 512) * 512;

    if (type === "L") {
      /* GNU long name: this entry *is* the next entry's name. */
      need(bytes, dataStart, size, "tar long name");
      longName = tarString(bytes, dataStart, size).replace(/\0+$/, "");
      at = dataStart + dataBlocks;
      continue;
    }
    if (type === "x" || type === "g" || type === "K") {
      /* pax headers, and long link names: skip the payload, keep going. */
      at = dataStart + dataBlocks;
      continue;
    }
    if (type === "5" || name.endsWith("/")) {
      if (name) {
        entries.push({
          path: name,
          isDirectory: true,
          size: 0,
          compressedSize: 0,
          headerOffset,
          method: 0,
          compressed: false,
        });
      }
    } else if (type === "0" || type === "\0" || type === "7") {
      entries.push({
        path: name,
        isDirectory: false,
        size,
        compressedSize: size,
        headerOffset,
        method: 0,
        compressed: false,
      });
    }
    /* Anything else (devices, fifos, hard links) is not a file to extract. */
    at = dataStart + dataBlocks;
  }
  return entries;
}

/* ---------- gzip ---------- */

function gzipName(bytes: Uint8Array): string | null {
  /* Header: magic(2) method(1) flags(1) mtime(4) xfl(1) os(1) — then, if
     FLG.FNAME (0x08) is set, a NUL-terminated file name. */
  if (bytes.length < 10) return null;
  const flags = bytes[3];
  if (!(flags & 0x08)) return null;
  let at = 10;
  if (flags & 0x04) {
    /* FEXTRA: 2-byte length, then that many bytes. */
    const len = u16(bytes, at);
    at += 2 + len;
  }
  const start = at;
  while (at < bytes.length && bytes[at] !== 0) at++;
  return at > start ? utf8.decode(bytes.subarray(start, at)) : null;
}

/* ---------- the public surface ---------- */

/**
 * Read the container. A `.gz` is decompressed here: if what comes out is a
 * tar, its entries are indexed against the decompressed bytes (and
 * `gzipped` says so); if it is a single file, `single` is that file.
 */
export async function openArchive(bytes: Uint8Array, kind: ArchiveKind): Promise<OpenedArchive> {
  if (!bytes.length) throw new ArchiveError("the file is empty");

  if (kind === "zip") {
    return { container: "zip", bytes, gzipped: false, entries: parseZip(bytes) };
  }
  if (kind === "tar") {
    if (!isTar(bytes)) {
      throw new ArchiveError("not a tar archive: no ustar header and no valid checksum");
    }
    return { container: "tar", bytes, gzipped: false, entries: parseTar(bytes) };
  }

  const inner = await decompress(bytes, "gzip");
  if (isTar(inner)) {
    return { container: "tar", bytes: inner, gzipped: true, entries: parseTar(inner) };
  }
  const name = gzipName(bytes) ?? "";
  return {
    container: "gzip",
    bytes: inner,
    gzipped: true,
    single: inner,
    entries: [
      {
        path: name,
        isDirectory: false,
        size: inner.length,
        compressedSize: bytes.length,
        headerOffset: 0,
        method: 0,
        compressed: true,
      },
    ],
  };
}

/** The list of entries alone — the common case. */
export async function listArchive(bytes: Uint8Array, kind: ArchiveKind): Promise<ArchiveEntry[]> {
  return (await openArchive(bytes, kind)).entries;
}

/** The bytes of one entry, decompressed. */
export async function readEntry(archive: OpenedArchive, entry: ArchiveEntry): Promise<Uint8Array> {
  if (entry.isDirectory) return new Uint8Array(0);
  const bytes = archive.bytes;

  if (archive.container === "gzip") return archive.single ?? bytes;

  if (archive.container === "tar") {
    need(bytes, entry.headerOffset + 512, entry.size, `tar entry ${entry.path}`);
    return bytes.slice(entry.headerOffset + 512, entry.headerOffset + 512 + entry.size);
  }

  /* zip: the local header repeats the name and extra fields, and its sizes
     may be zero (the real ones are in the central directory we already
     read) — so take the name/extra lengths from the local header and use the
     size we already know. */
  const at = entry.headerOffset;
  need(bytes, at, 30, `zip entry ${entry.path}`);
  if (u32(bytes, at) !== ZIP_LOCAL) {
    throw new ArchiveError(`zip entry "${entry.path}" points at the wrong place`);
  }
  const nameLen = u16(bytes, at + 26);
  const extraLen = u16(bytes, at + 28);
  const start = at + 30 + nameLen + extraLen;

  if (entry.method === 0) {
    if (entry.size > 0) {
      need(bytes, start, entry.size, `zip entry ${entry.path}`);
      return bytes.slice(start, start + entry.size);
    }
    /* Stored with no size recorded (streamed zip): take what is left. */
    return bytes.slice(start);
  }
  /* Deflate. The stream ends itself, so the tail of the file would do — but
     using the recorded length keeps a corrupt size from eating the next
     entry. */
  if (entry.compressedSize > 0) {
    need(bytes, start, entry.compressedSize, `zip entry ${entry.path}`);
    return decompress(bytes.slice(start, start + entry.compressedSize), "deflate-raw");
  }
  return decompress(bytes.slice(start), "deflate-raw");
}
