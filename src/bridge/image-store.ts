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

import { fs } from "@zenfs/core";
import { decompress as fzstd } from "fzstd";
import { logInfo, logWarn } from "../core/log";

/*
 * A content blob is named after a *prefix of the sha256* of its contents, so
 * `<hex>.bin`. The length of that prefix is a property of whichever fs2json
 * built the image, not of the format: copy.sh's current Arch image uses 8
 * (`e3b0c442.bin` is the empty file), older ones used 10. Accept any sane
 * prefix length — pinning it to 10 made every file in this image look like a
 * symlink, which is a quiet way to hand the guest an unusable root.
 */
/**
 * Options for every request that leaves our origin.
 *
 * The image store is behind a CDN with a referer check: with a Referer it
 * answers 200 `application/json` with `Access-Control-Allow-Origin: *`; with
 * no Referer it refuses the connection outright. Browsers normally send a
 * referrer cross-origin, but not always — a strict Referrer-Policy, Safari's
 * tracking protections, or a stripped header all turn every image request
 * into an opaque failure. Asking for `origin` explicitly makes the header
 * non-optional, which is the difference between booting and not.
 */
const CROSS_ORIGIN: RequestInit = { referrerPolicy: "origin", credentials: "omit" };

const BLOB_RE = /^[0-9a-f]{4,64}\.bin(\.zst)?$/;

/** Is this string a blob name (a file's contents) rather than a symlink target? */
export function isBlobName(name: string): boolean {
  return BLOB_RE.test(name);
}

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

/** Where the list came from — shown in Settings and the Terminal. */
export type ListSource = "shipped" | "vendored" | "live";

/** ZenFS path of a vendored list (per image base is overkill: one at a time). */
export const VENDORED_LIST = (root: string): string => `${root}/.dragon86-image-fs.json`;

interface VendoredRecord {
  base: string;
  savedAt: number;
  bytes: number;
  json: string;
}

export class ImageStore implements BaseLayer {
  private blobs = new Map<string, Uint8Array>();
  /** Set once the mirror has served a blob, so the log says it only once. */
  private mirrorNoted = false;
  /** Where to report "blobs are coming from the mirror" (the Terminal). */
  private notice: ((text: string) => void) | null = null;
  private links = 0;
  private bytes = 0;

  private constructor(
    private base: string,
    private entries: Map<string, Node>,
    public readonly source: ListSource,
    /** Optional same-list mirror to retry against when `base` refuses a blob. */
    private fallback: string | null = null,
  ) {}

