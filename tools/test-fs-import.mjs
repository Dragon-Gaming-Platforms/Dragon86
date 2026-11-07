#!/usr/bin/env node
/**
 * Tests for the import half of src/core/fs-export.ts.
 *
 * The claims the Settings page makes are each proven here:
 *   1. a snapshot our own export produced round-trips exactly
 *      (contents, modes, symlinks, long paths) after the tree is wiped;
 *   2. archives made by REAL tar import too — GNU format (@LongLink)
 *      and POSIX/pax format (path= records), gzipped and plain;
 *   3. overlay semantics: same-path files replaced, others left alone;
 *   4. "../" paths are refused and tmp/ entries are skipped;
 *   5. a non-tar file fails loudly instead of pretending.
 *
 *   node --experimental-strip-types tools/test-fs-import.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const { configure, fs, InMemory } = await import("@zenfs/core");
const { exportFsSnapshot, importFsSnapshot } = await import("../src/core/fs-export.ts");

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`[PASS] ${name}`);
  else {
    failed++;
    console.log(`[FAIL] ${name}  ${detail}`);
  }
}

await configure({ mounts: { "/": InMemory, "/tmp": InMemory } });

/** Wipe everything under / except the /tmp mount. */
async function wipeRoot() {
  for (const name of await fs.promises.readdir("/")) {
    if (name === "tmp") continue;
    await fs.promises.rm(`/${name}`, { recursive: true, force: true });
  }
}

const LONG_DIR = "usr/lib/modules/6.18.60-1-lts/kernel/drivers/gpu/drm/some/very/deep/path/that/overflows/the/ustar/name/field";
const LONG_FILE = `${LONG_DIR}/bochs.ko`;

/* ---------- 1) round-trip: export → wipe → import ---------- */
{
  await fs.promises.mkdir("/etc", { recursive: true });
  await fs.promises.writeFile("/etc/hostname", "dragon86\n");
  await fs.promises.mkdir(`/${LONG_DIR}`, { recursive: true });
  const big = new Uint8Array(3000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 17) & 0xff;
  await fs.promises.writeFile(`/${LONG_FILE}`, big);
  await fs.promises.mkdir("/usr/bin", { recursive: true });
  await fs.promises.writeFile("/usr/bin/tool", "#!/bin/sh\necho ok\n");
  await fs.promises.chmod("/usr/bin/tool", 0o755);
  await fs.promises.symlink("usr/bin", "/bin");

  const { blob } = await exportFsSnapshot();
  await wipeRoot();
  check("round-trip: tree is actually gone", !(await fs.promises.readdir("/")).includes("etc"));

  let progressCalls = 0;
  const res = await importFsSnapshot(blob, () => progressCalls++);
  check("round-trip: import reports entries", res.files > 0, `files=${res.files}`);
  check("round-trip: nothing skipped", res.skipped === 0, `skipped=${res.skipped}`);
  check("round-trip: progress fired", progressCalls > 0);
  check("round-trip: text restored", (await fs.promises.readFile("/etc/hostname", "utf8")) === "dragon86\n");
  const back = new Uint8Array(await fs.promises.readFile(`/${LONG_FILE}`));
  check("round-trip: long-path bytes identical", back.length === big.length && back.every((b, i) => b === big[i]));
  check("round-trip: mode 755 restored", ((await fs.promises.stat("/usr/bin/tool")).mode & 0o777) === 0o755);
  const lst = await fs.promises.lstat("/bin");
  check("round-trip: symlink restored as symlink", lst.isSymbolicLink());
  check("round-trip: symlink target restored", String(await fs.promises.readlink("/bin")) === "usr/bin");
}

