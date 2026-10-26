/**
 * Files — file manager over the ZenFS VFS.
 *
 * Two behaviours worth calling out:
 *
 *   - deleting means "move to the trash", which is a folder you need a
 *     passphrase to look in (core/trash.ts). Inside the trash the menu offers
 *     Restore and Delete permanently instead;
 *   - every row's right-click menu has "Open with" listing everyone who can
 *     open that file, with the current default marked.
 */

import { el, icon, attachLongPress } from "../core/dom";
import { showContextMenu, showConfirm, showInput, type CtxItem } from "../core/dialog";
import * as vfs from "../core/vfs";
import type { Win } from "../core/wm";
import { extOf, isDefault, openersFor, canLaunchAsApp } from "../core/filetypes";
import { TRASH, isUnlocked, moveToTrash, restore, unlockTrash, emptyTrash } from "../core/trash";
import { appForFile } from "../core/fs-apps";
import { onDesktop, setOnDesktop } from "../core/desktop-apps";
import { notify } from "../core/toast";
import { refreshDesktops } from "../core/desktop";

export interface FilesHandlers {
  openFile: (path: string) => void;
  /** Open a file with a specific opener (see core/filetypes.ts). */
  openWith?: (path: string, openerId: string) => void;
  /** Ask for the trash passphrase and open it. */
  openTrash?: () => void;
  /** Open the App Store window. */
  openStore?: () => void;
  openTerminal?: () => void;
}

const inTrash = (path: string): boolean => path === TRASH || path.startsWith(`${TRASH}/`);

