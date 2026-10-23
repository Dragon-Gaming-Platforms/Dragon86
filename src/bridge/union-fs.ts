/**
 * Union filesystem — a read-only image with ZenFS on top, presented to the
 * 9p server as if it were one ordinary filesystem.
 *
 * This is what makes the full Arch root "available for edit in ZenFS".
 * Layout on the OS side:
 *
 *   /home/user/v86/…      the guest's whole root, writable and persistent
 *   /home/user/v86/shared the guest's /shared folder
 *
 * Reads that ZenFS cannot satisfy come from the image store (copy.sh's
 * fs.json + blobs). The first *write* to an image file copies it up into
 * ZenFS — the classic overlay trick — so edits land in IndexedDB and are
 * visible in the Files app, while untouched files stay lazy and cost
 * nothing. Deletions of image files are recorded as whiteouts so they do not
 * reappear on the next read.
 *
 * The same class serves the shared folder: ZenFS is the floor (your existing
 * Files), /home/user/v86/shared is where changes go.
 */

import { fs } from "@zenfs/core";
import { logInfo } from "../core/log";
import type { BaseLayer, BaseStat } from "./image-store";

const WHITEOUT_FILE = ".dragon86-whiteouts.json";

export interface UnionStat extends BaseStat {
  /** Where this path actually lives ("upper" = ZenFS, "base" = image). */
  origin: "upper" | "base";
}

interface UHandle {
  read(buf: Uint8Array, off: number, len: number, pos: number): Promise<number>;
  write(buf: Uint8Array, off: number, len: number, pos: number): Promise<number>;
  truncate(len: number): Promise<void>;
  close(): Promise<void>;
}

export interface UnionFs {
  root: string;
  stat(path: string): Promise<UnionStat>;
  readdir(path: string): Promise<string[]>;
  open(path: string, flags: string): Promise<UHandle>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  truncate(path: string, length: number): Promise<void>;
  utimes(path: string, atime: number, mtime: number): Promise<void>;
  readlink(path: string): Promise<string>;
  /** Force a path out of the image into ZenFS (used by the Files app). */
  materialize(path: string): Promise<void>;
}

const parentOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};

type FsError = Error & { code?: string };

const notFound = (p: string): FsError => {
  const e = new Error(`ENOENT: ${p}`) as FsError;
  e.code = "ENOENT";
  return e;
};

