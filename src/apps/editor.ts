/**
 * Text Editor — open/edit/save files in the VFS.
 *
 * Code and text files are edited with Monaco (the editor behind VS Code),
 * vendored under public/monaco/ (npm `monaco-editor`, minified AMD build —
 * no CDN at runtime). Monaco loads lazily the first time an editor window
 * opens; if it fails for any reason, the plain <textarea> stays as fallback.
 */

import { el, icon } from "../core/dom";
import { showInput } from "../core/dialog";
import * as vfs from "../core/vfs";
import type { Win } from "../core/wm";

/* Minimal shapes for the parts of Monaco we use (the package ships no
   importable types for the AMD build, and we deliberately don't bundle it). */
interface MonacoModel {
  setValue(v: string): void;
}
interface MonacoEditor {
  getValue(): string;
  setValue(v: string): void;
  getModel(): MonacoModel | null;
  onDidChangeModelContent(cb: () => void): void;
  addCommand(keybinding: number, handler: () => void): void;
  focus(): void;
  dispose(): void;
  layout(): void;
}
interface Monaco {
  editor: {
    create(dom: HTMLElement, opts: Record<string, unknown>): MonacoEditor;
    setModelLanguage(model: MonacoModel, language: string): void;
  };
  KeyMod: { CtrlCmd: number };
  KeyCode: { KeyS: number };
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", js: "javascript", mjs: "javascript",
  cjs: "javascript", jsx: "javascript", tsx: "typescript",
  json: "json", jsonc: "json", html: "html", htm: "html", css: "css",
  scss: "scss", less: "less", md: "markdown", markdown: "markdown",
  py: "python", sh: "shell", bash: "shell", zsh: "shell",
  xml: "xml", svg: "xml", yml: "yaml", yaml: "yaml", toml: "ini",
  ini: "ini", c: "c", h: "c", cpp: "cpp", cs: "csharp", go: "go",
  rs: "rust", java: "java", php: "php", rb: "ruby", sql: "sql",
  lua: "lua", txt: "plaintext", log: "plaintext",
};

function languageFor(path: string | null): string {
  if (!path) return "plaintext";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "plaintext";
}

let monacoPromise: Promise<Monaco> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.append(s);
  });
}

/** Load the vendored Monaco AMD build once; resolves with `window.monaco`. */
function loadMonaco(): Promise<Monaco> {
  if (monacoPromise) return monacoPromise;
  monacoPromise = (async () => {
    const w = window as unknown as Record<string, unknown>;
    const vsBase = `${import.meta.env.BASE_URL}monaco/vs`;
    if (!w.require) {
      w.require = { paths: { vs: vsBase } };
      await loadScript(`${vsBase}/loader.js`);
    }
    const amdRequire = w.require as (deps: string[], cb: () => void) => void;
    await new Promise<void>((resolve) => amdRequire(["vs/editor/editor.main"], resolve));
    return w.monaco as Monaco;
  })();
  /* A failed load shouldn't poison later windows — let them retry. */
  monacoPromise.catch(() => { monacoPromise = null; });
  return monacoPromise;
}

export function openEditor(win: Win, path: string | null): void {
  let currentPath = path;
  let dirty = false;
  let applying = false; // true while we set content programmatically

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
  area.placeholder = "Loading Monaco… (plain editor if it can't load) · Ctrl+S saves.";
  const monacoHost = el("div", "editor-monaco");
  monacoHost.style.display = "none";
  body.append(area, monacoHost);

  const status = el("div", "app-statusbar");
  const statusPath = el("span");
  const statusStats = el("span");
  status.append(statusPath, statusStats);

  root.append(toolbar, body, status);
  win.el.append(root);

  let monaco: Monaco | null = null;
  let mEditor: MonacoEditor | null = null;

  function getText(): string {
    return mEditor ? mEditor.getValue() : area.value;
  }

  function setText(text: string, forPath: string | null): void {
    applying = true;
    try {
      if (mEditor && monaco) {
        mEditor.setValue(text);
        const model = mEditor.getModel();
        if (model) monaco.editor.setModelLanguage(model, languageFor(forPath));
      } else {
        area.value = text;
      }
    } finally {
      applying = false;
    }
  }

  function markDirty(): void {
    if (applying) return;
    if (!dirty) dirty = true;
    refreshTitle();
  }

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
    const text = getText();
    statusStats.textContent = `${text.split("\n").length} lines · ${text.length} chars`;
  }

  async function load(pathIn: string): Promise<void> {
    try {
      setText(await vfs.readText(pathIn), pathIn);
    } catch {
      setText("", pathIn);
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
    await vfs.writeText(currentPath, getText());
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

  area.addEventListener("input", markDirty);
  area.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      void save();
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const s = area.selectionStart;
      area.setRangeText("    ", s, area.selectionEnd, "end");
      markDirty();
    }
  });

  openBtn.addEventListener("click", async () => {
    const chosen = await showInput("Open File", "Path:", currentPath ?? `${vfs.HOME}/Documents/`);
    if (!chosen) return;
    await load(chosen);
  });
  saveBtn.addEventListener("click", () => void save());
  saveAsBtn.addEventListener("click", () => void saveAs());

  /* Bring Monaco up; swap the textarea out when it's ready, carrying over
     whatever is currently shown (file contents or early typing). */
  void loadMonaco()
    .then((m) => {
      if (!win.el.isConnected) return; // window closed while loading
      monaco = m;
      const pending = area.value;
      area.style.display = "none";
      monacoHost.style.display = "block";
      mEditor = m.editor.create(monacoHost, {
        value: pending,
        language: languageFor(currentPath),
        theme: "vs-dark",
        automaticLayout: true,
        fontSize: 13,
        fontFamily: "var(--font-mono, monospace)",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: "on",
      });
      mEditor.onDidChangeModelContent(markDirty);
      mEditor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => void save());
      refreshTitle();
      mEditor.focus();
    })
    .catch(() => {
      /* Stay on the textarea; say so once in the status bar. */
      if (win.el.isConnected) {
        statusStats.textContent = "Monaco unavailable — plain editor";
      }
    });

  if (path) void load(path);
  else refreshTitle();

  requestAnimationFrame(() => area.focus());
}
