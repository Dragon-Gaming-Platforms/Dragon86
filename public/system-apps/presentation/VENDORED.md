# Vendored Puter Presentation app

- source: https://github.com/heyputer/everything (src/presentation)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: AGPL-3.0-only (per-app LICENSE) — see LICENSE.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. index.html - removed the `https://js.puter.com/v2/` SDK script tag.
  2. src/cloud.js signIn() - throws a clear 'not available in this build'
     message, so the 'Sign in to save' buttons fail honestly instead of
     mysteriously. Work is kept as local drafts (IndexedDB
     'presentation-drafts-v1'); Download/export still produces files.
- storage: presentations are kept as drafts in this browser (IndexedDB 'presentation-drafts-v1'). Nothing is uploaded anywhere.