export function createUnionFs(upperRoot: string, base: BaseLayer): UnionFs {
  const basePath = (p: string): string | null => {
    if (p === upperRoot) return "/";
    if (!p.startsWith(`${upperRoot}/`)) return null;
    return p.slice(upperRoot.length) || "/";
  };

  /* ---- whiteouts (deleted image paths), persisted in the upper root ---- */
  const whiteouts = new Set<string>();
  let whiteoutsLoaded = false;
  let whiteoutsDirty = false;

  async function loadWhiteouts(): Promise<void> {
    if (whiteoutsLoaded) return;
    whiteoutsLoaded = true;
    try {
      const raw = await fs.promises.readFile(`${upperRoot}/${WHITEOUT_FILE}`, "utf8");
      for (const p of JSON.parse(raw) as string[]) whiteouts.add(p);
    } catch {
      /* none yet */
    }
  }

  function saveWhiteouts(): void {
    whiteoutsDirty = true;
    queueMicrotask(() => {
      if (!whiteoutsDirty) return;
      whiteoutsDirty = false;
      const data = JSON.stringify([...whiteouts].sort());
      void fs.promises.mkdir(upperRoot, { recursive: true })
        .then(() => fs.promises.writeFile(`${upperRoot}/${WHITEOUT_FILE}`, data))
        .catch(() => {});
    });
  }

  const isDeleted = (key: string): boolean => {
    if (whiteouts.has(key)) return true;
    /* A deleted directory hides everything beneath it. */
    let p = key;
    while (p !== "/" && p !== "") {
      p = parentOf(p);
      if (whiteouts.has(p)) return true;
    }
    return false;
  };

  async function upperStat(p: string) {
    try {
      return await fs.promises.stat(p);
    } catch {
      return null;
    }
  }

  async function baseStatFor(p: string): Promise<BaseStat | null> {
    const rel = basePath(p);
    if (rel === null || isDeleted(rel)) return null;
    return base.stat(rel);
  }

  async function stat(p: string): Promise<UnionStat> {
    await loadWhiteouts();
    const up = await upperStat(p);
    if (up) {
      const st = up as unknown as BaseStat;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { origin: "upper" as const });
    }
    const bs = await baseStatFor(p);
    if (bs) return Object.assign(bs, { origin: "base" as const });
    throw notFound(p);
  }

  async function readdir(p: string): Promise<string[]> {
    await loadWhiteouts();
    const names = new Set<string>();
    const rel = basePath(p);
    if (rel !== null) {
      const entries = await base.readdir(rel);
      for (const e of entries ?? []) {
        if (isDeleted(rel === "/" ? `/${e.name}` : `${rel}/${e.name}`)) continue;
        names.add(e.name);
      }
    }
    try {
      for (const name of await fs.promises.readdir(p)) {
        if (name !== WHITEOUT_FILE) names.add(name);
      }
    } catch {
      /* upper dir missing: image-only directory */
    }
    return [...names];
  }

  /** Ensure the upper directory chain for `p` exists. */
  async function ensureUpperDir(p: string): Promise<void> {
    if (p === "/" || p === "") return;
    await fs.promises.mkdir(p, { recursive: true });
  }

  /** Copy an image file up into ZenFS so it can be modified. */
  async function copyUp(p: string): Promise<void> {
    const rel = basePath(p);
    if (rel === null) return;
    if (await upperStat(p)) return;
    const bs = await base.stat(rel);
    if (!bs) throw notFound(p);
    await ensureUpperDir(p.slice(0, p.lastIndexOf("/")) || "/");
    if (bs.isDirectory()) {
      await fs.promises.mkdir(p, { recursive: true });
      return;
    }
    if (bs.isSymbolicLink()) {
      const target = (await base.readlink?.(rel)) ?? null;
      if (target) {
        try {
          await fs.promises.symlink(target, p);
          return;
        } catch {
          /* ZenFS may not do symlinks — fall through to an empty file */
        }
      }
      await fs.promises.writeFile(p, new Uint8Array(0));
      return;
    }
    const data = (await base.readFile(rel)) ?? new Uint8Array(0);
    await fs.promises.writeFile(p, data);
  }

  async function open(p: string, flags: string): Promise<UHandle> {
    await loadWhiteouts();
    const writable = flags.includes("+") || flags.includes("w") || flags.includes("a");
    const up = await upperStat(p);
    if (!up && writable) await copyUp(p); // may throw ENOENT for a new file
    if (!up && !writable) {
      /* Reads may be served straight from the image; writes to such a file
         copy it up first (see the wrapper below). */
      const bs = await baseStatFor(p);
      if (!bs) throw notFound(p);
      if (bs.isDirectory()) return directoryHandle();
      const rel = basePath(p)!;
      const bytes = (await base.readFile(rel)) ?? new Uint8Array(0);
      return imageHandle(p, bytes);
    }
    const handle = (await fs.promises.open(p, writable ? (flags.includes("w") ? "w+" : "r+") : "r")) as unknown as UHandle;
    return handle;
  }

  function directoryHandle(): UHandle {
    return {
      async read() { return 0; },
      async write() { throw Object.assign(new Error("EISDIR"), { code: "EISDIR" }); },
      async truncate() { throw Object.assign(new Error("EISDIR"), { code: "EISDIR" }); },
      async close() {},
    };
  }

  /** Handle over image bytes: reads are local, the first write copies up. */
  function imageHandle(path: string, initial: Uint8Array): UHandle {
    let data = initial;
    const real: UHandle | null = null;
    const flush = async (): Promise<void> => {
      await ensureUpperDir(path.slice(0, path.lastIndexOf("/")) || "/");
      await fs.promises.writeFile(path, data);
    };
    return {
      async read(buf, off, len, pos) {
        if (real) return (real as UHandle).read(buf, off, len, pos);
        const slice = data.subarray(pos, pos + len);
        buf.set(slice, off);
        return slice.byteLength;
      },
      async write(buf, off, len, pos) {
        if (real) return (real as UHandle).write(buf, off, len, pos);
        const end = pos + len;
        if (end > data.byteLength) {
          const grown = new Uint8Array(end);
          grown.set(data);
          data = grown;
        }
        data.set(buf.subarray(off, off + len), pos);
        await flush();
        return len;
      },
      async truncate(len) {
        if (real) return (real as UHandle).truncate(len);
        const next = new Uint8Array(len);
        next.set(data.subarray(0, Math.min(len, data.byteLength)));
        data = next;
        await flush();
      },
      async close() {
        if (real) return (real as UHandle).close();
        if (!(await upperStat(path))) await flush();
      },
    };
  }

  async function readFile(p: string): Promise<Uint8Array> {
    await loadWhiteouts();
    if (await upperStat(p)) return new Uint8Array(await fs.promises.readFile(p));
    const rel = basePath(p);
    if (rel !== null) {
      const data = await base.readFile(rel);
      if (data) return data;
    }
    throw notFound(p);
  }

  async function writeFile(p: string, data: Uint8Array): Promise<void> {
    await ensureUpperDir(p.slice(0, p.lastIndexOf("/")) || "/");
    await fs.promises.writeFile(p, data);
  }

  async function mkdir(p: string): Promise<void> {
    await fs.promises.mkdir(p);
  }

  async function unlink(p: string): Promise<void> {
    await loadWhiteouts();
    const up = await upperStat(p);
    if (up) {
      await fs.promises.unlink(p);
      return;
    }
    const rel = basePath(p);
    if (rel !== null && (await base.stat(rel))) {
      whiteouts.add(rel);
      saveWhiteouts();
      return;
    }
    throw notFound(p);
  }

  async function rmdir(p: string): Promise<void> {
    await loadWhiteouts();
    const names = await readdir(p);
    if (names.length > 0) {
      throw Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" });
    }
    const up = await upperStat(p);
    if (up) {
      await fs.promises.rmdir(p);
      return;
    }
    const rel = basePath(p);
    if (rel !== null) {
      whiteouts.add(rel);
      saveWhiteouts();
      return;
    }
    throw notFound(p);
  }

  async function rename(from: string, to: string): Promise<void> {
    await loadWhiteouts();
    if (!(await upperStat(from))) await copyUp(from);
    await ensureUpperDir(to.slice(0, to.lastIndexOf("/")) || "/");
    await fs.promises.rename(from, to);
    const relFrom = basePath(from);
    if (relFrom !== null && whiteouts.has(relFrom)) whiteouts.delete(relFrom);
    const relTo = basePath(to);
    if (relTo !== null && (await base.stat(relTo)) && !whiteouts.has(relTo)) {
      /* Overwriting an image file with a renamed one: the upper copy wins,
         and a stale image entry must not peek through. */
      whiteouts.add(relTo);
      saveWhiteouts();
    }
  }

  async function chmod(p: string, mode: number): Promise<void> {
    await loadWhiteouts();
    if (!(await upperStat(p))) {
      const bs = await baseStatFor(p);
      if (!bs) throw notFound(p);
      if (mode === bs.mode) return; // no-op on the image: nothing to record
      await copyUp(p);
    }
    await fs.promises.chmod(p, mode);
  }

  async function truncate(p: string, length: number): Promise<void> {
    if (!(await upperStat(p))) await copyUp(p);
    await fs.promises.truncate(p, length);
  }

  async function utimes(p: string, atime: number, mtime: number): Promise<void> {
    if (!(await upperStat(p))) await copyUp(p);
    await fs.promises.utimes(p, atime, mtime);
  }

  async function readlink(p: string): Promise<string> {
    if (await upperStat(p)) return fs.promises.readlink(p);
    const rel = basePath(p);
    const target = rel !== null ? await base.readlink?.(rel) : null;
    if (!target) throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
    return target;
  }

  /** Pull a path (or a whole directory) out of the image into ZenFS. */
  async function materialize(p: string): Promise<void> {
    await loadWhiteouts();
    if (await upperStat(p)) return;
    const bs = await baseStatFor(p);
    if (!bs) throw notFound(p);
    if (bs.isDirectory()) {
      await fs.promises.mkdir(p, { recursive: true });
      for (const name of (await readdir(p))) {
        await materialize(`${p}/${name}`);
      }
      return;
    }
    await copyUp(p);
  }

  logInfo("union", `upper=${upperRoot}`);

  return {
    root: upperRoot,
    stat,
    readdir,
    open,
    readFile,
    writeFile,
    mkdir,
    unlink,
    rmdir,
    rename,
    chmod,
    truncate,
    utimes,
    readlink,
    materialize,
  };
}

