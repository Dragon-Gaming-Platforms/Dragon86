/**
 * Fast HTTP downloads for the App Store and the distro installer.
 *
 * Why this exists: the store used to `fetch(...).arrayBuffer()` each payload
 * file one after another. For a 59 MB guest pack that is one long, single
 * connection with no progress to show. Two honest speedups, no magic:
 *
 *  - big files are fetched as several HTTP range requests IN PARALLEL.
 *    GitHub Pages (and any static host worth the name) serves ranges; on
 *    high-latency links several streams fill the pipe a single stream
 *    never does. If the server ignores ranges we detect that (a 200
 *    instead of a 206) and fall back to one streamed request.
 *  - everything streams, so callers get byte-accurate progress instead of
 *    a file counter that sits still for a minute.
 *
 * What is deliberately NOT here: a WASM build of anything. The bottleneck
 * is the network and IndexedDB, not JavaScript — the only CPU-heavy steps
 * (gzip, inflate) already run native via DecompressionStream.
 *
 * Safari note (a real bug this file shipped with): every request that
 * carries a Range header — the one-byte size probe included — must use
 * cache: "no-store". WebKit writes partial 206 responses into its HTTP
 * cache, and the next plain GET of that URL then dies with WebKit's
 * generic "Load failed". Chrome and Firefox shrug this off; Safari does
 * not, and it broke every App Store install there. Range responses are
 * useless in the cache anyway, so nothing is lost by skipping it.
 */

export interface FetchBytesOptions {
  /** Called as bytes arrive. `total` is null when the server did not say. */
  onProgress?: (done: number, total: number | null) => void;
  /**
   * True when a cached copy likely exists and the caller only wants to
   * revalidate it (conditional request → 304 → bytes from the HTTP cache).
   * Range requests bypass the HTTP cache, so this forces the plain path.
   */
  revalidate?: boolean;
}

/** Files at least this big are split into parallel range requests. */
const RANGED_MIN = 8 * 1024 * 1024;
/** Size of each ranged chunk. */
const CHUNK = 4 * 1024 * 1024;
/** How many range requests run at once. */
const PARALLEL = 5;

/** Run `fn` over `items` with at most `limit` in flight. Order preserved. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * The size of `url` in bytes without downloading the body, or null when the
 * server will not say. Tries HEAD first, then a one-byte range request
 * (whose Content-Range carries the full size). Sizes are only trusted when
 * no Content-Encoding is in play — an encoded length is not the real one.
 */
export async function remoteSize(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (res.ok && !res.headers.get("content-encoding")) {
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > 0) return len;
    }
  } catch {
    /* fall through to the range probe */
  }
  try {
    /* no-store: see the Safari note in the file header. */
    const res = await fetch(url, { headers: { Range: "bytes=0-0" }, cache: "no-store" });
    if (res.status === 206) {
      const m = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "");
      /* Don't leave the one-byte body dangling. */
      void res.body?.cancel();
      if (m) return Number(m[1]);
    } else {
      void res.body?.cancel();
    }
  } catch {
    /* unknown it is */
  }
  return null;
}

/** One streamed GET with progress. The fallback everything else rests on. */
async function fetchStreamed(url: string, opts: FetchBytesOptions): Promise<Uint8Array> {
  try {
    return await streamOnce(url, opts, opts.revalidate ? "no-cache" : "default");
  } catch (err) {
    /* Only a network-layer rejection (TypeError) is worth retrying — an
       HTTP error status would just repeat. Users who hit the Safari
       cache-poisoning bug before it was fixed still carry broken 206
       entries in their HTTP cache; "reload" goes straight to the network
       and overwrites the entry with the full response, healing it. */
    if (!(err instanceof TypeError)) throw err;
    console.warn(`[download] ${url}: GET failed at the network layer (${err.message}) — retrying past the HTTP cache`);
    return await streamOnce(url, opts, "reload");
  }
}

async function streamOnce(url: string, opts: FetchBytesOptions, cache: RequestCache): Promise<Uint8Array> {
  const res = await fetch(url, { cache });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const totalHeader = Number(res.headers.get("content-length"));
  /* With Content-Encoding the header counts encoded bytes, not real ones. */
  const total = !res.headers.get("content-encoding") && Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
  if (!res.body) {
    const data = new Uint8Array(await res.arrayBuffer());
    opts.onProgress?.(data.byteLength, data.byteLength);
    return data;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    parts.push(value);
    done += value.byteLength;
    opts.onProgress?.(done, total);
  }
  const out = new Uint8Array(done);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/**
 * Download `url` as fast as the connection allows.
 *
 * Big files (when the server honours ranges and applies no transfer
 * encoding) arrive as parallel range requests written straight into one
 * preallocated buffer; everything else arrives as a single streamed GET.
 */
export async function fetchBytes(url: string, opts: FetchBytesOptions = {}): Promise<Uint8Array> {
  if (!opts.revalidate) {
    const plan = await planRanged(url);
    if (plan) {
      try {
        return await fetchRanged(url, plan, opts);
      } catch (err) {
        /* A proxy that mangles ranges, a flaky chunk — the slow road still
           leads home. */
        console.warn(`[download] ranged fetch of ${url} failed, falling back to one stream`, err);
      }
    }
  }
  return fetchStreamed(url, opts);
}

interface RangedPlan {
  size: number;
}

/** Decide whether `url` is worth fetching in parallel ranges. */
async function planRanged(url: string): Promise<RangedPlan | null> {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (!res.ok) return null;
    if (res.headers.get("content-encoding")) return null;
    if (!(res.headers.get("accept-ranges") ?? "").includes("bytes")) return null;
    const size = Number(res.headers.get("content-length"));
    if (!Number.isFinite(size) || size < RANGED_MIN) return null;
    return { size };
  } catch {
    return null;
  }
}

async function fetchRanged(url: string, plan: RangedPlan, opts: FetchBytesOptions): Promise<Uint8Array> {
  const { size } = plan;
  const out = new Uint8Array(size);
  const ranges: { start: number; end: number }[] = [];
  for (let start = 0; start < size; start += CHUNK) {
    ranges.push({ start, end: Math.min(start + CHUNK, size) - 1 });
  }
  /* One chunk failing must stop the others immediately: the caller falls
     back to a plain streamed GET, and that GET should not have to share
     the connection with five abandoned range streams. */
  const ctrl = new AbortController();
  let done = 0;
  try {
    await mapLimit(ranges, PARALLEL, async ({ start, end }) => {
      /* no-store: see the Safari note in the file header. */
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, cache: "no-store", signal: ctrl.signal });
      if (res.status !== 206) throw new Error(`${url}: expected 206 for range ${start}-${end}, got ${res.status}`);
      if (!res.body) {
        const data = new Uint8Array(await res.arrayBuffer());
        if (data.byteLength !== end - start + 1) throw new Error(`${url}: range ${start}-${end} returned ${data.byteLength} bytes`);
        out.set(data, start);
        done += data.byteLength;
        opts.onProgress?.(done, size);
        return;
      }
      const reader = res.body.getReader();
      let off = start;
      for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        if (off + value.byteLength > end + 1) throw new Error(`${url}: range ${start}-${end} overflowed`);
        out.set(value, off);
        off += value.byteLength;
        done += value.byteLength;
        opts.onProgress?.(done, size);
      }
      if (off !== end + 1) throw new Error(`${url}: range ${start}-${end} ended short at ${off}`);
    });
  } catch (err) {
    ctrl.abort();
    throw err;
  }
  return out;
}

export function humanMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
