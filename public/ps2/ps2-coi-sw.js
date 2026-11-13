/*
 * PS2-only isolation and ZenFS file server.
 * Its registration scope is /<base>/ps2/; it must never be widened to the
 * Dragon86 root. The OS keeps its own COI policy disabled.
 */
const PS2_SCOPE = new URL(self.registration.scope).pathname;
const FILES_PREFIX = `${PS2_SCOPE}files/`;
const MESSAGE_TIMEOUT_MS = 30000;

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PS2_SCOPE)) return;

  if (url.pathname.startsWith(FILES_PREFIX) && ["GET", "HEAD", "PUT"].includes(request.method)) {
    event.respondWith(serveGameFile(request, url.pathname.slice(FILES_PREFIX.length)));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(fetch(request, { cache: "no-store" }).then(isolatedDocument).catch(() => new Response("PS2 launcher page could not be loaded.", { status: 503 })));
  }
});

async function isolatedDocument(response) {
  if (!response || response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function serveGameFile(request, route) {
  const segments = decodeRoute(route);
  if (!segments || segments.length < 2 || !/^[a-z0-9-]{1,64}$/.test(segments[0])) return text(404, "Invalid PS2 game asset path.");
  const [gameId, ...relative] = segments;
  const game = await gameClient(gameId);
  if (!game) return text(503, "Keep the PS2 launcher tab open while the game is running.");
  const range = request.headers.get("Range") || "";
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  const body = request.method === "PUT" ? await request.arrayBuffer() : undefined;
  const response = await askGamePage(game, {
    type: "d86-ps2-file-request",
    method: request.method,
    relativePath: relative.join("/"),
    range: match ? { start: Number(match[1]), end: match[2] ? Number(match[2]) : null } : null,
    body,
  });
  if (!response) return text(504, "Timed out reading a local PS2 build file.");
  const headers = new Headers({
    "Content-Type": mimeType(relative.at(-1) || ""),
    "Content-Length": String(response.length || 0),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  });
  if (response.contentRange) headers.set("Content-Range", response.contentRange);
  if (response.contentEncoding) {
    headers.set("Content-Encoding", response.contentEncoding);
    headers.set("Vary", "Accept-Encoding");
  }
  if (response.status === 416) return new Response(null, { status: 416, headers });
  if (request.method === "HEAD") return new Response(null, { status: response.status || 200, headers });
  const bytes = response.bytes instanceof ArrayBuffer ? response.bytes : new ArrayBuffer(0);
  return new Response(bytes, { status: response.status || 200, headers });
}

function decodeRoute(route) {
  try {
    const parts = route.split("/").map(decodeURIComponent);
    if (parts.some((part) => !part || part === "." || part === ".." || /[\\/\0]/.test(part))) return null;
    return parts;
  } catch { return null; }
}

async function gameClient(gameId) {
  const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of pages) {
    try {
      const url = new URL(client.url);
      const isLauncherPage = url.pathname === PS2_SCOPE || url.pathname.endsWith("/index.html");
      const fileRoute = url.pathname.startsWith(FILES_PREFIX) ? url.pathname.slice(FILES_PREFIX.length) : "";
      const fileGameId = fileRoute.split("/")[0];
      if (url.pathname.startsWith(PS2_SCOPE)
        && ((isLauncherPage && url.searchParams.get("game") === gameId)
          || fileGameId === gameId)) return client;
    } catch { /* ignore malformed client URLs */ }
  }
  return null;
}

function askGamePage(client, message) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      channel.port1.close();
      resolve(value || null);
    };
    const timer = setTimeout(() => finish(null), MESSAGE_TIMEOUT_MS);
    channel.port1.onmessage = (event) => finish(event.data);
    const transfer = [channel.port2];
    if (message.body instanceof ArrayBuffer) transfer.push(message.body);
    client.postMessage(message, transfer);
  });
}

function mimeType(name) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return ({
    html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8", wasm: "application/wasm",
    css: "text/css; charset=utf-8", json: "application/json",
    data: "application/octet-stream", iso: "application/octet-stream",
    bin: "application/octet-stream", gz: "application/gzip",
  })[ext] || "application/octet-stream";
}

function text(status, value) {
  return new Response(value, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
