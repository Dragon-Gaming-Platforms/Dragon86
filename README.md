# <div align="center">Dragon86 </div>

**A web OS by Dragon Gaming Platforms.** No login, no server — the whole desktop lives in your browser's local storage.
<div align="center">
  
![status](https://img.shields.io/badge/status-dev%20build-e60012) ![stack](https://img.shields.io/badge/stack-Vite%20%C2%B7%20TypeScript%20%C2%B7%20ZenFS-2a2a2a)

</div>

## What's in the box

- **Window manager** — draggable, resizable, focusable windows with taskbar integration
- **Files** — browse/create/rename/delete on a virtual hard drive (ZenFS → IndexedDB)
- **Text Editor** — open & edit any text file, `Ctrl+S` saves
- **Terminal** — xterm.js front end, waiting for the **CheerpX** engine (message-bridge protocol v1 is wired)
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
4. Shared Linux folder in the Files app
5. Multiple terminals / tmux, cloud-drive mounts (ZenFS backends)

## Engine

The Terminal connects to the **CheerpX-Bridge** hoster by default
(`https://dragon-gaming-platforms.github.io/CheerpX-Bridge/`). Override it in
**Settings → Engine** for development. First cold boot can take ~20 seconds
(service-worker install + WASM compile + disk connect); later opens are warm
and fast.

**Diagnostics:** the Terminal has a **Dev Console** button (Eruda, contained
in the window). Watch the `[D86:bridge]` logs — especially the *iframe probe*
line, which reads the embedded hoster's `crossOriginIsolated` directly.
Isolation debugging rule: the top OS page must report
`crossOriginIsolated: true` (after the one-time service-worker reload) before
the engine inside the iframe can start at all.

## Credits

- Design tokens & themes: [Dragon-Gaming-Platforms](https://github.com/Dragon-Gaming-Platforms/Dragon-Gaming-Platforms) brand stylesheet
- [ZenFS](https://github.com/zen-fs/core) (LGPL-3.0) — virtual filesystem
- [xterm.js](https://github.com/xtermjs/xterm.js) (MIT) — terminal emulator
- [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT, © Guido Zuidhof and contributors) — vendored at `public/coi-serviceworker.js`, license in `third-party/`
- CheerpX is a trademark of Leaning Technologies; engine licensing applies (Community/Commercial)

## License

TBD by Dragon Gaming Platforms (keep ZenFS's LGPL obligations in mind when shipping).
