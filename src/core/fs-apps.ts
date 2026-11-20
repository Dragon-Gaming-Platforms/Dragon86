/**
 * Filesystem apps — apps whose files live in your Dragon86 filesystem.
 *
 * The registry is plain JSON inside the filesystem itself:
 *
 *     ~/system/apps/*.json        ← what the OS reads
 *     /system/apps/*.json         ← the same files, inside the v86 guest
 *
 * The guest's `/` is the OS home's engine folder, and `~/system` is grafted
 * into it at `/system`, so an app you add from the emulated machine shows up
 * in the launcher, and one you add in Files shows up in the guest.
 *
 * Each file is either `{ "apps": [ … ] }` or a bare `[ … ]`; every entry:
 *
 *     {
 *       "id": "my-app",                // also the folder name: apps/<id>/
 *       "name": "My app",
 *       "icon": "browser",
 *       "entry": "index.html",         // default "index.html"
 *       "folder-isolated": true,       // stay inside apps/<id>/  (recommended)
 *       "width": 480, "height": 320
 *     }
 *
 * `folder-isolated: false` lets the app walk up out of its own folder with
 * `../` (as far as the OS home) — useful for a file viewer, not for anything
 * whose code you didn't write.
 *
 * Serving: the app is addressed as `<base>9pf/<id>/<path>` and answered by
 * `public/app-sw.js`, which asks this page for the bytes. Real URLs mean
 * `<script src="app.js">`, `import "./mod.js"`, `fetch("data.json")`, wasm
 * and images all just work — no HTML rewriting anywhere.
 */

import { fs } from "@zenfs/core";
import * as vfs from "./vfs";
import { decideOpenRead, parseRequester, resolvePath, within, type Requester } from "./fs-access";
import { logInfo, logWarn } from "./log";
import { registerFsApps, registerTransientApp, type IframeAppDef } from "../apps/iframe-app";
import { injectAppBridge } from "../apps/app-bridge";

/** Where the OS looks for app registries, in order (first one wins per id). */
export const APPS_DIRS = [`${vfs.HOME}/system/apps`];

const BASE = import.meta.env.BASE_URL;

interface RawApp {
  id?: unknown;
  name?: unknown;
  sub?: unknown;
  icon?: unknown;
  entry?: unknown;
  status?: unknown;
  width?: unknown;
  height?: unknown;
  folder?: unknown;
  "folder-isolated"?: unknown;
  /** Extensions this app can open: ["nes"], [".nes", "*.zip"], "nes". */
  opens?: unknown;
  /**
   * An image inside the app folder to use as its icon:
   *   "icon-path": "icon.svg"        → served as 9pf/<id>/icon.svg
   * Absolute URLs are refused; the icon has to be a file the app ships.
   */
  "icon-path"?: unknown;
  /** Start with a desktop icon? Default true. The start menu always lists it. */
  desktop?: unknown;
  /**
   * Window title when the app opens a file, with {file} standing for its
   * name: "title-template": "Preview - {file}". Default: the app's name.
   */
  "title-template"?: unknown;
}

interface LoadedApp {
  def: IframeAppDef;
  /** Absolute ZenFS folder the app is served from. */
  dir: string;
  isolated: boolean;
}

/* The live registry. Reading builds a new map and swaps it in, so the OS
   never sees a half-built list: the alternative (clear, then fill) left a
   window where every installed app had vanished, which is how a fresh
   install could miss its own "can open .nes files" question. */
let loaded = new Map<string, LoadedApp>();
/** Apps registered for one open window only (the App Launcher). */
const transient = new Map<string, LoadedApp>();
const appListeners = new Set<() => void>();

export interface FsAppSummary {
  id: string;
  name: string;
  sub: string;
  icon: string;
  dir: string;
  /** Entry file inside `dir` (usually index.html). */
  entry: string;
  opens: string[];
  /** False when the manifest says "desktop": false. */
  onDesktop: boolean;
}

