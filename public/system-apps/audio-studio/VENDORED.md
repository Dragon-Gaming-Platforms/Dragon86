# Vendored Puter Audio Studio app

- source: https://github.com/heyputer/everything (src/audio-studio)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: MIT, repo-level (no per-app license) — see LICENSE.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. index.html - removed the `https://js.puter.com/v2/` SDK script tag.
  2. src/main.js - removed upstream's 'unregister old service workers'
     cleanup. On Dragon86's origin every registration belongs to the OS,
     and unregistering them would break app serving for the whole system.
- storage: recordings and projects are edited in memory; save/export goes through the browser. Nothing is uploaded anywhere.
