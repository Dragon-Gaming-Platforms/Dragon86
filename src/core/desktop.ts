/**
 * Desktop — wallpaper, icons (app shortcuts + ~/Desktop contents), menus.
 *
 * Icons live on a grid you can rearrange: drag one anywhere and the drop
 * snaps it to the nearest free cell, and the arrangement is remembered per
 * device. Dragging on empty wallpaper draws a selection box, and anything it
 * touches gets selected — the same gesture Explorer and Finder use, because
 * the alternative is people trying it and concluding the desktop is broken.
 *
 * Icons carry no chrome until they are highlighted: no boxes, no outlines,
 * just the icon and its name over the wallpaper. A selected (or
 * marquee-touched) icon gets its frame; hovering only tints it.
 */

import { el, icon, attachLongPress } from "./dom";
import { showContextMenu, showInput, type CtxItem } from "./dialog";
import { getSettings, onSettingsChange } from "./settings";
import * as vfs from "./vfs";
import { openersFor, isDefault, extOf } from "./filetypes";
import { moveToTrash } from "./trash";
import { notify } from "./toast";
import { loadDesktopPrefs, onDesktop, setOnDesktop, onDesktopAppsChange } from "./desktop-apps";
import type { AppShortcut } from "./taskbar";

export interface DesktopHandlers {
  openApp: (id: string) => void;
  openFile: (path: string) => void;
  openFolder: (path: string) => void;
  /** Open a file with a specific opener id (see core/filetypes.ts). */
  openWith: (path: string, openerId: string) => void;
}

/** Cell size per icon size setting. Keep in step with os.css. */
const CELL = {
  small: { w: 78, h: 84 },
  medium: { w: 92, h: 96 },
  large: { w: 108, h: 112 },
} as const;

const LAYOUT_KEY = "dragon86.desktop.layout";
const PAD = 14;

interface Slot {
  col: number;
  row: number;
}