/** "NES", ".nes", "*.nes" → "nes". */
export function normExt(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\*?\./, "");
}

function parseOpens(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const ext = normExt(item);
    if (ext && /^[a-z0-9_+-]+$/.test(ext) && !out.includes(ext)) out.push(ext);
  }
  return out;
}

/** Every installed filesystem app, in registry order. */
export function getFsApps(): FsAppSummary[] {
  return [...loaded.values()].map((a) => ({
    id: a.def.id,
    name: a.def.name,
    sub: a.def.sub ?? "",
    icon: a.def.icon,
    dir: a.dir,
    entry: a.def.fs?.entry ?? "index.html",
    opens: a.def.opens ?? [],
    onDesktop: a.def.onDesktop ?? true,
  }));
}

/** Installed apps that open `ext` (all apps that open anything, if omitted). */
export function fsAppsWithOpens(ext?: string): FsAppSummary[] {
  const all = getFsApps();
  if (ext === undefined) return all.filter((a) => a.opens.length > 0);
  return all.filter((a) => a.opens.includes(ext));
}

export function getFsApp(id: string): FsAppSummary | null {
  return getFsApps().find((a) => a.id === id) ?? null;
}

/**
 * The installed app a file *is* — its entry document. Used by "Add to
 * Desktop" and "Remove from Desktop": an .html file that has a manifest and
 * is listed as an app is that app's page, not a loose file.
 */
export function appForFile(path: string): FsAppSummary | null {
  const want = path.replace(/\/+$/, "");
  return getFsApps().find((a) => `${a.dir}/${a.entry}` === want) ?? null;
}

/** Listen for installs, removals and edits (desktop, start menu, Settings). */
export function onFsAppsChange(fn: () => void): () => void {
  appListeners.add(fn);
  return () => appListeners.delete(fn);
}

function emitAppsChange(): void {
  for (const fn of appListeners) {
    try {
      fn();
    } catch (err) {
      logWarn("os", "an apps-change listener threw", err);
    }
  }
}

/** Read the registry again (after an install, an uninstall, or a manual edit). */
export async function reloadFsApps(): Promise<void> {
  await loadFsApps();
  emitAppsChange();
}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/* ---------- reading the registry ---------- */

async function exists(path: string): Promise<boolean> {
  try {
    await fs.promises.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readDir(path: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(path)) as unknown as string[];
  } catch {
    return [];
  }
}

