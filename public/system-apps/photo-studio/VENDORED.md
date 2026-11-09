# Vendored Puter Photo Studio app

- source: https://github.com/heyputer/everything (src/photo-studio)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: MIT (per-app LICENSE) — see LICENSE.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. index.html - removed the `https://js.puter.com/v2/` SDK script tag.
     The editor boots unconditionally; every Puter feature degrades on
     its own when the SDK is absent.
- storage: documents live in this browser (IndexedDB 'photo-studio-local'). Nothing is uploaded anywhere.
