/**
 * The Dragon86 scripting API — `window.d86`.
 *
 * A `.js` file in your filesystem can be run as a system script (right-click →
 * Run as system script). It is inserted into this page as a real <script>, so
 * it runs with the OS's own privileges: no sandbox, no worker, no isolation.
 * That is the point — a script is meant to be able to set things up, which
 * means writing to ZenFS, registering an app, opening a window.
 *
 * These are the hooks it gets. They are the same objects the OS itself uses,
 * not a copy: `d86.fs.write` really is `vfs.writeText`.
 *
 *   d86.version                 "1.0"
 *   d86.home                    "/home/user"
 *
 *   d86.fs.readText(path)       → Promise<string>
 *   d86.fs.readBytes(path)      → Promise<Uint8Array>
 *   d86.fs.writeText(path, s)   → Promise<void>   (creates parent folders)
 *   d86.fs.writeBytes(path, u8) → Promise<void>
 *   d86.fs.list(path)           → Promise<[{ name, path, isDirectory, size }]>
 *   d86.fs.mkdir(path)          → Promise<void>
 *   d86.fs.remove(path)         → Promise<void>   (files and folders)
 *   d86.fs.exists(path)         → Promise<boolean>
 *   d86.fs.stat(path)           → Promise<{ size, isDirectory, mtime }>
 *
 *   d86.apps.list()             → [{ id, name, dir, opens }]  installed apps
 *   d86.apps.register(entry)    → Promise<void>   add/replace a user-apps.json entry
 *   d86.apps.reload()           → Promise<void>   re-read the registry
 *   d86.apps.launch(id)         → void            open a window
 *
 *   d86.engine.attach(source)   → void            show this machine in Engine Viewer
 *                                                  (a TerminalBackend; see
 *                                                  bridge/hoster.ts)
 *   d86.engine.screen()         → {cols,rows,lines} | null  the live VGA text
 *
 *   d86.open(path)              → void            open a file the way the OS would
 *   d86.notify({ title, body }) → void            a toast in the corner
 *   d86.log(...args)            → void            console, tagged [D86:script]
 *   d86.script.path             the file being run (only while it runs)
 *
 * Everything is promise-based: a script that wants to write and then launch
 * can await. A path may be absolute, or start with `~` for the home folder.
 */

import * as vfs from "./vfs";
import { logInfo, logWarn } from "./log";
import { notify } from "./toast";
import { fs as zenfs } from "@zenfs/core";
import { getFsApps, reloadFsApps, upsertAppEntry } from "./fs-apps";
import { rememberEngine, engineForViewer } from "../apps/engine-viewer";
import type { EngineScreen, TerminalBackend } from "../bridge/hoster";

export interface D86FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

export interface D86AppEntry {
  id: string;
  name: string;
  sub?: string;
  icon?: string;
  entry?: string;
  opens?: string[];
  desktop?: boolean;
  width?: number;
  height?: number;
  "folder-isolated"?: boolean;
}

export interface D86Api {
  version: string;
  home: string;
  script: { path: string | null };
  fs: {
    readText(path: string): Promise<string>;
    readBytes(path: string): Promise<Uint8Array>;
    writeText(path: string, text: string): Promise<void>;
    writeBytes(path: string, bytes: Uint8Array | ArrayBuffer | number[]): Promise<void>;
    list(path: string): Promise<D86FsEntry[]>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<{ size: number; isDirectory: boolean; mtime: number }>;
  };
  apps: {
    list(): { id: string; name: string; dir: string; opens: string[] }[];
    register(entry: D86AppEntry): Promise<void>;
    reload(): Promise<void>;
    launch(id: string): void;
  };
  engine: {
    /** Point the Engine Viewer at a machine (the Terminal does this itself). */
    attach(source: TerminalBackend | null): void;
    /** What the viewer would draw right now, or null when there is nothing. */
    screen(): EngineScreen | null;
  };
  open(path: string): void;
  notify(opts: { title: string; body?: string; icon?: string; timeout?: number }): void;
  log(...args: unknown[]): void;
}

/** `~/Desktop` → `/home/user/Desktop`; anything else is taken as given. */
export function resolveScriptPath(path: string): string {
  const text = String(path ?? "").trim();
  if (!text) throw new Error("a path is required");
  if (text === "~") return vfs.HOME;
  if (text.startsWith("~/")) return `${vfs.HOME}/${text.slice(2).replace(/^\/+/, "")}`;
  if (text.startsWith("/")) return text;
  return `${vfs.HOME}/${text}`;
}

