/**
 * Small, dependency-free ZIP writer for Files → Download folder.
 *
 * It writes UTF-8 paths and stored entries (no compression), which keeps the
 * output broadly compatible and makes the archive's memory/time cost
 * predictable. ZIP64 is intentionally refused rather than silently
 * truncating offsets; an individual file or archive must fit in 32-bit ZIP
 * limits.
 */

export interface ZipFile {
  path: string;
  bytes: Uint8Array;
  modified?: number;
  isDirectory?: boolean;
}

const encoder = new TextEncoder();
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(ms?: number): [number, number] {
  const date = new Date(ms ?? Date.now());
  if (!Number.isFinite(date.getTime())) return [0, 0x21]; // 1980-01-01
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return [time, day];
}

function put16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function put32(bytes: Uint8Array, offset: number, value: number): void {
  put16(bytes, offset, value & 0xffff);
  put16(bytes, offset + 2, value >>> 16);
}

function safeZipPath(path: string, directory: boolean): string {
  const normalized = path.replace(/\\/g, "/");
  const rawParts = normalized.split("/");
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || rawParts.some((part) => part === "..")) {
    throw new Error(`Invalid ZIP path: ${JSON.stringify(path)}`);
  }
  const parts = rawParts.filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => /[\0-\x1f\x7f]/.test(part))) {
    throw new Error(`Invalid ZIP path: ${JSON.stringify(path)}`);
  }
  return parts.join("/") + (directory ? "/" : "");
}

/** Build an application/zip Blob from relative paths and file bytes. */
export function createZipArchive(files: readonly ZipFile[]): Blob {
  if (files.length > 0xffff) throw new Error("This folder has too many entries for a standard ZIP archive.");
  if (!files.length) throw new Error("There is nothing to download from this folder.");

  const local: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let centralLength = 0;

  for (const file of files) {
    const directory = !!file.isDirectory;
    const name = encoder.encode(safeZipPath(file.path, directory));
    const data = directory ? new Uint8Array(0) : file.bytes;
    if (name.length > 0xffff) throw new Error("A filename is too long for a standard ZIP archive.");
    if (data.byteLength > 0xffffffff || offset > 0xffffffff) {
      throw new Error("This folder is too large for a standard ZIP archive (4 GB limit).");
    }
    const checksum = crc32(data);
    const [time, date] = dosTimestamp(file.modified);
    const localHeader = new Uint8Array(30);
    put32(localHeader, 0, 0x04034b50);
    put16(localHeader, 4, 20);
    put16(localHeader, 6, 0x0800); // UTF-8 paths
    put16(localHeader, 8, 0); // stored, no compression
    put16(localHeader, 10, time);
    put16(localHeader, 12, date);
    put32(localHeader, 14, checksum);
    put32(localHeader, 18, data.byteLength);
    put32(localHeader, 22, data.byteLength);
    put16(localHeader, 26, name.length);
    put16(localHeader, 28, 0);
    local.push(localHeader, name, data as unknown as BlobPart);

    const centralHeader = new Uint8Array(46);
    put32(centralHeader, 0, 0x02014b50);
    put16(centralHeader, 4, 20);
    put16(centralHeader, 6, 20);
    put16(centralHeader, 8, 0x0800);
    put16(centralHeader, 10, 0);
    put16(centralHeader, 12, time);
    put16(centralHeader, 14, date);
    put32(centralHeader, 16, checksum);
    put32(centralHeader, 20, data.byteLength);
    put32(centralHeader, 24, data.byteLength);
    put16(centralHeader, 28, name.length);
    put16(centralHeader, 30, 0);
    put16(centralHeader, 32, 0);
    put16(centralHeader, 34, 0);
    put16(centralHeader, 36, 0);
    put32(centralHeader, 38, directory ? 0x41ed0010 : 0x81a40000);
    put32(centralHeader, 42, offset);
    central.push(centralHeader, name);
    centralLength += centralHeader.byteLength + name.byteLength;
    offset += localHeader.byteLength + name.byteLength + data.byteLength;
  }

  if (offset > 0xffffffff || centralLength > 0xffffffff) {
    throw new Error("This folder is too large for a standard ZIP archive (4 GB limit).");
  }
  const end = new Uint8Array(22);
  put32(end, 0, 0x06054b50);
  put16(end, 4, 0);
  put16(end, 6, 0);
  put16(end, 8, files.length);
  put16(end, 10, files.length);
  put32(end, 12, centralLength);
  put32(end, 16, offset);
  put16(end, 20, 0);
  return new Blob([...local, ...central, end] as BlobPart[], { type: "application/zip" });
}