/** Every `*.json` in `dir`, each of which is `{apps:[…]}` or `[… ]`. */
async function readRegistries(dir: string): Promise<{ file: string; apps: RawApp[] }[]> {
  const out: { file: string; apps: RawApp[] }[] = [];
  for (const name of await readDir(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const file = `${dir}/${name}`;
    try {
      const parsed = JSON.parse(await vfs.readText(file)) as unknown;
      const apps = Array.isArray(parsed)
        ? (parsed as RawApp[])
        : (parsed && typeof parsed === "object" && Array.isArray((parsed as { apps?: unknown }).apps)
            ? ((parsed as { apps: RawApp[] }).apps)
            : null);
      if (!apps) {
        logWarn("os", `filesystem apps: ${file} has no "apps" array — ignored`);
        continue;
      }
      out.push({ file, apps });
    } catch (err) {
      logWarn("os", `filesystem apps: could not read ${file}`, err);
    }
  }
  return out;
}

/* ---------- the OS-owned app seed version ---------- */

/* Increment when a one-time migration removes or adds an OS-seeded app. */
const BUILTIN_VERSION = 5;

/**
 * Apps that ship in public/system-apps/ and get copied into the FS *once*,
 * on the first boot of a new install. Nothing here is re-seeded afterwards,
 * which is what makes uninstalling one stick.
 */
const BUILTIN_APPS = [] as const;

/** Copy one of the OS's bundled apps out of public/system-apps/<id>/. */
async function seedBundledApp(id: string): Promise<void> {
  const dir = `${APPS_DIRS[0]}/${id}`;
  await vfs.ensureDir(dir);
  let files: string[] = [];
  try {
    const res = await fetch(`${BASE}system-apps/${id}/index.json`);
    if (res.ok) files = ((await res.json()) as { files?: string[] }).files ?? [];
  } catch {
    /* offline first run: the manifest is still initialized below */
  }
  for (const name of files) {
    const target = `${dir}/${name}`;
    if (await exists(target)) continue;
    try {
      const res = await fetch(`${BASE}system-apps/${id}/${name}`);
      if (!res.ok) continue;
      await vfs.writeBytes(target, new Uint8Array(await res.arrayBuffer()));
    } catch (err) {
      logWarn("os", `filesystem apps: could not copy ${id}/${name}`, err);
    }
  }
}

async function removeLegacySeed(dir: string, id: string): Promise<void> {
  const folder = `${dir}/${id}`;
  if (!(await exists(folder))) return;
  try {
    await vfs.removePath(folder);
    logInfo("os", `removed the legacy ${id} seed from system/apps`);
  } catch (err) {
    logWarn("os", `could not remove the legacy ${id} seed`, err);
  }
}

/**
 * Create the apps folder on a device that has never had one, and make sure
 * `user-apps.json` mentions the bundled apps. The merge runs once per
 * BUILTIN_VERSION: after that the file is the user's, so deleting an entry
 * stays deleted.
 *
 * The version gate also runs one-time cleanup for apps removed from the OS.
 */
async function seedApps(): Promise<void> {
  const dir = APPS_DIRS[0];
  await vfs.ensureDir(dir);

  const manifest = `${dir}/user-apps.json`;
  let parsed: { seeded?: number; apps?: RawApp[] } = { apps: [] };
  try {
    if (await exists(manifest)) parsed = JSON.parse(await vfs.readText(manifest));
  } catch (err) {
    logWarn("os", `filesystem apps: ${manifest} is not valid JSON — leaving it alone`, err);
    return;
  }
  const had = parsed.seeded ?? 0;
  if (had >= BUILTIN_VERSION) return;
  /* A manifest from before seeding existed is a fresh device; one from an
     older build is an existing device that is being upgraded. Upgrades keep
     user-installed apps, while the versioned migrations only remove retired
     OS-owned entries. */
  const fresh = had === 0 && !(Array.isArray(parsed.apps) && parsed.apps.length);

  if (had < 4) {
    /* v4: Preview became a fixed page and NES left the filesystem app list. */
    parsed.apps = (Array.isArray(parsed.apps) ? parsed.apps : []).filter(
      (a) => !(a && ((a as RawApp).id === "preview" || (a as RawApp).id === "nes")),
    );
    for (const gone of ["preview", "nes"]) await removeLegacySeed(dir, gone);
  }
  if (had < 5) {
    /* v5: Hello was only a tutorial demo, not a useful system app. Remove its
       old registry entry and seeded folder so upgrades match fresh installs. */
    parsed.apps = (Array.isArray(parsed.apps) ? parsed.apps : []).filter(
      (a) => !(a && (a as RawApp).id === "hello"),
    );
    await removeLegacySeed(dir, "hello");
  }

  if (!fresh) {
    /* Nothing to install, but the version still has to move forward, or the
       migration above would run on every single boot. */
    await vfs.writeText(
      manifest,
      JSON.stringify({ seeded: BUILTIN_VERSION, apps: Array.isArray(parsed.apps) ? parsed.apps : [] }, null, 2),
    );
    return;
  }

  for (const id of BUILTIN_APPS) await seedBundledApp(id);

  const apps: RawApp[] = Array.isArray(parsed.apps) ? parsed.apps : [];
  await vfs.writeText(manifest, JSON.stringify({ seeded: BUILTIN_VERSION, apps }, null, 2));
}

/* ---------- loading ---------- */

function toDef(raw: RawApp, dir: string): { def: IframeAppDef; isolated: boolean } | null {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!ID_RE.test(id)) {
    logWarn("os", `filesystem apps: bad or missing id (${JSON.stringify(raw.id)}) — skipped`);
    return null;
  }
  const isolated = truthy(raw["folder-isolated"]);
  const folder = str(raw.folder, id);
  if (folder.includes("..") || folder.startsWith("/")) {
    logWarn("os", `filesystem apps: ${id}: folder must be a name inside the apps dir`);
    return null;
  }
  const entry = str(raw.entry, "index.html").replace(/^\/+/, "");
  /* "icon-path": "icon.svg" wins over "icon": an app that ships its own
     artwork uses it, and it is resolved through the app's own 9pf route so
     the file has to exist in the app folder. */
  const iconPath = str(raw["icon-path"], "").replace(/^\/+/, "");
  const icon = iconPath
    ? `img:9pf/${id}/${iconPath}`
    : typeof raw.icon === "string"
      ? raw.icon
      : "browser";
  const titleTemplate =
    typeof raw["title-template"] === "string" ? raw["title-template"] : undefined;
  const def: IframeAppDef = {
    id,
    name: str(raw.name, id),
    sub: typeof raw.sub === "string" ? raw.sub : "Filesystem app",
    icon,
    titleTemplate,
    onDesktop: raw.desktop === undefined ? true : truthy(raw.desktop),
    status:
      typeof raw.status === "string"
        ? raw.status
        : `${str(raw.name, id)}: served from your filesystem (9pf/${id}/)`,
    width: num(raw.width),
    height: num(raw.height),
    fs: { entry, isolated, dir: `${dir}/${folder}` },
    opens: parseOpens(raw.opens),
    /* NOT sandboxed, deliberately. A sandboxed iframe without
       allow-same-origin has an opaque origin, and a service worker does not
       control opaque-origin documents — the app's own <script src="app.js">
       would leave the worker and 404 against GitHub Pages. So filesystem apps
       run same-origin, exactly like the vendored proxy apps. (Single-file
       apps that inline everything could opt in with "sandbox": true.) */
    sandbox: false,
  };
  return { def, isolated };
}

