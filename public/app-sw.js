/*
 * Dragon86 — filesystem apps service worker.
 *
 * Apps live in your filesystem (see src/core/fs-apps.ts), but a browser can
 * only run an app it can *address*: <script src="app.js">, import "./mod.js",
 * fetch("data.json"), a wasm file, an image — all of those need real URLs
 * that resolve, with real content types. Without a URL space you end up
 * rewriting HTML attributes and breaking on the first runtime fetch.
 *
 * So this worker owns one path prefix — <base>/9pf/ — and turns it into a
 * filesystem:
 *
 *     /9pf/<app-id>/index.html   → the app's entry document
 *     /9pf/<app-id>/js/app.js    → any file in the app's folder
 *
 * The worker cannot read the filesystem itself (ZenFS lives in the page's
 * memory), so every request is answered by asking a Dragon86 window over
 * postMessage. If no window is open there is nothing to serve and it says
 * so, plainly, instead of hanging.
 *
 * The worker also provides the PWA shell: it refreshes the OS document from
 * the network when possible, falls back to the last cached shell offline, and
 * caches same-origin static shell assets. Filesystem app responses stay
 * uncached so edits in Files appear immediately. No COOP/COEP headers are
 * stamped here; Dragon86 no longer requires cross-origin isolation.
 */

const PREFIX = "/9pf/";
const ASK_TIMEOUT_MS = 8000;
const CACHE_PREFIX = "dragon86-pwa-";
const SHELL_CACHE = `${CACHE_PREFIX}v1`;
const SCOPE_URL = new URL(self.registration.scope);
const SCOPE_PATH = SCOPE_URL.pathname.endsWith("/") ? SCOPE_URL.pathname : `${SCOPE_URL.pathname}/`;
const SHELL_URL = new URL("./", SCOPE_URL).href;
const OFFLINE_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dragon86 offline</title><body style="font:16px system-ui;background:#101116;color:#f4f5f7;padding:2rem"><h1>Dragon86 is offline</h1><p>The OS shell has not been cached on this device yet. Connect once, open Dragon86, then try again.</p></body>`;
const STATIC_DESTINATIONS = new Set(["script", "style", "image", "font", "worker", "manifest"]);
const MAX_CACHED_ASSETS = 180;

self.addEventListener("install", (event) => event.waitUntil((async () => {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(SHELL_URL, { cache: "reload" });
    if (response.ok) await cache.put(SHELL_URL, response.clone());
  } catch { /* first install may be offline; activation still succeeds */ }
  await self.skipWaiting();
})()));
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE).map((key) => caches.delete(key)));
  await self.clients.claim();
})()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  const at = url.pathname.indexOf(PREFIX);
  if (at !== -1) {
    event.respondWith(
      serve(url.pathname.slice(at + PREFIX.length), url.search, event).catch(
        (err) => text(500, `Dragon86 filesystem app: ${err && err.message ? err.message : err}`),
      ),
    );
    return;
  }
  if (url.origin !== SCOPE_URL.origin || !url.pathname.startsWith(SCOPE_PATH)) return;
  if (req.mode === "navigate" && (url.pathname === SCOPE_PATH || url.pathname === `${SCOPE_PATH}index.html`)) {
    event.respondWith(loadShell(req));
    return;
  }
  if (STATIC_DESTINATIONS.has(req.destination) && !url.pathname.includes("/scramjet/") && !url.pathname.includes("/ps2/")) {
    event.respondWith(cacheStatic(req));
  }
});

async function loadShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request, { cache: "no-cache" });
    if (response.ok) await cache.put(SHELL_URL, response.clone());
    return response;
  } catch {
    return (await cache.match(SHELL_URL)) ?? new Response(OFFLINE_HTML, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}

async function cacheStatic(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response.ok && response.type !== "opaque") {
      void cache.put(request, response.clone()).then(() => trimCache(cache)).catch(() => {});
    }
    return response;
  });
  if (cached) {
    void network.catch(() => {});
    return cached;
  }
  return network;
}

async function trimCache(cache) {
  const requests = await cache.keys();
  const assets = requests.filter((request) => request.url !== SHELL_URL);
  while (assets.length > MAX_CACHED_ASSETS) await cache.delete(assets.shift());
}

/**
 * Who is asking? "os" (the OS page, Preview, the file viewer), "app:<id>" (a
 * filesystem app's own document) or "unknown". The page applies the access
 * rules (src/core/fs-access.ts); this only says who is asking, and says
 * "unknown" rather than guessing when the browser does not tell us.
 */
async function requesterOf(event) {
  let docUrl = "";
  if (event.clientId) {
    try {
      const client = await self.clients.get(event.clientId);
      if (client && client.url) docUrl = client.url;
    } catch {
      /* fall through to the referrer */
    }
  }
  if (!docUrl) {
    const ref = event.request.referrer;
    if (ref && ref !== "about:client") docUrl = ref;
  }
  if (!docUrl) return "unknown";
  let page;
  try {
    page = new URL(docUrl).pathname;
  } catch {
    return "unknown";
  }
  const at = page.indexOf(PREFIX);
  if (at === -1) return "os";
  /* Decode the whole remainder before splitting, exactly as serve() does:
     `@open%2Fhome…` and `@open/home…` both name the viewer. */
  let id;
  try {
    id = decodeURIComponent(page.slice(at + PREFIX.length)).split("/")[0];
  } catch {
    return "unknown";
  }
  if (!id) return "unknown";
  /* The file viewer (`@open`) is the OS's own reader, not an app. */
  if (id === "@open") return "os";
  return "app:" + id;
}

async function serve(rest, search, event) {
  let path = rest;
  try {
    path = decodeURIComponent(rest);
  } catch {
    /* keep the raw path */
  }
  const slash = path.indexOf("/");
  const appId = slash === -1 ? path : path.slice(0, slash);
  let sub = slash === -1 ? "" : path.slice(slash + 1);
  /* `/9pf/@open/<encoded absolute path>` — one file from the OS filesystem,
     not from an app folder. The App Launcher and the built-in viewer use it
     to show a page that is not an installed app. */
  const isFile = appId === "@open";
  if (sub === "" || sub.endsWith("/")) sub += "index.html";
  if (!appId) return text(404, "Filesystem app: no app id in " + rest);

  const client = await pickClient();
  if (!client) {
    return text(
      503,
      "Dragon86 is not open in this browser.\n\n" +
        "Filesystem apps are served from your device's filesystem by the OS page, " +
        "so the OS has to be running. Open Dragon86 and launch the app from there.",
    );
  }

  const answer = isFile
    ? await ask(client, { file: sub, from: await requesterOf(event) })
    : await ask(client, { appId, path: sub, search });
  if (!answer) return text(504, "Dragon86 did not answer in time (" + appId + "/" + sub + ")");
  if (!answer.ok) return text(answer.status || 404, answer.error || `${appId}/${sub} not found`);
  const size = answer.body.byteLength;
  const headers = {
    "Content-Type": answer.mime || "application/octet-stream",
    /* No caching, by design: the filesystem is the source of truth. */
    "Cache-Control": "no-store",
    /* Apps run in a sandboxed (opaque-origin) frame, so their own module
       scripts and fetches are CORS requests with Origin: null. */
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Accept-Ranges": "bytes",
  };
  /* Safari will not play <audio> or <video> from a response that ignores
     Range: it asks for "bytes=0-1" first and needs a 206 back. So a single
     range is cut from the bytes we already have, and anything else (no
     header, several ranges, a malformed one) gets the whole file, as
     RFC 9110 allows. */
  const want = parseRange(event && event.request && event.request.headers ? event.request.headers.get("range") : null, size);
  if (want.kind === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": "0" } });
  }
  if (want.kind === "single") {
    const part = answer.body.slice(want.start, want.end + 1);
    return new Response(part, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${want.start}-${want.end}/${size}`, "Content-Length": String(part.byteLength) },
    });
  }
  return new Response(answer.body, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
}

