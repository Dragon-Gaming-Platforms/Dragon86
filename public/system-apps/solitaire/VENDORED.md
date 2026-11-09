# Vendored Puter Solitaire app

- source: https://github.com/heyputer/everything (src/solitaire)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: MIT, repo-level (this app ships no per-app license and its
  package.json names none) — see LICENSE. Copyright Puter Technologies Inc.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. index.html - removed the `https://js.puter.com/v2/` SDK script tag.
     Upstream's cloud sync is fully optional-chained, so removing the tag
     turns it off silently; saves and stats are local.
  2. src/main.js - service-worker registration disabled (and sw.js not
     shipped): Dragon86 already serves this app through its own service
     worker, and a second one registered at this scope would break reloads.
- storage: saves, stats and settings stay in this browser (localStorage). Nothing is uploaded anywhere.
