/**
 * Files — file manager over the ZenFS VFS.
 */

import { el, icon } from "../core/dom";
import { showContextMenu, showConfirm, showInput } from "../core/dialog";
import * as vfs from "../core/vfs";
import type { Win } from "../core/wm";

export interface FilesHandlers {
  openFile: (path: string) => void;
  openTerminal?: () => void;
}

interface NavPoint {
  path: string;
}

export function openFiles(win: Win, startPath: string, handlers: FilesHandlers): void {
  let cwd = startPath || vfs.HOME;
  const backStack: NavPoint[] = [];
  const fwdStack: NavPoint[] = [];

  const root = el("div", "app-root");

  /* toolbar */
  const toolbar = el("div", "app-toolbar");
  const backBtn = toolButton("back", "Back");
  const fwdBtn = toolButton("forward", "Forward");
  const upBtn = toolButton("up", "Up");
  const pathInput = el("input", "input fm-path-input");
  pathInput.spellcheck = false;
  const newFolderBtn = toolButton("plus", "New Folder");
  const newFileBtn = toolButton("text", "New File");
  const refreshBtn = toolButton("refresh", "");
  toolbar.append(backBtn, fwdBtn, upBtn, pathInput, newFolderBtn, newFileBtn, refreshBtn);

  /* body */
  const body = el("div", "fm-body");
  const sidebar = el("div", "fm-sidebar");
  const main = el("div", "fm-main");
  const list = el("div", "fm-list");
  main.append(list);
  body.append(sidebar, main);

  /* status */
  const status = el("div", "app-statusbar");

  root.append(toolbar, body, status);
  win.el.append(root);

  function toolButton(ic: string, label: string): HTMLButtonElement {
    const b = el("button", "tool-btn");
    b.innerHTML = icon(ic).innerHTML;
    if (label) b.append(` ${label}`);
    return b;
  }

  /* sidebar */
  const sideItems: { name: string; ic: string; path: string; disabled?: boolean }[] = [
    { name: "Home", ic: "home", path: vfs.HOME },
    { name: "Documents", ic: "text", path: vfs.SPECIAL_DIRS.Documents },
    { name: "Downloads", ic: "download", path: vfs.SPECIAL_DIRS.Downloads },
    { name: "Desktop", ic: "desktop", path: vfs.SPECIAL_DIRS.Desktop },
    { name: "Linux (CheerpX)", ic: "linux", path: "", disabled: true },
  ];

  function renderSidebar(): void {
    sidebar.textContent = "";
    for (const item of sideItems) {
      const b = el("button", "fm-side-item");
      b.innerHTML = icon(item.ic).innerHTML;
      b.append(` ${item.name}`);
      if (item.disabled) {
        b.classList.add("disabled");
        b.title = "Available when the CheerpX engine is connected";
      } else {
        if (item.path === cwd) b.classList.add("active");
        b.addEventListener("click", () => navigate(item.path));
      }
      sidebar.append(b);
    }
  }

  function renderBreadcrumb(): void {
    pathInput.value = cwd;
  }

  async function render(): Promise<void> {
    renderSidebar();
    renderBreadcrumb();
    list.textContent = "";
    backBtn.disabled = backStack.length === 0;
    fwdBtn.disabled = fwdStack.length === 0;
    upBtn.disabled = cwd === "/" || cwd === "";

    let entries: vfs.Entry[] = [];
    try {
      entries = await vfs.listDir(cwd);
    } catch {
      list.append(emptyState("Folder not found"));
      return;
    }

    if (entries.length === 0) {
      list.append(emptyState("This folder is empty"));
    }

    for (const entry of entries) {
      const row = el("div", "fm-row");
      const ic = icon(entry.isDirectory ? "folder" : entry.name.match(/\.(txt|md|log|json|js|ts|css|html|sh|py|yml|yaml)$/i) ? "text" : "file");
      row.append(
        ic,
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
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.add("selected");
        showContextMenu(e.clientX, e.clientY, [
          { label: "Open", iconHtml: icon("file").innerHTML, onClick: () => openEntry(entry) },
          {
            label: "Rename",
            iconHtml: icon("rename").innerHTML,
            onClick: async () => {
              const name = await showInput("Rename", "New name:", entry.name);
              if (!name || name === entry.name) return;
              await vfs.renamePath(entry.path, vfs.join(cwd, name));
              void render();
            },
          },
          { label: "", separator: true },
          {
            label: "Delete",
            iconHtml: icon("trash").innerHTML,
            danger: true,
            onClick: async () => {
              const ok = await showConfirm("Delete", `Delete "${entry.name}"?`, true);
              if (!ok) return;
              await vfs.removePath(entry.path);
              void render();
            },
          },
        ]);
      });
      list.append(row);
    }

    const dirs = entries.filter((e) => e.isDirectory).length;
    const files = entries.length - dirs;
    status.textContent = `${entries.length} items · ${dirs} folders, ${files} files`;
    win.setTitle(`Files — ${vfs.baseName(cwd) || cwd}`);
  }

  function emptyState(msg: string): HTMLElement {
    const box = el("div", "fm-empty");
    box.append(icon("folder"), el("div", undefined, msg));
    return box;
  }

  function openEntry(entry: vfs.Entry): void {
    if (entry.isDirectory) navigate(entry.path);
    else handlers.openFile(entry.path);
  }

  function navigate(path: string, pushHistory = true): void {
    if (path === cwd) return;
    if (pushHistory) {
      backStack.push({ path: cwd });
      fwdStack.length = 0;
    }
    cwd = path;
    void render();
  }

  /* toolbar events */
  backBtn.addEventListener("click", () => {
    const prev = backStack.pop();
    if (!prev) return;
    fwdStack.push({ path: cwd });
    cwd = prev.path;
    void render();
  });
  fwdBtn.addEventListener("click", () => {
    const next = fwdStack.pop();
    if (!next) return;
    backStack.push({ path: cwd });
    cwd = next.path;
    void render();
  });
  upBtn.addEventListener("click", () => navigate(vfs.parentOf(cwd)));
  refreshBtn.addEventListener("click", () => void render());
  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") navigate(pathInput.value.trim() || vfs.HOME);
  });

  newFolderBtn.addEventListener("click", async () => {
    const name = await showInput("New Folder", "Folder name:", "New Folder");
    if (!name) return;
    await vfs.ensureDir(vfs.join(cwd, name));
    void render();
  });
  newFileBtn.addEventListener("click", async () => {
    const name = await showInput("New File", "File name:", "untitled.txt");
    if (!name) return;
    await vfs.writeText(vfs.join(cwd, name), "");
    void render();
  });

  list.addEventListener("click", () => {
    list.querySelectorAll(".fm-row.selected").forEach((n) => n.classList.remove("selected"));
  });
  list.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest(".fm-row")) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      {
        label: "New Folder",
        iconHtml: icon("folder").innerHTML,
        onClick: () => newFolderBtn.click(),
      },
      {
        label: "New File",
        iconHtml: icon("text").innerHTML,
        onClick: () => newFileBtn.click(),
      },
      { label: "", separator: true },
      { label: "Refresh", iconHtml: icon("refresh").innerHTML, onClick: () => void render() },
    ]);
  });

  void render();
}
