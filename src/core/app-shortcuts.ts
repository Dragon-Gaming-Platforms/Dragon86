/**
 * `.d86` files — the shortcuts that make fixed apps visible in the filesystem.
 *
 * Scramjet, Preview and the Engine Viewer are pages that ship with the OS:
 * there is no folder to install and nothing to uninstall. That left them
 * invisible in ~/system/apps, where every other app lives, so each one gets a
 * `.d86` file (Dragon86) beside the app folders. The file *is* the shortcut:
 * its contents are the HTML that embeds the app, so anything that just reads
 * it — the Text Editor, `cat` in the guest, a copy to another machine — gets
 * the iframe markup, and opening it in the OS launches the real window.
 *
 * Written once, behind a version, like the seeded apps: deleting the file is
 * a decision the OS does not undo on the next boot.
 */

import * as vfs from "./vfs";
import { logInfo, logWarn } from "./log";
import { staticIframeApp, staticIframeApps } from "../apps/iframe-app";

export const SHORTCUT_EXT = "d86";

/** Bump when a new fixed app appears: existing devices then get its file. */
const SHORTCUT_VERSION = 1;

const DIR = `${vfs.HOME}/system/apps`;
const MANIFEST = `${vfs.HOME}/system/app-shortcuts.json`;

export interface FixedApp {
  id: string;
  name: string;
  sub?: string;
}

/**
 * Apps that are part of the OS rather than folders: the fixed iframe apps,
 * plus the Engine Viewer, which is a native window with no page of its own.
 */
export function fixedApps(): FixedApp[] {
  const apps: FixedApp[] = staticIframeApps().map((def) => ({
    id: def.id,
    name: def.name,
    sub: def.sub,
  }));
  apps.push({
    id: "engine-viewer",
    name: "Engine Viewer",
    sub: "The v86 machine's own screen",
  });
  return apps;
}

export function shortcutPath(id: string): string {
  return `${DIR}/${id}.${SHORTCUT_EXT}`;
}

/** `~/system/apps/scramjet.d86` → `scramjet`. */
export function appIdFromShortcut(path: string): string {
  const name = vfs.baseName(path);
  return name.replace(new RegExp(`\\.${SHORTCUT_EXT}$`, "i"), "");
}

export function isShortcut(path: string): boolean {
  return new RegExp(`\\.${SHORTCUT_EXT}$`, "i").test(path);
}

function osBase(): string {
  return new URL(import.meta.env.BASE_URL, window.location.origin).href;
}

/**
 * What a `.d86` file contains: the iframe that embeds the app, at an absolute
 * URL (the file lives at a 9pf path, so a relative one would resolve there).
 * The Engine Viewer has no page, so its file says what it is and where it
 * lives instead of pointing at something that does not exist.
 */
export function shortcutHtml(app: FixedApp): string {
  const def = staticIframeApp(app.id);
  if (!def?.url) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${app.name}</title>
</head>
<body style="margin:0;background:#111;color:#ddd;font:14px/1.5 ui-monospace,monospace">
<!-- Dragon86 app shortcut: ${app.name}. This app is part of the OS rather than
     a page, so there is no iframe to embed — opening this file launches it.
     In the Terminal, "View Engine" opens the same window for its machine. -->
<pre style="padding:16px">${app.name}
${app.sub ?? ""}

Part of Dragon86: it runs inside the OS window manager, not inside an iframe.
Open this file to launch it, or use the start menu.</pre>
</body>
</html>
`;
  }
  const url = new URL(def.url, osBase()).href;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${app.name}</title>
</head>
<body style="margin:0">
<!-- Dragon86 app shortcut: ${app.name}. The app itself is ${url} — a fixed
     page that ships with the OS. Opening this file launches it as a window. -->
<iframe src="${url}" title="${app.name}" style="border:0;display:block;width:100vw;height:100vh" allow="${def.allow ?? "clipboard-read; clipboard-write; fullscreen; gamepad"}"></iframe>
</body>
</html>
`;
}

async function exists(path: string): Promise<boolean> {
  try {
    return await vfs.exists(path);
  } catch {
    return false;
  }
}

/**
 * Put the shortcut files in place once per version. Called at boot, after the
 * filesystem is ready.
 */
export async function ensureAppShortcuts(): Promise<void> {
  try {
    await vfs.ensureDir(DIR);
    let version = 0;
    if (await exists(MANIFEST)) {
      try {
        const parsed = JSON.parse(await vfs.readText(MANIFEST)) as { version?: number };
        version = typeof parsed.version === "number" ? parsed.version : 0;
      } catch (err) {
        logWarn("os", `${MANIFEST} is not valid JSON — rewriting it`, err);
      }
    }
    if (version >= SHORTCUT_VERSION) return;

    const written: string[] = [];
    for (const app of fixedApps()) {
      const path = shortcutPath(app.id);
      /* Never overwrite a file that is there: it may have been edited, and a
         boot must not quietly undo an edit. */
      if (await exists(path)) continue;
      await vfs.writeText(path, shortcutHtml(app));
      written.push(app.id);
    }
    await vfs.writeText(MANIFEST, JSON.stringify({ version: SHORTCUT_VERSION }, null, 2));
    logInfo(
      "os",
      written.length
        ? `wrote ${written.length} .${SHORTCUT_EXT} shortcut(s) in system/apps: ${written.join(", ")}`
        : `app shortcuts are up to date (${SHORTCUT_VERSION})`,
    );
  } catch (err) {
    logWarn("os", "could not write the .d86 app shortcuts", err);
  }
}

/** The app a shortcut points at, if it is still part of the OS. */
export function fixedAppFor(id: string): FixedApp | null {
  const def = staticIframeApp(id);
  if (def) return { id: def.id, name: def.name, sub: def.sub };
  if (id === "engine-viewer") return { id, name: "Engine Viewer", sub: "The v86 machine's own screen" };
  return null;
}
