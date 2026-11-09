#!/usr/bin/env node
/**
 * Tests for src/core/download.ts — parallel ranged downloads for the store.
 *
 * Runs a real HTTP server in-process and checks the things that actually
 * go wrong with range requests: a server that honours them (bytes must
 * reassemble exactly), a server that ignores them (the fallback must kick
 * in and still deliver), a server with no HEAD (size probing falls back to
 * a one-byte range), and small files (which must NOT be split).
 *
 *   node --experimental-strip-types tools/test-download.mjs
 */
import { createServer } from "node:http";

const { fetchBytes, remoteSize, mapLimit } = await import("../src/core/download.ts");

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`[PASS] ${name}`);
  else {
    failed++;
    console.log(`[FAIL] ${name}  ${detail}`);
  }
}

/* A 20 MB body with position-dependent bytes — any reassembly mistake
   (swapped chunks, off-by-one ranges) changes the content, not just the
   length. */
const SIZE = 20 * 1024 * 1024;
const body = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) body[i] = (i * 31 + ((i >> 13) * 7)) & 0xff;

function serve(opts) {
  const stats = { gets: 0, heads: 0, rangeRequests: 0 };
  const server = createServer((req, res) => {
    if (req.method === "HEAD") {
      stats.heads++;
      if (opts.noHead) {
        res.statusCode = 405;
        res.end();
        return;
      }
      res.setHeader("content-length", String(SIZE));
      if (!opts.noRanges) res.setHeader("accept-ranges", "bytes");
      res.end();
      return;
    }
    stats.gets++;
    const range = req.headers.range;
    if (range && !opts.ignoreRanges) {
      stats.rangeRequests++;
      const m = /bytes=(\d+)-(\d+)?/.exec(range);
      const start = Number(m[1]);
      const end = m[2] !== undefined ? Number(m[2]) : SIZE - 1;
      res.statusCode = 206;
      res.setHeader("content-range", `bytes ${start}-${end}/${SIZE}`);
      res.setHeader("content-length", String(end - start + 1));
      res.end(body.subarray(start, end + 1));
      return;
    }
    res.setHeader("content-length", String(SIZE));
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/file.bin`, stats, close: () => server.close() });
    });
  });
}

/* ---------- ranged happy path ---------- */
{
  const srv = await serve({});
  let lastDone = 0;
  let lastTotal = null;
  const data = await fetchBytes(srv.url, {
    onProgress: (done, total) => {
      lastDone = done;
      lastTotal = total;
    },
  });
  check("ranged: bytes identical", Buffer.compare(Buffer.from(data), body) === 0);
  check("ranged: actually split into ranges", srv.stats.rangeRequests > 1, `ranges=${srv.stats.rangeRequests}`);
  check("ranged: progress reached the end", lastDone === SIZE && lastTotal === SIZE, `${lastDone}/${lastTotal}`);
  srv.close();
}

/* ---------- server ignores Range → fallback still delivers ---------- */
{
  const srv = await serve({ ignoreRanges: true });
  const data = await fetchBytes(srv.url);
  check("ignored ranges: bytes identical via fallback", Buffer.compare(Buffer.from(data), body) === 0);
  srv.close();
}

/* ---------- no accept-ranges advertised → one plain GET ---------- */
{
  const srv = await serve({ noRanges: true });
  const data = await fetchBytes(srv.url);
  check("no accept-ranges: bytes identical", Buffer.compare(Buffer.from(data), body) === 0);
  check("no accept-ranges: no range requests sent", srv.stats.rangeRequests === 0);
  srv.close();
}

/* ---------- revalidate mode never splits ---------- */
{
  const srv = await serve({});
  const data = await fetchBytes(srv.url, { revalidate: true });
  check("revalidate: bytes identical", Buffer.compare(Buffer.from(data), body) === 0);
  check("revalidate: single plain GET", srv.stats.rangeRequests === 0 && srv.stats.gets === 1, `gets=${srv.stats.gets} ranges=${srv.stats.rangeRequests}`);
  srv.close();
}

/* ---------- remoteSize: HEAD, and the range probe when HEAD is gone ---------- */
{
  const srv = await serve({});
  check("remoteSize via HEAD", (await remoteSize(srv.url)) === SIZE);
  check("remoteSize downloads nothing", srv.stats.gets === 0, `gets=${srv.stats.gets}`);
  srv.close();

  const srv2 = await serve({ noHead: true });
  check("remoteSize via range probe when HEAD 405s", (await remoteSize(srv2.url)) === SIZE);
  srv2.close();
}

/* ---------- a network-layer failure gets exactly one retry ---------- */
/* This is the Safari "Load failed" shape: the GET dies below HTTP (WebKit
   kills loads served from a cache entry poisoned by earlier 206s). The
   fix retries once with cache:"reload"; a second network failure — or any
   HTTP error status — must still surface. */
{
  let gets = 0;
  const server = createServer((req, res) => {
    gets++;
    if (gets === 1) {
      req.socket.destroy();
      return;
    }
    res.setHeader("content-length", "5");
    res.end("hello");
  });
  const url = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/flaky.bin`));
  });
  const data = await fetchBytes(url);
  check("network failure: one retry delivers", Buffer.from(data).toString() === "hello" && gets === 2, `gets=${gets}`);
  server.close();
}
{
  const server = createServer((req, res) => {
    if (req.method === "HEAD") {
      res.statusCode = 405;
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end("nope");
  });
  const url = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/gone.bin`));
  });
  let threw = null;
  try {
    await fetchBytes(url);
  } catch (err) {
    threw = err;
  }
  check("HTTP errors are not retried away", threw !== null && /404/.test(String(threw)), String(threw));
  server.close();
}

/* ---------- mapLimit: order kept, limit respected ---------- */
{
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([...Array(20).keys()], 3, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  });
  check("mapLimit keeps order", out.every((v, i) => v === i * 2));
  check("mapLimit respects the limit", peak <= 3, `peak=${peak}`);
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall download tests passed");
