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

Two traps worth knowing before you conclude "the network is broken":

- **`ping` always succeeds.** v86 answers ICMP on its own virtual link, so a
  ping reply arrives even with the relay switched off. Use `d86-net check` in
  the guest instead: it tests the interface, the route, `resolv.conf`, a real
  DNS lookup and a real TLS connection, and stops at the first broken link.
- **`git clone https://…` is a real clone.** git keeps its HTTP transports in
  separate programs, so the guest gets git's own `git-remote-http` (and the
  `git-remote-https` alias) in `/usr/lib/git-core`: a static build of git
  2.49.1's transport with libcurl and mbedTLS, plus a CA bundle at
  `/etc/ssl/certs/ca-certificates.crt`. Nothing is proxied, nothing is
  faked — the guest's git fetches over TLS itself, with history, branches and
  `git pull`. `d86-clone` stays as the fallback for repositories where the
  tarball is the sane choice; it is no longer what an https clone does.

### Preview — one place for everything you look at but do not edit

**Preview** (`public/preview/`) is the default app for pictures,
sound, video, PDFs, 3D models and disc images. Opening any of those from
Files, the desktop or `Open with ›` lands there, and the window is titled
after the file (`Preview - holiday.png`).

| kind | formats | how |
| --- | --- | --- |
| images | png, jpg/jpeg/jfif, gif, webp, avif, bmp, ico, svg, apng, heic/heif, tif/tiff | the browser decodes it; Preview adds zoom, rotate and a real-size button |
| audio | mp3, wav, ogg/oga, opus, flac, m4a, aac, weba, aiff | `<audio>` plus a waveform decoded from the file itself |
| video | mp4, m4v, webm, ogv, mov, mkv, avi | `<video>`, with the codec limit explained when it cannot play |
| documents | pdf | the browser's own PDF viewer, with "open in tab" when it declines |
| 3D models | glb, gltf, stl, obj, ply | parsed and drawn with WebGL — orbit, zoom, spin |
| disc images | iso, img | ISO9660 volume label and a three-level listing of what is inside |

Everything that needs parsing is parsed in `parsers.js` (pure functions, no
DOM) and tested byte-for-byte in `tools/test-preview.mjs`. There is no
three.js and no CDN: the model viewer is a small WebGL renderer, and the
formats are read directly.

Formats the browser itself cannot decode — HEIF outside Safari, ProRes `.mov`,
a `.gltf` whose `.bin` lives next door — say so in plain words instead of
showing a blank pane. That is the whole point of a preview: it should never
leave you wondering whether the file or the app is broken.

Preview ships with `"desktop": false`: it is reached by opening a file, not
from a shelf. **Add to Desktop** (Settings → Apps, or the app's `preview.d86`
shortcut in Files) puts the icon there if you would rather launch it directly.

Preview is a fixed page, not an app folder: it is listed in
`src/apps/iframe-apps.json` beside Scramjet, ships in `public/preview/`, and
never appears in the App Store or in `~/system/apps/`. It is the default
opener for every type it can render.

### Desktop icons are a choice, not a side effect

Installing an app no longer adds an icon you have to tidy away. The start menu
lists everything installed; the desktop only holds what you put on it:

- **Remove from Desktop** in an app icon's menu takes the icon away and leaves
  the app installed.
- **Add to Desktop** on the app's own page — right-click the app's
  `index.html` in Files — puts it back.
- Settings → **Apps** has a switch per app, plus the file types each claims.

The choice lives in `~/system/desktop-apps.json`, visible in Files like the
rest of your data. Apps can also ship with `"desktop": false` in their
manifest, which is how Preview stays out of the way by default.

### App icons

An app can now carry its own artwork: `"icon-path": "icon.svg"` in its
manifest points at an image inside the app folder, served through the app's
own `9pf/<id>/` route. The desktop icon, the start menu entry and the App
Store card all draw it — so what you see in the store before installing is
the catalog's `icon`, and after installing it is the app's own file. Every
bundled app ships an `icon.svg` next to its code.

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

    ~/system/apps/                 (the guest sees this as /system/apps)

