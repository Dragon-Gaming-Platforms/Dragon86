#!/usr/bin/env node
/**
 * Tests for src/core/archive.ts — zip, tar and gzip reading with no library.
 *
 * The archives here are built by Node's own zlib and by hand-written
 * container bytes, so this does not depend on any tool being installed, and
 * it exercises the two things that actually break in an archive reader:
 * the central directory (names, sizes, offsets, zip64) and the boundary
 * between "deflate bytes" and "the next entry".
 *
 *   node --experimental-strip-types tools/test-archive.mjs
 */
import { deflateRawSync, gzipSync } from "node:zlib";
import { crc32 } from "node:zlib";

const {
  detectArchiveKind,
  archiveBaseName,
  isArchiveName,
  openArchive,
  listArchive,
  readEntry,
  decompress,
  ArchiveError,
} = await import("../src/core/archive.ts");

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`[PASS] ${name}`);
  else {
    failed++;
    console.log(`[FAIL] ${name}  ${detail}`);
  }
}
const text = (bytes) => Buffer.from(bytes).toString("utf8");

/* ---------- building a zip by hand (no dependency, no tool) ---------- */

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data);
    const data = entry.store ? raw : deflateRawSync(raw);
    const method = entry.store ? 0 : 8;
    const crc = crc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // flags: names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }
  const centralStart = offset;
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBytes, eocd]));
}

/* ---------- building a tar (ustar + a GNU long name) ---------- */

