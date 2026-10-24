/**
 * App registry — wires apps to windows and to file types.
 *
 * Opening a file is no longer "is it text?": the file's extension is looked
 * up in core/filetypes.ts, which knows the built-ins, the installed apps that
 * claim the type, and the user's choice of default. An app that claims a type
 * is handed the path as `?file=<path>` so it can open it; the built-ins get
 * it directly.
 */

import type { WindowManager } from "../core/wm";
import * as vfs from "../core/vfs";
import { openFiles } from "./files";
import { openEditor } from "./editor";
import { openTerminal } from "./terminal";
import { openSettings } from "./settings";
import { openStore } from "./store";
import { openViewer } from "./viewer";
import { IFRAME_APPS, openIframeApp, type IframeAppDef } from "./iframe-app";
import { getFsApps, loadFsApps, registerAdHocApp } from "../core/fs-apps";
import {
  BUILTIN,
  defaultFor,
  extOf,
  loadDefaults,
  openersFor,
  openerById,
  isTextExt,
} from "../core/filetypes";
import { logInfo, logWarn } from "../core/log";
import { TRASH, unlockTrash } from "../core/trash";

export function createLauncher(wm: WindowManager) {
  function openFilesAt(path?: string): void {
    const win = wm.create({
      title: "Files",
      icon: "folder",
      width: 860,
      height: 540,
    });
    openFiles(win, path ?? vfs.HOME, {
      openFile: (p) => openFile(p),
      openWith: (p, id) => openWith(p, id),
      openTrash: () => void openTrash(),
      openStore: () => openStoreAt(),
    });
  }

  function openEditorAt(path?: string): void {
    const win = wm.create({
      title: "Text Editor",
      icon: "editor",
      width: 720,
      height: 500,
    });
    openEditor(win, path ?? null);
  }

  function openTerminalAt(): void {
    const win = wm.create({
      title: "Terminal",
      icon: "terminal",
      width: 760,
      height: 480,
    });
    openTerminal(win);
  }

  function openIframeAppAt(def: IframeAppDef, filePath?: string): void {
    const win = wm.create({
      title: def.name,
      icon: def.icon,
      width: def.width ?? 880,
      height: def.height ?? 600,
    });
    openIframeApp(win, def, filePath);
  }

  function openSettingsAt(page?: string): void {
    const win = wm.create({
      title: "Settings",
      icon: "settings",
      width: 860,
      height: 600,
    });
    openSettings(win, page);
  }

  function openStoreAt(): void {
    const win = wm.create({
      title: "App Store",
      icon: "store",
      width: 940,
      height: 640,
    });
    openStore(win);
  }

  function openViewerAt(path: string): void {
    const win = wm.create({
      title: `System — ${vfs.baseName(path)}`,
      icon: "browser",
      width: 760,
      height: 560,
    });
    openViewer(win, path);
  }

  /** The trash only opens behind its passphrase. */
  async function openTrash(): Promise<void> {
    if (!(await unlockTrash())) return;
    openFilesAt(TRASH);
  }

  /** Run a stray page as an app, for the life of its window. */
  function launchAsApp(path: string): void {
    const def = registerAdHocApp(path);
    if (!def) {
      logWarn("os", `cannot run ${path} as an app: it must be inside your home folder`);
      return;
    }
    openIframeAppAt(def);
  }

  /** Open a file with one specific opener. */
  function openWith(path: string, openerId: string): void {
    const opener = openerById(openerId, path);
    if (!opener) {
      logWarn("os", `no opener called ${openerId}; falling back`);
      openFile(path);
      return;
    }
    switch (opener.kind) {
      case "editor":
        openEditorAt(path);
        return;
      case "system":
        openViewerAt(path);
        return;
      case "launcher":
        launchAsApp(path);
        return;
      case "app": {
        const def = IFRAME_APPS.find((a) => a.id === opener.id);
        if (!def) {
          logWarn("os", `${opener.id} claims files but is not installed any more`);
          openFile(path);
          return;
        }
        openIframeAppAt(def, path);
        return;
      }
    }
  }

  /** Open a file the way the OS says it should be opened. */
  function openFile(path: string): void {
    void (async () => {
      await loadDefaults();
      const ext = extOf(path);
      const chosen = defaultFor(ext);
      const openers = openersFor(path);
      const usable = chosen && openers.some((o) => o.id === chosen) ? chosen : (openers[0]?.id ?? BUILTIN.system);
      if (usable === BUILTIN.system && isTextExt(ext)) {
        openEditorAt(path);
        return;
      }
      openWith(path, usable);
    })();
  }

  const launch: Record<string, () => void> = {
    files: () => openFilesAt(),
    terminal: () => openTerminalAt(),
    editor: () => openEditorAt(),
    settings: () => openSettingsAt(),
    store: () => openStoreAt(),
  };
  for (const def of IFRAME_APPS) {
    launch[def.id] = () => openIframeAppAt(def);
  }

  /* The App Store's "Open" button lives in a different module and has no
     handle on this launcher. One event keeps that seam narrow: anything in
     the OS can ask it to launch an app by id. */
  window.addEventListener("d86-launch-app", (event) => {
    const id = (event as CustomEvent<string>).detail;
    if (!id) return;
    const open = launch[id];
    if (!open) {
      logWarn("os", `asked to launch "${id}", which is not installed any more`);
      return;
    }
    open();
  });

  /**
   * Re-read the filesystem registry and rebuild the launch table.
   *
   * Uses loadFsApps (no change broadcast): whoever called this is usually
   * already reacting to that broadcast, and re-emitting would loop.
   */
  async function refreshApps(): Promise<void> {
    await loadFsApps();
    for (const def of IFRAME_APPS) {
      launch[def.id] = () => openIframeAppAt(def);
    }
    for (const app of getFsApps()) {
      if (!launch[app.id]) launch[app.id] = () => openIframeAppAt(IFRAME_APPS.find((a) => a.id === app.id)!);
    }
    logInfo("os", `launcher knows ${Object.keys(launch).length} apps`);
  }

  return {
    launch,
    openFile,
    openWith,
    openFolder: (path: string) => openFilesAt(path),
    openSettings: (page?: string) => openSettingsAt(page),
    openStore: () => openStoreAt(),
    openTrash,
    launchAsApp,
    refreshApps,
  };
}

export type Launcher = ReturnType<typeof createLauncher>;
