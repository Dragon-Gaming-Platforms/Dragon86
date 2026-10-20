/**
 * p9 — a 9p2000.L server backed directly by Dragon86's filesystem.
 *
 * This is how the OS filesystem is wired into the v86 guest: v86's
 * `filesystem.handle9p` hands us raw 9p frames from the guest kernel, and
 * every operation (walk/open/read/write/mkdir/unlink/rename…) is served
 * straight from ZenFS. The guest mounts it with
 * `mount -t 9p -o trans=virtio,version=9p2000.L host9p /shared`, so the
 * guest's /shared *is* /home/user — live, both ways, including creates,
 * deletes and renames. No boot-time push, no shell commands, no sync
 * events. (AnuraOS achieves the same shape with a forked v86 whose 9p
 * layer calls their host fs; this is the stock-upstream-v86 equivalent.)
 *
 * Scope: the subset of 9p2000.L a Linux client exercises against a
 * simple file share. xattrs, locks (beyond trivial success), symlinks
 * and device nodes return ENOSYS.
 */

import { fs } from "@zenfs/core";
import { logInfo, logWarn } from "../core/log";

type Promises = typeof fs.promises;
type Handle = Awaited<ReturnType<Promises["open"]>>;

const MSIZE = 262144;
const IOUNIT = MSIZE - 64;

/* errno values the guest turns into strerror() text */
const ENOENT = 2, EPERM = 1, EIO = 5, EEXIST = 17, ENOTDIR = 20,
  EISDIR = 21, EINVAL = 22, ENOSYS = 38, ENOTEMPTY = 39;

function errnoOf(err: unknown): number {
  const code = (err as { code?: string })?.code ?? "";
  switch (code) {
    case "ENOENT": return ENOENT;
    case "EEXIST": return EEXIST;
    case "ENOTDIR": return ENOTDIR;
    case "EISDIR": return EISDIR;
    case "EINVAL": return EINVAL;
    case "EPERM": case "EACCES": return EPERM;
    case "ENOTEMPTY": return ENOTEMPTY;
    default: return EIO;
  }
}

/* ---------- wire helpers (little-endian) ---------- */

