# Vendored: Scramjet

This is Dragon86's self-contained Scramjet proxy frontend, deployed under
`/Dragon86/scramjet/` and embedded by Dragon86's Browser app.

## Upstream versions

Source: [MercuryWorkshop/scramjet v2.1.0](https://github.com/MercuryWorkshop/scramjet/releases/tag/v2.1.0).
This is the v2 stable release; upstream split the runtime, controller, and
utilities into separate packages and overhauled the controller API. Dragon86
vendors their published browser bundles instead of building the full upstream
monorepo (which needs the Rust/WASM rewriter toolchain).

| Vendored path | npm package | Version |
|---|---|---:|
| `scramjet/scramjet.js`, `scramjet/scramjet.wasm` | `@mercuryworkshop/scramjet` | `2.1.0` |
| `controller/controller.api.js`, `controller.inject.js`, `controller.sw.js` | `@mercuryworkshop/scramjet-controller` | `0.1.0` |
| `transport/epoxy.mjs` | `@mercuryworkshop/epoxy-transport` | `3.0.2` |
| `transport/libcurl.mjs` | `@mercuryworkshop/libcurl-transport` | `2.0.6` |
| `utils/scramjet-utils.mjs` | `@mercuryworkshop/scramjet-utils` | `0.0.3` |

The utility package's published bundle still asserts compatibility with the
older `2.0.67-alpha.1` / controller `0.0.13` prereleases and reads the removed
`$scramjetController.VERSION` property. Its bundled assertion was adjusted to
the v2.1.0 runtime and the v0.1.0 controller's `versionInfo.version`. The
plugins themselves are the package's published bundle and use the v2 fetch
hooks. If refreshing this file, reapply that compatibility adjustment or
rebuild the utility bundle from the matching upstream source tree.

The upstream packages are AGPL-3.0-only. The license text is in `LICENSE` next
to this file; upstream source and package versions are identified above.

## Dragon86 integration changes

All paths are resolved relative to this app so the proxy works under the
GitHub Pages project path. The Scramjet service worker imports the controller
worker bundle relative to itself. The controller receives the Scramjet runtime,
inject, and WASM URLs from `app.js`; the controller's default `virtualWasmPath`
and URL codecs are retained. Epoxy and libcurl are loaded on demand as ES
modules, receive the selected Wisp WebSocket URL, and are initialized before
controller requests can use them. `app.js` keeps the same browser UI and
Dragon86 ZenFS upload/download bridge around the new engine.

Proxy traffic needs a Wisp websocket relay, which cannot run on GitHub Pages.
The default is `wss://anura.pro/`; it is configurable in the settings panel and
stored in localStorage. All proxied traffic flows through that relay.