/** A BaseLayer over a ZenFS directory — used for the shared folder's floor. */
export function zenfsBase(root: string, hide: string[] = []): BaseLayer {
  const rel = (p: string): string => (p === "/" ? root : `${root}${p}`);
  const hidden = (p: string): boolean => hide.some((h) => p === `/${h}` || p.startsWith(`/${h}/`));
  return {
    async stat(p) {
      if (hidden(p)) return null;
      try {
        const st = await fs.promises.stat(rel(p));
        return {
          mode: st.mode,
          size: st.size,
          mtimeMs: st.mtimeMs,
          isDirectory: () => st.isDirectory(),
          isSymbolicLink: () => st.isSymbolicLink(),
          isFile: () => st.isFile(),
        };
      } catch {
        return null;
      }
    },
    async readdir(p) {
      if (hidden(p)) return null;
      try {
        const names = await fs.promises.readdir(rel(p));
        const out = [];
        for (const name of names) {
          if (hidden(`${p === "/" ? "" : p}/${name}`)) continue;
          out.push({ name, isDirectory: (await fs.promises.stat(`${rel(p)}/${name}`)).isDirectory() });
        }
        return out;
      } catch {
        return null;
      }
    },
    async readFile(p) {
      if (hidden(p)) return null;
      try {
        return new Uint8Array(await fs.promises.readFile(rel(p)));
      } catch {
        return null;
      }
    },
    async readlink(p) {
      if (hidden(p)) return null;
      try {
        return await fs.promises.readlink(rel(p));
      } catch {
        return null;
      }
    },
  };
}