class Reader {
  private v: DataView;
  off = 0;
  constructor(private buf: Uint8Array) {
    this.v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  u8(): number { const x = this.v.getUint8(this.off); this.off += 1; return x; }
  u16(): number { const x = this.v.getUint16(this.off, true); this.off += 2; return x; }
  u32(): number { const x = this.v.getUint32(this.off, true); this.off += 4; return x; }
  u64(): number { const x = Number(this.v.getBigUint64(this.off, true)); this.off += 8; return x; }
  str(): string {
    const n = this.u16();
    const s = new TextDecoder().decode(this.buf.subarray(this.off, this.off + n));
    this.off += n;
    return s;
  }
  bytes(n: number): Uint8Array {
    const b = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }
}

class Writer {
  private chunks: number[] = [];
  u8(x: number): this { this.chunks.push(x & 0xff); return this; }
  u16(x: number): this { this.chunks.push(x & 0xff, (x >> 8) & 0xff); return this; }
  u32(x: number): this {
    this.chunks.push(x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, (x >> 24) & 0xff);
    return this;
  }
  u64(x: number): this {
    let b = BigInt(Math.trunc(x));
    for (let i = 0; i < 8; i++) { this.chunks.push(Number(b & 0xffn)); b >>= 8n; }
    return this;
  }
  str(s: string): this {
    const b = new TextEncoder().encode(s);
    this.u16(b.length);
    for (const c of b) this.chunks.push(c);
    return this;
  }
  raw(b: Uint8Array): this { for (const c of b) this.chunks.push(c); return this; }
  build(type: number, tag: number): Uint8Array {
    const body = new Uint8Array(this.chunks);
    const out = new Uint8Array(7 + body.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, out.length, true);
    v.setUint8(4, type);
    v.setUint16(5, tag, true);
    out.set(body, 7);
    return out;
  }
}

/* ---------- server ---------- */

interface Fid {
  path: string; // absolute ZenFS path
  handle?: Handle;
  dirBuf?: Uint8Array; // serialized readdir listing
  dirEnds?: number[]; // cumulative end offset per entry
}

interface Qid { type: number; version: number; id: number }

const QTDIR = 0x80, QTFILE = 0x00, QTLINK = 0x02;

export function createP9Handler(
  root: string,
  fsImpl: Promises = fs.promises,
): (req: Uint8Array, reply: (buf: Uint8Array) => void) => void {
  const fids = new Map<number, Fid>();
  const qidIds = new Map<string, number>();
  let nextQid = 1;

  const joinRel = (base: string, name: string): string => {
    if (name === "" || name === ".") return base;
    if (name === "..") {
      const i = base.lastIndexOf("/");
      return i <= root.length ? root : base.slice(0, i);
    }
    return `${base}/${name}`.replace(/\/{2,}/g, "/");
  };

  /** ZenFS path → guest-view check: never escape the share root. */
  const inside = (p: string): boolean => p === root || p.startsWith(`${root}/`);

  async function qidFor(path: string): Promise<Qid> {
    const st = await fsImpl.stat(path);
    let id = qidIds.get(path);
    if (id === undefined) {
      id = nextQid++;
      qidIds.set(path, id);
    }
    const type = st.isDirectory() ? QTDIR : st.isSymbolicLink() ? QTLINK : QTFILE;
    return { type, version: Math.floor(st.mtimeMs / 1000), id };
  }

  function writeQid(w: Writer, q: Qid): Writer {
    return w.u8(q.type).u32(q.version).u64(q.id);
  }

  function getFid(fid: number): Fid {
    /* Unknown fid (e.g. after a save-state restore into a fresh server):
       fall back to the share root — the guest re-walks from there and
       heals itself, instead of every I/O failing. */
    let f = fids.get(fid);
    if (!f) {
      f = { path: root };
      fids.set(fid, f);
    }
    return f;
  }

  function error(tag: number, errno: number): Uint8Array {
    return new Writer().u32(errno).build(7, tag); // Rlerror
  }

  async function handle(req: Uint8Array): Promise<Uint8Array> {
    const r = new Reader(req);
    r.u32(); // size
    const type = r.u8();
    const tag = r.u16();
    try {
      switch (type) {
        case 100: { // Tversion
          const msize = r.u32();
          const version = r.str();
          return new Writer()
            .u32(Math.min(msize, MSIZE))
            /* The kernel asks for "9P2000.L" (capital P) and aborts the
               mount unless it gets that exact string back. */
            .str(version.includes("2000.L") ? "9P2000.L" : version.includes("2000") ? "9P2000" : "unknown")
            .build(101, tag);
        }
        case 102: // Tauth — not required
          return error(tag, ENOSYS);
        case 104: { // Tattach
          const fid = r.u32();
          r.u32(); r.str(); r.str(); r.u32();
          fids.set(fid, { path: root });
          return writeQid(new Writer(), await qidFor(root)).build(105, tag);
        }
        case 108: // Tflush
          return new Writer().build(109, tag);
        case 110: { // Twalk
          const fid = r.u32(), newfid = r.u32(), nw = r.u16();
          const names: string[] = [];
          for (let i = 0; i < nw; i++) names.push(r.str());
          let cur = getFid(fid).path;
          const qids: Qid[] = [];
          for (let i = 0; i < nw; i++) {
            const next = joinRel(cur, names[i]);
            if (!inside(next)) {
              if (i === 0) return error(tag, ENOENT);
              break;
            }
            try {
              qids.push(await qidFor(next));
            } catch {
              if (i === 0) return error(tag, ENOENT);
              break;
            }
            cur = next;
          }
          if (qids.length === nw) fids.set(newfid, { path: cur });
          const out = new Writer().u16(qids.length);
          for (const q of qids) writeQid(out, q);
          return out.build(111, tag);
        }
        case 12: { // Tlopen
          const fid = r.u32(), flags = r.u32();
          const f = getFid(fid);
          const st = await fsImpl.stat(f.path);
          if (st.isDirectory()) {
            if ((flags & 3) !== 0) return error(tag, EISDIR);
          } else {
            const acc = flags & 3;
            const mode = acc === 0 ? "r" : "r+";
            f.handle = await fsImpl.open(f.path, mode);
            if (flags & 512) await f.handle.truncate(0); // O_TRUNC
          }
          return writeQid(new Writer(), await qidFor(f.path)).u32(IOUNIT).build(13, tag);
        }
        case 14: { // Tlcreate
          const fid = r.u32(), name = r.str(), flags = r.u32();
          r.u32(); r.u32();
          const f = getFid(fid);
          const path = joinRel(f.path, name);
          if (!inside(path)) return error(tag, EPERM);
          try {
            await fsImpl.stat(path);
          } catch {
            await fsImpl.writeFile(path, new Uint8Array(0));
          }
          const acc = flags & 3;
          f.path = path;
          f.handle = await fsImpl.open(path, acc === 0 ? "r" : "r+");
          if (flags & 512) await f.handle.truncate(0);
          return writeQid(new Writer(), await qidFor(path)).u32(IOUNIT).build(15, tag);
        }
        case 72: { // Tmkdir
          const fid = r.u32(), name = r.str();
          r.u32(); r.u32();
          const path = joinRel(getFid(fid).path, name);
          if (!inside(path)) return error(tag, EPERM);
          await fsImpl.mkdir(path);
          return writeQid(new Writer(), await qidFor(path)).build(73, tag);
        }
        case 40: { // Treaddir
          const fid = r.u32(), offset = r.u64(), count = r.u32();
          const f = getFid(fid);
          if (!f.dirBuf || offset === 0) {
            const names = (await fsImpl.readdir(f.path)) as unknown as string[];
            const chunks: Uint8Array[] = [];
            const ends: number[] = [];
            let total = 0;
            for (const name of names) {
              const p = joinRel(f.path, name);
              let q: Qid;
              try { q = await qidFor(p); } catch { continue; }
              const st = await fsImpl.stat(p).catch(() => null);
              const dtype = st?.isDirectory() ? 4 : st?.isSymbolicLink() ? 10 : 8;
              const entryLen = 13 + 8 + 1 + 2 + new TextEncoder().encode(name).length;
              const wpart = writeQid(new Writer(), q).u64(total + entryLen).u8(dtype).str(name);
              const bytes = wpart.build(0, 0).subarray(7);
              chunks.push(bytes);
              total += entryLen;
              ends.push(total);
            }
            f.dirBuf = new Uint8Array(total);
            let o = 0;
            for (const c of chunks) { f.dirBuf.set(c, o); o += c.length; }
            f.dirEnds = ends;
          }
          /* serve whole entries that fit in count, starting at offset */
          let end = offset;
          for (const e of f.dirEnds ?? []) {
            if (e <= offset) continue;
            if (e - offset > count) break;
            end = e;
          }
          const data = f.dirBuf.subarray(offset, end);
          return new Writer().u32(data.length).raw(data).build(41, tag);
        }
        case 24: { // Tlgetattr
          const fid = r.u32();
          r.u64();
          const f = getFid(fid);
          const st = await fsImpl.stat(f.path);
          const q = await qidFor(f.path);
          const sec = (ms: number) => Math.floor(ms / 1000);
          const nsec = (ms: number) => Math.floor((ms % 1000) * 1e6);
          const w = new Writer()
            .u64(0x7ff) // valid: all basic fields
            ;
          writeQid(w, q);
          w.u32(st.mode)
            .u32(0).u32(0) // uid, gid
            .u64(1) // nlink
            .u64(0) // rdev
            .u64(st.size)
            .u64(4096) // blksize
            .u64(Math.ceil(st.size / 512)) // blocks
            .u64(sec(st.atimeMs)).u64(nsec(st.atimeMs))
            .u64(sec(st.mtimeMs)).u64(nsec(st.mtimeMs))
            .u64(sec(st.ctimeMs)).u64(nsec(st.ctimeMs))
            .u64(0).u64(0) // btime
            .u64(0) // gen
            .u64(0); // data_version
          return w.build(25, tag);
        }
        case 26: { // Tlsetattr
          const fid = r.u32(), valid = r.u32();
          const mode = r.u32();
          r.u32(); r.u32(); // uid, gid — share is single-user, ignore
          const size = r.u64();
          const atimeSec = r.u64(), atimeNsec = r.u64();
          const mtimeSec = r.u64(), mtimeNsec = r.u64();
          const f = getFid(fid);
          /* valid bits (9p2000.L): MODE=1 SIZE=8 ATIME=16 MTIME=32
             ATIME_SET=128 MTIME_SET=256. A previous version read two
             u64s too many here, ran off the packet, and turned every
             chmod/touch/truncate into EIO. */
          if (valid & 0x1) {
            const st = await fsImpl.stat(f.path);
            /* Guest mode may or may not carry file-type bits; keep the
               real ones, take the permission bits from the guest. */
            await fsImpl.chmod(f.path, (st.mode & 0o170000) | (mode & 0o7777));
          }
          if (valid & 0x8) await fsImpl.truncate(f.path, size); // SIZE
          if (valid & 0xf0) {
            const st = await fsImpl.stat(f.path);
            const now = new Date();
            const atime = valid & 0x80
              ? new Date(atimeSec * 1000 + atimeNsec / 1e6)
              : valid & 0x10 ? now : st.atime;
            const mtime = valid & 0x100
              ? new Date(mtimeSec * 1000 + mtimeNsec / 1e6)
              : valid & 0x20 ? now : st.mtime;
            await fsImpl.utimes(f.path, atime, mtime);
          }
          return new Writer().build(27, tag);
        }
        case 116: { // Tread
          const fid = r.u32(), offset = r.u64(), count = r.u32();
          const f = getFid(fid);
          if (!f.handle) return error(tag, EINVAL);
          const buf = new Uint8Array(Math.min(count, IOUNIT));
          const res = (await f.handle.read(buf, 0, buf.length, offset)) as
            | { bytesRead: number }
            | number;
          const n = typeof res === "number" ? res : res.bytesRead;
          return new Writer().u32(n).raw(buf.subarray(0, n)).build(117, tag);
        }
        case 118: { // Twrite
          const fid = r.u32(), offset = r.u64(), count = r.u32();
          const data = r.bytes(count);
          const f = getFid(fid);
          if (!f.handle) return error(tag, EINVAL);
          const res = (await f.handle.write(data, 0, data.length, offset)) as
            | { bytesWritten: number }
            | number;
          const n = typeof res === "number" ? res : res.bytesWritten;
          return new Writer().u32(n).build(119, tag);
        }
        case 120: { // Tclunk
          const fid = r.u32();
          const f = fids.get(fid);
          if (f?.handle) await f.handle.close().catch(() => {});
          fids.delete(fid);
          return new Writer().build(121, tag);
        }
        case 122: { // Tremove
          const fid = r.u32();
          const f = getFid(fid);
          if (f.path === root) return error(tag, EPERM);
          if (f.handle) await f.handle.close().catch(() => {});
          const st = await fsImpl.stat(f.path);
          if (st.isDirectory()) await fsImpl.rmdir(f.path);
          else await fsImpl.unlink(f.path);
          fids.delete(fid);
          return new Writer().build(123, tag);
        }
        case 76: { // Tunlinkat
          const dirfid = r.u32(), name = r.str(), flags = r.u32();
          const path = joinRel(getFid(dirfid).path, name);
          if (path === root || !inside(path)) return error(tag, EPERM);
          if (flags & 512) await fsImpl.rmdir(path);
          else await fsImpl.unlink(path);
          return new Writer().build(77, tag);
        }
        case 20: { // Trename
          const fid = r.u32(), newdirfid = r.u32(), name = r.str();
          const f = getFid(fid);
          const to = joinRel(getFid(newdirfid).path, name);
          if (!inside(to) || f.path === root) return error(tag, EPERM);
          await fsImpl.rename(f.path, to);
          qidIds.set(to, qidIds.get(f.path) ?? nextQid++);
          qidIds.delete(f.path);
          f.path = to;
          return new Writer().build(21, tag);
        }
        case 74: { // Trenameat
          const od = r.u32(), oname = r.str(), nd = r.u32(), nname = r.str();
          const from = joinRel(getFid(od).path, oname);
          const to = joinRel(getFid(nd).path, nname);
          if (!inside(from) || !inside(to) || from === root) return error(tag, EPERM);
          await fsImpl.rename(from, to);
          return new Writer().build(75, tag);
        }
        case 50: // Tfsync
          return new Writer().build(51, tag);
        case 52: { // Tlock — grant everything
          return new Writer().u8(0).build(53, tag);
        }
        case 54: { // Tgetlock — nothing held
          r.u32();
          const w = new Writer().u8(2).u64(0).u64(0).u32(0).str("");
          return w.build(55, tag);
        }
        default:
          return error(tag, ENOSYS);
      }
    } catch (err) {
      logWarn("v86", `9p op ${type} failed:`, err);
      return error(tag, errnoOf(err));
    }
  }

  let logged = false;
  return (req, reply) => {
    if (!logged) {
      logged = true;
      logInfo("v86", `9p share live: guest /shared ↔ ${root}`);
    }
    void handle(req).then(reply, () => reply(error(0xffff, EIO)));
  };
}