export function openFiles(win: Win, startPath: string, handlers: FilesHandlers): void {
  let cwd = startPath || vfs.HOME;
  const backStack: string[] = [];
  const fwdStack: string[] = [];

  const root = el("div", "app-root fm-root");

  /* toolbar */
  const toolbar = el("div", "app-toolbar");
  const backBtn = toolButton("back", "", "Back");
  const fwdBtn = toolButton("forward", "", "Forward");
  const upBtn = toolButton("up", "", "Up one folder");
  const pathInput = el("input", "input fm-path-input");
  pathInput.spellcheck = false;
  pathInput.title = "Path — press Enter to go there";
  const newFolderBtn = toolButton("plus", "", "New Folder");
  const newFileBtn = toolButton("text", "", "New File");
  const refreshBtn = toolButton("refresh", "", "Refresh");
  toolbar.append(backBtn, fwdBtn, upBtn, pathInput, newFolderBtn, newFileBtn, refreshBtn);

  /* body */
  const body = el("div", "fm-body");
  const sidebar = el("div", "fm-sidebar");
  const main = el("div", "fm-main");
  const list = el("div", "fm-list");
  main.append(list);
  body.append(sidebar, main);

  const status = el("div", "app-statusbar");

  root.append(toolbar, body, status);
  win.el.append(root);

  function toolButton(ic: string, label: string, title: string): HTMLButtonElement {
    const b = el("button", "tool-btn");
    b.innerHTML = icon(ic).innerHTML;
    if (label) b.append(` ${label}`);
    /* Icon-only buttons need a tooltip — otherwise they are a guessing game. */
    b.title = title;
    b.setAttribute("aria-label", title);
    return b;
  }

  const sideItems: { name: string; ic: string; path: string; locked?: boolean }[] = [
    { name: "Home", ic: "home", path: vfs.HOME },
    { name: "Documents", ic: "text", path: vfs.SPECIAL_DIRS.Documents },
    { name: "Downloads", ic: "download", path: vfs.SPECIAL_DIRS.Downloads },
    { name: "Desktop", ic: "desktop", path: vfs.SPECIAL_DIRS.Desktop },
    { name: "Trash", ic: "trash", path: TRASH, locked: true },
    { name: "v86", ic: "linux", path: vfs.ENGINE_ROOT.v86 },
    { name: "CheerpX", ic: "browser", path: vfs.ENGINE_ROOT.cheerpx },
  ];

  function renderSidebar(): void {
    sidebar.textContent = "";
    for (const item of sideItems) {
      const b = el("button", "fm-side-item");
      b.innerHTML = icon(item.locked && !isUnlocked() ? "lock" : item.ic).innerHTML;
      b.append(el("span", "side-label", item.name));
      if (item.path === cwd) b.classList.add("active");
      if (item.locked) b.title = "Locked — needs your trash passphrase";
      b.addEventListener("click", () => {
        if (item.locked && !isUnlocked()) {
          /* Ask for the passphrase, then stay in this window — opening a
             second Files window just to show the bin is disorienting. */
          void unlockTrash().then((ok) => {
            if (ok) void navigate(item.path);
          });
          return;
        }
        void navigate(item.path);
      });
      sidebar.append(b);
    }
  }

  async function render(): Promise<void> {
    renderSidebar();
    pathInput.value = cwd;
    list.textContent = "";
    backBtn.disabled = backStack.length === 0;
    fwdBtn.disabled = fwdStack.length === 0;
    upBtn.disabled = cwd === "/" || cwd === "";
    newFolderBtn.disabled = inTrash(cwd);
    newFileBtn.disabled = inTrash(cwd);

    let entries: vfs.Entry[] = [];
    try {
      entries = await vfs.listDir(cwd);
    } catch {
      list.append(emptyState("folder", "Folder not found"));
      return;
    }

    if (entries.length === 0) {
      list.append(
        emptyState(
          inTrash(cwd) ? "trash" : "folder",
          inTrash(cwd) ? "The trash is empty" : "This folder is empty",
        ),
      );
    }

    for (const entry of entries) {
      list.append(makeRow(entry));
    }

    const dirs = entries.filter((e) => e.isDirectory).length;
    const files = entries.length - dirs;
    status.textContent = inTrash(cwd)
      ? `Trash · ${entries.length} item${entries.length === 1 ? "" : "s"} · emptied when Dragon86 is reopened`
      : `${entries.length} items · ${dirs} folder${dirs === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"}`;
    win.setTitle(inTrash(cwd) ? "Files — Trash" : `Files — ${vfs.baseName(cwd) || cwd}`);
  }

  function makeRow(entry: vfs.Entry): HTMLElement {
    const row = el("div", "fm-row");
    row.append(
      icon(entryIcon(entry)),
      el("div", "name", entry.name),
      el("div", "size", vfs.formatSize(entry.size, entry.isDirectory)),
      el("div", "mtime", vfs.formatDate(entry.mtime)),
    );
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      list.querySelectorAll(".fm-row.selected").forEach((n) => n.classList.remove("selected"));
      row.classList.add("selected");
    });
    row.addEventListener("dblclick", () => openEntry(entry));

    const openRowMenu = (x: number, y: number): void => {
      row.classList.add("selected");
      showContextMenu(x, y, menuFor(entry));
    };
    attachLongPress(row, openRowMenu);
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openRowMenu(e.clientX, e.clientY);
    });
    return row;
  }

  function menuFor(entry: vfs.Entry): CtxItem[] {
    if (inTrash(cwd)) {
      return [
        {
          label: "Restore",
          iconHtml: icon("refresh").innerHTML,
          onClick: async () => {
            const to = await restore(entry.name);
            status.textContent = to ? `Restored to ${to}` : "Could not restore that item";
            refreshDesktops();
            void render();
          },
        },
        { label: "", separator: true },
        {
          label: "Delete permanently",
          iconHtml: icon("trash").innerHTML,
          danger: true,
          onClick: async () => {
            const ok = await showConfirm("Delete permanently", `Delete "${entry.name}" for good?`, true);
            if (!ok) return;
            await vfs.removePath(entry.path);
            void render();
          },
        },
        {
          label: "Empty the trash",
          iconHtml: icon("trash").innerHTML,
          danger: true,
          onClick: async () => {
            const ok = await showConfirm("Empty the trash", "Delete everything in the trash for good?", true);
            if (!ok) return;
            await emptyTrash();
            void render();
            refreshDesktops();
          },
        },
      ];
    }

    const items: CtxItem[] = [
      { label: "Open", iconHtml: icon("open").innerHTML, onClick: () => openEntry(entry) },
    ];

    if (!entry.isDirectory && handlers.openWith) {
      const openers = openersFor(entry.path);
      if (openers.length >= 1 || canLaunchAsApp(entry.path)) {
        const ext = extOf(entry.path);
        items.push({
          label: "Open with",
          iconHtml: icon("browser").innerHTML,
          children: openers.map((opener) => ({
            label: opener.name,
            hint: isDefault(ext, opener.id) ? "(default)" : undefined,
            iconHtml: icon(opener.icon).innerHTML,
            onClick: () => handlers.openWith?.(entry.path, opener.id),
          })),
        });
      }
    }

    /* An .html file that has a manifest and is listed as an app is that app's
       page. Putting the app on the desktop (or taking it off) belongs here,
       next to the file — that is where you go looking for the app itself. */
    const owningApp = entry.isDirectory ? null : appForFile(entry.path);
    if (owningApp) {
      const shown = onDesktop(owningApp.id, owningApp.onDesktop);
      items.push({
        label: shown ? "Remove from Desktop" : "Add to Desktop",
        iconHtml: icon(shown ? "close" : "grid").innerHTML,
        onClick: async () => {
          await setOnDesktop(owningApp.id, !shown);
          notify({
            title: shown
              ? `${owningApp.name} removed from the desktop`
              : `${owningApp.name} added to the desktop`,
            body: shown
              ? "Still installed: it stays in the start menu, and this menu puts the icon back."
              : "Its icon is on the desktop now, and it stays there after a reload.",
            icon: owningApp.icon,
            timeout: 5000,
          });
          refreshDesktops();
          void render();
        },
      });
    }

    items.push({
      label: "Rename",
      iconHtml: icon("rename").innerHTML,
      onClick: async () => {
        const name = await showInput("Rename", "New name:", entry.name);
        if (!name || name === entry.name) return;
        await vfs.renamePath(entry.path, vfs.join(cwd, name));
        refreshDesktops();
        void render();
      },
    });

    items.push(
      { label: "", separator: true },
      {
        label: "Move to Trash",
        iconHtml: icon("trash").innerHTML,
        danger: true,
        onClick: async () => {
          if (await moveToTrash(entry.path)) {
            status.textContent = `Moved "${entry.name}" to the trash`;
            refreshDesktops();
            void render();
          }
        },
      },
    );
    return items;
  }

  function entryIcon(entry: vfs.Entry): string {
    if (entry.isDirectory) return "folder";
    const ext = extOf(entry.name);
    if (ext === "nes" || ext === "rom") return "games";
    if (/^(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/.test(ext)) return "image";
    if (/^(mp3|wav|ogg|flac|m4a)$/.test(ext)) return "audio";
    if (/^(mp4|webm|mkv|mov)$/.test(ext)) return "video";
    if (/^(html?|url)$/.test(ext)) return "browser";
    if (/^(txt|md|log|json|js|mjs|ts|css|yml|yaml|sh|py|xml|csv|ini|conf|env|toml)$/.test(ext)) return "text";
    return "file";
  }

  function emptyState(ic: string, msg: string): HTMLElement {
    const box = el("div", "fm-empty");
    box.append(icon(ic), el("div", undefined, msg));
    return box;
  }

  function openEntry(entry: vfs.Entry): void {
    if (entry.isDirectory) navigate(entry.path);
    else handlers.openFile(entry.path);
  }

  async function navigate(path: string, pushHistory = true): Promise<void> {
    if (path === cwd) return;
    /* The trash asks for the passphrase every session, including when the
       path is typed into the address bar. */
    if (inTrash(path) && !isUnlocked()) {
      const ok = await unlockTrash();
      if (!ok) return;
    }
    if (pushHistory) {
      backStack.push(cwd);
      fwdStack.length = 0;
    }
    cwd = path;
    await render();
  }

  /* toolbar events */
  backBtn.addEventListener("click", () => {
    const prev = backStack.pop();
    if (!prev) return;
    fwdStack.push(cwd);
    cwd = prev;
    void render();
  });
  fwdBtn.addEventListener("click", () => {
    const next = fwdStack.pop();
    if (!next) return;
    backStack.push(cwd);
    cwd = next;
    void render();
  });
  upBtn.addEventListener("click", () => void navigate(vfs.parentOf(cwd)));
  refreshBtn.addEventListener("click", () => void render());
  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void navigate(pathInput.value.trim() || vfs.HOME);
  });

  newFolderBtn.addEventListener("click", async () => {
    const name = await showInput("New Folder", "Folder name:", "New Folder");
    if (!name) return;
    await vfs.ensureDir(vfs.join(cwd, name));
    refreshDesktops();
    void render();
  });
  newFileBtn.addEventListener("click", async () => {
    const name = await showInput("New File", "File name:", "untitled.txt");
    if (!name) return;
    await vfs.writeText(vfs.join(cwd, name), "");
    refreshDesktops();
    void render();
  });

  list.addEventListener("click", () => {
    list.querySelectorAll(".fm-row.selected").forEach((n) => n.classList.remove("selected"));
  });
  list.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest(".fm-row")) return;
    e.preventDefault();
    const items: CtxItem[] = [];
    if (!inTrash(cwd)) {
      items.push(
        { label: "New Folder", iconHtml: icon("folder").innerHTML, onClick: () => newFolderBtn.click() },
        { label: "New File", iconHtml: icon("text").innerHTML, onClick: () => newFileBtn.click() },
        { label: "", separator: true },
      );
    } else {
      items.push({
        label: "Empty the trash",
        iconHtml: icon("trash").innerHTML,
        danger: true,
        onClick: async () => {
          const ok = await showConfirm("Empty the trash", "Delete everything in the trash for good?", true);
          if (!ok) return;
          await emptyTrash();
          void render();
        },
      });
      items.push({ label: "", separator: true });
    }
    items.push(
      { label: "Refresh", iconHtml: icon("refresh").innerHTML, onClick: () => void render() },
      {
        label: "Get more apps",
        iconHtml: icon("store").innerHTML,
        onClick: () => handlers.openStore?.(),
      },
    );
    showContextMenu(e.clientX, e.clientY, items);
  });

  /* A file made elsewhere (an install, the guest writing into the tree) shows
     up without reopening the window. */
  window.addEventListener("d86-desktop-changed", () => void render());

  if (!isUnlocked() && inTrash(cwd)) {
    void unlockTrash().then((ok) => {
      if (!ok) {
        cwd = vfs.HOME;
        void render();
        return;
      }
      void render();
    });
    return;
  }
  void render();
}
