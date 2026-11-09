# Vendored Puter Notes app

- source: https://github.com/heyputer/everything (src/notes)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93 (AGPL-3.0-only — see LICENSE)
- built: 2026-10-18 with `vite build` (base './', upstream config) after
  these Dragon86 modifications to the source:
  1. index.html — removed the `https://js.puter.com/v2/` SDK script tag.
     The app never talks to Puter's cloud from Dragon86.
  2. src/main.js boot() — the upstream dev-only `?local` branch is now the
     only branch: the app always uses its own IndexedDB backend
     (src/data/local-backend.js, DB name 'notes-local'), no sign-in screen.
  3. The local session starts with env 'app' instead of 'web', which hides
     the sign-out button and the Puter apps panel — neither makes sense here.
- storage: everything stays in this browser (IndexedDB 'notes-local').
  Nothing is uploaded anywhere.
- the bundle still contains the upstream cloud-backend module as dead code
  (it is statically imported); it is unreachable and no Puter URL is fetched.