  /**
   * Resolve the image index and index it.
   *
   * Order matters and is deliberate:
   *   1. `shipped`  — public/v86/fs.json, vendored into the build
   *                   (tools/arch-image/mirror.py --list-only). Same origin, no CORS, no
   *                   network dependency.
   *   2. `vendored` — a list this browser kept in ZenFS from an earlier run
   *                   (see vendorList()), which is what makes boots offline
   *                   and instant after the first visit.
   *   3. `live`     — fs.json from the configured image store, then kept in
   *                   ZenFS so the next boot is case 2.
   *
   * Only file *contents* always come from the image store.
   */
  static async load(
    baseRaw: string,
    opts: {
      root?: string;
      shippedUrl?: string;
      signal?: AbortSignal;
      fallbackBase?: string;
      /** Called once with a human sentence about where blobs will come from. */
      onNotice?: (text: string) => void;
    } = {},
  ): Promise<ImageStore> {
    const base = baseRaw.endsWith("/") ? baseRaw : `${baseRaw}/`;
    const fallback = opts.fallbackBase ? normalizeBase(opts.fallbackBase) : null;

    const fromShipped = async (): Promise<string | null> => {
      const url = opts.shippedUrl ?? `${import.meta.env.BASE_URL}v86/fs.json`;
      try {
        const res = await fetch(url, { signal: opts.signal, cache: "no-cache" });
        if (!res.ok) return null;
        const text = await res.text();
        /* A dev server or Pages SPA fallback answers 200 with index.html for
           a missing path. An image list is one JSON object; anything else is
           not a list, so treat it as absent rather than as a parse error. */
        if (!text.trimStart().startsWith("{")) return null;
        logInfo("image", `using the shipped image list (${url})`);
        return text;
      } catch {
        return null;
      }
    };

    const fromVendored = async (): Promise<string | null> => {
      if (!opts.root) return null;
      try {
        const raw = await fs.promises.readFile(VENDORED_LIST(opts.root), "utf8");
        const rec = JSON.parse(raw) as VendoredRecord;
        logInfo(
          "image",
          `using the vendored image list (${(rec.bytes / 1048576).toFixed(1)} MB, saved ${new Date(rec.savedAt).toLocaleString()})`,
        );
        return rec.json;
      } catch {
        return null;
      }
    };

    const fromLive = async (): Promise<string | null> => {
      const get = async (url: string): Promise<string | null> => {
        try {
          const res = await fetch(url, { signal: opts.signal, cache: "no-cache", ...CROSS_ORIGIN });
          if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
          const text = await res.text();
          return text.trimStart().startsWith("{") ? text : null;
        } catch (err) {
          logWarn("image", "could not fetch fs.json:", err);
          return null;
        }
      };
      const direct = await get(`${base}fs.json`);
      if (direct) return direct;
      if (!fallback) return null;
      logWarn("image", `retrying the image list from the mirror at ${fallback}`);
      return get(`${fallback}fs.json`);
    };

    let text = await fromShipped();
    let source: ListSource = "shipped";
    if (!text) {
      text = await fromVendored();
      source = "vendored";
    }
    if (!text) {
      text = await fromLive();
      source = "live";
    }
    if (!text) {
      throw new Error(
        `no image list for ${base}: no shipped copy at public/v86/fs.json, nothing vendored on this device, ` +
          `and the origin did not serve fs.json (check Settings -> v86 image -> Test)`,
      );
    }

    const store = ImageStore.parse(text, base, source, fallback);
    store.notice = opts.onNotice ?? null;
    /* First successful live fetch: keep it, so this source is only needed once. */
    if (source === "live" && opts.root) {
      void store.persistList(text, opts.root).catch(() => {});
    }
    return store;
  }

  /** Parse a document (shipped, vendored or fetched) into an indexed store. */
  static parse(text: string, baseRaw: string, source: ListSource, fallback: string | null = null): ImageStore {
    const base = baseRaw.endsWith("/") ? baseRaw : `${baseRaw}/`;
    let doc: { fsroot?: unknown[] };
    try {
      doc = JSON.parse(text) as { fsroot?: unknown[] };
    } catch (err) {
      throw new Error(`image list is not valid JSON (${(err as Error).message})`);
    }
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
    if (entries.size === 0) throw new Error("image list has no entries");

    const store = new ImageStore(base, entries, source, fallback);
    store.links = [...entries.values()].filter(
      (n) => typeof n.last === "string" && BLOB_RE.test(n.last),
    ).length;
    logInfo(
      "image",
      `indexed ${entries.size} paths, ${store.links} blobs from the ${source} list (${base})`,
    );
    return store;
  }

  /** Save a list in ZenFS so later boots need no network for the index. */
  async persistList(text: string, root: string): Promise<void> {
    const rec: VendoredRecord = {
      base: this.base,
      savedAt: Date.now(),
      bytes: text.length,
      json: text,
    };
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.writeFile(VENDORED_LIST(root), JSON.stringify(rec));
    logInfo("image", `image list vendored at ${VENDORED_LIST(root)} (${(text.length / 1048576).toFixed(1)} MB)`);
  }

  /** Drop the vendored list (Settings -> v86 image -> Clear vendored list). */
  static async clearVendored(root: string): Promise<boolean> {
    try {
      await fs.promises.unlink(VENDORED_LIST(root));
      logInfo("image", "vendored image list removed");
      return true;
    } catch {
      return false;
    }
  }

  /** Is a list vendored on this device, and how big is it? */
  static async vendoredInfo(root: string): Promise<{ savedAt: number; bytes: number } | null> {
    try {
      const rec = JSON.parse(await fs.promises.readFile(VENDORED_LIST(root), "utf8")) as VendoredRecord;
      return { savedAt: rec.savedAt, bytes: rec.bytes };
    } catch {
      return null;
    }
  }