/**
 * Present a UnionFs in the shape the 9p server expects (the subset of
 * `fs.promises` p9.ts calls). Keeps p9.ts unchanged and honest: it does not
 * need to know an image sits underneath.
 */
export function unionAsPromises(u: UnionFs): {
  stat(p: string): Promise<{
    mode: number; size: number; mtimeMs: number; atimeMs: number; ctimeMs: number;
    isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean;
  }>;
  readdir(p: string): Promise<string[]>;
  open(p: string, flags: string): Promise<UHandle>;
  readFile(p: string): Promise<Uint8Array>;
  writeFile(p: string, data: Uint8Array): Promise<void>;
  mkdir(p: string, opts?: unknown): Promise<void>;
  unlink(p: string): Promise<void>;
  rmdir(p: string): Promise<void>;
  rename(a: string, b: string): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
  truncate(p: string, n: number): Promise<void>;
  utimes(p: string, a: number, m: number): Promise<void>;
  readlink(p: string): Promise<string>;
} {
  return {
    async stat(p) {
      const st = await u.stat(p);
      const ms = st.mtimeMs || 0;
      return {
        mode: st.mode,
        size: st.size,
        mtimeMs: ms,
        atimeMs: ms,
        ctimeMs: ms,
        isDirectory: () => st.isDirectory(),
        isSymbolicLink: () => st.isSymbolicLink(),
        isFile: () => st.isFile(),
      };
    },
    readdir: (p) => u.readdir(p),
    open: (p, flags) => u.open(p, flags),
    readFile: (p) => u.readFile(p),
    writeFile: (p, data) => u.writeFile(p, data),
    mkdir: async (p) => {
      /* mkdir -p spirit: intermediate dirs may still be image-only. */
      try {
        await u.stat(p);
        return;
      } catch {
        /* not there yet */
      }
      try {
        await u.mkdir(p);
      } catch (err) {
        if ((err as { code?: string }).code === "EEXIST") return;
        throw err;
      }
    },
    unlink: (p) => u.unlink(p),
    rmdir: (p) => u.rmdir(p),
    rename: (a, b) => u.rename(a, b),
    chmod: (p, mode) => u.chmod(p, mode),
    truncate: (p, n) => u.truncate(p, n),
    utimes: (p, a, m) => u.utimes(p, a, m),
    readlink: (p) => u.readlink(p),
  };
}

