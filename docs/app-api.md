# Dragon86 app JavaScript API

Same-origin iframe apps receive a `d86` API on their own `window` (also exposed
as `window.Dragon86`). The familiar `parent.d86` API remains available for
compatibility. Filesystem apps get the app API from a tiny script injected into
their entry HTML before app scripts execute. Fixed same-origin apps receive it
when the iframe finishes loading; they can listen for `d86-ready` if needed.

```js
if (window.d86) startApp();
else window.addEventListener("d86-ready", startApp, { once: true });
```

`d86-ready` carries `{ appId }` in `event.detail`. It fires once each time an
app document is connected to its Dragon86 window.

## ZenFS and picker-backed files

`d86.fs` is the same ZenFS-backed filesystem API available to Dragon86 system
scripts. It includes `readText`, `readBytes`, `writeText`, `writeBytes`,
`list`, `mkdir`, `remove`, `exists`, and `stat`. Paths may be absolute or start
with `~` (for `/home/user`). Writes go straight to ZenFS and appear in Files.

For interactive file transfer, use `d86.files`; its pickers show Dragon86
Files, not the host operating system's file picker. Selected files are
returned as `File` objects with their absolute ZenFS `path` and an authorized
same-origin `url`:

```js
const picked = await d86.files.open({
  accept: ".jar,.zip", // extensions, MIME types, or MIME wildcards
  multiple: false,
});
if (picked.length) {
  const { file, name, path, url } = picked[0];
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Or pass `url` to a runtime that reads files using fetch/HTTP.
}
```

Options are `accept`, `multiple`, and `directory`. A directory selection
returns its files recursively. Each result has:

- `file`: a browser `File` made from the ZenFS bytes;
- `name`: the leaf filename;
- `path`: the absolute ZenFS path;
- `token`: an opaque capability for writing back to this exact selected path
  with `d86.files.write(token, blob)`;
- `url`: the `/9pf/@open/` URL for runtimes such as CheerpJ that need an HTTP
  mount. Opening through the picker grants that exact path to the requesting
  app; the app's existing folder-isolation rules still apply to other paths.

To save output back into ZenFS:

```js
// One-call save picker + write:
await d86.files.save("output.txt", new Blob(["hello"], { type: "text/plain" }));

// Or choose a destination first and write it later:
const target = await d86.files.saveAs("output.zip");
if (target) await target.write(zipBlob);
```

`save` returns `false` if the user cancels. `saveAs` returns `null` on cancel;
otherwise it returns `{ name, path, write(blob) }`. `d86.files.write(token,
blob)` is also available when an app needs to write to a token returned by its
open picker. These operations write to ZenFS; they do not trigger a device
browser download.

## Open URLs through Scramjet

Apps and system scripts can request a proxied HTTPS URL without constructing
Scramjet routes themselves:

```js
d86.openScramjet("https://example.com/");          // regular app window
d86.openScramjetWindow("https://example.com/");    // separate window
d86.openScramjetWebview("https://example.com/");   // maximized webview
```

All three methods validate and route through Dragon86's Scramjet app and its
configured Wisp relay. The URL must be HTTPS; the app title is derived from its
hostname. `openScramjetWebview` maximizes the Dragon86 window, not browser-level
fullscreen. These methods return immediately; they do not await page load.

## Owning Dragon86 app window

Apps can request that their Dragon86 window be maximized, without asking the
browser to enter browser-level fullscreen:

```js
await d86.window.requestFullscreen();
// ... later
if (d86.window.isFullscreen()) d86.window.exitFullscreen();
// or use d86.window.toggleFullscreen()
```

`requestFullscreen()` focuses and maximizes the owning window. `exitFullscreen()`
restores it if maximized; `toggleFullscreen()` toggles; `isFullscreen()`
reports the maximized state. The same user gesture restrictions that apply to
browser-level fullscreen do not apply because this operates the OS window
manager.

## Trust boundary

The API is intended for trusted, same-origin apps. As with Dragon86's system
scripts, same-origin app JavaScript is not a security sandbox: `d86.fs` exposes
the app-author filesystem API and can read or write ZenFS paths. The `files`
picker is the user-visible, explicit-transfer path and grants a selected file
for the app's scoped `/9pf/@open/` access. Do not embed untrusted third-party
scripts in an app that receives this API.

## TypeScript

The public interfaces are defined in `src/apps/app-bridge.ts`. The underlying
filesystem-script API is defined in `src/core/dev-api.ts`; the picker bridge
is in `src/apps/zenfs-files.ts`.
