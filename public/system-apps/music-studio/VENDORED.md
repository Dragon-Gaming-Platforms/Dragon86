# Vendored Puter Music Studio app

- source: https://github.com/heyputer/everything (src/music-studio)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: MIT, repo-level (no per-app license) — see LICENSE.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. index.html - removed the `https://js.puter.com/v2/` SDK script tag.
     Upstream's Puter wrapper degrades gracefully by design ('the only
     backend... every call degrades when the SDK is missing').
- storage: songs and presets live in this browser (IndexedDB 'music-studio'). Nothing is uploaded anywhere.
