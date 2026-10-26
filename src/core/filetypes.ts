/**
 * File types — who opens what.
 *
 * Three kinds of opener:
 *
 *   1. the OS's own built-ins: the Text Editor for text, and "System" for
 *      everything else (the built-in viewer, apps/viewer.ts). Built-ins have
 *      no app folder, so menus name them after what they are;
 *   2. installed apps that declare `"opens": ["nes"]` in their
 *      user-apps.json entry (or in the App Store listing they came from).
 *      Such an app may ask, once, to become the default;
 *   3. the App Launcher, offered for any .html file that is not itself an
 *      installed app: it runs the page as an app for as long as it is open.
 *
 * The user's choices live in the filesystem, next to the apps themselves:
 *
 *     ~/system/default-apps.json
 *     { "defaults": { "nes": "nes" }, "asked": { "nes": "nes" } }
 */

import * as vfs from "./vfs";
import { logInfo, logWarn } from "./log";
import { notify } from "./toast";
import { fsAppsWithOpens, getFsApps, normExt, type FsAppSummary } from "./fs-apps";

export interface Opener {
  /** App id, or one of BUILTIN ids below. */
  id: string;
  name: string;
  icon: string;
  kind: "app" | "editor" | "system" | "launcher";
}

export const BUILTIN = {
  editor: "builtin:editor",
  system: "builtin:system",
  launcher: "builtin:launcher",
} as const;

const TEXT_EXT = new Set(
  (
    "txt md markdown log json jsonc js mjs cjs ts tsx jsx css scss sass less yml yaml sh bash zsh " +
    "py xml csv tsv ini cfg conf env toml c h cpp hpp rs go java kt rb php sql lua"
  ).split(" "),
);

const PAGE_EXT = new Set(["html", "htm"]);

const FILE = `${vfs.HOME}/system/default-apps.json`;

interface DefaultsFile {
  defaults?: Record<string, string>;
  asked?: Record<string, string>;
}

let store: DefaultsFile = { defaults: {}, asked: {} };
let loaded = false;

