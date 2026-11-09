#!/usr/bin/env node
/**
 * Symlinks over 9p — the production stack, driven with raw frames.
 *
 * The App Store packs are tarballs the guest extracts onto its 9p root.
 * fontconfig alone ships dozens of symlinks, so `tar x` sends Tsymlink —
 * and that opcode used to die with EIO because the production fs wrapper
 * (unionAsPromises over createDirectFs over ZenFS) had no symlink() at
 * all. The VM harness never caught it: its hand-rolled fs shim *did*
 * have symlink(), and its stat() was secretly an lstat, so dangling
 * links worked there and nowhere else.
 *
 * This test runs the real pieces — src/bridge/p9.ts over
 * unionAsPromises(createDirectFs(...)) over real ZenFS — and speaks wire
 * format to them, the way the guest kernel does:
 *
 *   - Tsymlink to an existing target, and readlink agrees
 *   - Tsymlink to a target that does not exist yet (tar extracts links
 *     before their targets all the time) — the regression
 *   - Twalk/Tlgetattr report QTLINK/S_IFLNK, not the target, not ENOENT
 *   - Treaddir lists a dangling symlink (it used to silently drop it)
 *   - Treadlink returns the target text
 *   - Tlsetattr on a symlink succeeds (tar sets mtimes after linking)
 *   - Tunlinkat removes the link and leaves the target alone
 *   - Tlink creates a hard link that shares the inode (pacman packages
 *     and tar payloads carry them; `ln` used to answer ENOSYS)
 *
 * Needs the vm bundle (same one test:vm uses):
 *   vite build --config tools/vm/vite.config.ts && node tools/test-p9-symlink.mjs
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const bundle = resolve(here, "vm/build/p9.cjs");
const { createP9Handler, createDirectFs, unionAsPromises } = require(bundle);
/* The bundle externalizes @zenfs/core; require() here lands on the same
   CJS instance, so this fs and the server's fs are one filesystem. */
const { fs } = require("@zenfs/core");

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`[PASS] ${name}`);
  else {
    failed++;
    console.log(`[FAIL] ${name}  ${detail}`);
  }
}

/* ---------- 9p wire helpers (little-endian) ---------- */

class W {
  constructor() { this.b = []; }
  u8(x) { this.b.push(x & 255); return this; }
  u16(x) { this.b.push(x & 255, (x >> 8) & 255); return this; }
  u32(x) { this.b.push(x & 255, (x >> 8) & 255, (x >> 16) & 255, (x >> 24) & 255); return this; }
  u64(x) {
    let v = BigInt(Math.trunc(x));
    for (let i = 0; i < 8; i++) { this.b.push(Number(v & 255n)); v >>= 8n; }
    return this;
  }
  str(s) {
    const e = new TextEncoder().encode(s);
    this.u16(e.length);
    for (const c of e) this.b.push(c);
    return this;
  }
  frame(type, tag) {
    const size = 7 + this.b.length;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, size, true);
    out[4] = type;
    dv.setUint16(5, tag, true);
    out.set(this.b, 7);
    return out;
  }
}

class R {
  constructor(buf) {
    this.buf = buf;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.off = 7; // past size[4] type[1] tag[2]
    this.type = buf[4];
  }
  u8() { const x = this.dv.getUint8(this.off); this.off += 1; return x; }
  u16() { const x = this.dv.getUint16(this.off, true); this.off += 2; return x; }
  u32() { const x = this.dv.getUint32(this.off, true); this.off += 4; return x; }
  u64() { const x = Number(this.dv.getBigUint64(this.off, true)); this.off += 8; return x; }
  str() {
    const n = this.u16();
    const s = new TextDecoder().decode(this.buf.subarray(this.off, this.off + n));
    this.off += n;
    return s;
  }
  qid() { return { type: this.u8(), version: this.u32(), id: this.u64() }; }
}

const call = (handler, frame) => new Promise((res) => handler(frame, res));
const QTLINK = 0x02;
const S_IFMT = 0o170000, S_IFLNK = 0o120000, S_IFREG = 0o100000;

/* ---------- the tree: a miniature of the fontconfig shape ---------- */

const ROOT = "/guest";
await fs.promises.mkdir(`${ROOT}/usr/share/conf.avail`, { recursive: true });
await fs.promises.mkdir(`${ROOT}/usr/share/conf.default`, { recursive: true });
await fs.promises.writeFile(`${ROOT}/usr/share/conf.avail/10-hinting.conf`, "<fontconfig/>");

const handler = createP9Handler(ROOT, unionAsPromises(createDirectFs(ROOT)));

/* fid 0 is unknown to the server, which deliberately heals it to the share
   root — the same fallback the guest kernel relies on after a restore. */
const walk = async (newfid, names) => {
  const w = new W().u32(0).u32(newfid).u16(names.length);
  for (const n of names) w.str(n);
  return new R(await call(handler, w.frame(110, 1)));
};

/* ---------- Tsymlink, target present ---------- */
{
  const dir = await walk(1, ["usr", "share", "conf.default"]);
  check("walk to conf.default", dir.type === 111 && dir.u16() === 3);
  const r = new R(await call(handler,
    new W().u32(1).str("10-hinting.conf").str("../conf.avail/10-hinting.conf").u32(0).frame(16, 2)));
  check("Tsymlink → Rsymlink (not Rlerror)", r.type === 17, `got type ${r.type}`);
  if (r.type === 17) check("…and the reply qid is QTLINK", r.qid().type === QTLINK);
  const target = await fs.promises.readlink(`${ROOT}/usr/share/conf.default/10-hinting.conf`)
    .catch((e) => `(readlink failed: ${e.code})`);
  check("…and ZenFS holds the link text verbatim", target === "../conf.avail/10-hinting.conf", target);
}

