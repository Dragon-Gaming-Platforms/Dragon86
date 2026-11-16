# Vendored upstream 3D Studio app

- Source: https://github.com/heyputer/everything (src/3d), commit
  `bfe63f34c06170bb9173bc3a99e26ccaf55dbb93`.
- License: AGPL-3.0-only (see the per-app `LICENSE`).
- Built 2026-10-18 with `vite build --base=./` from Dragon86's vendored app.
- Dragon86 changes: the former hosted AI provider was replaced in the shipped
  assistant bundle with OpenRouter's `/api/v1/chat/completions` endpoint. The
  assistant requires an OpenRouter sign-in from Dragon86 Settings → AI; it
  reads that browser-local credential and sends requests directly to OpenRouter.
  The shipped code does not load a third-party AI SDK.
- Storage: scenes and preferences stay in this browser. The assistant sends
  the scene context and user messages to OpenRouter when used.