/**
 * Parse a Range header for a body of `size` bytes. Returns
 *   { kind: "single", start, end }  — one satisfiable range, end inclusive
 *   { kind: "unsatisfiable" }       — a valid range past the end (→ 416)
 *   { kind: "none" }                — no header, several ranges or a malformed one (→ 200)
 */
function parseRange(header, size) {
  if (!header) return { kind: "none" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === "" && m[2] === "")) return { kind: "none" };
  const unsat = { kind: "unsatisfiable" };
  let start;
  let end;
  if (m[1] === "") {
    /* bytes=-N: the last N bytes */
    const n = Number(m[2]);
    if (n === 0 || size === 0) return unsat;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    if (m[2] !== "" && Number(m[2]) < start) return { kind: "none" };
    if (start >= size) return unsat;
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return { kind: "single", start, end };
}

/** Any open Dragon86 window can answer; prefer one that is visible. */
async function pickClient() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (!all.length) return null;
  const visible = all.find((c) => c.visibilityState === "visible");
  return visible || all[0];
}

/** Ask `client` for one file. Resolves null on timeout. */
function ask(client, payload) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), ASK_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data || null);
    };
    try {
      client.postMessage({ type: "d86-fs-read", ...payload }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function text(status, body) {
  return new Response(body + "\n", {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
