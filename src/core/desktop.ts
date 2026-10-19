/**
 * Desktop — wallpaper, icons (app shortcuts + ~/Desktop contents), context menu.
 */

import { el, icon } from "./dom";
import { showContextMenu, showInput, type CtxItem } from "./dialog";
import { getSettings, onSettingsChange } from "./settings";
import * as vfs from "./vfs";
import type { AppShortcut } from "./taskbar";

export interface DesktopHandlers {
  openApp: (id: string) => void;
  openFile: (path: string) => void;
  openFolder: (path: string) => void;
}

export function buildDesktop(apps: AppShortcut[], handlers: DesktopHandlers): void {
  const desktop = document.getElementById("desktop")!;
  const wallpaper = el("div", "wallpaper");
  desktop.append(wpaper(wallpaper));

  const iconsArea = el("div", "desktop-icons");
  desktop.append(iconsArea);

  function wpaper(node: HTMLElement): HTMLElement {
    const apply = () => {
      const css = getWallpaperCss();
      if (css.startsWith("url(")) {
        node.style.backgroundImage = css;
      } else if (css.includes("var(--wall-")) {
        node.style.backgroundImage = `var(--wall-${getSettings().wallpaper})`;
      } else {
        node.style.backgroundImage = css;
      }
    };
    apply();
    onSettingsChange(apply);
    return node;
  }

  function getWallpaperCss(): string {
    const id = getSettings().wallpaper;
    if (id === "ember") return "var(--wall-ember)";
    if (id === "obsidian") return "var(--wall-obsidian)";
    const preset: Record<string, string> = {
      void: "radial-gradient(ellipse at 30% 20%, rgba(var(--theme-rgb),0.18), transparent 55%), #050505",
      inferno:
        "radial-gradient(ellipse at 70% 80%, rgba(var(--theme-rgb),0.35), transparent 60%), linear-gradient(160deg, #0a0a0a 30%, rgba(var(--theme-rgb),0.15))",
      grid: "repeating-linear-gradient(0deg, transparent 0 38px, rgba(var(--theme-rgb),0.07) 38px 40px), repeating-linear-gradient(90deg, transparent 0 38px, rgba(var(--theme-rgb),0.07) 38px 40px), #060606",
    };
    return preset[id] ?? preset["void"]!;
  }

  /* wallpaper CSS vars for the generated images */
  document.documentElement.style.setProperty(
    "--wall-ember",
    "url('/Dragon86/wallpapers/ember.jpg')",
  );
  document.documentElement.style.setProperty(
    "--wall-obsidian",
    "url('/Dragon86/wallpapers/obsidian.jpg')",
  );

  async function refreshIcons(): Promise<void> {
    iconsArea.textContent = "";
    for (const app of apps) {
      iconsArea.append(makeIcon(app.name, app.icon, () => handlers.openApp(app.id), false));
    }
    try {
      const entries = await vfs.listDir(vfs.SPECIAL_DIRS.Desktop);
      for (const entry of entries) {
        iconsArea.append(
          makeIcon(
            entry.name,
            entry.isDirectory ? "folder" : guessIcon(entry.name),
            () => (entry.isDirectory ? handlers.openFolder(entry.path) : handlers.openFile(entry.path)),
            true,
            entry.path,
          ),
        );
      }
    } catch {
      /* first boot — folder not created yet */
    }
  }

  function makeIcon(
    label: string,
    iconName: string,
    onOpen: () => void,
    fromVfs: boolean,
    path?: string,
  ): HTMLElement {
    const node = el("div", "desktop-icon");
    node.append(icon(iconName), el("div", "label", label));
    node.addEventListener("click", (e) => {
      e.stopPropagation();
      iconsArea.querySelectorAll(".desktop-icon.selected").forEach((n) => n.classList.remove("selected"));
      node.classList.add("selected");
    });
    node.addEventListener("dblclick", () => onOpen());
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      node.classList.add("selected");
      const items: CtxItem[] = [{ label: "Open", iconHtml: icon("file").innerHTML, onClick: onOpen }];
      if (fromVfs && path) {
        items.push({
          label: "Delete",
          iconHtml: icon("trash").innerHTML,
          danger: true,
          onClick: async () => {
            await vfs.removePath(path);
            void refreshIcons();
          },
        });
      }
      showContextMenu(e.clientX, e.clientY, items);
    });
    return node;
  }

  function guessIcon(name: string): string {
    if (/\.(txt|md|log|json|js|ts|css|html|yml|yaml|sh|py)$/i.test(name)) return "text";
    return "file";
  }

  /* deselect + right-click menu on empty space */
  desktop.addEventListener("click", () => {
    iconsArea.querySelectorAll(".desktop-icon.selected").forEach((n) => n.classList.remove("selected"));
  });
  desktop.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest(".desktop-icon")) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      {
        label: "New Folder",
        iconHtml: icon("folder").innerHTML,
        onClick: async () => {
          const name = await showInput("New Folder", "Folder name:", "New Folder");
          if (!name) return;
          await vfs.ensureDir(vfs.join(vfs.SPECIAL_DIRS.Desktop, name));
          void refreshIcons();
        },
      },
      {
        label: "New Text File",
        iconHtml: icon("text").innerHTML,
        onClick: async () => {
          const name = await showInput("New Text File", "File name:", "untitled.txt");
          if (!name) return;
          const path = vfs.join(vfs.SPECIAL_DIRS.Desktop, name);
          await vfs.writeText(path, "");
          void refreshIcons();
        },
      },
      { label: "", separator: true },
      {
        label: "Open Terminal",
        iconHtml: icon("terminal").innerHTML,
        onClick: () => handlers.openApp("terminal"),
      },
      {
        label: "Settings",
        iconHtml: icon("settings").innerHTML,
        onClick: () => handlers.openApp("settings"),
      },
      {
        label: "Refresh",
        iconHtml: icon("refresh").innerHTML,
        onClick: () => void refreshIcons(),
      },
    ]);
  });

  void refreshIcons();
}
