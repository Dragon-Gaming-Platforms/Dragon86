/**
 * App registry — wires apps to windows and file types.
 */

import type { WindowManager } from "../core/wm";
import * as vfs from "../core/vfs";
import { openFiles } from "./files";
import { openEditor } from "./editor";
import { openTerminal } from "./terminal";
import { openSettings } from "./settings";
import { IFRAME_APPS, openIframeApp, type IframeAppDef } from "./iframe-app";

const TEXT_EXT = /\.(txt|md|log|json|js|ts|css|html|htm|yml|yaml|sh|py|xml|csv|ini|cfg|conf|env)$/i;

export function createLauncher(wm: WindowManager) {
  function openFilesAt(path?: string): void {
    const win = wm.create({
      title: "Files",
      icon: "folder",
      width: 820,
      height: 520,
    });
    openFiles(win, path ?? vfs.HOME, {
      openFile: (p) => openFile(p),
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
      title: "Terminal — CheerpX",
      icon: "terminal",
      width: 760,
      height: 480,
    });
    openTerminal(win);
  }

  /* Iframe apps come from iframe-apps.json — see iframe-app.ts. */
  function openIframeAppAt(def: IframeAppDef): void {
    const win = wm.create({
      title: def.name,
      icon: def.icon,
      width: def.width ?? 880,
      height: def.height ?? 600,
    });
    openIframeApp(win, def);
  }

  function openSettingsAt(): void {
    const win = wm.create({
      title: "Settings",
      icon: "settings",
      width: 700,
      height: 560,
    });
    openSettings(win);
  }

  function openFile(path: string): void {
    if (TEXT_EXT.test(path)) {
      openEditorAt(path);
      return;
    }
    /* unknown binary-ish type: open in editor anyway for now */
    openEditorAt(path);
  }

  const launch: Record<string, () => void> = {
    files: () => openFilesAt(),
    terminal: () => openTerminalAt(),
    editor: () => openEditorAt(),
    settings: () => openSettingsAt(),
  };
  for (const def of IFRAME_APPS) {
    launch[def.id] = () => openIframeAppAt(def);
  }

  return {
    launch,
    openFile,
    openFolder: (path: string) => openFilesAt(path),
  };
}
