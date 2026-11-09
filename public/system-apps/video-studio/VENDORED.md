# Vendored Puter Video Studio app

- source: https://github.com/heyputer/everything (src/video-studio)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: AGPL-3.0-only (per-app LICENSE) — see LICENSE.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. index.html - removed the `https://js.puter.com/v2/` SDK script tag.
  2. src/main.js boot() - always takes the local path (no 5-second SDK
     wait, no sign-in): the media library lives in this browser's own
     private storage (OPFS folder 'video-studio/').
- storage: projects and media live in this browser (OPFS + IndexedDB). The bundled
  MediaPipe models (pose/face landmarkers) run locally in the page. Nothing is uploaded anywhere.
