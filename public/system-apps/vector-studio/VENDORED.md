# Vendored Puter Vector Studio app

- source: https://github.com/heyputer/everything (src/vector-studio)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: MIT, repo-level (no per-app license) — see LICENSE.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. index.html - removed the `https://js.puter.com/v2/` SDK script tag.
  2. src/main.js waitForPuter() - resolves null immediately instead of
     polling 5 seconds for an SDK that never loads; the app boots
     straight into its local, signed-out mode.
- storage: documents and preferences live in this browser. Nothing is uploaded anywhere.