export function buildDesktop(getApps: () => AppShortcut[], handlers: DesktopHandlers): void {
  const desktop = document.getElementById("desktop")!;
  const wallpaper = el("div", "wallpaper");
  desktop.append(wallpaper);

  const iconsArea = el("div", "desktop-icons");
  const marquee = el("div", "desktop-marquee");
  marquee.hidden = true;
  desktop.append(iconsArea, marquee);

  applyWallpaper(wallpaper);
  onSettingsChange(() => applyWallpaper(wallpaper));

  function applyWallpaper(node: HTMLElement): void {
    const id = getSettings().wallpaper;
    if (id === "ember" || id === "obsidian") {
      node.style.backgroundImage = `var(--wall-${id})`;
      return;
    }
    const preset: Record<string, string> = {
      void: "radial-gradient(ellipse at 30% 20%, rgba(var(--theme-rgb),0.18), transparent 55%), #050505",
      inferno:
        "radial-gradient(ellipse at 70% 80%, rgba(var(--theme-rgb),0.35), transparent 60%), linear-gradient(160deg, #0a0a0a 30%, rgba(var(--theme-rgb),0.15))",
      grid: "repeating-linear-gradient(0deg, transparent 0 38px, rgba(var(--theme-rgb),0.07) 38px 40px), repeating-linear-gradient(90deg, transparent 0 38px, rgba(var(--theme-rgb),0.07) 38px 40px), #060606",
    };
    node.style.backgroundImage = preset[id] ?? preset["void"]!;
  }

  document.documentElement.style.setProperty("--wall-ember", "url('/Dragon86/wallpapers/ember.jpg')");
  document.documentElement.style.setProperty(
    "--wall-obsidian",
    "url('/Dragon86/wallpapers/obsidian.jpg')",
  );

  /* ---------- layout: which icon sits in which cell ---------- */

  let layout: Record<string, Slot> = {};
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    layout = raw ? (JSON.parse(raw) as Record<string, Slot>) : {};
  } catch {
    layout = {};
  }

  function saveLayout(): void {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* private mode: the arrangement just will not survive a reload */
    }
  }

  function cellSize(): { w: number; h: number } {
    return CELL[getSettings().iconSize] ?? CELL.medium;
  }

  /* The shell is built while `#os` is still hidden, and a hidden element
     measures 0×0. A 0×0 desktop is one cell wide and one cell tall, which is
     how every icon ended up stacked in the top-left corner on load — and the
     arrangement was then saved, so it stayed broken across reloads. Nothing
     about the grid is decided until the desktop has a real size. */
  function measurable(): boolean {
    return iconsArea.clientWidth > 0 && iconsArea.clientHeight > 0;
  }

  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 16);
    });

  async function waitForSize(): Promise<boolean> {
    for (let i = 0; i < 600 && !measurable(); i++) await nextFrame();
    return measurable();
  }

  function gridSize(): { cols: number; rows: number } {
    const { w, h } = cellSize();
    const width = iconsArea.clientWidth || desktop.clientWidth;
    const height = iconsArea.clientHeight || desktop.clientHeight;
    return {
      cols: Math.max(1, Math.floor((width - PAD * 2) / w)),
      rows: Math.max(1, Math.floor((height - PAD * 2) / h)),
    };
  }

  /** Where an icon currently sits, in cells. */
  function slotOf(node: HTMLElement): Slot {
    const { w, h } = cellSize();
    return {
      col: Math.round((node.offsetLeft - PAD) / w),
      row: Math.round((node.offsetTop - PAD) / h),
    };
  }

  function place(node: HTMLElement, slot: Slot): void {
    const { w, h } = cellSize();
    node.style.left = `${PAD + slot.col * w}px`;
    node.style.top = `${PAD + slot.row * h}px`;
  }

  function occupied(except?: HTMLElement): Set<string> {
    const taken = new Set<string>();
    for (const node of iconsArea.querySelectorAll<HTMLElement>(".desktop-icon")) {
      if (node === except) continue;
      const s = slotOf(node);
      taken.add(`${s.col},${s.row}`);
    }
    return taken;
  }

  /** The closest free cell to `want` (spirals out, then falls back to first). */
  function freeSlot(want: Slot, taken: Set<string>): Slot {
    const { cols, rows } = gridSize();
    const has = (c: number, r: number): boolean =>
      c >= 0 && c < cols && r >= 0 && r < rows && !taken.has(`${c},${r}`);
    if (has(want.col, want.row)) return want;
    for (let ring = 1; ring < Math.max(cols, rows) + 2; ring++) {
      for (let dc = -ring; dc <= ring; dc++) {
        for (let dr = -ring; dr <= ring; dr++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
          const c = want.col + dc;
          const r = want.row + dr;
          if (has(c, r)) return { col: c, row: r };
        }
      }
    }
    /* Completely full: leave it where it was dropped. */
    return want;
  }

  function firstFreeCell(taken: Set<string>): Slot {
    const { cols, rows } = gridSize();
    for (let col = 0; col < cols; col++) {
      for (let row = 0; row < rows; row++) {
        if (!taken.has(`${col},${row}`)) return { col, row };
      }
    }
    return { col: 0, row: 0 };
  }

  /* ---------- icons ---------- */

  const selected = new Set<string>();

  function syncSelection(): void {
    for (const node of iconsArea.querySelectorAll<HTMLElement>(".desktop-icon")) {
      node.classList.toggle("selected", selected.has(node.dataset.key ?? ""));
    }
  }

  function clearSelection(): void {
    if (!selected.size) return;
    selected.clear();
    syncSelection();
  }

  function selectOnly(key: string): void {
    selected.clear();
    selected.add(key);
    syncSelection();
  }

  /** Set when a refresh is asked for while one is already running. */
  let refreshQueued = false;
  let refreshRunning = false;

  /**
   * Re-read the desktop and lay the icons out. Never runs twice at once: the
   * shell fires several of these in the same breath at boot (apps loaded,
   * desktop changed, window focused), and two interleaved passes would append
   * every icon twice.
   */
  async function refreshIcons(): Promise<void> {
    if (refreshRunning) {
      refreshQueued = true;
      return;
    }
    refreshRunning = true;
    try {
      do {
        refreshQueued = false;
        await layoutIcons();
      } while (refreshQueued);
    } finally {
      refreshRunning = false;
    }
  }

  async function layoutIcons(): Promise<void> {
    if (!measurable()) {
      /* Draw nothing rather than draw everything on top of everything else:
         a 0×0 desktop is a one-cell grid, so every icon lands in the same
         corner. Wait for the boot screen to make way, then lay out for real. */
      await waitForSize();
      if (!measurable()) {
        await nextFrame();
        refreshQueued = true;
        return;
      }
    }
    const keep = new Set(selected);
    const present = new Set<string>();
    iconsArea.textContent = "";
    const taken = new Set<string>();

    for (const app of getApps()) {
      /* Not every app belongs here: the start menu lists everything that
         exists, the desktop only what you put on it. */
      if (!onDesktop(app.id, app.onDesktop ?? true)) continue;
      const key = `app:${app.id}`;
      present.add(key);
      iconsArea.append(makeIcon(key, app.name, app.icon, () => handlers.openApp(app.id), taken));
    }
    try {
      const entries = await vfs.listDir(vfs.SPECIAL_DIRS.Desktop);
      for (const entry of entries) {
        const key = `file:${entry.name}`;
        present.add(key);
        iconsArea.append(
          makeIcon(
            key,
            entry.name,
            entry.isDirectory ? "folder" : guessIcon(entry.name),
            () => (entry.isDirectory ? handlers.openFolder(entry.path) : handlers.openFile(entry.path)),
            taken,
            entry.path,
          ),
        );
        rememberDeskPath(key, entry.path);
      }
    } catch {
      /* first boot — the folder may not exist yet */
    }

    /* Anything that disappeared drops its remembered cell. */
    for (const key of Object.keys(layout)) {
      if (!present.has(key)) delete layout[key];
    }
    selected.clear();
    for (const key of keep) if (present.has(key)) selected.add(key);
    syncSelection();
    if (measurable()) saveLayout();
  }

  const deskPaths = new Map<string, string>();
  function rememberDeskPath(key: string, path: string): void {
    deskPaths.set(key, path);
  }

  function makeIcon(
    key: string,
    label: string,
    iconName: string,
    onOpen: () => void,
    taken: Set<string>,
    path?: string,
  ): HTMLElement {
    const node = el("div", "desktop-icon");
    node.dataset.key = key;
    node.append(icon(iconName), el("div", "label", label));

    const want = layout[key] ?? firstFreeCell(taken);
    const slot = freeSlot(want, taken);
    layout[key] = slot;
    taken.add(`${slot.col},${slot.row}`);
    place(node, slot);

    /* ---- selection + open ---- */
    let dragged = false;
    node.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dragged) {
        dragged = false;
        return;
      }
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        if (selected.has(key)) selected.delete(key);
        else selected.add(key);
        syncSelection();
        return;
      }
      selectOnly(key);
    });
    node.addEventListener("dblclick", () => {
      if (dragged) return;
      onOpen();
    });

    /* ---- dragging ---- */
    node.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const originX = node.offsetLeft;
      const originY = node.offsetTop;
      let active = false;
      node.setPointerCapture(e.pointerId);

      const move = (ev: PointerEvent): void => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!active && Math.hypot(dx, dy) < 5) return;
        if (!active) {
          active = true;
          dragged = false;
          node.classList.add("dragging");
          if (!selected.has(key)) selectOnly(key);
        }
        if (Math.hypot(dx, dy) > 5) dragged = true;
        node.style.left = `${originX + dx}px`;
        node.style.top = `${originY + dy}px`;
      };

      const end = (): void => {
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", end);
        node.removeEventListener("pointercancel", end);
        if (!active) return;
        node.classList.remove("dragging");
        const snapped = freeSlot(slotOf(node), occupied(node));
        layout[key] = snapped;
        place(node, snapped);
        saveLayout();
      };

      node.addEventListener("pointermove", move);
      node.addEventListener("pointerup", end);
      node.addEventListener("pointercancel", end);
    });

    const openMenu = (x: number, y: number): void => {
      if (!selected.has(key)) selectOnly(key);
      const filePath = path ?? deskPaths.get(key);
      const entries: CtxItem[] = [
        { label: "Open", iconHtml: icon("file").innerHTML, onClick: onOpen },
      ];

      /* Apps can be taken off the desktop without being uninstalled: the app
         and its files stay, only the shortcut goes. "(Add to Desktop)" is on
         the app's own page instead — see Files and Settings → Apps. */
      if (!filePath && key.startsWith("app:")) {
        const appId = key.slice(4);
        entries.push({
          label: "Remove from Desktop",
          iconHtml: icon("close").innerHTML,
          onClick: async () => {
            await setOnDesktop(appId, false);
            notify({
              title: `${label} removed from the desktop`,
              body: "The app is still installed — it is in the start menu, and Add to Desktop brings it back.",
              icon: "grid",
              timeout: 6000,
            });
            void refreshIcons();
          },
        });
      }

      if (filePath) {
        const openers = openersFor(filePath);
        if (openers.length >= 1) {
          entries.push({
            label: "Open with",
            iconHtml: icon("browser").innerHTML,
            children: openers.map((opener) => ({
              label: opener.name,
              hint: isDefault(extOf(filePath), opener.id) ? "(default)" : undefined,
              iconHtml: icon(opener.icon).innerHTML,
              onClick: () => handlers.openWith(filePath, opener.id),
            })),
          });
        }
      }

      if (filePath) {
        entries.push({
          label: "Rename",
          iconHtml: icon("rename").innerHTML,
          onClick: async () => {
            const name = await showInput("Rename", "New name:", vfs.baseName(filePath));
            if (!name || name === vfs.baseName(filePath)) return;
            await vfs.renamePath(filePath, vfs.join(vfs.SPECIAL_DIRS.Desktop, name));
            void refreshIcons();
          },
        });
        entries.push(
          { label: "", separator: true },
          {
            label: "Move to Trash",
            iconHtml: icon("trash").innerHTML,
            danger: true,
            onClick: async () => {
              if (await moveToTrash(filePath)) void refreshIcons();
            },
          },
        );
      }
      showContextMenu(x, y, entries);
    };

    attachLongPress(node, openMenu);
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(e.clientX, e.clientY);
    });
    return node;
  }

  function guessIcon(name: string): string {
    const ext = extOf(name);
    if (ext === "nes" || ext === "rom") return "games";
    /* A .d86 file *is* an app shortcut (core/app-shortcuts), so it should not
       look like a stray document. */
    if (ext === "d86") return "grid";
    if (/^(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/.test(ext)) return "image";
    if (/^(html?|url)$/.test(ext)) return "browser";
    if (/^(mp3|wav|ogg|flac|m4a)$/.test(ext)) return "audio";
    if (/^(mp4|webm|mkv|mov)$/.test(ext)) return "video";
    if (/^(txt|md|log|json|js|ts|css|yml|yaml|sh|py|xml|csv|ini)$/.test(ext)) return "text";
    return "file";
  }

  /* ---------- marquee selection on empty wallpaper ---------- */

  desktop.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".desktop-icon") || target.closest(".d86-window")) return;
    if (target.closest(".start-menu") || target.closest(".ctx-menu")) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? new Set(selected) : new Set<string>();
    let active = false;
    const host = desktop.getBoundingClientRect();

    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!active && Math.hypot(dx, dy) < 4) return;
      if (!active) {
        active = true;
        marquee.hidden = false;
      }
      const rect = {
        left: Math.min(startX, ev.clientX),
        top: Math.min(startY, ev.clientY),
        right: Math.max(startX, ev.clientX),
        bottom: Math.max(startY, ev.clientY),
      };
      marquee.style.left = `${rect.left - host.left}px`;
      marquee.style.top = `${rect.top - host.top}px`;
      marquee.style.width = `${rect.right - rect.left}px`;
      marquee.style.height = `${rect.bottom - rect.top}px`;

      selected.clear();
      for (const key of base) selected.add(key);
      for (const node of iconsArea.querySelectorAll<HTMLElement>(".desktop-icon")) {
        const r = node.getBoundingClientRect();
        const hit =
          r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top;
        if (hit) selected.add(node.dataset.key ?? "");
      }
      syncSelection();
    };

    const end = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      marquee.hidden = true;
      if (!active && !additive) clearSelection();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  });

  /* Right-click on empty wallpaper. */
  desktop.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest(".desktop-icon")) return;
    if ((e.target as HTMLElement).closest(".d86-window")) return;
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
          await vfs.writeText(vfs.join(vfs.SPECIAL_DIRS.Desktop, name), "");
          void refreshIcons();
        },
      },
      { label: "", separator: true },
      {
        label: "Tidy up icons",
        iconHtml: icon("grid").innerHTML,
        onClick: () => {
          layout = {};
          saveLayout();
          void refreshIcons();
        },
      },
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

  /* Icon size changes re-flow the grid. */
  onSettingsChange(() => {
    for (const node of iconsArea.querySelectorAll<HTMLElement>(".desktop-icon")) {
      const key = node.dataset.key ?? "";
      const slot = freeSlot(layout[key] ?? { col: 0, row: 0 }, occupied(node));
      layout[key] = slot;
      place(node, slot);
    }
    saveLayout();
  });

  /* Keep things inside the grid when the window changes shape. */
  let resizeTimer: number | null = null;
  window.addEventListener("resize", () => {
    if (resizeTimer !== null) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = null;
      const { cols } = gridSize();
      for (const node of iconsArea.querySelectorAll<HTMLElement>(".desktop-icon")) {
        const key = node.dataset.key ?? "";
        const slot = layout[key];
        if (slot && slot.col < cols) continue;
        const fixed = freeSlot(
          { col: Math.min(slot?.col ?? 0, cols - 1), row: slot?.row ?? 0 },
          occupied(node),
        );
        layout[key] = fixed;
        place(node, fixed);
      }
      saveLayout();
    }, 200);
  });

  /* A file made in Files (or deleted there) shows up without a reload: the
     Files app and the trash announce changes, and coming back to the tab
     re-reads the folder. */
  window.addEventListener("d86-desktop-changed", () => void refreshIcons());
  onDesktopAppsChange(() => void refreshIcons());
  window.addEventListener("focus", () => void refreshIcons());

  /* Belt and braces for the same 0×0 problem: whenever the desktop first gets
     a real size (boot reveal, a rotated phone, a resized window), re-place the
     icons against the grid that actually exists. */
  let hadSize = measurable();
  const onMaybeSized = (): void => {
    const now = measurable();
    if (now && !hadSize) void refreshIcons();
    hadSize = now;
  };
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(onMaybeSized).observe(iconsArea);
  } else {
    window.addEventListener("resize", onMaybeSized);
  }

  void loadDesktopPrefs().then(() => refreshIcons());
}

/** Ask every open desktop to re-read ~/Desktop (from anywhere in the OS). */
export function refreshDesktops(): void {
  window.dispatchEvent(new Event("d86-desktop-changed"));
}