/** `notes.TXT` → `txt`; no extension → "". */
export function extOf(path: string): string {
  const name = vfs.baseName(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function isTextExt(ext: string): boolean {
  return TEXT_EXT.has(ext);
}

export async function loadDefaults(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    if (await vfs.exists(FILE)) {
      const parsed = JSON.parse(await vfs.readText(FILE)) as DefaultsFile;
      store = {
        defaults: parsed.defaults && typeof parsed.defaults === "object" ? parsed.defaults : {},
        asked: parsed.asked && typeof parsed.asked === "object" ? parsed.asked : {},
      };
    }
  } catch (err) {
    logWarn("os", `${FILE} is not valid JSON — ignoring it`, err);
  }
}

async function save(): Promise<void> {
  try {
    await vfs.writeText(FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    logWarn("os", "could not write default-apps.json", err);
  }
}

function builtinOpeners(ext: string): Opener[] {
  if (TEXT_EXT.has(ext)) {
    return [
      { id: BUILTIN.editor, name: "Text Editor", icon: "editor", kind: "editor" },
      /* Also offered: useful for a file that is called .txt but is not. */
      { id: BUILTIN.system, name: "System", icon: "browser", kind: "system" },
    ];
  }
  /* A page is shown by System, but editing one is common enough that the
     editor belongs in its "Open with" list too. */
  if (PAGE_EXT.has(ext)) {
    return [
      { id: BUILTIN.system, name: "System", icon: "browser", kind: "system" },
      { id: BUILTIN.editor, name: "Text Editor", icon: "editor", kind: "editor" },
    ];
  }
  /* Pages and binaries both land on the built-in viewer, which knows how to
     show a picture, a page, or a hex dump. It has no app name of its own, so
     it is called System — which is exactly what it is. */
  return [{ id: BUILTIN.system, name: "System", icon: "browser", kind: "system" }];
}

/** Installed apps that claim this extension, in registry order. */
export function appOpeners(ext: string): Opener[] {
  return fsAppsWithOpens(ext).map((app: FsAppSummary) => ({
    id: app.id,
    name: app.name,
    icon: app.icon,
    kind: "app" as const,
  }));
}

/** True when this is a page that is not itself an installed app. */
export function canLaunchAsApp(path: string): boolean {
  if (!PAGE_EXT.has(extOf(path))) return false;
  const dir = vfs.parentOf(path);
  const name = vfs.baseName(path).replace(/\.html?$/i, "");
  return !getFsApps().some((a) => a.id === name || a.dir === dir);
}

export function launcherOpener(): Opener {
  return { id: BUILTIN.launcher, name: "App Launcher", icon: "browser", kind: "launcher" };
}

/** Everyone who can open this file, default first. */
export function openersFor(path: string): Opener[] {
  const ext = extOf(path);
  const list = [...appOpeners(ext), ...builtinOpeners(ext)];
  if (canLaunchAsApp(path)) list.push(launcherOpener());
  const wanted = defaultFor(ext);
  const at = list.findIndex((o) => o.id === wanted);
  if (at > 0) list.unshift(...list.splice(at, 1));
  return list;
}

export function openerById(id: string, path?: string): Opener | null {
  if (path) {
    const found = openersFor(path).find((o) => o.id === id);
    if (found) return found;
  }
  if (id === BUILTIN.editor) return { id, name: "Text Editor", icon: "editor", kind: "editor" };
  if (id === BUILTIN.system) return { id, name: "System", icon: "browser", kind: "system" };
  if (id === BUILTIN.launcher) return launcherOpener();
  const app = getFsApps().find((a) => a.id === id);
  return app ? { id, name: app.name, icon: app.icon, kind: "app" } : null;
}

export function defaultFor(ext: string): string | null {
  const chosen = store.defaults?.[ext];
  if (chosen) return chosen;
  /* No choice yet: an app that claims the type wins over the built-in,
     which is the point of an app asking for it. */
  const claim = appOpeners(ext)[0];
  if (claim) return claim.id;
  return builtinOpeners(ext)[0]?.id ?? null;
}

export function isDefault(ext: string, openerId: string): boolean {
  return defaultFor(ext) === openerId;
}

export async function setDefault(ext: string, openerId: string | null): Promise<void> {
  await loadDefaults();
  if (!ext) return;
  store.defaults ??= {};
  if (openerId) store.defaults[ext] = openerId;
  else delete store.defaults[ext];
  await save();
  logInfo("os", `default for .${ext} is now ${openerId ?? "(built-in)"}`);
}

/**
 * Drop every default choice that points at `appId` — called when an app is
 * uninstalled, so the type falls back to something that still exists instead
 * of to a name nothing answers to. Returns the extensions that were reset.
 */
export async function clearDefaultsForApp(appId: string): Promise<string[]> {
  await loadDefaults();
  const cleared: string[] = [];
  for (const [ext, id] of Object.entries(store.defaults ?? {})) {
    if (id !== appId) continue;
    delete store.defaults![ext];
    cleared.push(ext);
  }
  for (const [ext, id] of Object.entries(store.asked ?? {})) {
    if (id === appId) delete store.asked![ext];
  }
  if (cleared.length) {
    await save();
    logInfo("os", `default app for ${cleared.map((e) => `.${e}`).join(", ")} reset (app removed)`);
  }
  return cleared;
}

/** Forget every "already asked" note, so apps may ask again. */
export async function resetAsked(): Promise<void> {
  await loadDefaults();
  store.asked = {};
  await save();
}

/**
 * Let installed apps ask, once each, to become the default for the types
 * they claim. Called once per boot, after the registry is loaded. Toasts
 * queue, so several apps never cover each other.
 */
export async function requestDefaults(): Promise<void> {
  await loadDefaults();
  store.asked ??= {};
  let changed = false;
  for (const app of fsAppsWithOpens()) {
    /* Collect this app's *unclaimed* types first, then ask once. An app that
       opens forty extensions (Preview) must not fire forty toasts. */
    const free: string[] = [];
    for (const raw of app.opens) {
      const ext = normExt(raw);
      if (!ext) continue;
      if (store.defaults?.[ext] === app.id) continue;
      if (store.asked[ext] === app.id) continue;
      /* Someone else already owns it: note it and leave their choice alone
         instead of nagging about a type that is already handled. */
      if (store.defaults?.[ext]) {
        store.asked[ext] = app.id;
        changed = true;
        continue;
      }
      store.asked[ext] = app.id;
      changed = true;
      free.push(ext);
    }
    if (!free.length) continue;

    const claim = () => {
      for (const ext of free) void setDefault(ext, app.id);
    };
    if (free.length === 1) {
      const ext = free[0];
      notify({
        title: `${app.name} can open .${ext} files`,
        body: `Make ${app.name} the default app for .${ext}? Change it any time in Settings → Default apps.`,
        icon: app.icon,
        timeout: 0,
        actions: [
          { label: "Set as default", primary: true, onClick: claim },
          { label: "Not now", onClick: () => void save() },
        ],
      });
    } else {
      const shown = free.slice(0, 6).map((e) => `.${e}`).join(", ");
      notify({
        title: `${app.name} can open ${free.length} file types`,
        body: `Including ${shown}${free.length > 6 ? " and more" : ""}. Make ${app.name} the default app for these? Change it any time in Settings → Default apps.`,
        icon: app.icon,
        timeout: 0,
        actions: [
          { label: `Set for ${free.length} types`, primary: true, onClick: claim },
          { label: "Not now", onClick: () => void save() },
        ],
      });
    }
  }
  if (changed) await save();
}
