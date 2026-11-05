/**
 * `.d86` pointers — one file per app, auto-generated in ~/applications.
 *
 * Every app entry in an app-related JSON gets a pointer file here:
 *
 *   - the fixed apps bundled in src/apps/iframe-apps.json (Preview,
 *     Scramjet, Dragon Gaming, DrakeForge) plus the Engine Viewer;
 *   - every entry in ~/system/apps/*.json (user-apps.json and friends) —
 *     the filesystem apps, installed from the App Store or by hand.
 *
 *     ~/applications/preview.d86
 *     ~/applications/snake.d86
 *     …
 *
 * The file *is* the shortcut: its contents are the HTML that embeds the
 * app, so anything that just reads it — the Text Editor, `cat` in the
 * guest, a copy to another machine — gets the iframe markup, and opening
 * it in the OS launches the real window.
 *
 * Generation rules:
 *   - regenerated whenever those JSONs change (boot + every registry
 *     reload), and only then — a signature of the current app list is kept
 *     in ~/system/app-pointers.json, so an unchanged list touches nothing
 *     (deleting a pointer by hand therefore sticks until the list changes);
 *   - never duplicated: one `<id>.d86` per app, rewritten in place only
 *     when its content is out of date;
 *   - a pointer whose app entry is gone (uninstalled) is removed — but only
 *     pointers this module generated; anything else in ~/applications is
 *     left alone.
 *
 * Removing an app from the DESKTOP does not touch these files: that is one
 * `hidden: "yes"` field in desktop-apps.json (core/desktop-apps.ts).
 *
 * Older builds wrote the fixed apps' shortcuts into ~/system/apps; those
 * migrate here once, so no app ever has two pointer files.
 */

import * as vfs from "./vfs";
import { logInfo, logWarn } from "./log";
import { staticIframeApp, staticIframeApps } from "../apps/iframe-app";
import { getFsApps, onFsAppsChange, type FsAppSummary } from "./fs-apps";

export const SHORTCUT_EXT = "d86";

/** Where the pointers live. */
export const POINTER_DIR = `${vfs.HOME}/applications`;

const MANIFEST = `${vfs.HOME}/system/app-pointers.json`;

/* The pre-~/applications scheme, cleaned up once. */
const OLD_DIR = `${vfs.HOME}/system/apps`;
const OLD_MANIFEST = `${vfs.HOME}/system/app-shortcuts.json`;

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
    sub: "The machine's own screen",
  });
  return apps;
}

export function shortcutPath(id: string): string {
  return `${POINTER_DIR}/${id}.${SHORTCUT_EXT}`;
}

/** `~/applications/scramjet.d86` → `scramjet`. */
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

