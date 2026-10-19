# Vendored: Scramjet

This directory is a self-contained Scramjet proxy site, deployed to
`https://dragon-gaming-platforms.github.io/Dragon86/scramjet/` and iframed
by the Dragon86 "Browser" app.

Source: https://github.com/MercuryWorkshop/scramjet (cloned & inspected
2026-10-19). The full source build needs a Rust/wasm toolchain, so the
**published npm builds of the exact versions the repo pins** are vendored
instead (identical code, prebuilt):

| Path | Package | Version |
|---|---|---|
| `scramjet/scramjet.js`, `scramjet/scramjet.wasm` | `@mercuryworkshop/scramjet` | 2.0.67-alpha.2 |
| `controller/controller.api.js`, `controller.inject.js`, `controller.sw.js` | `@mercuryworkshop/scramjet-controller` | 0.0.14 |
| `transport/epoxy.mjs` | `@mercuryworkshop/epoxy-transport` | 3.0.1 |
| `transport/libcurl.mjs` | `@mercuryworkshop/libcurl-transport` | 2.0.5 |
| `utils/scramjet-utils.mjs` | `@mercuryworkshop/scramjet-utils` | 0.0.3 |

License: AGPL-3.0-only (Scramjet and Mercury Workshop transports) — full
text in `LICENSE` next to this file, and credited in the Dragon86 README.

**Path corrections vs upstream demo** (the demo assumes a site-root
deployment): all absolute paths (`/scramjet/scramjet.js`,
`/controller/controller.sw.js`, prefix `/~/sj/`) were replaced with paths
computed from the page's own directory in `app.js` / `sw.js`, so the site
works under the `/Dragon86/scramjet/` project path.

**Wisp server:** proxy traffic needs a Wisp websocket server, which
cannot run on GitHub Pages. Default is the public endpoint the upstream
demo builds against (`wss://anura.pro/`); it's configurable in the ⚙
panel and stored in localStorage. All proxied traffic flows through that
server — self-host a Wisp server for real privacy.

**Updating:** re-download the npm tarballs at pinned versions, replace
the files above, re-check the controller's runtime version assertion
(`assertRuntimeScramjetVersion`: controller and scramjet versions move
together), and re-test.
