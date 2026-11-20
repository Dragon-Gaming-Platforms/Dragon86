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
 *     "status": "Status bar text",    // optional
 *     "desktop": false,               // optional: no desktop icon
 *     "title-template": "My App - {file}",  // optional window title
 *     "opens": ["png", "pdf"]         // optional: file types it opens
 *   }
 *
 * Every entry also gets a shortcut file in the filesystem —
 * `~/system/apps/<id>.d86`, written at boot — so an iframe app is visible
 * where apps live even though its code is a fixed page, not a folder. The
 * file holds the plain HTML that embeds the app; opening it launches the
 * window (see core/fs-apps.ts and core/filetypes.ts).
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
import { installZenFSFilesBridge, isZenFSFileApp } from "./zenfs-files";
import { openPs2Library } from "./ps2-library";
import * as vfs from "../core/vfs";
import { grantFile } from "../core/fs-access";
import { createFsResponder } from "../bridge/fs-bridge";
import {
  DRAKEFORGE_CHANNEL_PREFIX,
  drakeforgeSessionUrl,
  startDrakeforgeSession,
} from "../bridge/drakeforge-session";

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
  /** Extensions this app opens, e.g. ["nes"]. Set from user-apps.json. */
  opens?: string[];
  /**
   * Window title while opening a file, {file} standing for its name. Set from
   * "title-template" in the manifest (Preview uses "Preview - {file}").
   */
  titleTemplate?: string;
  /** Whether the app starts with a desktop icon (default true). */
  onDesktop?: boolean;
  /** Put the iframe behind a sandbox (no allow-same-origin). */
  sandbox?: boolean;
}

/**
 * The JSON keys are kebab-case ("title-template") because they sit next to
 * user-apps.json, which uses the same style; the runtime object is camelCase.
 * `desktop` is accepted as the JSON spelling of `onDesktop`.
 */
interface RawIframeApp extends IframeAppDef {
  desktop?: boolean;
  "title-template"?: string;
}

function normalize(raw: RawIframeApp): IframeAppDef {
  const { desktop, "title-template": titleTemplate, ...rest } = raw;
  return {
    ...rest,
    onDesktop: desktop ?? raw.onDesktop ?? true,
    titleTemplate: titleTemplate ?? raw.titleTemplate,
  };
}

export const IFRAME_APPS: IframeAppDef[] = (appsJson as RawIframeApp[]).map(normalize);

/** Ids that came from the filesystem registry the last time it was read. */
let fsAppIds = new Set<string>();

/**
 * Replace the filesystem half of the app list — called at boot and again
 * after the App Store installs or removes something, so the desktop, the
 * start menu and the file-type menus all see the new set.
 */
export function registerFsApps(defs: IframeAppDef[]): void {
  for (const def of defs) {
    const at = IFRAME_APPS.findIndex((a) => a.id === def.id);
    if (at >= 0) IFRAME_APPS[at] = def;
    else IFRAME_APPS.push(def);
  }
  const keep = new Set(defs.map((d) => d.id));
  for (const id of fsAppIds) {
    if (keep.has(id)) continue;
    const at = IFRAME_APPS.findIndex((a) => a.id === id);
    if (at >= 0) IFRAME_APPS.splice(at, 1);
  }
  fsAppIds = keep;
}

/** The fixed apps from iframe-apps.json (not installed from the filesystem). */
export function staticIframeApps(): IframeAppDef[] {
  return IFRAME_APPS.filter((a) => !a.fs);
}

/** The fixed app with this id, if any. */
export function staticIframeApp(id: string): IframeAppDef | null {
  return IFRAME_APPS.find((a) => a.id === id && !a.fs) ?? null;
}

/** Register a one-off app (an .html file run through the App Launcher). */
export function registerTransientApp(def: IframeAppDef): void {
  const at = IFRAME_APPS.findIndex((a) => a.id === def.id);
  if (at >= 0) IFRAME_APPS[at] = def;
  else IFRAME_APPS.push(def);
}

