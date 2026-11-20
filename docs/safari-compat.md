# Safari-only bugs: review and fixes

Found by reading the code for things that behave differently in WebKit (Safari, iOS Safari) than in Chromium. None of these fixes have been run in real Safari yet. The Node-based tests cover the logic; a manual check in Safari 17+ and iOS is still needed (see "Not verified").

Ranked by impact, highest first.

## 1. Media served by the service worker ignored `Range` (fixed)

- **Where:** `public/app-sw.js` (`serve()`), `public/preview/app.js` (`showAudio`, `showVideo`).
- **Evidence:** the service worker returned `200` with the whole file for every request, including `Range: bytes=0-1`. Safari needs `206` with `Content-Range` before it will play `<audio>` or `<video>` (Safari asks for the first bytes and then seeks). Preview set `audio.src` and `video.src` to the `9pf/@open` URL, so audio and video did not play in Safari.
- **Confidence:** high. A Node harness of the service worker showed `200`, no `Content-Range`, for `Range: bytes=0-1`.
- **Fix:** `serve()` now answers a single range with `206`, `Content-Range`, and `Accept-Ranges: bytes`. A range past the end gets `416` with `Content-Range: bytes */size`. Requests with no `Range`, several ranges, or a malformed or backwards range still get `200` with the whole file.
- **Test:** `tools/test-app-sw.mjs` (section 8, 14 checks).

## 2. Preview's `@open` requester check could block its own media (avoided)

- **Where:** `public/app-sw.js` (`requesterOf`), `public/preview/app.js`.
- **Evidence:** `requesterOf` identifies the requester by `clientId` first, then by referrer. For media loads, WebKit may send neither, which would leave the requester as `unknown` and refuse the read.
- **Confidence:** medium. Not tested in WebKit.
- **Fix:** Preview no longer depends on this path for audio or video. It reads the bytes once through `fetch` (same route as images) and plays them from a `blob:` URL. The `@open` rules are unchanged. Removing `@open` wholesale is out of scope, since Preview, CheerpJ, and store-installed apps need it.
- **Test:** `tools/test-preview.mjs` checks that audio and video use `blobUrl(` and not `fileUrl(`, and that blob URLs are revoked on `pagehide`.

## 3. Script-written storage can be purged by Safari after 7 days (partly fixed)

- **Where:** `src/apps/settings.ts` (`renderStorage`), `src/main.ts`.
- **Evidence:** the only storage call was `navigator.storage.estimate()`. Nothing called `navigator.storage.persist()`. Safari's Intelligent Tracking Prevention (ITP) can delete script-written storage (IndexedDB, OPFS, Cache, localStorage) after 7 days without a visit, unless the site is installed to the Home Screen. Dragon86's disk lives in IndexedDB, so a Safari user could lose the whole disk.
- **Confidence:** medium. Based on secondary sources. Those sources disagree on whether `persist()` exempts an origin from the 7-day cap in Safari, so this is not stated as fact.
- **Fix:** Settings → Storage now shows whether the browser keeps the disk (`navigator.storage.persisted()`) and offers a button to ask (`navigator.storage.persist()`). In Safari, when the answer is no, it warns about the 7-day limit and the Home Screen. The page still shows the export-snapshot backup advice.
- **Deliberate change from the plan:** `persist()` is not called at boot. Firefox shows a permission prompt for it, so calling it on every load would prompt users unprompted. It runs only when the user clicks the button.
- **Not verified:** whether `persist()` in Safari actually stops the 7-day purge. Needs a Safari 17+ test.

## 4. `100vh` clipped the bottom of app iframes on iOS (fixed)

- **Where:** `src/core/app-shortcuts.ts` (`iframeBody`).
- **Evidence:** iOS Safari's `100vh` ignores the toolbar, so it is taller than the visible area and the bottom of the app is hidden under the toolbar.
- **Confidence:** medium (known WebKit behaviour; not seen on a device).
- **Fix:** `height:100vh;height:100dvh`. Browsers without `dvh` ignore the second declaration and keep `100vh`, so Chromium is unchanged. I did not use `100%`, because the wrapper document does not size `html` or `body`, and `100%` would collapse the iframe to zero height.

## 5. Missing `-webkit-backdrop-filter` (fixed)

- **Where:** `src/styles/os.css` (`.ps2-picker, .ps2-import-overlay`, around line 2611).
- **Evidence:** the other `backdrop-filter` rules already had the prefix; this one did not. Safari 17 and older ignore the unprefixed property, so the blur was missing.
- **Fix:** added the prefixed declaration.

## 6. Waveform failed silently (fixed)

- **Where:** `public/preview/app.js` (`showAudio`, waveform decode).
- **Evidence:** if `decodeAudioData` fails (for some codecs in WebKit), the waveform was removed with no explanation.
- **Fix:** the canvas is replaced by a short note saying no waveform could be drawn and playback still works. Playback itself is unchanged.

## Checked and not a bug

- **`CompressionStream` in `src/bridge/v86.ts` (`saveState`):** an earlier note said this was unguarded. It is already in a try/catch that stores the raw data. No change.
- **`src/bridge/netbsd64.ts`:** `openDiskWritable`, `diskLockHint`, and `checkQuota` already handle WebKit errors.

## Not verified

- No run in real Safari or iOS Safari. The Range behaviour, the `persist()` result in Safari, and the iOS `dvh` fix all need a device check.
- Item 2 (requester identity for media) is avoided rather than tested. Other media loads that go through `@open` are unchanged and still depend on it.

## Tests run

`npm run build` (same two baseline `INEFFECTIVE_DYNAMIC_IMPORT` warnings), `npm run test:unit` (20 suites), `tools/test-app-sw.mjs` (33/33), `tools/test-preview.mjs`, `npm run test:guest`, `npm run test:ui`, `npm run test:fs-access` (27/27).