/* ---------- 2) archives made by real tar ---------- */
for (const [label, format, gz] of [
  ["GNU-format .tar.gz", "gnu", true],
  ["POSIX/pax-format .tar.gz", "posix", true],
  ["plain uncompressed .tar", "gnu", false],
]) {
  const dir = mkdtempSync(join(tmpdir(), "d86-import-"));
  try {
    mkdirSync(join(dir, "payload", LONG_DIR), { recursive: true });
    writeFileSync(join(dir, "payload", LONG_FILE), "module bytes\n");
    mkdirSync(join(dir, "payload", "opt/app"), { recursive: true });
    writeFileSync(join(dir, "payload", "opt/app/run.sh"), "#!/bin/sh\n");
    chmodSync(join(dir, "payload", "opt/app/run.sh"), 0o755);
    utimesSync(join(dir, "payload", "opt/app/run.sh"), new Date(1700000000_000), new Date(1700000000_000));
    symlinkSync("run.sh", join(dir, "payload", "opt/app/start"));
    const tarPath = join(dir, gz ? "t.tar.gz" : "t.tar");
    execFileSync("tar", [gz ? "-czf" : "-cf", tarPath, `--format=${format}`, "-C", join(dir, "payload"), "."]);

    await wipeRoot();
    const res = await importFsSnapshot(new Blob([readFileSync(tarPath)]));
    check(`${label}: imports`, res.files > 0, `files=${res.files}`);
    check(`${label}: long path restored`, (await fs.promises.readFile(`/${LONG_FILE}`, "utf8")) === "module bytes\n");
    check(`${label}: exec bit restored`, ((await fs.promises.stat("/opt/app/run.sh")).mode & 0o777) === 0o755);
    check(`${label}: symlink restored`, String(await fs.promises.readlink("/opt/app/start")) === "run.sh");
    const mt = (await fs.promises.stat("/opt/app/run.sh")).mtimeMs;
    check(`${label}: mtime restored`, Math.abs(mt - 1700000000_000) < 5000, `mtimeMs=${mt}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------- 3) overlay semantics ---------- */
{
  await wipeRoot();
  await fs.promises.mkdir("/home/user", { recursive: true });
  await fs.promises.writeFile("/home/user/keep.txt", "not in the snapshot");
  await fs.promises.writeFile("/home/user/replace.txt", "old");

  const dir = mkdtempSync(join(tmpdir(), "d86-overlay-"));
  try {
    mkdirSync(join(dir, "home/user"), { recursive: true });
    writeFileSync(join(dir, "home/user/replace.txt"), "new");
    const tarPath = join(dir, "o.tar.gz");
    execFileSync("tar", ["-czf", tarPath, "-C", dir, "home"]);
    await importFsSnapshot(new Blob([readFileSync(tarPath)]));
    check("overlay: same-path file replaced", (await fs.promises.readFile("/home/user/replace.txt", "utf8")) === "new");
    check("overlay: unrelated file untouched", (await fs.promises.readFile("/home/user/keep.txt", "utf8")) === "not in the snapshot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------- 4) hostile and skippable entries ---------- */
{
  /* A hand-built tar: one "../evil" entry, one tmp/ entry, one good file. */
  const enc = new TextEncoder();
  function header(name, size, type) {
    const b = new Uint8Array(512);
    b.set(enc.encode(name), 0);
    b.set(enc.encode("0000644"), 100);
    b.set(enc.encode("0000000"), 108);
    b.set(enc.encode("0000000"), 116);
    b.set(enc.encode(size.toString(8).padStart(11, "0")), 124);
    b.set(enc.encode("00000000000"), 136);
    b[156] = type.charCodeAt(0);
    b.set(enc.encode("ustar"), 257);
    b[263] = 0x30;
    b[264] = 0x30;
    b.fill(0x20, 148, 156);
    let sum = 0;
    for (const x of b) sum += x;
    b.set(enc.encode(sum.toString(8).padStart(6, "0")), 148);
    b[154] = 0;
    b[155] = 0x20;
    return b;
  }
  const pad = (n) => new Uint8Array((512 - (n % 512)) % 512);
  const body1 = enc.encode("evil");
  const body2 = enc.encode("scratch");
  const body3 = enc.encode("fine");
  const tar = new Blob([
    header("../evil.txt", body1.length, "0"), body1, pad(body1.length),
    header("tmp/scratch.txt", body2.length, "0"), body2, pad(body2.length),
    header("srv/good.txt", body3.length, "0"), body3, pad(body3.length),
    new Uint8Array(1024),
  ]);
  await wipeRoot();
  const res = await importFsSnapshot(new Blob([gzipSync(Buffer.from(await tar.arrayBuffer()))]));
  check("hostile: ../ entry skipped", res.skipped >= 1, `skipped=${res.skipped}`);
  check("hostile: tmp/ entry skipped too", res.skipped === 2, `skipped=${res.skipped}`);
  check("hostile: evil.txt nowhere in /", !(await fs.promises.readdir("/")).some((n) => n.includes("evil")));
  check("hostile: good entry still imported", (await fs.promises.readFile("/srv/good.txt", "utf8")) === "fine");
}

/* ---------- 5) garbage in → error out ---------- */
{
  let threw = false;
  try {
    await importFsSnapshot(new Blob([new Uint8Array([1, 2, 3, 4, 5])]));
  } catch {
    threw = true;
  }
  check("not-a-tar throws", threw);
  let threw2 = false;
  try {
    /* valid gzip, but the payload is not a tar */
    await importFsSnapshot(new Blob([gzipSync(Buffer.from("just some text"))]));
  } catch {
    threw2 = true;
  }
  check("gzipped non-tar throws", threw2);
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall fs-import tests passed");
