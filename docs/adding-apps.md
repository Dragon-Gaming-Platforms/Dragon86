# Adding an app to the Dragon86 App Store

Everything the store installs is declared in three places, all in this
repo. Follow them in order and your app appears in the catalog, installs
cleanly, and gets its `.d86` pointer generated automatically.

## 1. Put the app's files in the repo

Create `public/system-apps/<id>/` with the app's files. `<id>` is lowercase,
unique, and becomes the folder name on every device. The app is a plain web
page: `index.html` plus whatever it loads with relative URLs (`app.js`,
`style.css`, images, wasm — real URLs all work; nothing is rewritten).

Rules the OS enforces:

- Installed apps are served from `~/system/apps/<id>/` behind
  `9pf/<id>/…` and are **folder-isolated** by default — the app cannot read
  outside its own folder.
- Icons: a file inside the folder (`"icon-path": "icon.svg"`), a repo image
  (`"icon": "img:icons/x.png"`), or a built-in glyph name (`"icon": "grid"`).
- No fake statistics, ever: the store shows only what it can check (the
  publisher, the files, their real byte count).

## 2. Give it an `app-manifest.json`

Every app entry in the repo carries `public/system-apps/<id>/app-manifest.json`
saying **where the App Store dumps the app's source** when installing:

```json
{
  "id": "my-app",
  "kind": "iframe-app",
  "dump": "~/system/apps/my-app/"
}
```

Ordinary apps dump into `~/system/apps/<id>/` (that is also the fallback if
the manifest is missing). The manifest exists so that *not-ordinary* entries
can say something different — the Arch Linux distro is a store entry whose
manifest (`public/v86/app-manifest.json`) is:

```json
{
  "id": "arch-linux",
  "kind": "distro",
  "dump": "/",
  "image": "initrd.gz",
  "kernel": "bzImage",
  "arch": ["x86_32", "x86_64"]
}
```

`"kind": "distro"` means: installing unpacks an operating system at the dump
location (`/`), and the Terminal's machines boot it from there. That is how a
distro can be an App Store entry dumped for an engine to run.

## 3. List it in `public/store.json`

Add one entry to the `apps` array:

```json
{
  "id": "my-app",
  "name": "My App",
  "sub": "One-line subtitle",
  "category": "Utilities",
  "publisher": "You",
  "icon": "grid",
  "base": "system-apps/my-app/",
  "entry": "index.html",
  "files": ["index.html", "app.js", "icon.svg", "app-manifest.json"],
  "opens": ["txt"],
  "width": 640,
  "height": 480,
  "description": "A paragraph for the detail page."
}
```

- `files` is the complete list the store fetches — forget one and the
  installed app 404s on it (nested paths like `resources/main.css` are fine).
- Do **not** add ratings, review counts, download counts, versions or any
  other number the catalog cannot actually measure. The store refuses to
  invent statistics and the test suite checks for them.
- `category` decides the tab (`Games` → Games, everything else → Apps).

## 4. What happens automatically

- **Install**: the store fetches every file in `files` into the manifest's
  dump folder, registers the entry in `~/system/apps/user-apps.json`, and the
  app appears on the desktop and in the start menu.
- **`.d86` pointer**: every app entry in the app JSONs (`user-apps.json`,
  the bundled `iframe-apps.json`) gets an auto-generated pointer file in
  `~/applications/<id>.d86` — the file *is* the embed HTML, and opening it
  launches the app. Pointers are regenerated whenever those JSONs change and
  are never duplicated; uninstalling removes the pointer.
- **Desktop removal deletes nothing**: taking an app off the desktop writes
  one field — `{ "hidden": "yes" }` for that app id — into
  `~/system/desktop-apps.json`. The `.d86` pointer and the app stay.
- **Uninstall** (ordinary apps): deletes the dump folder and the registry
  entry. A distro offers no uninstall — its files are woven into `/`.

## Apps that ship installed

Folders here with an `index.json` (Preview, NES, the seeded Hello) are copied
onto every device at first boot by `src/core/fs-apps.ts`. A store app does
not need `index.json`; the catalog's `files` list is its equivalent.
