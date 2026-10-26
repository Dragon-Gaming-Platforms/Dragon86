# Vendored: Sandstone

Source: https://github.com/ading2210/sandstone (cloned + built 2026-10-19),
AGPL-3.0 (license in `LICENSE` beside this file).

Built from source here, not copied from any demo host:
- root project: `npm install` + `npm run build:prod` (webpack) — the client
  library bundles libcurl.js **including its wasm, base64-inlined**, so there
  is no CDN endpoint to download for the engine itself
- example frontend: `npm install` + webpack production build

Layout: `index.html` + `resources/` are the upstream example frontend;
`dist/sandstone_frontend.js` is its built bundle. Sandstone needs no service
worker (it proxies inside sandboxed iframes). Remaining network need is the
Wisp websocket server — default `wss://wisp.mercurywork.shop/` (upstream's
example default), changeable in the app's Options panel.

Under Dragon86 it is an App Store app: `public/store.json` lists every file in this folder, the store copies them into `~/system/apps/sandstone/`, and the window opens `index.html` from there.
