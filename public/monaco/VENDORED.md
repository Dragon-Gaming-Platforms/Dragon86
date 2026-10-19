# Vendored: Monaco Editor

`monaco-editor@0.57.0` from npm (the registry "latest" at download time,
2026-10-19), MIT license in `LICENSE`. Only the minified AMD build
(`min/vs/`) is vendored, including its language workers — Dragon86 loads
`monaco/vs/loader.js` + `vs/editor/editor.main` at runtime from
`src/apps/editor.ts`, so the OS itself works with zero CDN requests.

Used for text/code files in the Text Editor app (syntax highlighting,
VS Code editing behaviour); if it ever fails to load, the editor falls
back to a plain textarea.