Each file is `{ "apps": [ … ] }` (or a bare array). One entry:

    {
      "id": "hello",                 // the folder name: apps/hello/
      "name": "Hello",
      "icon": "browser",
      "entry": "index.html",
      "folder-isolated": true,
      "opens": ["txt"],              // file types it can open (optional)
      "width": 520, "height": 420
    }

`folder-isolated: true` means the app cannot climb out of its own folder with
`../` — the service worker answers 403. `false` lets it walk up as far as the
OS home (`/home/user`), which is what a file viewer wants and what you should
not give code you didn't write. Either way the app runs same-origin: an
opaque-origin (sandboxed) frame is not controlled by a service worker, so
its own files would not be served at all.

A demo app (`hello`: a clock that fetches `data.json` next to itself) is
created on first boot so the whole loop is visible immediately, and the NES
emulator ships alongside it.

### Default apps and "Open with"

`opens` in an app's registry entry (or in the App Store listing it came from)
declares the file types it handles: `["nes"]`, `[".nes", "*.zip"]`. On boot
every such app may ask — once — to become the default for its types, in a
corner card with **Set as default** / **Not now**. The answer, and the list of
which apps have already asked, live next to the registry:

    ~/system/default-apps.json
    { "defaults": { "nes": "nes" }, "asked": { "nes": "nes" } }

Right-clicking a file in Files or on the desktop offers **Open with ›** with
the current default marked `(default)`. The built-ins have no app folder, so
they are named for what they are: **Text Editor**, and **System** — the
built-in viewer that shows a picture, a page, a PDF or a hex dump. An `.html`
file that is not itself an installed app also offers **App Launcher**, which
runs that one page through the same `9pf/` route an app uses, for as long as
its window is open; nothing is added to `user-apps.json`.

### The App Store

`public/store.json` is the catalog. The App Store (`~/system/apps`'s front
door, hardcoded into the OS) reads it, shows the apps, and installs one by
fetching each file it lists and writing it to `~/system/apps/<id>/` — then
adds the entry to `user-apps.json`. An installed app is therefore an ordinary
folder: editable in Files, visible to the v86 guest at `/system/apps/<id>`,
and removable from the store or by hand.

    {
      "apps": [{
        "id": "snake", "name": "Snake", "icon": "games",
        "base": "system-apps/snake/",        // relative to store.json, or absolute
        "entry": "index.html",
        "files": ["index.html", "app.js", "index.json"],
        "opens": ["nes"],                     // optional, see above
        "description": "…",
        "icon-path": "icon.svg"              // optional: art inside the app folder
      }]
    }

There are no ratings, review counts, download counts or version strings in the
catalog, and the store does not print any. Those numbers would all be invented
— a local catalog has no users to average — so the listing shows only what can
be checked: publisher, category, the files that get written, and the download
size measured from those files when you open the listing.

Settings → Apps → *Catalog* points the store at a different `store.json`
(any URL or path). Nothing is fetched until you press Install, and the store
cannot write outside `~/system/apps`.

What counts as installed is answered by the disk, not by the registry: the
store checks that `~/system/apps/<id>/` still holds the app's entry file, so a
folder deleted in Files (or an entry left behind by a failed uninstall) shows
up as **Install** again rather than as a button pair for something that is no
longer there. It re-reads that state when the window is focused, when anything
else in the OS changes the filesystem, and on demand via **Rescan disk**.

Installed apps get **Open** and **Uninstall** buttons, in the cards, the
featured panel and the detail page. Uninstall is a real delete, not a trip to
the trash: it removes `~/system/apps/<id>/` and takes the entry out of
`user-apps.json`, so nothing is left pointing at files that no longer exist.
Any default-app choice that pointed at the app is reset at the same time,
which means the file type falls back to something that still opens it. The
**Installed** tab re-reads the disk every time you open it, so apps added by
hand (a folder dropped in with Files, or an app copied in from inside the
guest) are listed — and can be uninstalled — the same way.

### The trash

Deleting means moving to `~/trash`, and the bin is the one place with a lock:
opening it asks for a passphrase you set the first time (stored as a SHA-256
hash in localStorage, never in the filesystem, so the guest cannot read it).
Restore and *Delete permanently* live in the trash's own context menu. The
bin is emptied every time Dragon86 is opened — the tab is the session.

