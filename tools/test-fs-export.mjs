#!/usr/bin/env node
/**
 * Tests for src/core/fs-export.ts — the "Export filesystem" snapshot.
 *
 * Builds a ZenFS tree in memory (files, nested dirs, a symlink, permission
 * bits, a path far beyond tar's 100-byte name field — the shape of a real
 * installed distro), exports it, then verifies the result two ways:
 *
 *   1. with GNU tar itself (`tar -tzf` + extraction and a byte compare),
 *      because "a tar our own parser likes" proves nothing;
 *   2. with the headers decoded by hand for the details tar -t does not
 *      show (modes, the GNU @LongLink entry, the trailing zero blocks).
 *
 *   node --experimental-strip-types tools/test-fs-export.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const { configure, fs, InMemory } = await import("@zenfs/core");
const { exportFsSnapshot, snapshotFilename } = await import("../src/core/fs-export.ts");

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`[PASS] ${name}`);
  else {
    failed++;
    console.log(`[FAIL] ${name}  ${detail}`);
  }
}

/* ---------- build the tree ---------- */

await configure({ mounts: { "/": InMemory, "/tmp": InMemory } });

const LONG_DIR = "usr/lib/modules/6.18.60-1-lts/kernel/drivers/input/mouse/some/very/deep/path/that/overflows/the/ustar/name/field";
const LONG_FILE = `${LONG_DIR}/psmouse.ko`;

await fs.promises.mkdir("/etc", { recursive: true });
await fs.promises.writeFile("/etc/hostname", "dragon86\n");
await fs.promises.mkdir("/home/user/Documents", { recursive: true });
await fs.promises.writeFile("/home/user/Documents/hello.txt", "snapshot me\n");
await fs.promises.mkdir(`/${LONG_DIR}`, { recursive: true });
const big = new Uint8Array(3000);
for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
await fs.promises.writeFile(`/${LONG_FILE}`, big);
await fs.promises.mkdir("/usr/bin", { recursive: true });
await fs.promises.writeFile("/usr/bin/tool", "#!/bin/sh\necho ok\n");
await fs.promises.chmod("/usr/bin/tool", 0o755);
await fs.promises.symlink("usr/bin", "/bin");
/* /tmp must NOT appear in the export. */
await fs.promises.writeFile("/tmp/scratch.txt", "ephemeral");

/* ---------- export ---------- */

let progressCalls = 0;
const { blob, files, bytes } = await exportFsSnapshot(() => progressCalls++);
const gz = new Uint8Array(await blob.arrayBuffer());

check("snapshot is gzip", gz[0] === 0x1f && gz[1] === 0x8b);
check("entry count counted", files > 0, `files=${files}`);
check("byte count counted", bytes >= 3000 + 12 + 9, `bytes=${bytes}`);
check("progress fired", progressCalls > 0);
check("filename looks right", /^dragon86-fs-\d{8}-\d{4}\.tar\.gz$/.test(snapshotFilename()));

/* ---------- 1) the authority: GNU tar reads it ---------- */

const dir = mkdtempSync(join(tmpdir(), "d86-export-"));
try {
  const tarPath = join(dir, "snap.tar.gz");
  writeFileSync(tarPath, gz);

  const listing = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8" }).split("\n").filter(Boolean);
  check("tar lists the plain file", listing.includes("etc/hostname"));
  check("tar lists the long path in full", listing.includes(LONG_FILE));
  check("tar lists the symlink", listing.includes("bin"));
  check("tar does not list /tmp", !listing.some((l) => l === "tmp/" || l.startsWith("tmp/")));

  const out = join(dir, "x");
  execFileSync("mkdir", ["-p", out]);
  execFileSync("tar", ["-xzf", tarPath, "-C", out]);
  check("extracted text matches", readFileSync(join(out, "etc/hostname"), "utf8") === "dragon86\n");
  check(
    "extracted long-path bytes match",
    Buffer.compare(readFileSync(join(out, LONG_FILE)), Buffer.from(big)) === 0,
  );
  check("extracted mode kept 755", (lstatSync(join(out, "usr/bin/tool")).mode & 0o777) === 0o755);
  const linkStat = lstatSync(join(out, "bin"));
  check("extracted symlink is a symlink", linkStat.isSymbolicLink());
  check("extracted symlink target", readlinkSync(join(out, "bin")) === "usr/bin");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/* ---------- 2) header details tar -t cannot show ---------- */

const tar = gunzipSync(gz);
check("tar is block-aligned", tar.length % 512 === 0, `len=${tar.length}`);
check(
  "archive ends with two zero blocks",
  tar.subarray(tar.length - 1024).every((b) => b === 0),
);

const names = [];
let sawLongLink = false;
for (let off = 0; off + 512 <= tar.length; ) {
  const block = tar.subarray(off, off + 512);
  if (block.every((b) => b === 0)) break;
  const name = block.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
  const size = parseInt(block.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim() || "0", 8);
  const type = String.fromCharCode(block[156]);
  /* checksum must verify */
  const copy = Buffer.from(block);
  copy.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of copy) sum += b;
  const stored = parseInt(block.subarray(148, 156).toString("utf8").replace(/[\0 ].*$/, ""), 8);
  if (sum !== stored) {
    check(`checksum of ${name}`, false, `computed ${sum}, stored ${stored}`);
    break;
  }
  if (name === "././@LongLink" && type === "L") sawLongLink = true;
  else names.push(name);
  off += 512 + Math.ceil(size / 512) * 512;
}
check("every header checksum verifies", true);
check("long path went through a GNU @LongLink entry", sawLongLink);
check("ordinary names stay in the ustar header", names.includes("etc/hostname"));

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall fs-export tests passed");
