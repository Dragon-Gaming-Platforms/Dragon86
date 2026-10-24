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
function boot({ reply = null, clients = 1 } = {}) {
  const handlers = {};
  const asked = [];
  const self = {
    addEventListener: (type, fn) => {
      (handlers[type] ||= []).push(fn);
    },
    skipWaiting: () => {},
    clients: {
      claim: async () => {},
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

async function fetchThrough(worker, url, { method = "GET" } = {}) {
  let promise = null;
  const event = {
    request: new Request(url, { method }),
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

for (const r of results) {
  console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}${r.detail ? "  (" + r.detail + ")" : ""}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
