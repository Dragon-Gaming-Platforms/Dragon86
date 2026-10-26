# Vendored: Monaco Editor

`monaco-editor@0.57.0` from npm (the registry "latest" at download time,
2026-10-19), MIT license in `LICENSE`. Only the minified AMD build
(`min/vs/`) is vendored, including its language workers — the **Monaco
Editor** app (`public/system-apps/monaco/`) loads `monaco/vs/loader.js` +
`vs/editor/editor.main` from here at runtime, so nothing is fetched from a CDN.

The OS itself does not use it: the built-in **Text Editor** is a plain
textarea (`src/apps/plain-editor.ts`), and Monaco is an app you install from
the App Store. That keeps the OS small and means a browser that cannot run
Monaco still has a working editor.