/**
 * Graft another UnionFs at a path inside this one — how the guest's
 * `/shared` is served out of the OS home while `/` is the Arch image.
 */
export function withSubmount(fs: UnionFs, mount: string, sub: UnionFs): UnionFs {
  const target = (p: string): { fs: UnionFs; path: string } | null => {
    if (p !== mount && !p.startsWith(`${mount}/`)) return null;
    return { fs: sub, path: `${sub.root}${p.slice(mount.length)}`.replace(/\/+/g, "/") };
  };
  const wrap = (fn: (f: UnionFs, p: string, ...rest: never[]) => Promise<unknown>) =>
    async (p: string, ...rest: unknown[]): Promise<never> => {
      const t = target(p);
      const f = t ? t.fs : fs;
      const path = t ? t.path : p;
      return (await (fn as unknown as (a: UnionFs, b: string, ...c: unknown[]) => Promise<unknown>)(f, path, ...rest)) as never;
    };
  const writeThrough = async (p: string, d: Uint8Array): Promise<void> => {
    const t = target(p);
    return t ? t.fs.writeFile(t.path, d) : fs.writeFile(p, d);
  };
  const chmodThrough = async (p: string, m: number): Promise<void> => {
    const t = target(p);
    return t ? t.fs.chmod(t.path, m) : fs.chmod(p, m);
  };
  const truncateThrough = async (p: string, n: number): Promise<void> => {
    const t = target(p);
    return t ? t.fs.truncate(t.path, n) : fs.truncate(p, n);
  };
  const utimesThrough = async (p: string, a: number, m: number): Promise<void> => {
    const t = target(p);
    return t ? t.fs.utimes(t.path, a, m) : fs.utimes(p, a, m);
  };

  return {
    root: fs.root,
    stat: wrap((f, p) => f.stat(p)),
    readdir: wrap((f, p) => f.readdir(p)),
    readFile: wrap((f, p) => f.readFile(p)),
    writeFile: (p, d) => writeThrough(p, d),
    mkdir: wrap((f, p) => f.mkdir(p)),
    unlink: wrap((f, p) => f.unlink(p)),
    rmdir: wrap((f, p) => f.rmdir(p)),
    chmod: (p, m) => chmodThrough(p, m),
    truncate: (p, n) => truncateThrough(p, n),
    utimes: (p, a, m) => utimesThrough(p, a, m),
    readlink: wrap((f, p) => f.readlink(p)),
    materialize: wrap((f, p) => f.materialize(p)),
    open: async (p, flags) => {
      const t = target(p);
      return t ? t.fs.open(t.path, flags) : fs.open(p, flags);
    },
    rename: async (from, to) => {
      const a = target(from);
      const b = target(to);
      if (a && b && a.fs === b.fs) return a.fs.rename(a.path, b.path);
      if (!a && !b) return fs.rename(from, to);
      throw Object.assign(new Error("EXDEV: cross-device rename"), { code: "EXDEV" });
    },
  };
}
