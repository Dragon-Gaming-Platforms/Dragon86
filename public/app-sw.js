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
 * Deliberately NOT done here (yet):
 *   - no Cache Storage: every read goes to the filesystem, so editing a file
 *     in the Files app and reloading the app always shows the new bytes;
 *   - no COOP/COEP stamping: that is coi-serviceworker.js's job, and its
 *     isolation half is switched off while this worker owns the scope
 *     (see the D86_COI flag there).
 */

const PREFIX = "/9pf/";
const ASK_TIMEOUT_MS = 8000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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
  if (at === -1) return; // anything else is none of our business
  event.respondWith(
    serve(url.pathname.slice(at + PREFIX.length), url.search).catch(
      (err) => text(500, `Dragon86 filesystem app: ${err && err.message ? err.message : err}`),
    ),
  );
});

async function serve(rest, search) {
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
    ? await ask(client, { file: sub })
    : await ask(client, { appId, path: sub, search });
  if (!answer) return text(504, "Dragon86 did not answer in time (" + appId + "/" + sub + ")");
  if (!answer.ok) return text(answer.status || 404, answer.error || `${appId}/${sub} not found`);
  return new Response(answer.body, {
    status: 200,
    headers: {
      "Content-Type": answer.mime || "application/octet-stream",
      "Content-Length": String(answer.body.byteLength),
      /* No caching, by design: the filesystem is the source of truth. */
      "Cache-Control": "no-store",
      /* Apps run in a sandboxed (opaque-origin) frame, so their own module
         scripts and fetches are CORS requests with Origin: null. */
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
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
