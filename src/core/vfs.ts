/**
 * VFS — ZenFS-backed virtual filesystem.
 *
 * Mounts:
 *   /home → IndexedDB (persistent, "the hard drive")
 *   /tmp  → InMemory   (scratch, cleared on reload)
 *
 * Everything here is async on purpose: browser backends are async at heart.
 */

import { configure, fs, InMemory, type Stats } from "@zenfs/core";
import { IndexedDB } from "@zenfs/dom";

export const HOME = "/home/user";

/**
 * Engine roots. The guest's filesystem shows up in the OS tree under the
 * engine it belongs to, so `/` in the guest maps to one of these:
 *
 *   ~/v86/…           the v86 machine's root filesystem — the guest's `/`
 *                     is this folder, served over 9p
 *   ~/Downloads/…     also at /Downloads inside the v86 guest (HOME_DIRS)
 *   ~/CheerpX/…       the CheerpX engine's equivalent home
 *
 * `~` here is HOME: /home/user, the persistent IndexedDB mount.
 */
export const ENGINE_ROOT = {
  v86: `${HOME}/v86`,
  cheerpx: `${HOME}/CheerpX`,
} as const;

export const SHARED_DIR = {
  /* CheerpX only: the hoster mounts its guest's /home/user/shared here. */
  cheerpx: `${ENGINE_ROOT.cheerpx}/shared`,
} as const;

/**
 * Your home folders, grafted into the v86 guest at `/`: the guest sees
 * `/Downloads`, `/Documents` and `/Desktop` and they *are* these. There is
 * no separate "shared" folder any more — everything in the guest is your
 * filesystem already.
 */
export const HOME_DIRS = ["Desktop", "Documents", "Downloads"] as const;

export const SPECIAL_DIRS = {
  Documents: `${HOME}/Documents`,
  Downloads: `${HOME}/Downloads`,
  Desktop: `${HOME}/Desktop`,
} as const;

let ready = false;

export async function initVfs(): Promise<void> {
  if (ready) return;
  await configure({
    mounts: {
      "/home": IndexedDB,
      "/tmp": InMemory,
    },
  });
  for (const dir of Object.values(SPECIAL_DIRS)) {
    await ensureDir(dir);
  }
  /* The engine folders exist from the first boot so Files shows the layout
     the guest lives in, even before an engine has ever run. */
  for (const dir of [ENGINE_ROOT.v86, ENGINE_ROOT.cheerpx, SHARED_DIR.cheerpx]) {
    await ensureDir(dir);
  }
  const welcome = `${HOME}/Documents/Welcome.txt`;
  if (!(await exists(welcome))) {
    await writeText(
      welcome,
      [
        "Welcome to Dragon86.",
        "",
        "This file lives in the virtual hard drive (browser storage).",
        "Edit it, break it, make new files — everything persists locally.",
        "",
        "What's here:",
        "  - Files app  : browse, create, rename, delete",
        "  - Text Editor: opens any text file, Ctrl+S saves",
        "  - Terminal   : waits for the CheerpX engine (see Settings)",
        "  - Settings   : themes, wallpaper, engine host URL",
        "",
        "No login. No server. Just your machine, in a tab.",
      ].join("\n"),
    );
  }
  ready = true;
}

export function vfsReady(): boolean {
  return ready;
}

/* ---------- helpers (all async — see header note) ---------- */

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.promises.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await fs.promises.mkdir(path, { recursive: true });
}

export async function readText(path: string): Promise<string> {
  return fs.promises.readFile(path, "utf8");
}

export async function writeText(path: string, text: string): Promise<void> {
  await ensureDir(parentOf(path));
  await fs.promises.writeFile(path, text, "utf8");
}

export async function readBytes(path: string): Promise<Uint8Array> {
  const data = (await fs.promises.readFile(path)) as unknown as Uint8Array;
  return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
}

export async function writeBytes(path: string, data: Uint8Array): Promise<void> {
  await ensureDir(parentOf(path));
  await fs.promises.writeFile(path, data as never);
}

export interface Entry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
}

export async function listDir(path: string): Promise<Entry[]> {
  type DirentLike = { name: string; isDirectory(): boolean };
  const dirents = (await fs.promises.readdir(path, {
    withFileTypes: true,
  })) as unknown as DirentLike[];
  const out: Entry[] = [];
  for (const d of dirents) {
    const full = join(path, d.name);
    let size = 0;
    let mtime = 0;
    try {
      const st: Stats = await fs.promises.stat(full);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      /* stale entry — show with zeros */
    }
    out.push({
      name: d.name,
      path: full,
      isDirectory: d.isDirectory(),
      size,
      mtime,
    });
  }
  out.sort((a, b) =>
    a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
  );
  return out;
}

export async function removePath(path: string): Promise<void> {
  const st = await fs.promises.stat(path);
  if (st.isDirectory()) {
    await fs.promises.rm(path, { recursive: true, force: true });
  } else {
    await fs.promises.unlink(path);
  }
}

export async function renamePath(from: string, to: string): Promise<void> {
  await fs.promises.rename(from, to);
}

export async function stat(path: string): Promise<Stats> {
  return fs.promises.stat(path);
}

/* ---------- path utils ---------- */

export function join(...parts: string[]): string {
  const joined = parts.filter(Boolean).join("/").replace(/\/+/g, "/");
  return joined.startsWith("/") ? joined : `/${joined}`;
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function formatSize(bytes: number, isDir: boolean): string {
  if (isDir) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Factory reset: wipe all IndexedDB stores + localStorage, then reload. */
export async function factoryReset(): Promise<void> {
  try {
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs.map(
        (d) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(d.name ?? "");
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          }),
      ),
    );
  } catch {
    /* older browsers: fall through */
  }
  localStorage.clear();
  location.reload();
}

/**
 * Fold a legacy `~/v86/shared` folder back into the home directory.
 *
 * Before the guest's `/` became your filesystem outright, the guest's
 * `/shared` was a union: the OS home as a read floor and `~/v86/shared` as
 * the writable layer. That layer is gone (everything is ZenFS now), but a
 * device that ran the old build still has files sitting in it — this copies
 * them to the matching place under `~` (never overwriting a file that
 * already exists) and removes the folder. Runs once, cheap when absent.
 */
export async function migrateLegacyShared(): Promise<number> {
  const legacy = `${ENGINE_ROOT.v86}/shared`;
  const n = await fs.promises.stat(legacy).catch(() => null);
  if (!n || !n.isDirectory()) return 0;

  let moved = 0;
  const walk = async (dir: string, target: string): Promise<void> => {
    let names: string[] = [];
    try {
      names = (await fs.promises.readdir(dir)) as unknown as string[];
    } catch {
      return;
    }
    for (const name of names) {
      const from = `${dir}/${name}`;
      const to = `${target}/${name}`;
      const st = await fs.promises.stat(from).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) {
        await fs.promises.mkdir(to, { recursive: true }).catch(() => {});
        await walk(from, to);
        await fs.promises.rmdir(from).catch(() => {});
        continue;
      }
      const already = await fs.promises.stat(to).catch(() => null);
      if (already) continue; // never overwrite something newer
      try {
        const data = await fs.promises.readFile(from);
        await fs.promises.writeFile(to, data);
        await fs.promises.chmod(to, st.mode & 0o7777).catch(() => {});
        await fs.promises.unlink(from).catch(() => {});
        moved++;
      } catch {
        /* leave it; a partial move is better than data loss */
      }
    }
  };

  await walk(legacy, HOME);
  await fs.promises.rmdir(legacy).catch(() => {});
  return moved;
}
