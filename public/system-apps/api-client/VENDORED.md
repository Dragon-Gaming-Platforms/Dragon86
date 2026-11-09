# Vendored Puter API Client app

- source: https://github.com/heyputer/everything (src/api-client)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: MIT, repo-level (no per-app license) — see LICENSE.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. index.html - removed the `https://js.puter.com/v2/` SDK script tag.
  2. src/main.js waitForPuter() - returns null immediately. Upstream's
     guest mode (IndexedDB 'api-client-guest') is first-class and becomes
     the only mode; no 4-second SDK wait, no sign-in.
- storage: collections, history and globals live in this browser (IndexedDB 'api-client-guest'). Requests go only where you point them. Nothing is uploaded anywhere.
