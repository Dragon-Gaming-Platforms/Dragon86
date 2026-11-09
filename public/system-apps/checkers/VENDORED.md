# Vendored Puter Checkers app

- source: https://github.com/heyputer/everything (src/checkers)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93
- license: MIT, repo-level (this app ships no per-app license and its
  package.json names none) — see LICENSE. Copyright Puter Technologies Inc.
- built: 2026-10-18 with `vite build --base=./` after these Dragon86
  modifications to the source:
  1. index.html - removed the plausible.io analytics script. The upstream
     queue stub that absorbs tracking calls when the script is absent stays,
     so no analytics run and nothing errors.
  2. src/net/online.js loadPuter() - now rejects immediately with a clear
     message. Online multiplayer needed a Puter account and Puter's relay
     servers; in Dragon86 the Online menu says it is unavailable. Local
     play (vs computer / two players at one keyboard) is untouched.
- storage: settings and the game in progress stay in this browser (localStorage). Nothing is uploaded anywhere.
