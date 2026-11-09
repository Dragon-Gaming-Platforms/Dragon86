# Vendored Puter Circuits app

- source: https://github.com/heyputer/everything (src/circuits)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: MIT, repo-level (no per-app license) — see LICENSE.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. index.html - the SDK script tag is replaced by `window.__puterFailed
     = true`, the exact flag upstream's loader watches for a failed SDK:
     loadPuter() resolves null at once and the app runs its offline path.
- storage: projects and the component library live in this browser (IndexedDB 'circuits-*'). Nothing is uploaded anywhere.
