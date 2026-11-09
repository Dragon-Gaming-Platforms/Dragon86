# Vendored Puter Records app

- source: https://github.com/heyputer/everything (src/records)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: MIT, repo-level (no per-app license) — see LICENSE.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. index.html - removed the `https://js.puter.com/v2/` SDK script tag.
  2. src/main.js boot() - the upstream dev-only `?local` branch is now the
     only branch: bases live in this browser (IndexedDB 'records-local'
     + a journal), no sign-in screen.
- storage: bases live in this browser (IndexedDB 'records-local'). Nothing is uploaded anywhere.