function pointerDoc(name: string, comment: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${name}</title>
</head>
<body style="margin:0">
<!-- ${comment} -->
${body}
</body>
</html>
`;
}

function iframeBody(name: string, url: string, allow?: string): string {
  return `<iframe src="${url}" title="${name}" style="border:0;display:block;width:100vw;height:100vh" allow="${allow ?? "clipboard-read; clipboard-write; fullscreen; gamepad"}"></iframe>`;
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
    return pointerDoc(
      app.name,
      `Dragon86 app pointer: ${app.name}. This app is part of the OS rather than
     a page, so there is no iframe to embed — opening this file launches it.
     In the Terminal, "View Engine" opens the same window for its machine.`,
      `<pre style="padding:16px;background:#111;color:#ddd;font:14px/1.5 ui-monospace,monospace">${app.name}
${app.sub ?? ""}

Part of Dragon86: it runs inside the OS window manager, not inside an iframe.
Open this file to launch it, or use the start menu.</pre>`,
    );
  }
  const url = new URL(def.url, osBase()).href;
  return pointerDoc(
    app.name,
    `Dragon86 app pointer: ${app.name}. The app itself is ${url} — a fixed
     page that ships with the OS. Opening this file launches it as a window.`,
    iframeBody(app.name, url, def.allow),
  );
}

/** The pointer for a filesystem app: its real 9pf URL, absolute. */
function fsAppHtml(app: FsAppSummary): string {
  const url = new URL(`9pf/${app.id}/${app.entry}`, osBase()).href;
  return pointerDoc(
    app.name,
    `Dragon86 app pointer: ${app.name}. The app's files live in
     ${app.dir.replace(vfs.HOME, "~")}/ and are served at ${url}.
     Opening this file in Dragon86 launches it as a window.`,
    iframeBody(app.name, url),
  );
}

interface PointerManifest {
  v: number;
  /** Signature of the app list the pointers were generated from. */
  sig: string;
  /** Ids this module generated — the only files it may ever delete. */
  generated: string[];
}

/** FNV-1a over a string — enough to tell two app lists apart. */
function sig(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

async function exists(path: string): Promise<boolean> {
  try {
    return await vfs.exists(path);
  } catch {
    return false;
  }
}

async function readManifest(): Promise<PointerManifest | null> {
  try {
    const parsed = JSON.parse(await vfs.readText(MANIFEST)) as PointerManifest;
    return typeof parsed.sig === "string" && Array.isArray(parsed.generated) ? parsed : null;
  } catch {
    return null;
  }
}

/** One-time move away from the old ~/system/apps/<id>.d86 scheme. */
async function migrateOldShortcuts(): Promise<void> {
  if (!(await exists(OLD_MANIFEST))) return;
  let removed = 0;
  for (const app of fixedApps()) {
    const old = `${OLD_DIR}/${app.id}.${SHORTCUT_EXT}`;
    if (await exists(old)) {
      await vfs.removePath(old).catch(() => {});
      removed++;
    }
  }
  await vfs.removePath(OLD_MANIFEST).catch(() => {});
  logInfo(
    "os",
    `app pointers moved to ~/applications${removed ? ` (${removed} old file(s) removed from ~/system/apps)` : ""}`,
  );
}

let running: Promise<void> | null = null;
let runAgain = false;

/**
 * Bring ~/applications in line with the app JSONs. Called at boot and after
 * every registry change; cheap when nothing changed.
 */
export function ensureAppShortcuts(): Promise<void> {
  if (running) {
    runAgain = true;
    return running;
  }
  running = (async () => {
    do {
      runAgain = false;
      await regenerate();
    } while (runAgain);
  })().finally(() => {
    running = null;
  });
  return running;
}

async function regenerate(): Promise<void> {
  try {
    await migrateOldShortcuts();

    /* Every app entry from every app-related JSON, one content per id. */
    const desired = new Map<string, string>();
    for (const app of fixedApps()) desired.set(app.id, shortcutHtml(app));
    for (const app of getFsApps()) {
      if (!desired.has(app.id)) desired.set(app.id, fsAppHtml(app));
    }

    const manifest = await readManifest();
    const listSig = sig([...desired.entries()].map(([id, html]) => `${id}:${sig(html)}`).join("\n"));
    if (manifest?.sig === listSig) return; /* the JSONs did not change */

    await vfs.ensureDir(POINTER_DIR);
    const written: string[] = [];
    for (const [id, html] of desired) {
      const path = shortcutPath(id);
      const current = (await exists(path)) ? await vfs.readText(path).catch(() => null) : null;
      if (current === html) continue; /* already there — never duplicate */
      await vfs.writeText(path, html);
      written.push(id);
    }

    /* Pointers whose app entry is gone — only ones this module generated. */
    const removed: string[] = [];
    for (const id of manifest?.generated ?? []) {
      if (desired.has(id)) continue;
      const path = shortcutPath(id);
      if (await exists(path)) {
        await vfs.removePath(path).catch(() => {});
        removed.push(id);
      }
    }

    await vfs.ensureDir(`${vfs.HOME}/system`);
    await vfs.writeText(
      MANIFEST,
      JSON.stringify({ v: 1, sig: listSig, generated: [...desired.keys()] } satisfies PointerManifest, null, 2),
    );
    if (written.length || removed.length) {
      logInfo(
        "os",
        `~/applications pointers: ${written.length} written${written.length ? ` (${written.join(", ")})` : ""}` +
          `${removed.length ? `, ${removed.length} removed (${removed.join(", ")})` : ""}`,
      );
    }
  } catch (err) {
    logWarn("os", "could not regenerate the .d86 app pointers", err);
  }
}

/** Regenerate whenever the app registry (the JSONs) changes. */
export function watchAppPointers(): void {
  onFsAppsChange(() => void ensureAppShortcuts());
}

/** The app a shortcut points at, if it is still part of the OS. */
export function fixedAppFor(id: string): FixedApp | null {
  const def = staticIframeApp(id);
  if (def) return { id: def.id, name: def.name, sub: def.sub };
  if (id === "engine-viewer") return { id, name: "Engine Viewer", sub: "The machine's own screen" };
  return null;
}
