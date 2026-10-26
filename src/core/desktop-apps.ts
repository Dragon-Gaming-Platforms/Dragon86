/**
 * Which apps get an icon on the desktop.
 *
 * An installed app and a desktop icon are two different things. The start
 * menu lists every app that exists; the desktop is a shelf you arrange, and
 * it should only hold the things you actually use — otherwise installing a
 * dozen apps means a dozen icons you then have to tidy away one by one.
 *
 * Three inputs decide it, in this order:
 *
 *   1. an explicit "shown" here (you pressed Add to Desktop);
 *   2. an explicit "hidden" here (you pressed Remove from Desktop);
 *   3. the app's own manifest: `"desktop": false` means "install me, do not
 *      clutter the desktop" — Preview ships that way.
 *
 * The file is part of the filesystem, not localStorage, for the same reason
 * user-apps.json is: it is user data, it should be visible in Files, and it
 * should survive a cleared browser profile.
 *
 *     ~/system/desktop-apps.json
 *     { "hidden": ["preview"], "shown": ["snake"] }
 */

import * as vfs from "./vfs";
import { logInfo, logWarn } from "./log";

const FILE = `${vfs.HOME}/system/desktop-apps.json`;
const EVENT = "d86-desktop-apps-changed";

interface Prefs {
  hidden: string[];
  shown: string[];
}

let prefs: Prefs = { hidden: [], shown: [] };
let loaded = false;
const listeners = new Set<() => void>();

function normalize(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export async function loadDesktopPrefs(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    if (await vfs.exists(FILE)) {
      const parsed = JSON.parse(await vfs.readText(FILE)) as Partial<Prefs>;
      prefs = { hidden: normalize(parsed.hidden), shown: normalize(parsed.shown) };
    }
  } catch (err) {
    logWarn("os", `${FILE} is not valid JSON — ignoring it`, err);
    prefs = { hidden: [], shown: [] };
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
  if (prefs.hidden.includes(id)) return false;
  if (prefs.shown.includes(id)) return true;
  return manifestDefault;
}

/** True when the choice is explicit rather than the manifest's default. */
export function desktopChoice(id: string): "shown" | "hidden" | null {
  if (prefs.hidden.includes(id)) return "hidden";
  if (prefs.shown.includes(id)) return "shown";
  return null;
}

export async function setOnDesktop(id: string, show: boolean): Promise<void> {
  await loadDesktopPrefs();
  prefs.hidden = prefs.hidden.filter((x) => x !== id);
  prefs.shown = prefs.shown.filter((x) => x !== id);
  (show ? prefs.shown : prefs.hidden).push(id);
  await save();
  logInfo("os", `${id} ${show ? "added to" : "removed from"} the desktop`);
  emit();
}

/** Forget an app's choice entirely — used when the app is uninstalled. */
export async function forgetDesktopChoice(id: string): Promise<void> {
  await loadDesktopPrefs();
  const before = prefs.hidden.length + prefs.shown.length;
  prefs.hidden = prefs.hidden.filter((x) => x !== id);
  prefs.shown = prefs.shown.filter((x) => x !== id);
  if (prefs.hidden.length + prefs.shown.length === before) return;
  await save();
  emit();
}

/** Notified after any change, so the desktop can redraw. */
export function onDesktopAppsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
