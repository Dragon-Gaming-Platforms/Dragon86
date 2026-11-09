# Vendored Puter Wiki app

- source: https://github.com/heyputer/everything (src/wiki)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: MIT, repo-level (this app ships no per-app license and its
  package.json names none) — see LICENSE. Copyright Puter Technologies Inc.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. index.html - removed the `https://js.puter.com/v2/` SDK script tag.
  2. src/main.js boot() - the upstream dev-only `?local` branch is now the
     only branch: pages live in this browser (IndexedDB 'wiki-local' plus a
     localStorage-backed copy of the collaboration service), no sign-in
     screen. The sharing features act on that in-browser copy only -
     invite links cannot actually reach another person.
- storage: pages stay in this browser (IndexedDB 'wiki-local' + localStorage). Nothing is uploaded anywhere.