  /**
   * Fetch the list from the image store and keep it, now. This is the
   * explicit "vendor it" action: it runs in the user's browser, where the
   * origin is reachable, and makes the tree available offline afterwards.
   */
  static async vendorList(baseRaw: string, root: string): Promise<{ bytes: number; paths: number; blobs: number }> {
    const base = baseRaw.endsWith("/") ? baseRaw : `${baseRaw}/`;
    const res = await fetch(`${base}fs.json`, { cache: "no-cache", ...CROSS_ORIGIN });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}fs.json`);
    const text = await res.text();
    const store = ImageStore.parse(text, base, "live");
    await store.persistList(text, root);
    return { bytes: text.length, paths: store.entries.size, blobs: store.links };
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

    const fetched = await this.fetchBlob(n.last);
    let data: Uint8Array<ArrayBuffer> = fetched;
    if (n.last.endsWith(".zst")) data = await unzstd(data);
    this.blobs.set(n.last, data);
    this.bytes += data.byteLength;
    return data;
  }

  /**
   * Download one content blob: mirror first, origin second.
   *
   * Measured, not assumed (docs/fs-probe.md): the upstream store sends
   * `Access-Control-Allow-Origin: *` but only answers requests whose
   * `Referer` is copy.sh's own — with our origin as the referrer it returns
   * 403, and with no referrer at all it drops the connection. `Referer` is a
   * forbidden header, so no page can forge one. That is true of *every*
   * browser, not just Safari, which means the mirror is not a fallback: it is
   * the source, and the origin is the fallback for whatever the mirror does
   * not carry (a 404 there).
   */
  private async fetchBlob(name: string): Promise<Uint8Array<ArrayBuffer>> {
    const origin = `${this.base}arch/${name}`;
    const mirrored = this.fallback ? `${this.fallback}arch/${name}` : null;
    const attempts = mirrored ? [mirrored, origin] : [origin];

    const failures: string[] = [];
    for (const url of attempts) {
      let res: Response | null = null;
      try {
        res = await fetch(url, { cache: "force-cache", ...CROSS_ORIGIN });
      } catch (err) {
        failures.push(`${url}: ${(err as Error).message}`);
        continue;
      }
      if (res.ok) {
        if (url !== origin) this.noteMirrorUsed(name);
        return new Uint8Array(await res.arrayBuffer());
      }
      failures.push(`${url}: HTTP ${res.status}`);
    }
    throw new Error(`blob ${name}: ${failures.join("; ")}`);
  }

  /** Say once per boot that the mirror is what is feeding the guest. */
  private noteMirrorUsed(name: string): void {
    if (this.mirrorNoted) return;
    this.mirrorNoted = true;
    const where = this.fallback ?? "";
    logInfo("image", `blobs are coming from the vendored mirror (${where}); started with ${name}`);
    this.notice?.(`blobs: vendored mirror (${where.replace(/^https?:\/\//, "").replace(/\/$/, "")})`);
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

/** Can this browser inflate zstd natively, or are we relying on fzstd? */
export function zstdSupport(): "native" | "built-in" {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  let native = false;
  if (DS) {
    try {
      new DS("zstd" as CompressionFormat);
      native = true;
    } catch {
      native = false;
    }
  }
  return native ? "native" : "built-in";
}

/**
 * zstd blobs. Chromium has had `DecompressionStream("zstd")` since 123; other
 * engines may not (Safari, notably), and a guest cannot boot with half its
 * files unreadable — so the shipped `fzstd` decoder is the fallback. Same
 * bytes in, same bytes out; only the speed differs.
 */
async function unzstd(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (DS) {
    for (const fmt of ["zstd", "zstandard"] as const) {
      try {
        const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS(fmt as CompressionFormat));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch {
        /* try the next spelling, then the fallback decoder */
      }
    }
  }
  try {
    return fzstd(data) as Uint8Array<ArrayBuffer>;
  } catch (err) {
    logWarn("image", "zstd decompression failed in this browser:", err);
    throw new Error(`zstd blob could not be decompressed (${(err as Error).message})`);
  }
}

/** Normalise a mirror base the way the setting does (no trailing-slash games). */
function normalizeBase(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  return withScheme.endsWith("/") ? withScheme : `${withScheme}/`;
}
