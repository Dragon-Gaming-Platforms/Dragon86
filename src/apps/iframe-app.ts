/**
 * Iframe apps — the JSON system for adding same-origin iframe apps.
 *
 * To add an app, add ONE entry to `iframe-apps.json` (no other code):
 *
 *   {
 *     "id": "my-app",                 // unique, stable
 *     "name": "My App",               // desktop / start-menu label
 *     "sub": "Short subtitle",        // start-menu subtitle (optional)
 *     "url": "my-app/",               // see URL rules below
 *     "icon": "browser",              // ICONS name in core/dom.ts, OR
 *                                     // "img:icons/my-app.png" for a
 *                                     // vendored image under public/
 *     "width": 900, "height": 600,    // initial window size (optional)
 *     "status": "Status bar text"     // optional
 *   }
 *
 * URL rules (enforced at runtime):
 * - Relative URLs ("scramjet/", "games/index.html") resolve against the
 *   OS base — the common case for pages vendored under public/.
 * - Absolute URLs are allowed ONLY if same-origin with the OS page
 *   (e.g. other project sites under dragon-gaming-platforms.github.io).
 *   Cross-origin entries are refused with an in-window error: under
 *   COEP require-corp they would usually be blocked by the browser
 *   anyway, and same-origin keeps the embed predictable.
 *
 * The app appears automatically on the desktop and in the start menu,
 * with a window titled `name`.
 */

import { el } from "../core/dom";
import type { Win } from "../core/wm";
import { logInfo, logWarn } from "../core/log";
import appsJson from "./iframe-apps.json";

export interface IframeAppDef {
  id: string;
  name: string;
  sub?: string;
  /** Set for entries that come from iframe-apps.json. */
  url?: string;
  icon: string;
  width?: number;
  height?: number;
  status?: string;
  allow?: string;
  /**
   * Set for apps that come from the filesystem (src/core/fs-apps.ts): the
   * app is addressed as <base>9pf/<id>/<entry> and served by the service
   * worker, file by file.
   */
  fs?: { entry: string; isolated: boolean; dir: string };
  /** Put the iframe behind a sandbox (no allow-same-origin). */
  sandbox?: boolean;
}

export const IFRAME_APPS: IframeAppDef[] = appsJson as IframeAppDef[];

/** Add apps discovered in the filesystem (called once per boot). */
export function registerFsApps(defs: IframeAppDef[]): void {
  for (const def of defs) {
    const at = IFRAME_APPS.findIndex((a) => a.id === def.id);
    if (at >= 0) IFRAME_APPS[at] = def;
    else IFRAME_APPS.push(def);
  }
}

/** The URL an app is served from; null if it would be cross-origin. */
export function resolveAppUrl(def: IframeAppDef): string | null {
  const base = new URL(import.meta.env.BASE_URL, window.location.origin);
  if (def.fs) {
    /* Real path, real origin: relative <script src>, imports, fetch() and
       wasm inside the app all resolve normally. */
    return new URL(`9pf/${def.id}/${def.fs.entry}`, base).href;
  }
  if (!def.url) return null;
  const resolved = new URL(def.url, base);
  return resolved.origin === window.location.origin ? resolved.href : null;
}

export function openIframeApp(win: Win, def: IframeAppDef): void {
  const root = el("div", "app-root");
  const status = el("div", "app-statusbar");
  status.textContent = def.status ?? def.name;

  const url = resolveAppUrl(def);
  if (!url) {
    const err = el(
      "div",
      "iframe-app-error",
      `Refused to load "${def.name}": iframe apps must be same-origin with Dragon86.`,
    );
    root.append(err, status);
    win.el.append(root);
    logWarn("os", `iframe app ${def.id}: cross-origin URL refused (${def.url})`);
    return;
  }

  const frame = document.createElement("iframe");
  frame.className = "browser-frame";
  frame.src = url;
  frame.title = def.name;
  /* Opt-in sandbox. Filesystem apps leave this off by default: an opaque
     origin is not controlled by a service worker, so the app's own files
     would stop being served (see the note in core/fs-apps.ts). */
  if (def.sandbox) {
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-modals allow-downloads");
  }
  frame.allow =
    def.allow ?? "clipboard-read; clipboard-write; fullscreen; gamepad";
  frame.addEventListener("load", () => {
    logInfo("os", `iframe app ${def.id} loaded: ${url}`);
  });

  root.append(frame, status);
  win.el.append(root);
}
