# <div align="center">Dragon86 </div>

**A web OS by Dragon Gaming Platforms.** No login, no server — the whole desktop lives in your browser's local storage.
<div align="center">
  
![status](https://img.shields.io/badge/status-dev%20build-e60012) ![stack](https://img.shields.io/badge/stack-Vite%20%C2%B7%20TypeScript%20%C2%B7%20ZenFS-2a2a2a)

</div>

### v86 networking

The NIC is emulated by v86 (`net_device: { type: "virtio", relay_url }`),
including DHCP for its local link — the guest only loads a driver and
asks for a lease. Set the relay in Settings → **v86 network** (`wss://`
wsproxy, `wisp://` wisp, `fetch` in-page, or `off`), press **Test** to
check it from your browser, and run `/networking.sh` in the guest
(same script copy.sh's images ship) for a status report.

### Filesystem apps (apps served from your files)

An app can live in your filesystem instead of the build. Its files sit in a
folder, its registration is a JSON file next to them, and the OS serves it
through a real URL space so that ordinary web code — `<script src="app.js">`,
`import "./mod.js"`, `fetch("data.json")`, wasm, images — just works:

    /Dragon86/9pf/<app-id>/index.html
    /Dragon86/9pf/<app-id>/app.js

`public/app-sw.js` (a service worker) owns that prefix. It cannot read the
filesystem itself, so for each request it asks an open Dragon86 window for
the bytes (`postMessage` + a MessagePort); the page reads ZenFS and answers.
Nothing is cached: edit a file in Files, reload the app, you see the new
bytes. If no Dragon86 window is open the worker answers 503 and says why.

**The registry** is read from the filesystem at boot, from every `*.json` in:

    ~/v86/shared/system/apps/      (the guest sees this as /shared/system/apps)
    ~/system/apps/                 (fallback, for apps dropped in via Files)

Each file is `{ "apps": [ … ] }` (or a bare array). One entry:

    {
      "id": "hello",                 // the folder name: apps/hello/
      "name": "Hello",
      "icon": "browser",
      "entry": "index.html",
      "folder-isolated": true,
      "width": 520, "height": 420
    }

`folder-isolated: true` means the app cannot climb out of its own folder with
`../` — the service worker answers 403. `false` lets it walk up as far as the
OS home (`/home/user`), which is what a file viewer wants and what you should
not give code you didn't write. Either way the app runs same-origin: an
opaque-origin (sandboxed) frame is not controlled by a service worker, so
its own files would not be served at all.

A demo app (`hello`: a clock that fetches `data.json` next to itself) is
created on first boot so the whole loop is visible immediately.

### Service worker: on only when the engine needs isolation

COOP/COEP arrive via `coi-serviceworker.js`, and only the **embedded
CheerpX** engine needs them. Selecting **Separate tab** or **v86** makes
the worker remove *itself*: its page half calls
`navigator.serviceWorker.getRegistrations()`, unregisters the worker and
reloads once so the next document carries no COOP/COEP — no reliance on
messaging a controller that may already be gone. Settings → System shows
the live state ("Isolation: ON/off", "Service worker: controlling / not
controlling"), and `tools/test-coi-deregister.mjs` (run by `npm run
build`) asserts the contract.

### The v86 guest: a lightweight Arch userland rooted in your files

The v86 engine boots one guest: the vendored Arch Linux 32 kernel plus a
hand-built userland (bash, coreutils, git, `networking.sh`). There is no big
disk image and nothing is downloaded at boot — the whole distro is unpacked
once from `public/v86/initrd.gz` into `~/v86`, and from then on **the guest's
`/` is that folder**.

That is the point of this engine: everything the distro reads is a file in
your Dragon86 filesystem, and everything it writes lands there too. Edit
`~/v86/etc/hostname` in Files, `cat /etc/hostname` in the Terminal — same
file, no sync step. Inside the guest, `/shared` is your Files folder.

How it hangs together (details in `public/v86/VENDORED.md`):

- the kernel boots a small initramfs (`public/v86/initrd.gz`), whose `/init`
  is built from `tools/guest-init/init`;
- `/init` brings up virtio + 9p, mounts the share as `/newroot`, bind-mounts
  `/proc`, `/sys` and `/dev` in, then `chroot`s into it;
- the share itself is served by `src/bridge/p9.ts`, a 9p2000.L server talking
  straight to ZenFS — no HTTP, no image store, no per-device vendoring.

`~/v86/.dragon86-root.json` marks an unpacked root (version, timestamp, file
count); Settings → **v86 filesystem** can re-unpack it if it is ever damaged.

## What's in the box

- **Window manager** — draggable, resizable, focusable windows with taskbar integration
- **Files** — browse/create/rename/delete on a virtual hard drive (ZenFS → IndexedDB)
- **Text Editor** — open & edit any text file, `Ctrl+S` saves
- **Terminal** — xterm.js front end, waiting for the **CheerpX** engine (message-bridge protocol v1 is wired)
- **Scramjet** — web proxy (vendored at `/scramjet/`; traffic via a configurable Wisp server), a JSON-defined iframe app
- **Dragon Gaming Platforms** — the org catalog player (`cdn.singlefile.html`), iframed live from the org's GitHub Pages site, also a JSON-defined iframe app
- **GUST** — single-file web proxy vendored at `/gust/` with its fonts/icons downloaded and served locally (see `public/gust/VENDORED.md`), a JSON-defined iframe app
- **Sandstone** — sandboxed-iframe web proxy, built from source and vendored at `/sandstone/` (see `public/sandstone/VENDORED.md`), a JSON-defined iframe app

Text/code files in the Text Editor open in **Monaco** (the VS Code editor),
vendored under `/monaco/` from the npm package — no CDN at runtime, with a
plain-textarea fallback.

### Adding an iframe app

Add **one entry** to `src/apps/iframe-apps.json` — no other code. Fields:
`id`, `name`, `sub`, `url` (relative to the OS base for vendored pages
under `public/`, or an absolute **same-origin** URL — cross-origin entries
are refused at runtime), `icon` (a built-in icon name, or
`"img:icons/<file>.png"` for a vendored image in `public/icons/`), and
optional `width`/`height`/`status`. The app appears on the desktop and in
the start menu automatically. See `src/apps/iframe-app.ts` for details.
- **Settings** — six themes (Dragon Red, Cyberpunk, Purple, Matrix, AMOLED, Sunset), wallpapers, engine host URL, factory reset

## Architecture (the two-repo plan)

| Repo | Role | Isolation |
|---|---|---|
| **Dragon86** (this one) | The OS: desktop, WM, ZenFS VFS, xterm.js UI | Cross-origin isolated via `coi-serviceworker`, scoped to `/Dragon86/` — an embedded frame can only get SharedArrayBuffer when the **top page** is isolated, so the OS isolates itself and the hoster inherits it |
| **hoster** (separate) | CheerpX engine page + disk images | Cross-origin isolated via `coi-serviceworker`, scoped to its subdirectory only |

The OS embeds the hoster as a **hidden iframe** and talks to it over a versioned `postMessage` protocol (PTY byte-stream + control channel — see `src/bridge/hoster.ts`). The terminal UI never leaves the OS; the engine never touches the OS DOM.

### VFS wiring

- `/home` → IndexedDB (persistent virtual hard drive), `/tmp` → in-memory
- The shared "Linux" folder will be a `dir` mount backed by the same storage CheerpX sees — files written in the terminal show up in the Files app, without shelling out to `ls`.

## Develop

```sh
npm install
npm run dev        # local dev server
npm run build      # type-check + production build → dist/
```

## Deploy

GitHub Actions (`.github/workflows/deploy.yml`) builds and publishes to **GitHub Pages** on every push to `main`. First time: repo **Settings → Pages → Source → GitHub Actions**.

> The base path is `/Dragon86/` (project site). For a custom-domain root deploy, set `PAGES_BASE=/` in the workflow's build step.

## Roadmap

1. ~~Core OS shell~~ ✔ desktop, WM, files, editor, settings, terminal chrome
2. ~~CheerpX hoster repo~~ ✔ [CheerpX-Bridge](https://github.com/Dragon-Gaming-Platforms/CheerpX-Bridge) (COI + scoped service worker + Debian disk image)
3. ~~Bridge handshake → real bash in the terminal~~ ✔ wired (default engine URL, cold-boot-aware handshake, late-ready recovery)
4. ~~Shared Linux folder~~ ✔ v86 engine: the guest's `/shared` is the OS filesystem live, both ways (9p served from ZenFS — see `public/v86/VENDORED.md`). CheerpX engine: OS side wired (bridge protocol v2 "fs1", `src/bridge/fs-bridge.ts`, spec in `docs/cheerpx-fs-protocol.md`) — waiting on the hoster to plug it into the guest at `/home/user/shared`
5. ~~Browser app~~ ✔ Scramjet proxy vendored at `/scramjet/` (see `public/scramjet/VENDORED.md`)
6. Multiple terminals / tmux, cloud-drive mounts (ZenFS backends)

## Engine

The Terminal connects to the **CheerpX-Bridge** hoster by default
(`https://dragon-gaming-platforms.github.io/CheerpX-Bridge/`). Override it in
**Settings → Engine** for development. First cold boot can take ~20 seconds
(service-worker install + WASM compile + disk connect); later opens are warm
and fast.

**Engine location toggle (Settings → Engine → "Engine runs"):**
- **Embedded** (default): hoster in a hidden iframe; Dragon86 itself is
  cross-origin isolated via the coi-serviceworker.
- **Separate tab**: the hoster opens as its own browser tab — engine only,
  no terminal UI over there; the Dragon86 Terminal still renders everything
  and talks to the tab over a `BroadcastChannel` (`dragon86-hoster-v1`,
  same v1 messages). In this mode Dragon86's coi-serviceworker is
  deregistered, so the OS page runs with **no COEP/COOP restrictions**.
  Switching modes reloads the page (isolation is a document-load property).
  ⚠️ Tab mode needs the hoster to listen on the BroadcastChannel too —
  that's a pending CheerpX-Bridge addition; until it lands, tab mode
  reports "still starting" while embedded mode keeps working.

**Shared folder (CheerpX modes):** the bridge speaks protocol v2 —
Dragon86 advertises `caps: ["fs1"]` and serves file requests straight
from its filesystem (guest `/home/user/shared` ↔ OS `/home/user`), the
same live arrangement as v86's 9p share but over bridge messages
(CheerpX's filesystem devices are whole-file JS APIs, so the wire is
file-level too). The hoster must still mount it inside the guest; the
contract + hoster implementation notes live in
`docs/cheerpx-fs-protocol.md`. Until a hoster echoes `fs1`, nothing
changes — v1 behavior, no shared folder in the CheerpX guest.

- **v86 (compatibility)**: a tiny Linux (vendored v86 emulator + Arch
  Linux 32 kernel + Arch's genuine GNU bash and coreutils, `public/v86/`)
  boots right inside the Dragon86 page — no isolation, no hoster, no
  service worker, so it runs in Android WebView and similar places the
  CheerpX modes can't. Slower and smaller than CheerpX, but its
  `/shared` folder **is** the OS virtual filesystem, live in both
  directions: Dragon86 serves 9p straight from its own filesystem
  (`src/bridge/p9.ts`), so guest creates/deletes/renames are OS
  operations and vice versa — no copying, no sync step. The Terminal's
  **Save State** button snapshots the machine to IndexedDB and the
  next v86 start resumes from it. Isolation is OFF in this mode, same
  as Separate tab. The distro's own `/` **is** `~/v86` — the same folder
  you see in Files under **v86** — so anything the guest reads or edits
  is editable from the Files app and vice versa.

**Diagnostics:** the Terminal has a **Dev Console** button (Eruda, contained
in the window). Watch the `[D86:bridge]` logs — especially the *iframe probe*
line, which reads the embedded hoster's `crossOriginIsolated` directly.
Isolation debugging rule: the top OS page must report
`crossOriginIsolated: true` (after the one-time service-worker reload) before
the engine inside the iframe can start at all.

**Isolation scope (for future apps):** only the OS *document* carries
COOP/COEP — the service worker stamps headers on navigation responses only
and never touches subresource responses. Isolation is still a page-level
property, so while the OS page is isolated, anything it embeds cross-origin
must satisfy the document's COEP (`require-corp`: CORS or a
`Cross-Origin-Resource-Policy` opt-in — the hoster does this). Apps that
can't meet that can open as their own top-level page/popup instead. If the
site ever moves to a host that can send real headers, the worker can be
deleted and nothing else changes.

## Credits

- Design tokens & themes: [Dragon-Gaming-Platforms](https://github.com/Dragon-Gaming-Platforms/Dragon-Gaming-Platforms) brand stylesheet
- [ZenFS](https://github.com/zen-fs/core) (LGPL-3.0) — virtual filesystem
- [xterm.js](https://github.com/xtermjs/xterm.js) (MIT) — terminal emulator
- [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT, © Guido Zuidhof and contributors) — vendored at `public/coi-serviceworker.js` with a local modification: it stamps COOP/COEP **only on document (navigation) responses**, letting all subresources pass through untouched; license in `third-party/`
- [Scramjet](https://github.com/MercuryWorkshop/scramjet) (AGPL-3.0, Mercury Workshop) — web proxy vendored at `public/scramjet/` from its pinned npm builds; license text included there. NOTE: this makes the combined deployed site AGPL-relevant — keep the source link handy.
- [GUST](https://github.com/nautilus-os/GUST) (AGPL-3.0, Nautilus Labs) — vendored at `public/gust/`; its Google Fonts / Font Awesome / iso-639-1 CDN resources were replaced with local copies.
- [Sandstone](https://github.com/ading2210/sandstone) (AGPL-3.0-only, ading2210) — built from source and vendored at `public/sandstone/`.
- [Monaco Editor](https://github.com/microsoft/monaco-editor) (MIT, Microsoft) — `monaco-editor` npm package's minified build vendored at `public/monaco/`.
- CheerpX is a trademark of Leaning Technologies; engine licensing applies (Community/Commercial)

## License

TBD by Dragon Gaming Platforms (keep ZenFS's LGPL obligations in mind when shipping).