### The desktop

Icons are laid out on a grid and can be dragged anywhere: the drop snaps to
the nearest free cell and the arrangement is remembered per device
(`localStorage: dragon86.desktop.layout`). Icons carry no frame until they are
highlighted; left-dragging on empty wallpaper draws a selection box, and
right-clicking it offers *Tidy up icons* to reset the layout.

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

### Archives unpack themselves: .zip, .tar, .gz

There is no archive library here. The browser already decompresses — that is
what `DecompressionStream` is — so `src/core/archive.ts` only had to learn the
*containers*: the zip central directory (stored and deflate entries, zip64,
UTF-8 names, trailing comments, encrypted entries refused with a sentence), tar
blocks (ustar, GNU long names, base-256 sizes, pax headers skipped), and the
gzip header. `src/core/archive-fs.ts` is the half that writes into ZenFS:
entry paths are checked before use (no `..`, no absolute paths), per-file and
total sizes are capped, and nothing is overwritten unless asked.

In the OS:

- **Files** → right-click a zip/tar/gz → **Extract here** or **Extract to
  `<name>`/**. (Archives get their own icon.)
- **Opening** one shows its table of contents: every entry, the unpacked
  total, and the same two extract buttons.
- A plain `.gz` holds one file; it lands under the name in the gzip header, or
  the `.gz`'s own name without the suffix. `.tar.gz`/`.tgz` are gunzipped once
  and then read as tars.

`tools/test-archive.mjs` builds real archives with Node's zlib and checks the
parts that break quietly: names, sizes, offsets, UTF-8, GNU long names, gzip
headers, and that the second entry of a zip is not read from the first one's
bytes. It runs as part of `npm run build`.

### Scripts: printing, running, and `window.d86`

**A `.sh` file opens in the Terminal — printed, not run.** "Open with →
Terminal (print)" (also on the desktop's file menu) opens a Terminal window and
writes the file into the console, with a line above and below saying what it is.
Nothing is executed and nothing is sent to the guest: a script pasted into a
root shell is a command, not a document. Reading a script before running it is
the point.

**A `.js` file can be run as a system script.** Right-click → *Run as system
script*. It asks first — a dialog that says the file runs inside Dragon86 with
no sandbox and can read and write anything in your filesystem — and then
inserts the file into this page as a real `<script>`. There is no worker and no
isolated realm; a reload removes whatever it added (files stay).

Scripts get an API (`src/core/dev-api.ts`), installed at boot as `window.d86`:

```js
// install an app the OS then knows about — no store, no folder copy
await d86.fs.mkdir("~/system/apps/greeter");
await d86.fs.writeText("~/system/apps/greeter/index.html", "<h1>Hello</h1>");
await d86.apps.register({ id: "greeter", name: "Greeter", icon: "grid" });
d86.apps.launch("greeter");
```

| call | |
| --- | --- |
| `d86.fs.readText/readBytes/writeText/writeBytes/list/mkdir/remove/exists/stat` | the same ZenFS the Files app shows (`~` works) |
| `d86.apps.list/register/reload/launch` | installed apps, and adding one from a script |
| `d86.open(path)` | open a file the way the OS would |
| `d86.notify({title, body})`, `d86.log(...)` | a toast, and a tagged console line |
| `d86.script.path` | the file being run |

Writes announce themselves, so files a script creates appear in Files and on
the desktop without a reload. The same object is reachable from a same-origin
app's page as `parent.d86` — that is how the Monaco Editor app saves your files.

### Monaco Editor is an app now; the Text Editor is the OS's own

The built-in **Text Editor** is a plain textarea: always there, no download,
no dependency (`src/apps/plain-editor.ts`). **Monaco Editor** — the editor
behind VS Code, vendored under `public/monaco/` — is an App Store app you
install when you want syntax highlighting and multi-cursor editing. It reads
and writes through `parent.d86`, so it is the same filesystem, not a copy.
Installing it does not steal your double-clicks: text and shell scripts stay
with the Text Editor until you say otherwise (its "Set as default" toast, or
Settings → Default apps).

### CheerpJ: .jar files in the App Store

**CheerpJ** (App Store → Utilities) runs unmodified Java. Pick a `.jar` from
your files and it runs: GUI programs get a display (Swing/AWT draw into the
window), console programs print below it. Once installed it offers to open
`.jar` files, so double-clicking one in Files runs it.

The honest limit: the Java runtime itself is **not vendored** — it is tens of
megabytes of WebAssembly from Leaning Technologies — so it is loaded from
`https://cjrtnc.leaningtech.com/4.3/loader.js` on first use. The jar, though,
is yours: it is passed to CheerpJ through the OS's own file route
(`9pf/@open/<path>`), not copied anywhere.

### Fixed apps live in the filesystem too: `.d86` shortcuts

Some apps are pages that ship with the OS rather than folders you install —
Preview, Scramjet, Dragon Gaming Platforms and the Engine Viewer. They still
show up where apps live: each gets a file in `~/system/apps/`
(`preview.d86`, `scramjet.d86`, `engine-viewer.d86`, …).

The file *is* the shortcut. It contains the HTML that embeds the app:

```html
<!-- Dragon86 app shortcut: Scramjet. The app itself is
     https://…/Dragon86/scramjet/ — a fixed page that ships with the OS. -->
<iframe src="https://…/Dragon86/scramjet/" …></iframe>
```

So anything that only *reads* the file — the Text Editor, `cat` in the guest,
a copy to another machine — gets the iframe markup, while opening it in the OS
launches the real window ("App shortcut" is the default opener for `.d86`).
They are written once, behind a version in `~/system/app-shortcuts.json`, so
deleting one is a decision the OS does not undo on the next boot.

### Engine Viewer: the machine's own screen

The Terminal shows the guest's **serial** console. The machine also has a VGA
display; the guest is booted with `console=tty0 console=ttyS0`, so the BIOS and
the kernel log draw on both. **View Engine** in the Terminal toolbar opens the
Engine Viewer on *that terminal's* machine: a canvas that mirrors the VGA text
screen (colours included — v86 hands the rows over with ANSI escapes), fitted
to the window and repainted only when the screen changes. It is part of the OS,
so it has no desktop icon and no folder; it sits in the start menu, and
`~/system/apps/engine-viewer.d86` points at it.

### The v86 guest: a lightweight Arch userland rooted in your files

The v86 engine boots one guest: the vendored Arch Linux 32 kernel plus a
hand-built userland (bash, coreutils, git, `networking.sh`). There is no big
disk image and nothing is downloaded at boot — the whole distro is unpacked
once from `public/v86/initrd.gz` into `~/v86`, and from then on **the guest's
`/` is that folder**.

That is the point of this engine: everything the distro reads is a file in
your Dragon86 filesystem, and everything it writes lands there too. Edit
`~/v86/etc/hostname` in Files, `cat /etc/hostname` in the Terminal — same
file, no sync step. Your home folders are grafted onto the guest's root, so
`/Documents`, `/Downloads` and `/Desktop` in the Terminal are the same folders
the Files app shows.

How it hangs together (details in `public/v86/VENDORED.md`):

- the kernel boots a small initramfs (`public/v86/initrd.gz`), whose `/init`
  is built from `tools/guest-init/init`;
- `/init` brings up virtio + 9p, mounts the share as `/newroot`, bind-mounts
  `/proc`, `/sys` and `/dev` in, then `chroot`s into it;
- the share itself is served by `src/bridge/p9.ts`, a 9p2000.L server talking
  straight to ZenFS — no HTTP, no image store, no per-device vendoring;
- at every boot the bridge also copies `public/v86/scripts/` into the guest
  root (`/networking.sh`, `/usr/bin/d86-clone`, `/usr/bin/d86-net`,
  `/usr/share/d86/`), and hooks the shell functions into a marked block at the
  end of `/etc/profile` — so `d86-clone`, `d86-net` and the `git` wrapper are
  there on the first login, and every one of those files is readable and
  editable in Files like anything else in the distro.

`~/v86/.dragon86-root.json` marks an unpacked root (version, timestamp, file
count); Settings → **v86 filesystem** can re-unpack it if it is ever damaged.

## What's in the box

- **Window manager** — draggable, resizable, focusable windows with taskbar integration
- **Desktop** — drag-and-drop icon grid, marquee selection, right-click menus
- **Files** — browse/create/rename/trash on a virtual hard drive (ZenFS → IndexedDB), with "Open with" per file type
- **App Store** — installs apps from `store.json` straight into `system/apps/`
- **Settings** — pages with a sidebar and a search box (appearance, apps, trash, engines, storage, about)
- **System viewer** — the built-in opener for anything no app claims: image, page, PDF, audio/video, or a hex dump
- **Text Editor** — the OS's own editor: plain text, `Ctrl+S` saves, no dependency. It opens every text type by default
- **Monaco Editor** — an App Store app (not installed by default): the editor behind VS Code, reading and writing the same files (see below)
- **Terminal** — xterm.js front end. **v86 is the default engine**: an Arch userland that boots inside the page with no isolation and no hoster. CheerpX (embedded or its own tab) is still there under Settings → Engine
- **Preview** — the default opener for pictures, sound, video, PDFs, 3D models and disc images; a fixed page (`public/preview/`), never in the App Store
- **Engine Viewer** — the v86 machine's own VGA display, on a canvas. Reach it from the Terminal's **View Engine** button
- **Scramjet** — web proxy (vendored at `/scramjet/`; traffic via a configurable Wisp server), a JSON-defined iframe app
- **Dragon Gaming Platforms** — the org catalog player (`cdn.singlefile.html`), iframed live from the org's GitHub Pages site, also a JSON-defined iframe app
- **GUST** — single-file web proxy, installed from the App Store like any other app: its folder (`public/system-apps/gust/`) ships its fonts and icons, so nothing comes from a CDN (see its `VENDORED.md`)
- **Sandstone** — sandboxed-iframe web proxy, built from source and installed from the App Store; its folder lives at `public/system-apps/sandstone/` (see its `VENDORED.md`)

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

    npm install
    npm run dev          # the OS at http://localhost:5173/Dragon86/
    npm run build        # typecheck + the unit checks + the Pages bundle
    npm run test:ui      # boots the whole OS headlessly (jsdom) and clicks it
    npm run test:vm      # boots the v86 guest for real, in Node (see below)

`npm run test:ui` bundles `src/main.ts` as one script, loads it into a
simulated page with IndexedDB, a stubbed service worker and a static file
server, then drives the UI: drag an icon, open a context menu, install an app
from the store, trash a file and unlock the bin. It is not a substitute for
looking at it, but it catches the failures that are otherwise invisible until
they throw.

`npm run test:vm` is the same idea one layer down: it loads the vendored
`libv86.js`, the real kernel and initramfs, and the real 9p server
(`src/bridge/p9.ts`, bundled for Node), boots the guest headlessly against a
directory on the host, and fails if the boot ends in the initramfs recovery
shell, if 9p reports `no channels available` even once, or if the shell cannot
run `git`. It is the only way to see a kernel-level v86 fault without a
browser, and it takes about thirty seconds.


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
4. ~~Shared Linux folder~~ ✔ v86 engine: the guest's `/` is the OS filesystem live, both ways (9p served from ZenFS — see `public/v86/VENDORED.md`). CheerpX engine: OS side wired (bridge protocol v2 "fs1", `src/bridge/fs-bridge.ts`, spec in `docs/cheerpx-fs-protocol.md`) — waiting on the hoster to plug it into the guest at `/home/user/shared`
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
  `/` **is** the OS virtual filesystem, live in both
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
- [GUST](https://github.com/nautilus-os/GUST) (AGPL-3.0, Nautilus Labs) — vendored at `public/system-apps/gust/`; its Google Fonts / Font Awesome / iso-639-1 CDN resources were replaced with local copies.
- [Sandstone](https://github.com/ading2210/sandstone) (AGPL-3.0-only, ading2210) — built from source and vendored at `public/system-apps/sandstone/`.
- [Monaco Editor](https://github.com/microsoft/monaco-editor) (MIT, Microsoft) — `monaco-editor` npm package's minified build vendored at `public/monaco/`.
- CheerpX is a trademark of Leaning Technologies; engine licensing applies (Community/Commercial)

## License

TBD by Dragon Gaming Platforms (keep ZenFS's LGPL obligations in mind when shipping).
