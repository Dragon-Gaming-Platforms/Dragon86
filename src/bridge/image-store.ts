/**
 * Image store — the copy/v86 Arch root filesystem, as a read-only base layer.
 *
 * copy.sh serves that image as `fs.json` (a tree) plus content-addressed
 * blobs under `arch/`. Nothing is ever downloaded up front: a path is
 * resolved against the tree and a blob is fetched the first time somebody
 * actually reads it, then kept in memory for the session.
 *
 * This module is deliberately dumb about the guest: it turns the JSON into a
 * path index and hands back bytes. The interesting part — making the image
 * *writable* on top of the OS filesystem — is union-fs.ts.
 */

import { logInfo, logWarn } from "../core/log";

const BLOB_RE = /^[0-9a-f]{10}\.bin(\.zst)?$/;

export interface BaseStat {
  mode: number; // POSIX st_mode (type bits + permissions)
  size: number;
  mtimeMs: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFile(): boolean;
}

export interface BaseDirEntry {
  name: string;
  isDirectory: boolean;
}

/** Read-only view the union layer layers on top of. */
export interface BaseLayer {
  stat(path: string): Promise<BaseStat | null>;
  readdir(path: string): Promise<BaseDirEntry[] | null>;
  readFile(path: string): Promise<Uint8Array | null>;
  readlink?(path: string): Promise<string | null>;
}

export function makeStat(mode: number, size: number, mtimeMs: number): BaseStat {
  return {
    mode,
    size,
    mtimeMs,
    isDirectory: () => (mode & 0o170000) === 0o040000,
    isSymbolicLink: () => (mode & 0o170000) === 0o120000,
    isFile: () => (mode & 0o170000) === 0o100000,
  };
}

/**
 * fs.json node layout (upstream fs2json.py):
 *   [name, size, mtime, mode, uid, gid, last]
 * `last` is a blob filename, a symlink target, or a child array; upstream
 * trims trailing nulls, so short nodes are empty directories.
 */
interface Node {
  name: string;
  size: number;
  mtime: number;
  mode: number;
  last: string | Node[] | null;
}

function asNode(raw: unknown): Node | null {
  if (!Array.isArray(raw) || raw.length === 0 || typeof raw[0] !== "string") return null;
  return {
    name: raw[0] as string,
    size: (raw[1] as number) ?? 0,
    mtime: (raw[2] as number) ?? 0,
    mode: (raw[3] as number) ?? 0o100644,
    last: (raw[6] as string | unknown[] | undefined) ?? null,
  } as Node;
}

export class ImageStore implements BaseLayer {
  private blobs = new Map<string, Uint8Array>();
  private links = 0;
  private bytes = 0;

  private constructor(
    private base: string,
    private entries: Map<string, Node>,
  ) {}

  /** Fetch fs.json, index the tree, return a ready store. */
  static async load(baseRaw: string, signal?: AbortSignal): Promise<ImageStore> {
    const base = baseRaw.endsWith("/") ? baseRaw : `${baseRaw}/`;
    const res = await fetch(`${base}fs.json`, { signal, cache: "no-cache" });
    if (!res.ok) throw new Error(`fs.json: HTTP ${res.status} from ${base}`);
    const doc = (await res.json()) as { fsroot?: unknown[] };
    const rootNodes = Array.isArray(doc.fsroot) ? doc.fsroot : (doc as unknown as unknown[]);
    const entries = new Map<string, Node>();

    const walk = (raw: unknown, parent: string): void => {
      const node = asNode(raw);
      if (!node) return;
      const path = parent === "/" ? `/${node.name}` : `${parent}/${node.name}`;
      entries.set(path, node);
      if (Array.isArray(node.last)) {
        for (const child of node.last) walk(child, path);
      }
    };
    for (const raw of rootNodes) walk(raw, "/");

    const store = new ImageStore(base, entries);
    store.links = [...entries.values()].filter(
      (n) => typeof n.last === "string" && BLOB_RE.test(n.last),
    ).length;
    logInfo("image", `indexed ${entries.size} paths, ${store.links} blobs, from ${base}fs.json`);
    return store;
  }

  get baseUrl(): string {
    return this.base;
  }

  get blobCount(): number {
    return this.links;
  }

  get cachedBytes(): number {
    return this.bytes;
  }

  private node(path: string): Node | undefined {
    return this.entries.get(path === "" ? "/" : path);
  }

  async stat(path: string): Promise<BaseStat | null> {
    const n = this.node(path);
    if (!n) return null;
    if (Array.isArray(n.last) || n.last === null) return makeStat(n.mode | 0o040000, 0, n.mtime * 1000);
    if (BLOB_RE.test(n.last)) return makeStat(n.mode | 0o100000, n.size, n.mtime * 1000);
    return makeStat(n.mode | 0o120000, n.last.length, n.mtime * 1000);
  }

  async readdir(path: string): Promise<BaseDirEntry[] | null> {
    const n = this.node(path);
    if (!n) return null;
    const out: BaseDirEntry[] = [];
    if (Array.isArray(n.last)) {
      for (const child of n.last) {
        const c = asNode(child);
        if (!c) continue;
        out.push({
          name: c.name,
          isDirectory: Array.isArray(c.last) || c.last === null,
        });
      }
    }
    return out;
  }

  async readlink(path: string): Promise<string | null> {
    const n = this.node(path);
    if (!n || typeof n.last !== "string" || BLOB_RE.test(n.last)) return null;
    return n.last;
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const n = this.node(path);
    if (!n || typeof n.last !== "string" || !BLOB_RE.test(n.last)) {
      if (n && Array.isArray(n.last)) return new Uint8Array(0);
      return null;
    }
    const hit = this.blobs.get(n.last);
    if (hit) return hit;

    const res = await fetch(`${this.base}arch/${n.last}`, { cache: "force-cache" });
    if (!res.ok) throw new Error(`blob ${n.last}: HTTP ${res.status}`);
    let data: Uint8Array<ArrayBuffer> = new Uint8Array(await res.arrayBuffer());
    if (n.last.endsWith(".zst")) data = await unzstd(data);
    this.blobs.set(n.last, data);
    this.bytes += data.byteLength;
    return data;
  }

  /** Every path in the image, depth-first, for materialising the tree. */
  paths(): string[] {
    return [...this.entries.keys()].sort();
  }

  /**
   * Find the kernel and initrd the way upstream does: /vmlinuz|bzimage and
   * /initrd|initramfs, in / or /boot, skipping *old* / *fallback* builds.
   */
  findKernel(): { kernel: string | null; initrd: string | null } {
    let kernel: string | null = null;
    let initrd: string | null = null;
    for (const path of this.entries.keys()) {
      /* Only the image root and /boot, like upstream — a plain depth check
         would also match /etc/initrd-release, which is not an initrd. */
      if (!/^\/[^/]+$/.test(path) && !/^\/boot\/[^/]+$/.test(path)) continue;
      const stale = /old|fallback/i.test(path);
      if (/vmlinuz|bzimage/i.test(path) && (!kernel || !stale)) kernel = path;
      if (/initrd|initramfs/i.test(path) && (!initrd || !stale)) initrd = path;
    }
    return { kernel, initrd };
  }
}

/** zstd blobs: the platform API where available, a clear error otherwise. */
async function unzstd(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (DS) {
    for (const fmt of ["zstd", "zstandard"] as const) {
      try {
        const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS(fmt as CompressionFormat));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch {
        /* try the next spelling */
      }
    }
  }
  logWarn("image", "this browser cannot decompress zstd blobs (needs DecompressionStream('zstd'))");
  throw new Error("zstd decompression unsupported in this browser");
}
