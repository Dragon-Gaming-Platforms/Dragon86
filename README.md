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
`../` — the service worker answers 403.

**What an isolated app may read.** Files outside an app's folder are reached
through `9pf/@open/<path>`, which Preview, the viewer and CheerpJ use. That
route is governed by `src/core/fs-access.ts`, not by the folder rule alone. An
isolated app may read its own folder and the exact file the OS handed it with
`?file=` (CheerpJ's `.jar`), and nothing else. The OS and non-isolated apps may
read the home folder and `/tmp`. A request whose asker cannot be identified is
refused. `false` lets it walk up as far as the
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

### Service worker: filesystem apps only

`public/app-sw.js` is the only service worker the OS registers. It answers
`9pf/` requests for filesystem apps and files (see *Filesystem apps* above).
Cross-origin isolation is off, so no page needs COOP/COEP headers, and the
legacy `coi-serviceworker.js` is no longer loaded. `tools/test-coi-deregister.mjs`
and `tools/test-startup-reload.mjs` (both run by `npm run build`) guard that
it stays that way: a worker that reloads the page can interrupt a VM while it boots (see the note in `index.html`).

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
waits for the filesystem boot message, guest readiness, and two seconds with no
new OS output before printing the file into the local console. The script
is never sent to the guest as input, and nothing is
executed just by opening it. If no compatible guest OS can boot, the Terminal
still shows the script locally and does not send it to the guest.

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
the desktop without a reload. Same-origin app frames also get a
developer-facing API as `window.d86` (and `window.Dragon86`). In addition to
the ZenFS methods above, it provides a
Dragon86-backed file picker and controls for the owning app window:

```js
const [jar] = await d86.files.open({ accept: ".jar" });
const response = await fetch(jar.url); // exact ZenFS path, granted to this app
await d86.window.requestFullscreen(); // maximize this Dragon86 app window
// Later: d86.window.exitFullscreen();
```

Use `d86.files.saveAs(name)` for a user-chosen ZenFS destination, then call the
returned `write(blob)` method; `d86.files.save(name, blob)` is the one-call
alternative. See [`docs/app-api.md`](docs/app-api.md) for the complete API,
bootstrap timing, examples, and the same-origin trust boundary. Filesystem app
pages receive it before their scripts run; fixed same-origin app pages receive
it at iframe load and may await the `d86-ready` event. The legacy
`parent.d86` route remains available to existing apps.

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

The app opens a `.jar` from Dragon86 Files with
`d86.files.open({ accept: ".jar" })` and runs the authorized ZenFS path through
the OS's `/9pf/@open/` route. It does not prompt for a raw path or keep a
browser-only copy. The
Fullscreen button demonstrates `d86.window.requestFullscreen()`.

The honest limit: the Java runtime itself is **not vendored** — it is tens of
megabytes of WebAssembly from Leaning Technologies — so it is loaded from
`https://cjrtnc.leaningtech.com/4.3/loader.js` on first use.

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

### Engine Viewer: the machine's own screen — and it is writable

The Terminal shows the guest's **serial** console. The machine also has a VGA
display, and this window shows *that* — the way copy.sh/v86 shows a machine.
**View Engine** in the Terminal toolbar opens it on that terminal's machine.

It is the machine's own rendering, not a copy of it. v86 is given a screen
container when the machine is built (`src/bridge/v86.ts` creates it before
`new V86(...)`, because the constructor needs it), and its screen adapter draws
into it from then on: one div per text row, each row a set of spans carrying
the console's own background and foreground colours, a blinking cursor, and a
canvas underneath for graphical modes. The Engine Viewer mounts that element
and scales it to the window with a transform, so the font, the colours, the
cursor — everything — is the machine's. If a guest ever switches to a graphical
mode, the canvas is what appears.

**You can type in it.** Click the screen and keys go to the emulated PS/2
keyboard, which lands on the guest's VGA console: tty1, where the guest's init
runs a login shell of its own. So the Engine Viewer is a *second terminal on the
same machine* — same filesystem, separate session and history, usable at the
same time as the Terminal. `ls`, `vim`, Tab completion, Ctrl-C, Ctrl-D, arrows
in the line editor: all of it works, because the guest's own keyboard driver is
decoding the keys. Pasting is supported too: a text console has no "insert this
string", so pasted text is typed at it, Shift and all (`scancodesForText`).

How the keys travel: `src/bridge/v86-keys.ts` maps `KeyboardEvent.code` (the
*physical* key) to PS/2 set-1 scancodes — release sets the high bit, and
arrows / Home / End / Delete / Insert / Page Up-Down / right Ctrl-Alt arrive
behind a `0xE0` prefix. Only physical keys are sent, never characters: the
guest applies Shift, Caps Lock and the layout itself, so Ctrl-C goes over as
"ctrl down, c down, c up, ctrl up". The machine is built with
`disable_keyboard: true`, which turns off v86's *page-wide* capture — an OS
window must not feed every keystroke in every app to a guest — and the viewer
calls `keyboard_send_scancodes` itself, only while its screen has focus. Keys
the viewer handles are swallowed (`preventDefault` + `stopPropagation`), so
Ctrl-C in the console is the guest's, not a browser or window-manager shortcut.
A machine whose Terminal has been closed is never typed into.

The guest side is two modules and a shell: `i8042`/`atkbd` are loaded at boot
(they simply never were, which is why the console had no keyboard), and
`run_console_session` in `tools/guest-init/init` keeps a login shell alive on
tty1 with `TERM=linux`.

The window asks the machine for its screen every frame rather than holding a
copy, so the order does not matter: open it from the start menu before any
Terminal and it attaches when a machine starts, or open it from a booted
Terminal and it shows that machine immediately. It distinguishes the states out
loud — no machine yet, a machine still booting, a machine whose Terminal has
been closed — because saying "no v86 machine" for a running one was a bug. A
machine has one screen and an element lives in one place, so if two Engine
Viewers are open the newest one shows it and the other says where it went.

Some honest limits. This Arch userland has no X server and the vendored kernel
has no framebuffer driver (`/proc/fb` is empty, there is no `/dev/fb0`), so the
guest is a text-mode machine — copy.sh's own Arch profile is a text console
too. The console grid is the VGA's 80×25. There is no mouse to route: without X,
nothing would read it.

The text buffer is also readable as rows — that is what the status bar counts,
and what the fallback canvas draws for a backend with no element of its own. It
lives on libv86's *screen adapter*, not on the emulator object:
`emu.get_text_screen` and `emu.screen` do not exist. `src/bridge/v86-screen.ts`
is the one place that knows this (including that the adapter appears a few
milliseconds after the constructor and that the method needs its own `this`),
and `tools/vm/boot.mjs` checks it against a real booted machine, so a libv86
bump that moves it again fails the build instead of the window.

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
- **Terminal** — xterm.js front end. **v86 is the default engine**: an Arch userland that boots inside the page, with no separate engine page to run
- **Preview** — the default opener for pictures, sound, video, PDFs, 3D models and disc images; a fixed page (`public/preview/`), never in the App Store
- **Engine Viewer** — the v86 machine's own display, drawn by the emulator. Reach it from the Terminal's **View Engine** button
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

## Architecture

Everything runs in one page. The OS (`src/`) is a Vite + TypeScript app — the
window manager, desktop, Files, App Store and a ZenFS virtual filesystem —
and the machines and apps plug into it:

| Part | Where | Role |
|---|---|---|
| OS page | `src/main.ts`, `src/core/`, `src/apps/` | desktop, window manager, ZenFS, App Store |
| Machine backends | `src/bridge/v86.ts` (x86 and ARM64/ARM32 on the vendored `public/v64/` build), `src/bridge/rv64.ts` (RISC-V 64), `src/bridge/netbsd64.ts` (disk-image OSes for the ARM machines) | the Terminal's machine, chosen in Settings → Engine → Machine architecture |
| Engine contract | `src/bridge/engine.ts` | what the Terminal and Engine Viewer expect from any machine |
| Guest filesystem | `src/bridge/p9.ts`, `src/bridge/guest-root.ts` | the v86 guest's `/` is the OS filesystem, served over 9p |
| Filesystem apps | `public/app-sw.js`, `src/core/fs-apps.ts`, `src/core/fs-access.ts` | apps served from `~/system/apps/` under `/9pf/`, and who may read which file through `/9pf/@open/` |
| DrakeForge bridge | `src/bridge/drakeforge-session.ts`, `src/bridge/fs-bridge.ts` | serves `/home/user` to the deployed DrakeForge workspace (protocol v2) |

The one service worker that runs is `public/app-sw.js`, which owns the `9pf/`
prefix. Cross-origin isolation is off for good: no engine needs
SharedArrayBuffer, and `index.html` says so. `public/coi-serviceworker.js` is
kept vendored but is not loaded.

### VFS wiring

- `/` → IndexedDB (`dragon86-root`), the system root
- `/home` → IndexedDB, your files: the virtual hard drive
- `/tmp` → in memory, cleared on reload

## Develop

    npm install
    npm run dev          # the OS at http://localhost:5173/Dragon86/
    npm run build        # typecheck, unit suites, VM build, then the Pages bundle

`npm run dev` listens on every network interface (`vite.config.ts` sets
`host: true`, which the preview environment needs). To keep it on this
machine, run `npx vite --host 127.0.0.1`.

Use Node 22 (`.nvmrc` pins it; `package.json` requires 22.6 or later, because
the test files run with `--experimental-strip-types`).

The scripts:

- `npm run typecheck` — `tsc --noEmit` over `src/`.
- `npm run test:unit` — every unit suite, listed once in
  `tools/run-unit-tests.mjs` (among them `test-fs-access` for the `@open`
  access rules, `test-app-sw` for the service worker, `test-preview`,
  `test-guest-scripts`). It runs them all and reports every failure together.
  Add a new suite to that list.
- `npm run build` — `typecheck`, `test:unit`, the VM bundle and its p9 test,
  then the production bundle (`build:app`). CI runs it on every pull request.
- `npm run test:ui` — boots the whole OS headlessly (jsdom) and clicks it.
- `npm run test:vm` — boots the v86 guest for real, in Node (see below).
- `npm run test:all` — `build` followed by `test:ui`.

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

## Deploy

GitHub Actions (`.github/workflows/deploy.yml`) builds and publishes to **GitHub Pages** on every push to `main`. First time: repo **Settings → Pages → Source → GitHub Actions**.

> The base path is `/Dragon86/` (project site). For a custom-domain root deploy, set `PAGES_BASE=/` in the workflow's build step.

### CI and repository size

- `.github/workflows/ci.yml` runs on every pull request: the large-file guard,
  `npm run build` and `npm run test:ui`.
- The large-file guard (`tools/check-added-files.mjs`) fails a change that
  **adds** a file over 10 MB. Files already in git are not checked. A
  deliberate exception goes in `.large-files-allow`, one path per line.
- The repository is large today: the NetBSD and Alpine disk images
  (`public/netbsd64/`, `public/alpine32/`), the vendored kernels and initrds,
  and a `.git` history of about 570 MB. New build outputs belong in a GitHub
  Release or external storage. Moving the committed images out of git changes
  how Pages gets them, so it is a deliberate follow-up, not part of the guard.

## Roadmap

1. ~~Core OS shell~~ ✔ desktop, WM, files, editor, settings, terminal chrome
2. ~~CheerpX hoster repo~~ ✔ [CheerpX-Bridge](https://github.com/Dragon-Gaming-Platforms/CheerpX-Bridge) (COI + scoped service worker + Debian disk image)
3. ~~Bridge handshake → real bash in the terminal~~ ✔ wired (default engine URL, cold-boot-aware handshake, late-ready recovery)
4. ~~Shared Linux folder~~ ✔ v86 engine: the guest's `/` is the OS filesystem live, both ways (9p served from ZenFS — see `public/v86/VENDORED.md`). CheerpX engine: OS side wired (bridge protocol v2 "fs1", `src/bridge/fs-bridge.ts`, spec in `docs/cheerpx-fs-protocol.md`) — waiting on the hoster to plug it into the guest at `/home/user/shared`
5. ~~Browser app~~ ✔ Scramjet proxy vendored at `/scramjet/` (see `public/scramjet/VENDORED.md`)
6. Multiple terminals / tmux, cloud-drive mounts (ZenFS backends)

## Engine

The Terminal runs the machine chosen in **Settings → Engine → Machine
architecture**. You choose the hardware; the OS picks the backend:

- **x86 (32-bit) and x86-64** — the vendored v64 emulator (`public/v64/`, a
  v86 descendant) booting a small Arch Linux userland (`public/v86/`). The
  guest's `/` **is** the OS filesystem, live in both directions: Dragon86 serves
  9p straight from ZenFS (`src/bridge/p9.ts`), so guest writes are OS writes
  and the reverse. The distro's own `/` is `~/v86` in Files. The Terminal's
  **Save State** snapshots the machine to IndexedDB, and the next start resumes
  from it. No service worker or isolation is needed for it.
- **ARM64** — NetBSD 11.0 from a real disk image in the browser's private
  storage (OPFS), installed from the App Store. Serial console only; log in as
  root.
- **ARM32** — Alpine Linux (armv7) from a disk image, installed from the App
  Store. Serial console only.
- **RISC-V 64** — the rv64.js emulator (`public/rv64/`), booting Alpine Linux
  (RISC-V 64) from the App Store. Serial console only; no display device.

Diagnostics: the Terminal has a **Dev Console** button (Eruda, contained in the
window), and the `[D86:bridge]` log lines show what each machine is doing.

## Credits

- Design tokens & themes: [Dragon-Gaming-Platforms](https://github.com/Dragon-Gaming-Platforms/Dragon-Gaming-Platforms) brand stylesheet
- [ZenFS](https://github.com/zen-fs/core) (LGPL-3.0) — virtual filesystem
- [xterm.js](https://github.com/xtermjs/xterm.js) (MIT) — terminal emulator
- [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT, © Guido Zuidhof and contributors) — vendored at `public/coi-serviceworker.js` with a local modification: it stamps COOP/COEP **only on document (navigation) responses**, letting all subresources pass through untouched; license in `third-party/`
- [Scramjet](https://github.com/MercuryWorkshop/scramjet) (AGPL-3.0, Mercury Workshop) — web proxy vendored at `public/scramjet/` from its pinned npm builds; license text included there. NOTE: this makes the combined deployed site AGPL-relevant — keep the source link handy.
- [GUST](https://github.com/nautilus-os/GUST) (AGPL-3.0, Nautilus Labs) — vendored at `public/system-apps/gust/`; its Google Fonts / Font Awesome / iso-639-1 CDN resources were replaced with local copies.
- [Sandstone](https://github.com/ading2210/sandstone) (AGPL-3.0-only, ading2210) — built from source and vendored at `public/system-apps/sandstone/`.
- [Monaco Editor](https://github.com/microsoft/monaco-editor) (MIT, Microsoft) — `monaco-editor` npm package's minified build vendored at `public/monaco/`.
- [Puter](https://github.com/heyputer) — a heartfelt **thank you to the heyputer team** for open-sourcing their entire app collection at [heyputer/everything](https://github.com/heyputer/everything). Twenty-one of those apps are vendored under `public/system-apps/`, rebuilt to run fully in the browser with no Puter account: Notes, Whiteboard, Wiki, Photo Studio, Vector Studio, Audio Studio, Music Studio, Video Studio, 3D Studio, Presentation, Records, API Client, CAD, Circuits, Parametric, Building Design, Sudoku, Chess, Checkers, Backgammon and Solitaire. Notes, Whiteboard, Video Studio, 3D Studio, Presentation, Parametric and Building Design are AGPL-3.0 (per-app licenses), the rest MIT; every app folder carries its LICENSE and a VENDORED.md describing the exact modifications. Check out the originals at [puter.com](https://puter.com) — they're even better with the cloud behind them.
- CheerpX is a trademark of Leaning Technologies; engine licensing applies (Community/Commercial)

## License

TBD by Dragon Gaming Platforms (keep ZenFS's LGPL obligations in mind when shipping).

### DrakeForge launcher

DrakeForge is a built-in app, not an engine or an App Store install. The IDE
and connected `/dragon86` route are maintained in the DrakeForge repository.
The launcher opens that route in a separate tab with a unique
`?channel=dragon86-drakeforge-<uuid>` BroadcastChannel and negotiates fs1 before
serving requests. DrakeForge's `v2` `fs-req` messages are answered from
Dragon86's `/home/user` directory; reads, writes, directory operations,
renames and removals are whole-file filesystem operations over the fs1 bridge.
A standalone route is also available as a fallback.

This is a workspace filesystem bridge, **not** a Terminal 9P integration and
not an authorization boundary. The random channel name prevents accidental
cross-talk; malicious same-origin scripts can still access it. Do not use it to
share files with an untrusted same-origin page.
