# EmulatorJS frontend

- Emulator runtime: EmulatorJS stable CDN (`https://cdn.emulatorjs.org/stable/data/`), loaded on demand; this repo does not vendor the runtime or any ROM/BIOS/game data.
- COI verification source: EmulatorJS repository revision `5a65bde5d3b47c75f22e90453c3c14c469411589`, `data/src/consts.js` maps `psx` to `pcsx_rearmed` first and lists thread-required cores as `ppsspp`, `dosbox_pure`, and `azahar`; `pcsx_rearmed` is not thread-required. The frontend explicitly disables threads. The app itself does not request COOP/COEP headers or rely on `SharedArrayBuffer`.
- The frontend passes the user-selected browser `File` directly as `EJS_gameUrl` (supported since EmulatorJS 4.2.2).
- PS1 is the EmulatorJS `psx` system, default `pcsx_rearmed`. Upstream EmulatorJS `data/src/consts.js` lists `requiresThreads` as `ppsspp`, `dosbox_pure`, and `azahar` only; `pcsx_rearmed` is not thread-only. This app explicitly sets `EJS_threads = false`, so PS1 gameplay does not require `SharedArrayBuffer` or cross-origin isolation (COI).
- User must provide a compatible game image; no ROMs or BIOS files are shipped.