/** Read every registry and hand the apps to the frame registry. */
/**
 * Reading the registry clears it and reads it back, so it must not run twice
 * at once: two overlapping loads each clear the list, and the loser leaves
 * the OS looking at an empty registry until its own read finishes. That race
 * is why a freshly installed app could be missing from "Open with" and why
 * its "can open .nes files" question never appeared — the ask ran in the
 * window where the list was momentarily empty. One load at a time; a request
 * that arrives during a load marks it dirty and gets a fresh read after.
 */
let inFlight: Promise<IframeAppDef[]> | null = null;
let loadAgain = false;

export function loadFsApps(): Promise<IframeAppDef[]> {
  if (inFlight) {
    loadAgain = true;
    return inFlight;
  }
  inFlight = (async () => {
    let defs = await readFsApps();
    while (loadAgain) {
      loadAgain = false;
      defs = await readFsApps();
    }
    return defs;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function readFsApps(): Promise<IframeAppDef[]> {
  try {
    const moved = await vfs.migrateLegacyShared();
    if (moved) logInfo("os", `folded ${moved} files from the old v86/shared folder into your home`);
  } catch (err) {
    logWarn("os", "could not migrate the old v86/shared folder", err);
  }
  try {
    await seedApps();
  } catch (err) {
    logWarn("os", "filesystem apps: could not create the apps folder", err);
  }

  const defs: IframeAppDef[] = [];
  const next = new Map<string, LoadedApp>();
  for (const dir of APPS_DIRS) {
    for (const { file, apps } of await readRegistries(dir)) {
      for (const raw of apps) {
        const made = toDef(raw, dir);
        if (!made) continue;
        if (next.has(made.def.id)) {
          logWarn("os", `filesystem apps: duplicate id ${made.def.id} in ${file} — ignored`);
          continue;
        }
        next.set(made.def.id, { def: made.def, dir: made.def.fs!.dir, isolated: made.isolated });
        defs.push(made.def);
      }
    }
  }
  loaded = next;
  registerFsApps(defs);
  logInfo("os", `filesystem apps: ${defs.length} loaded${defs.length ? ` (${defs.map((d) => d.id).join(", ")})` : ""}`);
  return defs;
}

/* ---------- serving ---------- */

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** Read one file anywhere under the OS home — the App Launcher's route. */
/** Read one file for the `9pf/@open/` route. The policy is in fs-access.ts. */
async function readHomeFile(rawPath: string, requester: Requester): Promise<ReadResult> {
  const app = requester.kind === "app" ? (loaded.get(requester.id) ?? transient.get(requester.id)) : undefined;
  const decision = decideOpenRead({
    rawPath,
    home: vfs.HOME,
    requester,
    app: app ? { id: requester.kind === "app" ? requester.id : "", dir: app.dir, isolated: app.isolated } : undefined,
  });
  if (!decision.ok) return { ok: false, status: decision.status, error: decision.error };
  const path = decision.path;
  try {
    const st = await fs.promises.stat(path);
    if (st.isDirectory()) return { ok: false, status: 404, error: `${path} is a directory` };
    const bytes = await vfs.readBytes(path);
    const copy = bytes.slice();
    return { ok: true, mime: mimeFor(path), body: copy.buffer as ArrayBuffer };
  } catch {
    return { ok: false, status: 404, error: `not found: ${path}` };
  }
}

export function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

interface ReadResult {
  ok: boolean;
  status?: number;
  error?: string;
  mime?: string;
  body?: ArrayBuffer;
}

async function readAppFile(appId: string, rel: string): Promise<ReadResult> {
  const app = loaded.get(appId) ?? transient.get(appId);
  if (!app) return { ok: false, status: 404, error: `no filesystem app called "${appId}"` };

  const path = resolvePath(app.dir, rel);
  if (!path) return { ok: false, status: 403, error: "path escapes the app folder" };
  if (app.isolated ? !within(path, resolvePath("/", app.dir) ?? app.dir) : !within(path, vfs.HOME)) {
    return {
      ok: false,
      status: 403,
      error: app.isolated
        ? `${appId} is folder-isolated: "${rel}" is outside its folder`
        : `"${rel}" is outside the OS home`,
    };
  }

  try {
    const st = await fs.promises.stat(path);
    if (st.isDirectory()) return { ok: false, status: 404, error: `${rel} is a directory` };
    let bytes = await vfs.readBytes(path);
    /* Inject the per-app API into every filesystem app's entry document at
       serve time, so old installs and freshly seeded apps both get it before
       their own scripts execute. */
    if (path === vfs.join(app.dir, app.def.fs?.entry ?? "index.html") && /\.html?$/i.test(path)) {
      bytes = new TextEncoder().encode(injectAppBridge(new TextDecoder().decode(bytes), appId));
    }
    const copy = bytes.slice();
    return { ok: true, mime: mimeFor(path), body: copy.buffer as ArrayBuffer };
  } catch {
    return { ok: false, status: 404, error: `not found: ${rel}` };
  }
}

/**
 * Run a stray file as an app, for as long as its window is open.
 *
 * It is served through the same worker path as a real app
 * (`9pf/<synthetic-id>/<file>`) because that is the only way a browser hands
 * a page real URLs for its scripts, styles and images. Nothing is written to
 * user-apps.json: it is not installed, it is just running.
 */
export function registerAdHocApp(path: string): IframeAppDef | null {
  const dir = vfs.parentOf(path);
  const entry = vfs.baseName(path);
  if (!dir.startsWith(vfs.HOME)) return null;
  const id = `d86-run-${dir.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root"}-${entry.replace(/[^a-zA-Z0-9.]+/g, "-")}`;
  const def: IframeAppDef = {
    id,
    name: entry,
    sub: "Opened as an app",
    icon: "browser",
    status: `${entry}: run as an app from ${dir}`,
    fs: { entry, isolated: true, dir },
    opens: [],
    sandbox: false,
  };
  transient.set(id, { def, dir, isolated: true });
  registerTransientApp(def);
  return def;
}

/** Route prefix for "any file in your home", as a URL. */
export const OPEN_PREFIX = "@open/";

/** A real URL for any file in the home directory. */
export function fileUrl(path: string): string {
  return `${BASE}9pf/${OPEN_PREFIX}${encodeURIComponent(path)}`;
}

/* ---------- the manifest, for the App Store ---------- */

const MANIFEST = `${APPS_DIRS[0]}/user-apps.json`;

async function readManifest(): Promise<{ seeded?: number; apps: RawApp[] }> {
  try {
    const parsed = JSON.parse(await vfs.readText(MANIFEST)) as { seeded?: number; apps?: RawApp[] };
    return { seeded: parsed.seeded, apps: Array.isArray(parsed.apps) ? parsed.apps : [] };
  } catch {
    return { apps: [] };
  }
}

/** Add or replace one entry in user-apps.json (the App Store's install step). */
export async function upsertAppEntry(entry: RawApp & { id: string }): Promise<void> {
  const manifest = await readManifest();
  const at = manifest.apps.findIndex((a) => a && (a as RawApp).id === entry.id);
  if (at >= 0) manifest.apps[at] = entry;
  else manifest.apps.push(entry);
  await vfs.writeText(
    MANIFEST,
    JSON.stringify({ seeded: manifest.seeded ?? BUILTIN_VERSION, apps: manifest.apps }, null, 2),
  );
}

export async function removeAppEntry(id: string): Promise<void> {
  const manifest = await readManifest();
  const apps = manifest.apps.filter((a) => a && (a as RawApp).id !== id);
  await vfs.writeText(
    MANIFEST,
    JSON.stringify({ seeded: manifest.seeded ?? BUILTIN_VERSION, apps }, null, 2),
  );
}

/** Answer the service worker's file requests. Call once, at boot. */
export function startFsAppBridge(): void {
  if (!("serviceWorker" in navigator)) {
    logWarn("os", "filesystem apps: this browser has no service workers — apps cannot be served");
    return;
  }

  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as {
      type?: string;
      appId?: string;
      path?: string;
      file?: string;
      from?: string;
    } | null;
    if (!data || data.type !== "d86-fs-read") return;
    const port = event.ports?.[0];
    const reply = (msg: ReadResult) => {
      if (port) port.postMessage(msg);
      else navigator.serviceWorker.controller?.postMessage(msg);
    };
    if (data.appId === OPEN_PREFIX.slice(0, -1) || data.file) {
      void readHomeFile(String(data.file ?? data.path ?? ""), parseRequester(data.from)).then(reply, () =>
        reply({ ok: false, status: 500, error: "the OS could not read that file" }),
      );
      return;
    }
    void readAppFile(String(data.appId ?? ""), String(data.path ?? "index.html")).then(reply, () =>
      reply({ ok: false, status: 500, error: "the OS could not read that file" }),
    );
  });

  navigator.serviceWorker
    .register(`${BASE}app-sw.js`, { scope: BASE })
    .then((reg) => {
      logInfo("os", `filesystem apps: service worker ready (${reg.scope})`);
      /* A worker that installed but isn't controlling this page yet would
         leave the first app launch unrouted; claiming is handled inside the
         worker, this is only for the log. */
      if (!navigator.serviceWorker.controller) {
        logInfo("os", "filesystem apps: worker installed; it takes over on the next load");
      }
    })
    .catch((err) => logWarn("os", "filesystem apps: could not register app-sw.js", err));
}
