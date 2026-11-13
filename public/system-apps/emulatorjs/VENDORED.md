# EmulatorJS frontend

- Emulator runtime: EmulatorJS stable CDN (`https://cdn.emulatorjs.org/stable/data/`), loaded on demand. This repo does not vendor the runtime or any ROM/BIOS/game data.
- Game loading: the frontend passes the user's browser `File` directly as `EJS_gameUrl` (supported since EmulatorJS 4.2.2).
- PS1/COI verification: at EmulatorJS revision `5a65bde5d3b47c75f22e90453c3c14c469411589`, `data/src/consts.js` maps `psx` to `pcsx_rearmed` first; its thread-required list is only `ppsspp`, `dosbox_pure`, and `azahar`. `pcsx_rearmed` is not thread-required. Both frontends explicitly set `EJS_threads = false`; neither needs `SharedArrayBuffer` or COOP/COEP headers for PS1.
- Users must provide compatible game files (and any BIOS their game requires). No ROMs or BIOS files are shipped.
