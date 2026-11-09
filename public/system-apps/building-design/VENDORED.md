# Vendored Puter Building Design app

- source: https://github.com/heyputer/everything (src/building-design)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: AGPL-3.0-only (per-app LICENSE) — see LICENSE.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. index.html - removed the `https://js.puter.com/v2/` SDK script tag.
     whenPuter() resolves at once when the tag is absent; device files +
     local recovery copies are the designed signed-out mode.
  2. src/main.js - its own service worker disabled (sw.js not shipped):
     Dragon86 already serves apps through the OS service worker.
- storage: projects save to files on this computer; recovery copies live in this browser (IndexedDB 'building-design'). Nothing is uploaded anywhere.
