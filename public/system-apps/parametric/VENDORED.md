# Vendored Puter Parametric app

- source: https://github.com/heyputer/everything (src/parametric)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: AGPL-3.0-only (per-app LICENSE) — see LICENSE.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. index.html - the SDK script tag is replaced by `window.__puterFailed
     = true` (the flag upstream's loader watches), so the app runs its
     offline path with no 5-second wait.
  2. index.html - removed the plausible.io analytics snippet.
- storage: parts and recovery copies live in this browser (IndexedDB 'parametric-*'). The replicad/OpenCascade kernel (22 MB wasm) runs locally. Nothing is uploaded anywhere.
