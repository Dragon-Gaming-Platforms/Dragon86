/**
 * Full-Arch image store: probing and boot configuration.
 *
 * copy/v86's Arch demo has no disk image. It boots `root=host9p` and v86
 * serves the entire root filesystem over 9p from a flat, content-addressed
 * HTTP store: `fs.json` (the directory tree) plus `arch/<sha256-10>.bin`
 * blobs, fetched lazily as the guest touches them.
 *
 * Those files live on a different origin (`i.copy.sh`), so this only works
 * if that host sends permissive CORS headers — it must, because copy.sh's
 * own page is a different origin from i.copy.sh and fetches the same URLs.
 * A CORS block is the one failure mode we can't fix from here, so
 * `probeImage()` exists to report it precisely on the device instead of
 * leaving the user with an emulator that never boots.
 *
 * The 1 GB GitHub Pages limit is avoided entirely: nothing is mirrored,
 * the browser streams blobs straight from the upstream store. (If the
 * origin ever blocks us, tools/arch-image/ mirrors the same store into a
 * Pages repo of our own — Pages sends `Access-Control-Allow-Origin: *`.)
 */

export const DEFAULT_IMAGE_BASE = "https://i.copy.sh/";

/** Accept `i.copy.sh`, `https://i.copy.sh`, `https://host/x/` alike. */
export function normalizeImageBase(raw: string): string {
  let s = (raw || DEFAULT_IMAGE_BASE).trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  if (!s.endsWith("/")) s += "/";
  return s;
}

export interface ImageProbe {
  ok: boolean;
  base: string;
  fsStatus: number | null;
  fsBytes: number | null;
  blobs: number | null;
  blobStatus: number | null;
  cors: boolean;
  message: string;
}

const BLOB_RE = /^[0-9a-f]{10}\.bin(\.zst)?$/;

/** Collect every blob filename referenced by an fs.json tree. */
function collectBlobs(node: unknown, out: Set<string>): void {
  if (!Array.isArray(node) || node.length === 0 || typeof node[0] !== "string") return;
  // [name, size, mtime, mode, uid, gid, last] — upstream trims trailing nulls
  if (node.length < 7) return;
  const last = node[6];
  if (typeof last === "string") {
    if (BLOB_RE.test(last)) out.add(last);
  } else if (Array.isArray(last)) {
    for (const child of last) collectBlobs(child, out);
  }
}

/**
 * Fetch fs.json (and the first blob) from an image store and report exactly
 * what happened. Safe to run from the OS page: read-only, no emulator.
 */
export async function probeImage(baseRaw: string): Promise<ImageProbe> {
  const base = normalizeImageBase(baseRaw);
  const result: ImageProbe = {
    ok: false,
    base,
    fsStatus: null,
    fsBytes: null,
    blobs: null,
    blobStatus: null,
    cors: true,
    message: "",
  };

  let text: string;
  try {
    const res = await fetch(`${base}fs.json`, { cache: "no-store" });
    result.fsStatus = res.status;
    if (!res.ok) {
      result.message =
        res.status === 404
          ? `${base}fs.json returned 404 — this image base has no fs.json.`
          : `${base}fs.json returned HTTP ${res.status}.`;
      return result;
    }
    text = await res.text();
    result.fsBytes = text.length;
  } catch (err) {
    /* A CORS rejection and an offline browser both surface as TypeError
       with an opaque message; the browser console has the real reason. */
    result.cors = false;
    result.message =
      `could not fetch ${base}fs.json (${(err as Error).message}). ` +
      `Either the browser is offline, or that origin refuses cross-origin ` +
      `requests (CORS). Open DevTools → Console: a red CORS line confirms it. ` +
      `Workaround: mirror the store into your own Pages repo with ` +
      `tools/arch-image/ (Pages always allows CORS).`;
    return result;
  }

  let tree: unknown;
  try {
    tree = JSON.parse(text);
  } catch {
    result.message = `${base}fs.json is not valid JSON.`;
    return result;
  }

  const blobs = new Set<string>();
  collectBlobs(tree, blobs);
  result.blobs = blobs.size;
  if (blobs.size === 0) {
    result.message = `${base}fs.json parsed but references no blobs — wrong file?`;
    return result;
  }

  const sample = [...blobs][0]!;
  try {
    const res = await fetch(`${base}arch/${sample}`, {
      headers: { Range: "bytes=0-1023" },
      cache: "no-store",
    });
    result.blobStatus = res.status;
    if (res.ok || res.status === 206) {
      result.ok = true;
      result.message =
        `image store OK — fs.json ${(result.fsBytes! / 1024).toFixed(0)} KB, ` +
        `${blobs.size} blobs, sample blob fetched (HTTP ${res.status}).`;
    } else {
      result.message = `fs.json is fine but arch/${sample} returned HTTP ${res.status}.`;
    }
  } catch (err) {
    result.cors = false;
    result.message = `blob fetch blocked (${(err as Error).message}) — likely CORS.`;
  }
  return result;
}