function tarHeader(name, size, { type = "0", prefix = "" } = {}) {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write("0000644\0", 100, "latin1");
  block.write("0001750\0", 108, "latin1");
  block.write("0001750\0", 116, "latin1");
  block.write(size.toString(8).padStart(11, "0") + "\0", 124, "latin1");
  block.write("14000000000\0", 136, "latin1");
  block.write("        ", 148, "latin1"); // checksum placeholder: spaces
  block.write(type, 156, "latin1");
  block.write("ustar\0", 257, "latin1");
  block.write("00", 263, "latin1");
  block.write(prefix.slice(0, 155), 345, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return block;
}

function pad512(buf) {
  const rest = buf.length % 512;
  return rest ? Buffer.concat([buf, Buffer.alloc(512 - rest)]) : buf;
}

/** gzip with a FNAME header field, which Node's zlib does not write. */
function gzipWithName(data, name) {
  const raw = Buffer.from(data);
  const deflated = deflateRawSync(raw);
  const header = Buffer.alloc(10);
  header[0] = 0x1f;
  header[1] = 0x8b;
  header[2] = 8; // deflate
  header[3] = 0x08; // FNAME
  header[4] = 0; // mtime
  header[8] = 0; // XFL
  header[9] = 3; // Unix
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(crc32(raw) >>> 0, 0);
  tail.writeUInt32LE(raw.length, 4);
  return new Uint8Array(
    Buffer.concat([header, Buffer.from(name, "utf8"), Buffer.from([0]), deflated, tail]),
  );
}

function tar(entries) {
  const out = [];
  for (const entry of entries) {
    if (entry.longName) {
      const nameBytes = Buffer.from(entry.name, "utf8");
      out.push(tarHeader("././@LongLink", nameBytes.length + 1, { type: "L" }));
      out.push(pad512(Buffer.concat([nameBytes, Buffer.from([0])])));
      out.push(tarHeader("truncated", entry.data.length));
      out.push(pad512(Buffer.from(entry.data)));
      continue;
    }
    out.push(tarHeader(entry.name, entry.data?.length ?? 0, { type: entry.dir ? "5" : "0" }));
    if (!entry.dir) out.push(pad512(Buffer.from(entry.data)));
  }
  out.push(Buffer.alloc(1024));
  return new Uint8Array(Buffer.concat(out));
}

/* ---------- names ---------- */
{
  check("zip is detected", detectArchiveKind("photos.ZIP") === "zip");
  check(".tar is detected", detectArchiveKind("backup.tar") === "tar");
  check(".tgz is detected", detectArchiveKind("backup.tgz") === "gzip");
  check(".tar.gz is detected", detectArchiveKind("backup.tar.gz") === "gzip");
  check("a plain text file is not an archive", detectArchiveKind("notes.txt") === null);
  check("isArchiveName agrees", isArchiveName("a.zip") && !isArchiveName("a.zipx"));
  check("the base name drops the suffix", archiveBaseName("backup.tar.gz") === "backup", archiveBaseName("backup.tar.gz"));
  check("…and for a plain zip", archiveBaseName("photos.zip") === "photos");
}

/* ---------- zip ---------- */
{
  const bytes = zip([
    { name: "hello.txt", data: "hello archive\n" },
    { name: "docs/", data: "", store: true },
    { name: "docs/readme.md", data: "# readme\n" },
    { name: "stored.bin", data: "raw bytes", store: true },
  ]);
  const entries = await listArchive(bytes, "zip");
  const names = entries.map((e) => e.path);
  check("zip: every entry is listed", names.join(",") === "hello.txt,docs/,docs/readme.md,stored.bin", names.join(","));
  check("zip: a trailing slash is a folder", entries[1].isDirectory === true);
  check("zip: sizes come from the central directory", entries[0].size === "hello archive\n".length, String(entries[0].size));
  check("zip: stored entries are marked", entries[3].method === 0);
  check("zip: deflated entries are marked", entries[0].method === 8);

  const openedZip = await openArchive(bytes, "zip");
  const hello = await readEntry(openedZip, entries[0]);
  check("zip: a deflated entry inflates", text(hello) === "hello archive\n", text(hello));
  const stored = await readEntry(openedZip, entries[3]);
  check("zip: a stored entry is copied", text(stored) === "raw bytes", text(stored));
  const nested = await readEntry(openedZip, entries[2]);
  check("zip: the second entry is read from its own offset", text(nested) === "# readme\n", text(nested));

  /* UTF-8 names: a name with an accent must survive byte-for-byte. */
  const unicode = zip([{ name: "café/naïve.txt", data: "ok" }]);
  const uniEntries = await listArchive(unicode, "zip");
  check("zip: UTF-8 names survive", uniEntries[0].path === "café/naïve.txt", uniEntries[0].path);

  /* A zip with a comment after the EOCD still parses. */
  const commented = Buffer.concat([Buffer.from(zip([{ name: "a.txt", data: "A" }])), Buffer.from("trailing comment")]);
  const commentEntries = await listArchive(new Uint8Array(commented), "zip");
  check("zip: a trailing comment does not hide the directory", commentEntries.length === 1);

  let err = null;
  try {
    await listArchive(new Uint8Array(Buffer.from("this is not a zip at all")), "zip");
  } catch (e) {
    err = e;
  }
  check("zip: a non-zip says why", err instanceof ArchiveError && /end-of-central-directory/.test(err.message), String(err));
}

/* ---------- tar ---------- */
{
  const bytes = tar([
    { name: "notes.txt", data: "tar says hi\n" },
    { name: "folder/", dir: true },
    { name: "folder/" + "a-very-long-directory-name/".repeat(4) + "deep.txt", data: "deep" , longName: true },
  ]);
  const entries = await listArchive(bytes, "tar");
  check("tar: entries are listed", entries.length === 3, String(entries.length));
  check("tar: a file has its size", entries[0].size === "tar says hi\n".length);
  check("tar: a folder is a folder", entries[1].isDirectory === true);
  const openedTar = await openArchive(bytes, "tar");
  const note = await readEntry(openedTar, entries[0]);
  check("tar: a file's bytes are read", text(note) === "tar says hi\n", text(note));
  const deep = await readEntry(openedTar, entries[2]);
  check("tar: a GNU long name is honoured", text(deep) === "deep", text(deep));
  check(
    "tar: …and the long name is used",
    entries[2].path === "folder/" + "a-very-long-directory-name/".repeat(4) + "deep.txt",
    entries[2].path,
  );

  let err = null;
  try {
    await listArchive(new Uint8Array(Buffer.alloc(1536)), "tar");
  } catch (e) {
    err = e;
  }
  check("tar: an empty archive says why", err instanceof ArchiveError, String(err));
}

/* ---------- gzip ---------- */
{
  const plain = Buffer.from("one line\nsecond line\n");
  const gz = gzipWithName(plain, "notes.txt");
  const openedGz = await openArchive(gz, "gzip");
  const entries = openedGz.entries;
  check("gz: one entry", entries.length === 1);
  check("gz: the header names the file", entries[0].path === "notes.txt", entries[0].path);
  check("gz: the size is the uncompressed size", entries[0].size === plain.length, String(entries[0].size));
  const out = await readEntry(openedGz, entries[0]);
  check("gz: the bytes come back", text(out) === plain.toString("utf8"), text(out));

  const tarGz = new Uint8Array(
    gzipSync(Buffer.from(tar([{ name: "inside.txt", data: "tarred and gzipped" }]))),
  );
  const openedTarGz = await openArchive(tarGz, "gzip");
  const inner = openedTarGz.entries;
  check("tar.gz: the container is the tar, not the gzip", openedTarGz.container === "tar" && openedTarGz.gzipped === true, openedTarGz.container);
  check("tar.gz: the tar inside is listed", inner.length === 1 && inner[0].path === "inside.txt", JSON.stringify(inner.map((e) => e.path)));
  const innerData = await readEntry(openedTarGz, inner[0]);
  check("tar.gz: its file reads correctly", text(innerData) === "tarred and gzipped", text(innerData));
}

/* ---------- the platform codec, used through the module ---------- */
{
  const raw = Buffer.from("deflate-raw round trip");
  const packed = new Uint8Array(deflateRawSync(raw));
  const back = await decompress(packed, "deflate-raw");
  check("decompress(): deflate-raw", text(back) === raw.toString("utf8"));
  let err = null;
  try {
    await decompress(new Uint8Array([1, 2, 3, 4]), "gzip");
  } catch (e) {
    err = e;
  }
  check("decompress(): bad data is an ArchiveError", err instanceof ArchiveError, String(err));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
