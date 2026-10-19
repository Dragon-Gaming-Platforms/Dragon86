/**
 * Text Editor — open/edit/save files in the VFS.
 */

import { el, icon } from "../core/dom";
import { showInput } from "../core/dialog";
import * as vfs from "../core/vfs";
import type { Win } from "../core/wm";

export function openEditor(win: Win, path: string | null): void {
  let currentPath = path;
  let dirty = false;

  const root = el("div", "app-root");
  const toolbar = el("div", "app-toolbar");
  const openBtn = tool("file", "Open");
  const saveBtn = tool("save", "Save");
  const saveAsBtn = tool("save", "Save As");
  const pathLabel = el("span", "editor-path");
  pathLabel.style.marginLeft = "10px";
  pathLabel.style.color = "var(--text-dim)";
  toolbar.append(openBtn, saveBtn, saveAsBtn, pathLabel);

  const area = el("textarea", "editor-area");
  area.spellcheck = false;
  area.placeholder = "Type here. Ctrl+S saves.";

  const status = el("div", "app-statusbar");
  const statusPath = el("span");
  const statusStats = el("span");
  status.append(statusPath, statusStats);

  root.append(toolbar, area, status);
  win.el.append(root);

  function tool(ic: string, label: string): HTMLElement {
    const b = el("button", "tool-btn");
    b.innerHTML = icon(ic).innerHTML;
    b.append(` ${label}`);
    return b;
  }

  function refreshTitle(): void {
    const name = currentPath ? vfs.baseName(currentPath) : "untitled";
    win.setTitle(`${dirty ? "● " : ""}${name} — Text Editor`);
    pathLabel.textContent = currentPath ?? "(unsaved)";
    statusPath.textContent = currentPath ?? "not saved";
    const lines = area.value.split("\n").length;
    statusStats.textContent = `${lines} lines · ${area.value.length} chars`;
  }

  async function load(pathIn: string): Promise<void> {
    try {
      area.value = await vfs.readText(pathIn);
      currentPath = pathIn;
      dirty = false;
      refreshTitle();
    } catch {
      area.value = "";
      currentPath = pathIn;
      dirty = false;
      refreshTitle();
    }
  }

  async function save(): Promise<void> {
    if (!currentPath) {
      await saveAs();
      return;
    }
    await vfs.writeText(currentPath, area.value);
    dirty = false;
    refreshTitle();
  }

  async function saveAs(): Promise<void> {
    const suggest = currentPath ?? `${vfs.HOME}/Documents/untitled.txt`;
    const chosen = await showInput("Save As", "Path:", suggest);
    if (!chosen) return;
    currentPath = chosen;
    await save();
  }

  area.addEventListener("input", () => {
    if (!dirty) {
      dirty = true;
      refreshTitle();
    }
    statusStats.textContent = `${area.value.split("\n").length} lines · ${area.value.length} chars`;
  });
  area.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      void save();
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const s = area.selectionStart;
      area.setRangeText("    ", s, area.selectionEnd, "end");
      dirty = true;
      refreshTitle();
    }
  });

  openBtn.addEventListener("click", async () => {
    const chosen = await showInput("Open File", "Path:", currentPath ?? `${vfs.HOME}/Documents/`);
    if (!chosen) return;
    await load(chosen);
  });
  saveBtn.addEventListener("click", () => void save());
  saveAsBtn.addEventListener("click", () => void saveAs());

  if (path) void load(path);
  else refreshTitle();

  requestAnimationFrame(() => area.focus());
}