let installed: D86Api | null = null;

/**
 * A script that writes files should see them appear in Files and on the
 * desktop, the same as a save from the editor does. Writes are batched into
 * one refresh: a script that installs forty files should not redraw the
 * desktop forty times.
 */
let announceTimer: ReturnType<typeof setTimeout> | null = null;
function announceChange(): void {
  if (announceTimer !== null) clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    announceTimer = null;
    window.dispatchEvent(new CustomEvent("d86-fs-changed"));
  }, 250);
}

/**
 * Put `window.d86` in place. Called once at boot; scripts and same-origin
 * iframe apps (which reach it as `parent.d86`) both use this object.
 */
export function installDevApi(hooks: { launch: (id: string) => void; open: (path: string) => void }): D86Api {
  if (installed) return installed;

  const api: D86Api = {
    version: "1.0",
    home: vfs.HOME,
    script: { path: null },
    fs: {
      readText: (path) => vfs.readText(resolveScriptPath(path)),
      readBytes: (path) => vfs.readBytes(resolveScriptPath(path)),
      writeText: async (path, text) => {
        await vfs.writeText(resolveScriptPath(path), String(text));
        announceChange();
      },
      writeBytes: (path, bytes) => {
        const data =
          bytes instanceof Uint8Array
            ? bytes
            : bytes instanceof ArrayBuffer
              ? new Uint8Array(bytes)
              : new Uint8Array(bytes);
        return vfs.writeBytes(resolveScriptPath(path), data).then(announceChange);
      },
      list: async (path) => {
        const entries = await vfs.listDir(resolveScriptPath(path));
        return entries.map((e) => ({
          name: e.name,
          path: e.path,
          isDirectory: e.isDirectory,
          size: e.size,
        }));
      },
      mkdir: (path) => vfs.ensureDir(resolveScriptPath(path)).then(announceChange),
      remove: (path) => vfs.removePath(resolveScriptPath(path)).then(announceChange),
      exists: async (path) => {
        try {
          return await vfs.exists(resolveScriptPath(path));
        } catch {
          return false;
        }
      },
      stat: async (path) => {
        const st = await vfs.stat(resolveScriptPath(path));
        return { size: st.size, isDirectory: st.isDirectory(), mtime: st.mtimeMs };
      },
    },
    apps: {
      list: () =>
        getFsApps().map((a) => ({ id: a.id, name: a.name, dir: a.dir, opens: a.opens })),
      register: async (entry) => {
        if (!entry || typeof entry.id !== "string" || !entry.id.trim()) {
          throw new Error("apps.register needs an entry with an id");
        }
        if (typeof entry.name !== "string" || !entry.name.trim()) {
          throw new Error("apps.register needs an entry with a name");
        }
        await upsertAppEntry({
          ...entry,
          id: entry.id.trim(),
          entry: entry.entry ?? "index.html",
          "folder-isolated": entry["folder-isolated"] ?? true,
        } as D86AppEntry & { id: string });
        await reloadFsApps();
      },
      reload: () => reloadFsApps(),
      launch: (id) => {
        window.dispatchEvent(new CustomEvent("d86-launch-app", { detail: id }));
      },
    },
    engine: {
      attach: (source) => {
        rememberEngine(source ?? null);
      },
      screen: () => engineForViewer()?.getScreen?.() ?? null,
    },
    open: (path) => hooks.open(resolveScriptPath(path)),
    notify: (opts) =>
      notify({ title: String(opts?.title ?? "Script"), body: opts?.body, icon: opts?.icon, timeout: opts?.timeout ?? 5000 }),
    log: (...args) => {
      const parts = args.map((a) => (typeof a === "string" ? a : safeJson(a)));
      logInfo("script", parts.join(" "));
    },
  };

  (window as unknown as { d86?: D86Api }).d86 = api;
  installed = api;
  return api;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** The API from anywhere in the OS, installing it if boot has not got there. */
export function devApi(): D86Api | null {
  return installed ?? ((window as unknown as { d86?: D86Api }).d86 ?? null);
}

/** For logs: a script's failure should say which file. */
export function logScriptFailure(path: string, err: unknown): void {
  logWarn("script", `${path} failed`, err);
  notify({
    title: "Script failed",
    body: `${vfs.baseName(path)}: ${(err as Error)?.message ?? String(err)}`,
    icon: "info",
    timeout: 8000,
  });
}

/** zenfs is re-exported for scripts that need a full Node-style fs. */
export const scriptFs = zenfs;
