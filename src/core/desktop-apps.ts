/**
 * Which apps get an icon on the desktop.
 *
 * An installed app and a desktop icon are two different things. The start
 * menu lists every app that exists; the desktop is a shelf you arrange, and
 * it should only hold the things you actually use — otherwise installing a
 * dozen apps means a dozen icons you then have to tidy away one by one.
 *
 * Removing an app from the desktop deletes NOTHING — not the app, not its
 * `.d86` pointer in ~/applications. The entire record of the choice is one
 * JSON field per app:
 *
 *     ~/system/desktop-apps.json
 *     { "apps": { "preview": { "hidden": "yes" }, "snake": { "hidden": "no" } } }
 *
 * `"hidden": "yes"` → no desktop icon; `"hidden": "no"` → icon, even when the
 * app's own manifest ships `"desktop": false`; no entry → the manifest's
 * default. That's it.
 *
 * The file is part of the filesystem, not localStorage, for the same reason
 * user-apps.json is: it is user data, it should be visible in Files, and it
 * should survive a cleared browser profile. (Older builds stored the same
 * choices as two arrays, `hidden` and `shown`; those migrate on first load.)
 */

import * as vfs from "./vfs";
import { logInfo, logWarn } from "./log";

const FILE = `${vfs.HOME}/system/desktop-apps.json`;
const EVENT = "d86-desktop-apps-changed";

type Hidden = "yes" | "no";

interface Prefs {
  apps: Record<string, { hidden: Hidden }>;
}

let prefs: Prefs = { apps: {} };
let loaded = false;
const listeners = new Set<() => void>();

function normalize(parsed: unknown): Prefs {
  const out: Prefs = { apps: {} };
  if (!parsed || typeof parsed !== "object") return out;
  const obj = parsed as {
    apps?: Record<string, { hidden?: unknown }>;
    hidden?: unknown;
    shown?: unknown;
  };
  if (obj.apps && typeof obj.apps === "object") {
    for (const [id, entry] of Object.entries(obj.apps)) {
      if (entry?.hidden === "yes" || entry?.hidden === "no") {
        out.apps[id] = { hidden: entry.hidden };
      }
    }
  }
  /* Migration from the old { hidden: [], shown: [] } arrays. */
  if (Array.isArray(obj.hidden)) {
    for (const id of obj.hidden) if (typeof id === "string") out.apps[id] = { hidden: "yes" };
  }
  if (Array.isArray(obj.shown)) {
    for (const id of obj.shown) if (typeof id === "string") out.apps[id] = { hidden: "no" };
  }
  return out;
}

export async function loadDesktopPrefs(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    if (await vfs.exists(FILE)) {
      const raw = JSON.parse(await vfs.readText(FILE)) as unknown;
      prefs = normalize(raw);
      /* Rewrite once if the file was in the old array format, so what is on
         disk matches what this module documents. */
      const obj = raw as { hidden?: unknown; shown?: unknown };
      if (Array.isArray(obj.hidden) || Array.isArray(obj.shown)) {
        await save();
        logInfo("os", "desktop-apps.json migrated to the hidden yes/no format");
      }
    }
  } catch (err) {
    logWarn("os", `${FILE} is not valid JSON — ignoring it`, err);
    prefs = { apps: {} };
  }
}

async function save(): Promise<void> {
  try {
    await vfs.ensureDir(`${vfs.HOME}/system`);
    await vfs.writeText(FILE, JSON.stringify(prefs, null, 2));
  } catch (err) {
    logWarn("os", "could not write desktop-apps.json", err);
  }
}

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      logWarn("os", "a desktop-apps listener threw", err);
    }
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Should this app have a desktop icon, given its manifest's default? */
export function onDesktop(id: string, manifestDefault = true): boolean {
  const hidden = prefs.apps[id]?.hidden;
  if (hidden === "yes") return false;
  if (hidden === "no") return true;
  return manifestDefault;
}

/** True when the choice is explicit rather than the manifest's default. */
export function desktopChoice(id: string): "shown" | "hidden" | null {
  const hidden = prefs.apps[id]?.hidden;
  if (hidden === "yes") return "hidden";
  if (hidden === "no") return "shown";
  return null;
}

export async function setOnDesktop(id: string, show: boolean): Promise<void> {
  await loadDesktopPrefs();
  prefs.apps[id] = { hidden: show ? "no" : "yes" };
  await save();
  logInfo("os", `${id}: hidden="${show ? "no" : "yes"}" in desktop-apps.json (nothing was deleted)`);
  emit();
}

/** Forget an app's choice entirely — used when the app is uninstalled. */
export async function forgetDesktopChoice(id: string): Promise<void> {
  await loadDesktopPrefs();
  if (!(id in prefs.apps)) return;
  delete prefs.apps[id];
  await save();
  emit();
}

/** Notified after any change, so the desktop can redraw. */
export function onDesktopAppsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
