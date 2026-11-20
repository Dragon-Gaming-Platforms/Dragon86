#!/usr/bin/env node
/**
 * Runtime test for public/app-sw.js — the filesystem-app service worker.
 *
 * The worker's job is narrow and easy to break silently: take
 * `<base>/9pf/<app>/<path>` out of a fetch, ask a Dragon86 window for the
 * bytes, and answer with the right content type; ignore every other request;
 * say something useful when no window is open.
 *
 * This loads the real shipped file into a vm with just enough worker API
 * stubbed (self, clients, respondWith) to run that logic, and checks the
 * responses. No browser, no dependencies.
 *
 *   node tools/test-app-sw.mjs [path-to-worker.js]
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(
  process.argv[2] || new URL("../public/app-sw.js", import.meta.url),
  "utf8",
);

/** Boot the worker; `reply` decides what the fake Dragon86 window answers. */
function boot({ reply = null, clients = 1, docs = {} } = {}) {
  const handlers = {};
  const asked = [];
  const self = {
    addEventListener: (type, fn) => {
      (handlers[type] ||= []).push(fn);
    },
    skipWaiting: () => {},
    clients: {
      claim: async () => {},
      get: async (id) => (docs[id] ? { url: docs[id] } : undefined),
      matchAll: async () =>
        Array.from({ length: clients }, (_, i) => ({
          visibilityState: i === 0 ? "visible" : "hidden",
          postMessage(message, ports) {
            asked.push(message);
            if (!reply) return;
            const port = ports[0];
            setTimeout(() => port.postMessage(reply(message)), 0);
          },
        })),
    },
    registration: { scope: "https://example.test/Dragon86/" },
  };
  const ctx = vm.createContext({ self, Response, MessageChannel, URL, setTimeout, clearTimeout, console });
  vm.runInContext(SRC, ctx);
  return { handlers, asked };
}

async function fetchThrough(worker, url, { method = "GET", referrer = "", clientId = "", range = null } = {}) {
  let promise = null;
  const event = {
    /* A plain object: Request() does not expose a settable referrer. */
    request: { url, method, referrer, headers: new Headers(range ? { Range: range } : {}) },
    clientId,
    respondWith: (p) => {
      promise = p;
    },
  };
  for (const fn of worker.handlers.fetch ?? []) fn(event);
  if (!promise) return null;
  return promise;
}

const results = [];
const check = (name, cond, detail = "") => results.push({ name, ok: !!cond, detail });

const APP = "https://example.test/Dragon86/9pf/hello/app.js";
const body = new TextEncoder().encode("console.log(1)").buffer;

/* 1. a file from an app: 200 + JS content type, asked for the right path */
{
  const worker = boot({ reply: () => ({ ok: true, body, mime: "text/javascript; charset=utf-8" }) });
  const res = await fetchThrough(worker, APP);
  check("serves a file from /9pf/", res && res.status === 200, `status=${res && res.status}`);
  check(
    "asks the page for appId + path",
    worker.asked.length === 1 && worker.asked[0].appId === "hello" && worker.asked[0].path === "app.js",
    JSON.stringify(worker.asked[0] && { appId: worker.asked[0].appId, path: worker.asked[0].path }),
  );
  check(
    "keeps the content type",
    res && res.headers.get("content-type") === "text/javascript; charset=utf-8",
    res && res.headers.get("content-type"),
  );
  check("never caches", res && res.headers.get("cache-control") === "no-store", res && res.headers.get("cache-control"));
  check(
    "is CORS-open for the app's own fetches",
    res && res.headers.get("access-control-allow-origin") === "*",
    res && res.headers.get("access-control-allow-origin"),
  );
}

/* 2. a bare folder URL resolves to index.html */
{
  const worker = boot({ reply: () => ({ ok: true, body, mime: "text/html" }) });
  await fetchThrough(worker, "https://example.test/Dragon86/9pf/hello/");
  check(
    "folder request → index.html",
    worker.asked[0] && worker.asked[0].path === "index.html",
    JSON.stringify(worker.asked[0] && worker.asked[0].path),
  );
}

/* 3. anything not under /9pf/ is left alone (no respondWith) */
{
  const worker = boot({ reply: () => ({ ok: true, body }) });
  const res = await fetchThrough(worker, "https://example.test/Dragon86/assets/index.js");
  check("ignores non-app requests", res === null);
}

/* 4. the page says 404 → the worker relays it as a 404, with a reason */
{
  const worker = boot({ reply: () => ({ ok: false, status: 404, error: "not found: nope.js" }) });
  const res = await fetchThrough(worker, "https://example.test/Dragon86/9pf/hello/nope.js");
  const text = res ? await res.text() : "";
  check("relays a 404", res && res.status === 404, `status=${res && res.status}`);
  check("says what was missing", text.includes("nope.js"), JSON.stringify(text.trim()));
}

/* 5. no Dragon86 window open → a 503 that explains itself, not a hang */
{
  const worker = boot({ clients: 0 });
  const res = await fetchThrough(worker, APP);
  const text = res ? await res.text() : "";
  check("no window → 503", res && res.status === 503, `status=${res && res.status}`);
  check("no window → explains why", /not open|Open Dragon86/i.test(text), JSON.stringify(text.trim().slice(0, 60)));
}

