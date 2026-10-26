/**
 * Text Editor — the OS's own editor: a plain textarea, a Save button, a
 * character count. No syntax highlighting, no dependency, no network.
 *
 * It used to be Monaco behind a textarea fallback. Monaco is now its own app
 * in the App Store ("Monaco Editor"), which is the honest arrangement: the
 * editor everybody needs should always be there and cost nothing, and a
 * 3 MB code editor is a thing you install when you want it.
 */

import { el, icon } from "../core/dom";
import { showInput } from "../core/dialog";
import * as vfs from "../core/vfs";
import { logWarn } from "../core/log";
import type { Win } from "../core/wm";

export function openPlainEditor(win: Win, path: string | null): void {
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

  const body = el("div", "editor-body");
  const area = el("textarea", "editor-area");
  area.spellcheck = false;
  area.placeholder = "Plain text. Ctrl+S saves.";
  body.append(area);

  const status = el("div", "app-statusbar");
  const statusPath = el("span");
  const statusStats = el("span");
  status.append(statusPath, statusStats);

  root.append(toolbar, body, status);
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
    const text = area.value;
    const lines = text ? text.split("\n").length : 0;
    statusStats.textContent = `${lines} line${lines === 1 ? "" : "s"} · ${text.length} chars${
      dirty ? " · unsaved changes" : ""
    }`;
  }

  async function load(pathIn: string): Promise<void> {
    try {
      area.value = await vfs.readText(pathIn);
    } catch (err) {
      logWarn("os", `editor could not read ${pathIn}`, err);
      area.value = "";
      statusStats.textContent = `could not read ${pathIn}`;
    }
    currentPath = pathIn;
    dirty = false;
    refreshTitle();
  }

  async function save(): Promise<void> {
    if (!currentPath) {
      await saveAs();
      return;
    }
    await vfs.writeText(currentPath, area.value);
    dirty = false;
    refreshTitle();
    statusStats.textContent += " · saved";
    window.dispatchEvent(new CustomEvent("d86-fs-changed"));
  }

  async function saveAs(): Promise<void> {
    const suggest = currentPath ?? `${vfs.HOME}/Documents/untitled.txt`;
    const chosen = await showInput("Save As", "Path:", suggest);
    if (!chosen) return;
    currentPath = chosen;
    await save();
  }

  area.addEventListener("input", () => {
    dirty = true;
    refreshTitle();
  });
  area.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const start = area.selectionStart;
      area.setRangeText("    ", start, area.selectionEnd, "end");
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
