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
 *       "id": "hello",                 // also the folder name: apps/<id>/
 *       "name": "Hello",
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
import { logInfo, logWarn } from "./log";
import { registerFsApps, type IframeAppDef } from "../apps/iframe-app";

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
}

interface LoadedApp {
  def: IframeAppDef;
  /** Absolute ZenFS folder the app is served from. */
  dir: string;
  isolated: boolean;
}

const loaded = new Map<string, LoadedApp>();

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

/* ---------- the demo app, created once ---------- */

/** The one manifest the OS owns a share of; user edits win after seeding. */
const BUILTIN_VERSION = 1;

/** Apps that ship in public/system-apps/ and get copied into the FS. */
const BUILTIN_APPS = ["nes"] as const;

const BUILTIN_ENTRIES: Record<string, RawApp> = {
  hello: {
    id: "hello",
    name: "Hello",
    sub: "Filesystem app",
    icon: "browser",
    entry: "index.html",
    "folder-isolated": true,
    width: 520,
    height: 420,
  },
  nes: {
    id: "nes",
    name: "NES",
    sub: "Emulator · test ROM",
    icon: "browser",
    entry: "index.html",
    "folder-isolated": true,
    width: 560,
    height: 620,
  },
};

const DEMO_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Hello</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: #12100f; color: #f3ece4;
         display: grid; place-items: center; min-height: 100vh; }
  main { padding: 24px 28px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 6px; color: #ff5a3c; }
  #clock { font-size: 34px; font-variant-numeric: tabular-nums; letter-spacing: 1px; }
  p { color: #b9aea4; margin: 10px 0 0; font-size: 13px; }
  code { color: #ffd9cf; }
</style>
</head>
<body>
<main>
  <h1>Hello from your filesystem</h1>
  <div id="clock">--:--:--</div>
  <p id="fromfs">loading data.json…</p>
  <p>These files live in <code>system/apps/hello/</code>.
     Edit them in Files and reload this window.</p>
</main>
<script src="./app.js"></script>
</body>
</html>
`;

const DEMO_JS = `/* Loaded from the filesystem through /9pf/hello/app.js — a plain relative
   <script src>, resolved against a real URL, exactly like any website. */
const tick = () => {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString();
};
tick();
setInterval(tick, 1000);

fetch("./data.json")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
  .then((data) => {
    document.getElementById("fromfs").textContent =
      data.message + " (data.json, " + Math.round(performance.now()) + " ms after load)";
  })
  .catch((err) => {
    document.getElementById("fromfs").textContent = "data.json failed: " + err.message;
  });
`;

const DEMO_DATA = JSON.stringify(
  { message: "This line came from data.json next to the app" },
  null,
  2,
);

/** Write `text` only when the file is missing — never clobber an edit. */
async function writeIfMissing(path: string, text: string): Promise<void> {
  if (await exists(path)) return;
  await vfs.writeText(path, text);
}

/** Copy one of the OS's bundled apps out of public/system-apps/<id>/. */
async function seedBundledApp(id: string): Promise<void> {
  const dir = `${APPS_DIRS[0]}/${id}`;
  await vfs.ensureDir(dir);
  let files: string[] = [];
  try {
    const res = await fetch(`${BASE}system-apps/${id}/index.json`);
    if (res.ok) files = ((await res.json()) as { files?: string[] }).files ?? [];
  } catch {
    /* offline first run: the demo apps below still seed */
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

/**
 * Create the apps folder on a device that has never had one, and make sure
 * `user-apps.json` mentions the bundled apps. The merge runs once per
 * BUILTIN_VERSION: after that the file is the user's, so deleting an entry
 * stays deleted.
 */
async function seedApps(): Promise<void> {
  const dir = APPS_DIRS[0];
  await vfs.ensureDir(dir);

  await writeIfMissing(`${dir}/hello/index.html`, DEMO_HTML);
  await writeIfMissing(`${dir}/hello/app.js`, DEMO_JS);
  await writeIfMissing(`${dir}/hello/data.json`, DEMO_DATA);
  for (const id of BUILTIN_APPS) await seedBundledApp(id);

  const manifest = `${dir}/user-apps.json`;
  let parsed: { seeded?: number; apps?: RawApp[] } = { apps: [] };
  try {
    if (await exists(manifest)) parsed = JSON.parse(await vfs.readText(manifest));
  } catch (err) {
    logWarn("os", `filesystem apps: ${manifest} is not valid JSON — leaving it alone`, err);
    return;
  }
  if ((parsed.seeded ?? 0) >= BUILTIN_VERSION) return;

  const apps: RawApp[] = Array.isArray(parsed.apps) ? parsed.apps : [];
  for (const [id, entry] of Object.entries(BUILTIN_ENTRIES)) {
    if (apps.some((a) => a && (a as RawApp).id === id)) continue;
    apps.push(entry);
  }
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
  const def: IframeAppDef = {
    id,
    name: str(raw.name, id),
    sub: typeof raw.sub === "string" ? raw.sub : "Filesystem app",
    icon: typeof raw.icon === "string" ? raw.icon : "browser",
    status:
      typeof raw.status === "string"
        ? raw.status
        : `${str(raw.name, id)}: served from your filesystem (9pf/${id}/)`,
    width: num(raw.width),
    height: num(raw.height),
    fs: { entry, isolated, dir: `${dir}/${folder}` },
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
export async function loadFsApps(): Promise<IframeAppDef[]> {
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
  loaded.clear();
  for (const dir of APPS_DIRS) {
    for (const { file, apps } of await readRegistries(dir)) {
      for (const raw of apps) {
        const made = toDef(raw, dir);
        if (!made) continue;
        if (loaded.has(made.def.id)) {
          logWarn("os", `filesystem apps: duplicate id ${made.def.id} in ${file} — ignored`);
          continue;
        }
        loaded.set(made.def.id, { def: made.def, dir: made.def.fs!.dir, isolated: made.isolated });
        defs.push(made.def);
      }
    }
  }
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

export function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

/** Join `rel` onto `dir`, honouring `.`/`..`. Null if it escapes `/`. */
export function resolvePath(dir: string, rel: string): string | null {
  const parts = dir.split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    if (seg.includes("\0")) return null;
    parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

interface ReadResult {
  ok: boolean;
  status?: number;
  error?: string;
  mime?: string;
  body?: ArrayBuffer;
}

async function readAppFile(appId: string, rel: string): Promise<ReadResult> {
  const app = loaded.get(appId);
  if (!app) return { ok: false, status: 404, error: `no filesystem app called "${appId}"` };

  const path = resolvePath(app.dir, rel);
  if (!path) return { ok: false, status: 403, error: "path escapes the app folder" };
  if (app.isolated ? !within(path, app.dir) : !within(path, vfs.HOME)) {
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
    const bytes = await vfs.readBytes(path);
    const copy = bytes.slice();
    return { ok: true, mime: mimeFor(path), body: copy.buffer as ArrayBuffer };
  } catch {
    return { ok: false, status: 404, error: `not found: ${rel}` };
  }
}

/** Answer the service worker's file requests. Call once, at boot. */
export function startFsAppBridge(): void {
  if (!("serviceWorker" in navigator)) {
    logWarn("os", "filesystem apps: this browser has no service workers — apps cannot be served");
    return;
  }

  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: string; appId?: string; path?: string } | null;
    if (!data || data.type !== "d86-fs-read") return;
    const port = event.ports?.[0];
    const reply = (msg: ReadResult) => {
      if (port) port.postMessage(msg);
      else navigator.serviceWorker.controller?.postMessage(msg);
    };
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
