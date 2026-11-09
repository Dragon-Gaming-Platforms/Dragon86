# Vendored Puter CAD app

- source: https://github.com/heyputer/everything (src/cad)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: MIT, repo-level (no per-app license) — see LICENSE.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. index.html - removed the `https://js.puter.com/v2/` SDK script tag.
     whenPuter() resolves false by itself when the tag is absent, and the
     app is 'usable without an account' by design (device files + local
     recovery copies).
  2. src/main.js - its own service worker disabled (sw.js not shipped):
     Dragon86 already serves apps through the OS service worker.
- storage: drawings save to files on this computer; recovery copies live in this browser (IndexedDB 'cad'). Nothing is uploaded anywhere.