/* ---------- Tsymlink, target NOT extracted yet — the regression ---------- */
{
  const r = new R(await call(handler,
    new W().u32(1).str("60-latin.conf").str("../conf.avail/60-latin.conf").u32(0).frame(16, 3)));
  check("Tsymlink with a dangling target succeeds", r.type === 17, `got type ${r.type}`);
}

/* ---------- the dangling link is a real, visible entry ---------- */
{
  const r = await walk(2, ["usr", "share", "conf.default", "60-latin.conf"]);
  const n = r.type === 111 ? r.u16() : 0;
  check("Twalk reaches the dangling symlink", n === 4, `type ${r.type}, nwqid ${n}`);
  if (n === 4) {
    r.qid(); r.qid(); r.qid();
    check("…and its qid is QTLINK", r.qid().type === QTLINK);
  }

  const ga = new R(await call(handler, new W().u32(2).u64(0x7ff).frame(24, 4)));
  check("Tlgetattr answers for a dangling symlink", ga.type === 25, `got type ${ga.type}`);
  if (ga.type === 25) {
    ga.u64(); ga.qid(); // valid, qid
    const mode = ga.u32();
    check("…with S_IFLNK, not the (absent) target", (mode & S_IFMT) === S_IFLNK,
      `mode ${(mode >>> 0).toString(8)}`);
  }

  const rl = new R(await call(handler, new W().u32(2).frame(22, 5)));
  check("Treadlink returns the target text",
    rl.type === 23 && rl.str() === "../conf.avail/60-latin.conf");

  /* tar restores mtimes on links after creating them */
  const sa = new R(await call(handler,
    new W().u32(2).u32(0x30).u32(0).u32(0).u32(0).u64(0)
      .u64(0).u64(0).u64(0).u64(0).frame(26, 6)));
  check("Tlsetattr on a symlink succeeds", sa.type === 27, `got type ${sa.type}`);
}

/* ---------- Treaddir shows both links (dangling included) ---------- */
{
  await walk(3, ["usr", "share", "conf.default"]);
  const rd = new R(await call(handler, new W().u32(3).u64(0).u32(65536).frame(40, 7)));
  check("Treaddir answers", rd.type === 41, `got type ${rd.type}`);
  const entries = new Map();
  if (rd.type === 41) {
    const count = rd.u32();
    const end = rd.off + count;
    while (rd.off < end) {
      rd.qid(); rd.u64();
      const dtype = rd.u8();
      entries.set(rd.str(), dtype);
    }
  }
  check("…listing the live symlink as DT_LNK", entries.get("10-hinting.conf") === 10,
    `entries: ${JSON.stringify([...entries])}`);
  check("…and the dangling one too (it used to vanish)", entries.get("60-latin.conf") === 10,
    `entries: ${JSON.stringify([...entries])}`);
}

/* ---------- plain files still look like plain files ---------- */
{
  await walk(4, ["usr", "share", "conf.avail", "10-hinting.conf"]);
  const ga = new R(await call(handler, new W().u32(4).u64(0x7ff).frame(24, 8)));
  ga.u64(); ga.qid();
  const mode = ga.u32();
  check("a regular file getattrs as S_IFREG", (mode & S_IFMT) === S_IFREG,
    `mode ${(mode >>> 0).toString(8)}`);
}

/* ---------- Tlink: hard links share the inode ---------- */
{
  // dfid: the directory the new name lands in; fid: the existing file
  await walk(5, ["usr", "share", "conf.avail"]);
  const r = new R(await call(handler, new W().u32(5).u32(4).str("hard.conf").frame(70, 10)));
  check("Tlink → Rlink (not Rlerror)", r.type === 71, `got type ${r.type}`);
  const viaLink = await fs.promises.readFile(`${ROOT}/usr/share/conf.avail/hard.conf`, "utf8")
    .catch((e) => `(read failed: ${e.code})`);
  check("…and the new name reads the file", viaLink === "<fontconfig/>", viaLink);
  await fs.promises.writeFile(`${ROOT}/usr/share/conf.avail/10-hinting.conf`, "<changed/>");
  const after = await fs.promises.readFile(`${ROOT}/usr/share/conf.avail/hard.conf`, "utf8")
    .catch((e) => `(read failed: ${e.code})`);
  check("…and it is the same inode, not a copy", after === "<changed/>", after);
  await fs.promises.writeFile(`${ROOT}/usr/share/conf.avail/10-hinting.conf`, "<fontconfig/>");
  const rm = new R(await call(handler, new W().u32(5).str("hard.conf").u32(0).frame(76, 11)));
  const orig = await fs.promises.readFile(`${ROOT}/usr/share/conf.avail/10-hinting.conf`, "utf8")
    .then(() => true, () => false);
  check("…unlinking one name keeps the other", rm.type === 77 && orig);
}

/* ---------- removing a link removes the link, not the target ---------- */
{
  const r = new R(await call(handler, new W().u32(3).str("10-hinting.conf").u32(0).frame(76, 9)));
  check("Tunlinkat removes a symlink", r.type === 77, `got type ${r.type}`);
  const gone = await fs.promises.readlink(`${ROOT}/usr/share/conf.default/10-hinting.conf`)
    .then(() => false, () => true);
  const kept = await fs.promises.stat(`${ROOT}/usr/share/conf.avail/10-hinting.conf`)
    .then(() => true, () => false);
  check("…the link is gone and the target survives", gone && kept);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall 9p symlink tests passed");
process.exit(failed ? 1 : 0);
