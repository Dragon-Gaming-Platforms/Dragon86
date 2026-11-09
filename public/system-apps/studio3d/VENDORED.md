# Vendored Puter 3D Studio app

- source: https://github.com/heyputer/everything (src/3d)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: AGPL-3.0-only (per-app LICENSE) — see LICENSE.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. src/assistant/puter.ts loadPuter() - resolves null immediately, so
     the AI assistant reports itself unavailable instead of fetching the
     SDK from js.puter.com (the only place upstream used Puter; the rest
     of the app is offline-first by design). Vendored under 'studio3d'
     because ids starting with a digit are fragile in the OS.
- storage: scenes and preferences live in this browser. Nothing is uploaded anywhere.