/** The URL an app is served from; null if it would be cross-origin. */
export function resolveAppUrl(def: IframeAppDef, filePath?: string): string | null {
  const base = new URL(import.meta.env.BASE_URL, window.location.origin);
  if (def.fs) {
    /* Real path, real origin: relative <script src>, imports, fetch() and
       wasm inside the app all resolve normally. `?file=` tells an app which
       document the user asked it to open (see apps/registry.ts). */
    const url = new URL(`9pf/${def.id}/${def.fs.entry}`, base);
    if (filePath) {
      url.searchParams.set("file", filePath);
      /* The one file this app was handed may be read through @open even when
         it lies outside an isolated app's folder (CheerpJ reads a .jar). */
      grantFile(def.id, filePath);
    }
    return url.href;
  }
  if (!def.url) return null;
  const resolved = new URL(def.url, base);
  if (resolved.origin !== window.location.origin) return null;
  /* A fixed app that opens files (Preview) is handed the path the same way:
     the page decides what to do with it. */
  if (filePath) resolved.searchParams.set("file", filePath);
  return resolved.href;
}

export function openIframeApp(win: Win, def: IframeAppDef, filePath?: string): void {
  if (def.id === "ps2-web-recomp") {
    openPs2Library(win);
    return;
  }
  if (isZenFSFileApp(def.id)) installZenFSFilesBridge();
  const root = el("div", "app-root");
  const status = el("div", "app-statusbar");
  status.textContent = filePath ? `${fileName(filePath)} — ${def.name}` : (def.status ?? def.name);

  if (def.id === "drakeforge") {
    openDrakeForge(win, root, status, def);
    return;
  }

  const url = resolveAppUrl(def, filePath);
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

  const fullscreenScramjet = def.id === "scramjet" && new URL(url).searchParams.get("fullscreen") === "1";
  if (fullscreenScramjet) {
    root.classList.add("scramjet-fullscreen");
    status.hidden = true;
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

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** DrakeForge owns its IDE UI; Dragon86 provides its scoped fs1 workspace
 * channel. This is deliberately a separate tab: DrakeForge's route owns the
 * isolation needed by BrowserPod, while BroadcastChannel carries only fs1. */
function openDrakeForge(win: Win, root: HTMLElement, status: HTMLElement, def: IframeAppDef): void {
  const panel = el("div", "iframe-app-error");
  const message = el("p");
  const connectedLink = el("a", "", "Open connected DrakeForge in a new tab") as HTMLAnchorElement;
  connectedLink.target = "_blank";
  connectedLink.rel = "noopener noreferrer";
  const standaloneLink = el("a", "", "Open standalone workspace instead") as HTMLAnchorElement;
  standaloneLink.href = def.url!;
  standaloneLink.target = "_blank";
  standaloneLink.rel = "noopener noreferrer";
  message.textContent =
    "The connected route can read and write your Dragon86 /home/user files through fs1. " +
    "This is a workspace bridge, not a Terminal 9P mount. The random channel name prevents " +
    "accidental cross-talk; it is not an authorization boundary against same-origin scripts.";
  panel.append(message, connectedLink, document.createElement("br"), standaloneLink);
  root.append(panel, status);
  win.el.append(root);

  if (typeof BroadcastChannel === "undefined" || typeof crypto.randomUUID !== "function") {
    status.textContent = "Connected DrakeForge requires BroadcastChannel and crypto.randomUUID; use standalone instead";
    connectedLink.hidden = true;
    return;
  }

  let stopSession = () => {};
  const setState = (state: "connecting" | "ready" | "fs1" | "offline") => {
    if (state === "connecting") status.textContent = "Waiting for the connected DrakeForge tab to open…";
    else if (state === "offline") status.textContent = "No DrakeForge handshake yet — still listening for the tab";
    else if (state === "ready") status.textContent = "DrakeForge opened, but did not negotiate fs1";
    else status.textContent = "Connected — Dragon86 /home/user is available over fs1";
  };
  const startSession = (): void => {
    stopSession();
    const id = crypto.randomUUID();
    const channelName = `${DRAKEFORGE_CHANNEL_PREFIX}${id}`;
    connectedLink.href = drakeforgeSessionUrl(id).href;
    const channel = new BroadcastChannel(channelName);
    stopSession = startDrakeforgeSession(channel, createFsResponder(vfs.HOME), setState);
  };
  startSession();
  connectedLink.addEventListener("click", () => {
    /* Each tab gets an isolated channel, even if the user opens DrakeForge
       more than once from this window. The link's default action reads this
       updated URL after the click listener returns. */
    startSession();
  });
  win.setOnClose(() => stopSession());
}