/* 6. POST is not served (apps are static files) */
{
  const worker = boot({ reply: () => ({ ok: true, body }) });
  const res = await fetchThrough(worker, APP, { method: "POST" });
  check("ignores non-GET", res === null);
}

/* 7. @open: the worker tells the page who is asking, from the referrer */
const OPEN = "https://example.test/Dragon86/9pf/@open%2Fhome%2Fuser%2Fnotes.txt";
const asker = async (opts) => {
  const worker = boot({ reply: () => ({ ok: true, body }), docs: { "client-1": "https://example.test/Dragon86/9pf/evil/index.html" } });
  await fetchThrough(worker, OPEN, opts);
  return worker.asked[0] && worker.asked[0].from;
};
check("OS page asks → from=os", (await asker({ referrer: "https://example.test/Dragon86/" })) === "os");
check("Preview asks → from=os", (await asker({ referrer: "https://example.test/Dragon86/preview/index.html" })) === "os");
check("the file viewer asks → from=os", (await asker({ referrer: "https://example.test/Dragon86/9pf/@open%2Fhome%2Fuser%2Fa.html" })) === "os");
check(
  "an app's document asks → from=app:<id>",
  (await asker({ referrer: "https://example.test/Dragon86/9pf/cheerpj/index.html" })) === "app:cheerpj",
);
check(
  "the requesting client wins over a missing referrer",
  (await asker({ clientId: "client-1" })) === "app:evil",
);
check("no referrer and no client → from=unknown (never guessed)", (await asker({})) === "unknown");
check("about:client is not a referrer → unknown", (await asker({ referrer: "about:client" })) === "unknown");

/* 8. Range requests — what Safari needs before it will play media */
{
  const data = new TextEncoder().encode("0123456789".repeat(100)).buffer; // 1000 bytes
  const media = () => boot({ reply: () => ({ ok: true, body: data, mime: "video/mp4" }) });
  const MOVIE = "https://example.test/Dragon86/9pf/@open%2Fhome%2Fuser%2Fmovie.mp4";
  const text = async (r) => new Uint8Array(await r.arrayBuffer());

  let w = media();
  let r = await fetchThrough(w, MOVIE, { range: "bytes=0-1", referrer: "https://example.test/Dragon86/preview/index.html" });
  check("Range bytes=0-1 → 206", r && r.status === 206, `status=${r && r.status}`);
  check("206 carries Content-Range for the bytes sent", r && r.headers.get("content-range") === "bytes 0-1/1000", r && r.headers.get("content-range"));
  let b = r ? await text(r) : new Uint8Array();
  check("206 body is exactly the 2 bytes asked for", b.length === 2 && b[0] === 0x30 && b[1] === 0x31, `len=${b.length}`);
  check("206 Content-Length matches the part", r && r.headers.get("content-length") === "2", r && r.headers.get("content-length"));

  w = media();
  r = await fetchThrough(w, MOVIE, { range: "bytes=990-" });
  check("open-ended range → 206 to the end", r && r.status === 206 && r.headers.get("content-range") === "bytes 990-999/1000", r && r.headers.get("content-range"));
  b = r ? await text(r) : new Uint8Array();
  check("open-ended range returns 10 bytes", b.length === 10, `len=${b.length}`);

  w = media();
  r = await fetchThrough(w, MOVIE, { range: "bytes=-5" });
  check("suffix range → last 5 bytes", r && r.status === 206 && r.headers.get("content-range") === "bytes 995-999/1000", r && r.headers.get("content-range"));

  w = media();
  r = await fetchThrough(w, MOVIE, { range: "bytes=500-2000" });
  check("end past the file is clipped, not refused", r && r.status === 206 && r.headers.get("content-range") === "bytes 500-999/1000", r && r.headers.get("content-range"));

  w = media();
  r = await fetchThrough(w, MOVIE, { range: "bytes=5000-" });
  check("start past the end → 416 with the real size", r && r.status === 416 && r.headers.get("content-range") === "bytes */1000", `status=${r && r.status}`);

  w = media();
  r = await fetchThrough(w, MOVIE, { range: "bytes=0-1,4-5" });
  check("several ranges → whole file, 200", r && r.status === 200 && (await text(r)).length === 1000);

  w = media();
  r = await fetchThrough(w, MOVIE, { range: "bytes=abc" });
  check("malformed Range → whole file, 200", r && r.status === 200);

  w = media();
  r = await fetchThrough(w, MOVIE, { range: "bytes=9-3" });
  check("backwards range → whole file, 200", r && r.status === 200);

  w = media();
  r = await fetchThrough(w, MOVIE);
  check("no Range → 200 and Accept-Ranges advertised", r && r.status === 200 && r.headers.get("accept-ranges") === "bytes", r && r.headers.get("accept-ranges"));

  w = media();
  r = await fetchThrough(w, MOVIE, { range: "bytes=0-1" });
  check("206 keeps no-store (filesystem is the source of truth)", r && r.headers.get("cache-control") === "no-store");
}

for (const r of results) {
  console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}${r.detail ? "  (" + r.detail + ")" : ""}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
