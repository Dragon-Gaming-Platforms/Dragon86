# system-apps — apps that ship with the OS

Each folder here is a **filesystem app**: the OS copies its listed files into
`~/system/apps/<id>/`, and from then on the guest and Files app see the same
files. The App Store manifest (`public/store.json`) is the source of each
app's file list.

For vendored Puter apps, file-open, upload, save-as, and download actions are
routed through Dragon86's ZenFS picker (the user's `/` and `/home`), not the
host browser's file chooser or Downloads folder. Dragon86 injects the adapter
when it serves those apps, so already-installed copies receive it too; their
existing local project/recovery storage remains unchanged.

| app | what it is |
|---|---|
| `preview` | The default app for pictures, sound, video, PDFs, 3D models and ISO disc images. |
| `emulatorjs` | EmulatorJS frontend; user selects their own game file. No ROMs or BIOS files are bundled. EmulatorJS runtime assets load from its CDN. |
| `ps1` | Dedicated PlayStation frontend using EmulatorJS `pcsx_rearmed`, explicitly single-threaded (no COI requirement); user supplies game files. |
| `tasks` | Vendored Puter Tasks app; Puter account and internet needed for cloud sync. |
| `contacts` | Vendored Puter Contacts app; Puter account and internet needed for cloud sync. |
| `snake` | A small grid game; installable from the App Store. |
| `calculator` | Four-function calculator; installable from the App Store. |

The EmulatorJS entry downloads only this lightweight frontend. The upstream
EmulatorJS runtime is fetched on demand from its CDN, and game/BIOS content is
never part of Dragon86's catalog or app files. The older standalone NES app
and its test ROM have been removed; filesystem migration also removes any old
NES app registration from users' app manifests.

## The manifest

`user-apps.json` (and an App Store listing) understands these fields:

```json
{
  "id": "my-app",                  // unique, lowercase; also the folder name
  "name": "My App",
  "sub": "Short subtitle",         // start menu / store subtitle
  "icon": "browser",               // a built-in glyph name, or "img:icons/x.png"
  "icon-path": "icon.svg",         // image inside the app folder (wins over "icon")
  "entry": "index.html",
  "title-template": "My App - {file}",  // window title when opening a file
  "desktop": false,                // start with no desktop icon (default true)
  "folder-isolated": true,
  "opens": ["txt"],
  "width": 640,
  "height": 480
}
```

`icon-path` is resolved through the app's own `9pf/<id>/` route, so the file
must be inside the app folder — `"icon-path": "icon.svg"` shows
`~/system/apps/my-app/icon.svg`. That is what the desktop icon, the start
menu and the App Store card draw, which is why bundled apps ship an
`icon.svg` next to their code.

`desktop` is only the *starting* state. The desktop is a shelf you arrange:
**Remove from Desktop** in an app icon's menu takes the icon away without
uninstalling anything (the app stays in the start menu), **Add to Desktop**
on the app's own page — right-click its `index.html` in Files — puts it back,
and Settings → Apps has a switch per app. The choice is stored in
`~/system/desktop-apps.json`.

`title-template` only applies when the app is opening a file: `{file}` is
replaced with the file's name. `opens` is optional and should only be listed
when the app can actually consume a path passed in `?file=<absolute path>`.
The EmulatorJS frontend uses a browser-local file picker instead, so it does
not claim file types it cannot automatically read from Dragon86 Files.

To make your own: add `~/system/apps/my-app/` with an `index.html`, then an
entry in `~/system/apps/user-apps.json`:

```json
{ "id": "my-app", "name": "My App", "entry": "index.html", "folder-isolated": true, "opens": ["txt"] }
```
