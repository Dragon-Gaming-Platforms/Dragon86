# Vendored Puter Whiteboard app

- source: https://github.com/heyputer/everything (src/whiteboard)
  @ bfe63f34c06170bb9173bc3a99e26ccaf55dbb93 (AGPL-3.0-only — see LICENSE)
- built: 2026-10-18 with `vite build` (base './', upstream config) after
  these Dragon86 modifications to the source:
  1. index.html — removed the `https://js.puter.com/v2/` SDK script tag.
     Upstream is local-first: boards live in IndexedDB and every Puter
     access is optional-chained, so the app runs fully without the SDK.
     Sign-in/sharing actions that need the cloud simply cannot connect.
  2. index.html — removed the plausible.io analytics snippet. No analytics
     run in Dragon86.
  3. removed robots.txt and sitemap.xml (website deployment cruft).
- storage: boards stay in this browser (IndexedDB). Nothing is uploaded.
- embeds pasted into a board (YouTube, Figma, …) load from their own sites
  only if the user adds one — the app itself makes no external requests.
