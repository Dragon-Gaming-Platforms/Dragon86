# Vendored: GUST

Source: https://github.com/nautilus-os/GUST (cloned 2026-10-19), AGPL-3.0
(license in `LICENSE` beside this file). GUST is a single-file web proxy
(libcurl.js/Wisp, no service worker) — its engine was already inlined in
`index.html` upstream.

Local changes to `index.html` (search them: `vendor/`):
- Google Fonts css2 (JetBrains Mono + Space Grotesk) → `vendor/fonts/fonts.css`
  with woff2 files from `@fontsource/*` (npm), and the preconnect/prerender
  hints removed
- Font Awesome 6.7.2 **and** 6.5.1 cdnjs links (head + generated sub-pages)
  → `vendor/font-awesome/` (GitHub release 6.7.2: css + webfonts)
- iso-639-1 jsDelivr script → `vendor/iso-639-1.js` (npm iso-639-1@2.1.11)

Everything else was already inline. Remaining network needs are runtime
services, not static resources: the Wisp websocket endpoints GUST is
configured with (configurable inside GUST) and whatever sites it proxies.

Under Dragon86 it is an App Store app: `public/store.json` lists every file in this folder, the store copies them into `~/system/apps/gust/`, and the window opens `index.html` from there — note the OS cache
worker excludes nothing here, but navigations are never cached and its
assets are static, so they cache normally.
