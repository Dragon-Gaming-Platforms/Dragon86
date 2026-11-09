# Vendored Puter Sudoku app

- source: https://github.com/heyputer/everything (src/sudoku)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: MIT, repo-level (this app ships no per-app license and its
  package.json names none) — see LICENSE. Copyright Puter Technologies Inc.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. index.html - removed the `https://js.puter.com/v2/` SDK script tag.
     With the SDK absent the app hides its account button on its own;
     cross-device sync is simply off.
- storage: puzzles in progress, settings and stats stay in this browser (localStorage). Nothing is uploaded anywhere.
