/**
 * A narrow File System Access adapter for the vendored Puter apps. The app
 * iframe never gets to browse the host device: every open/save goes through
 * a user-visible picker backed by Dragon86's ZenFS filesystem.
 */
import { fs } from "@zenfs/core";
import * as vfs from "../core/vfs";
export { injectPuterFilesAdapter, isPuterApp, PUTER_APP_IDS } from "./puter-files-meta";

interface PickOptions {
  accept?: string;
  multiple?: boolean;
  directory?: boolean;
}
interface PickedFile {
  file: File;
  path: string;
  token: string;
  relativePath?: string;
}
interface BridgeApi {
  open(child: Window, options?: PickOptions): Promise<PickedFile[]>;
  saveAs(child: Window, name?: string): Promise<{ name: string; path: string; token: string } | null>;
  saveFile(child: Window, name: string, data: Blob): Promise<boolean>;
  write(child: Window, token: string, data: Blob): Promise<void>;
  install(child: Window): void;
}

declare global {
  interface Window { __d86PuterFiles?: BridgeApi }
}


const TOKEN_PATHS = new WeakMap<Window, Map<string, string>>();
const HOME = "/home/user";
const DEFAULT_DIR = `${HOME}/Documents`;

export function installPuterFilesBridge(): void {
  if (window.__d86PuterFiles) return;
  const api: BridgeApi = {
    open: async (child, options = {}) => {
      assertChild(child);
      const paths = await showPicker("open", options);
      const files: PickedFile[] = [];
      for (const path of paths) {
        let st;
        try { st = await fs.promises.stat(path); } catch { continue; }
        const members = options.directory && st.isDirectory() ? await walkFiles(path) : [path];
        for (const member of members) {
          const file = await zenFile(member);
          files.push({ file, path: member, token: remember(child, member), relativePath: member.startsWith(`${path}/`) ? `${vfs.baseName(path)}/${member.slice(path.length + 1)}` : undefined });
        }
      }
      return files;
    },
    saveAs: async (child, name = "Untitled") => {
      assertChild(child);
      const path = await chooseSave(name);
      return path ? { name: vfs.baseName(path), path, token: remember(child, path) } : null;
    },
    saveFile: async (child, name, data) => {
      assertChild(child);
      const path = await chooseSave(name);
      if (!path) return false;
      await writePath(path, data);
      return true;
    },
    write: async (child, token, data) => {
      assertChild(child);
      const path = TOKEN_PATHS.get(child)?.get(token);
      if (!path) throw new Error("That Dragon86 file handle is no longer valid. Open or save the file again.");
      await writePath(path, data);
    },
    install: installInChild,
  };
  window.__d86PuterFiles = api;
}

function assertChild(child: Window): void {
  if (child === window || child.parent !== window || child.location.origin !== window.location.origin) {
    throw new Error("Dragon86 file access is only available to a same-origin app window.");
  }
}

function remember(child: Window, path: string): string {
  let map = TOKEN_PATHS.get(child);
  if (!map) TOKEN_PATHS.set(child, (map = new Map()));
  const token = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  map.set(token, path);
  return token;
}

async function writePath(path: string, data: Blob): Promise<void> {
  await vfs.ensureDir(vfs.parentOf(path));
  await vfs.writeBytes(path, new Uint8Array(await data.arrayBuffer()));
}

async function walkFiles(path: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await vfs.listDir(path)) {
    if (entry.isDirectory) files.push(...await walkFiles(entry.path));
    else files.push(entry.path);
  }
  return files;
}

async function zenFile(path: string): Promise<File> {
  const bytes = await vfs.readBytes(path);
  const st = await fs.promises.stat(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new File([buffer], vfs.baseName(path), {
    lastModified: st.mtimeMs || Date.now(),
    type: mimeFor(vfs.baseName(path)),
  });
}

function mimeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return ({
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    svg: "image/svg+xml", pdf: "application/pdf", json: "application/json", txt: "text/plain",
    csv: "text/csv", wav: "audio/wav", mp3: "audio/mpeg", mp4: "video/mp4", webm: "video/webm",
  } as Record<string, string>)[ext] ?? "application/octet-stream";
}

function accepted(name: string, accept = ""): boolean {
  const rules = accept.split(/[;,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!rules.length) return true;
  const ext = `.${name.split("/").pop()?.split(".").pop()?.toLowerCase() ?? ""}`;
  const mime = mimeFor(name);
  return rules.some((r) => r.startsWith(".") ? ext === r : r.endsWith("/*") ? mime.startsWith(r.slice(0, -1)) : r === mime);
}

function addTypeAccept(types: unknown): string {
  if (!Array.isArray(types)) return "";
  const out: string[] = [];
  for (const type of types as Array<{ accept?: Record<string, string[]> }>) {
    for (const [mime, exts] of Object.entries(type.accept ?? {})) out.push(...exts, mime);
  }
  return out.join(",");
}

async function chooseSave(name: string): Promise<string | null> {
  return (await showPicker("save", { suggestedName: name }))[0] ?? null;
}

function showPicker(mode: "open" | "save", options: PickOptions | { suggestedName: string }): Promise<string[]> {
  return new Promise((resolve) => {
    let current = DEFAULT_DIR;
    let selected = new Set<string>();
    const directoryMode = mode === "open" && !!(options as PickOptions).directory;
    const multiple = mode === "open" && !!(options as PickOptions).multiple;
    const accept = mode === "open" ? (options as PickOptions).accept ?? "" : "";
    const suggested = mode === "save" ? (options as { suggestedName: string }).suggestedName : "";
    const overlay = document.createElement("div");
    const panel = document.createElement("section");
    Object.assign(overlay.style, { position: "fixed", inset: "0", zIndex: "2147483000", background: "#080d18cc", display: "grid", placeItems: "center", padding: "12px", font: "14px system-ui,sans-serif", color: "#e7edf8" });
    Object.assign(panel.style, { width: "min(680px, 96vw)", maxHeight: "min(620px, 90vh)", display: "flex", flexDirection: "column", background: "#111a2b", border: "1px solid #42516d", borderRadius: "12px", boxShadow: "0 20px 70px #000a", overflow: "hidden" });
    overlay.append(panel);

    const heading = document.createElement("header");
    Object.assign(heading.style, { padding: "15px 18px", borderBottom: "1px solid #33415c", fontSize: "17px", fontWeight: "650" });
    heading.textContent = mode === "open" ? directoryMode ? "Choose a Dragon86 folder" : "Open from Dragon86 Files" : "Save to Dragon86 Files";
    const location = document.createElement("div");
    Object.assign(location.style, { display: "flex", gap: "8px", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #26344d" });
    const up = button("↑ Up");
    const home = button("Home");
    const pathLabel = document.createElement("div");
    Object.assign(pathLabel.style, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#b6c4da", flex: "1" });
    location.append(up, home, pathLabel);
    const list = document.createElement("div");
    Object.assign(list.style, { overflow: "auto", minHeight: "190px", flex: "1", padding: "6px 10px" });
    const filename = document.createElement("input");
    filename.value = suggested;
    filename.placeholder = "File name";
    filename.setAttribute("aria-label", "File name");
    Object.assign(filename.style, { display: mode === "save" ? "block" : "none", margin: "10px 14px 0", padding: "9px 10px", background: "#0b1220", color: "#fff", border: "1px solid #42516d", borderRadius: "6px" });
    const footer = document.createElement("footer");
    Object.assign(footer.style, { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", padding: "12px 14px", borderTop: "1px solid #33415c" });
    const hint = document.createElement("span");
    hint.style.color = "#a9b7cc";
    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";
    const cancel = button("Cancel");
    const confirm = button(mode === "open" ? directoryMode ? "Choose folder" : "Open" : "Save here");
    confirm.style.background = "#3478f6";
    confirm.style.borderColor = "#5590ff";
    actions.append(cancel, confirm);
    footer.append(hint, actions);
    panel.append(heading, location, list, filename, footer);

    let settled = false;
    const finish = (paths: string[]) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(paths);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") finish([]); };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("pointerdown", (event) => { if (event.target === overlay) finish([]); });
    cancel.onclick = () => finish([]);
    up.onclick = () => { if (current !== "/") { current = vfs.parentOf(current); selected.clear(); void render(); } };
    home.onclick = () => { current = HOME; selected.clear(); void render(); };
    confirm.onclick = async () => {
      if (mode === "save") {
        const name = filename.value.trim();
        if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) { filename.focus(); return; }
        const path = vfs.join(current, name);
        try {
          const st = await fs.promises.stat(path);
          if (st && !window.confirm(`Replace “${name}” in Dragon86 Files?`)) return;
        } catch { /* new path */ }
        finish([path]);
      } else if (directoryMode) {
        finish([current]);
      } else {
        const paths = [...selected];
        if (!paths.length) return;
        finish(multiple ? paths : paths.slice(0, 1));
      }
    };

    const render = async () => {
      pathLabel.textContent = current;
      list.replaceChildren();
      if (directoryMode) {
        const chooseCurrent = button(`Use this folder: ${vfs.baseName(current) || "/"}`);
        chooseCurrent.style.width = "100%";
        chooseCurrent.onclick = () => finish([current]);
        list.append(chooseCurrent);
      }
      let entries: vfs.Entry[];
      try { entries = await vfs.listDir(current); }
      catch (error) { const message = document.createElement("p"); message.textContent = `Cannot read ${current}: ${String(error)}`; list.append(message); return; }
      const visible = entries.filter((entry) => entry.isDirectory || accepted(entry.name, accept));
      for (const entry of visible) {
        if (directoryMode && !entry.isDirectory) continue;
        const row = document.createElement("button");
        Object.assign(row.style, { display: "flex", width: "100%", padding: "9px 10px", margin: "2px 0", gap: "10px", alignItems: "center", textAlign: "left", color: "#e7edf8", background: selected.has(entry.path) ? "#23406b" : "transparent", border: "1px solid transparent", borderRadius: "6px", cursor: "pointer" });
        const glyph = document.createElement("span");
        glyph.textContent = entry.isDirectory ? "📁" : "📄";
        const label = document.createElement("span");
        label.textContent = entry.name;
        label.style.flex = "1";
        const meta = document.createElement("small");
        meta.textContent = entry.isDirectory ? "Folder" : vfs.formatSize(entry.size, false);
        meta.style.color = "#9eacc2";
        row.append(glyph, label, meta);
        row.onclick = () => {
          if (entry.isDirectory) { current = entry.path; selected.clear(); void render(); return; }
          if (mode === "save") { filename.value = entry.name; return; }
          if (!multiple) selected.clear();
          selected.has(entry.path) ? selected.delete(entry.path) : selected.add(entry.path);
          hint.textContent = `${selected.size} selected`;
          void render();
        };
        row.ondblclick = () => { if (!entry.isDirectory && mode === "open" && !directoryMode) finish([entry.path]); };
        list.append(row);
      }
      if (!visible.length && !directoryMode) { const empty = document.createElement("p"); empty.textContent = accept ? "No matching files in this folder." : "This folder is empty."; empty.style.color = "#a9b7cc"; list.append(empty); }
    };
    document.body.append(overlay);
    void render();
    if (mode === "save") setTimeout(() => { filename.focus(); filename.select(); }, 0);
  });
}

function button(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  Object.assign(b.style, { padding: "7px 11px", color: "#edf3ff", background: "#202e46", border: "1px solid #42516d", borderRadius: "6px", cursor: "pointer" });
  return b;
}

function installInChild(child: Window): void {
  assertChild(child);
  const cw = child as Window & typeof globalThis;
  const w = cw as Window & { __d86PuterPatched?: boolean; showOpenFilePicker?: (opts?: unknown) => Promise<unknown[]>; showSaveFilePicker?: (opts?: unknown) => Promise<unknown> };
  if (w.__d86PuterPatched) return;
  w.__d86PuterPatched = true;
  const bridge = window.__d86PuterFiles!;
  const makeHandle = (picked: PickedFile) => ({
    kind: "file",
    name: picked.file.name,
    getFile: async () => picked.file,
    createWritable: async () => {
      const chunks: BlobPart[] = [];
      let closed = false;
      return {
        write: async (data: BlobPart | { data?: BlobPart; type?: string }) => {
          if (closed) throw new Error("Writable stream is closed");
          chunks.push(data && typeof data === "object" && "type" in data && (data as { type?: string }).type === "write" ? (data as { data?: BlobPart }).data! : data as BlobPart);
        },
        close: async () => { if (!closed) { closed = true; await bridge.write(child, picked.token, new Blob(chunks)); } },
        abort: async () => { closed = true; chunks.length = 0; },
      };
    },
  });

  const makeFiles = (input: HTMLInputElement, items: PickedFile[]) => {
    const files = items.map((item) => {
      if (input.hasAttribute("webkitdirectory")) {
        const relative = item.relativePath ?? vfs.baseName(item.path);
        try { Object.defineProperty(item.file, "webkitRelativePath", { configurable: true, value: relative }); } catch { /* File may be frozen */ }
      }
      return item.file;
    });
    try {
      const transfer = new cw.DataTransfer();
      for (const file of files) transfer.items.add(file);
      Object.defineProperty(input, "files", { configurable: true, value: transfer.files });
    } catch {
      Object.defineProperty(input, "files", { configurable: true, value: files });
    }
    input.dispatchEvent(new cw.Event("input", { bubbles: true }));
    input.dispatchEvent(new cw.Event("change", { bubbles: true }));
  };

  const openForInput = async (input: HTMLInputElement) => {
    try {
      const files = await bridge.open(child, { accept: input.accept, multiple: input.multiple, directory: input.hasAttribute("webkitdirectory") || input.hasAttribute("directory") });
      if (files.length) makeFiles(input, files);
      else input.dispatchEvent(new cw.Event("cancel", { bubbles: false }));
    } catch (error) {
      cw.console.error("Dragon86 ZenFS file picker failed", error);
    }
  };

  const inputProto = cw.HTMLInputElement.prototype;
  const nativeClick = inputProto.click;
  inputProto.click = function(this: HTMLInputElement): void {
    if (this.type === "file") { void openForInput(this); return; }
    nativeClick.call(this);
  };
  cw.document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof cw.HTMLInputElement) || target.type !== "file") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void openForInput(target);
  }, true);
  const replayedDrops = new WeakSet<Event>();
  cw.document.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
  }, true);
  cw.document.addEventListener("drop", (event) => {
    if (replayedDrops.has(event) || !event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = event.target;
    void bridge.open(child, { multiple: true }).then((picked) => {
      if (!picked.length || !(target instanceof cw.Node)) return;
      const transfer = new cw.DataTransfer();
      for (const item of picked) transfer.items.add(item.file);
      const replay = new cw.DragEvent("drop", { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer });
      replayedDrops.add(replay);
      target.dispatchEvent(replay);
    }).catch((error) => cw.console.error("Dragon86 ZenFS upload picker failed", error));
  }, true);
  if (typeof inputProto.showPicker === "function") {
    inputProto.showPicker = function(this: HTMLInputElement): void {
      if (this.type === "file") { void openForInput(this); return; }
      nativeClick.call(this);
    };
  }

  w.showOpenFilePicker = async (opts: unknown = {}) => {
    const options = opts as { multiple?: boolean; types?: unknown };
    const picked = await bridge.open(child, { accept: addTypeAccept(options.types), multiple: options.multiple });
    if (!picked.length) throw new cw.DOMException("The user aborted a request.", "AbortError");
    return (options.multiple ? picked : picked.slice(0, 1)).map(makeHandle);
  };
  w.showSaveFilePicker = async (opts: unknown = {}) => {
    const result = await bridge.saveAs(child, (opts as { suggestedName?: string }).suggestedName);
    if (!result) throw new cw.DOMException("The user aborted a request.", "AbortError");
    return makeHandle({ file: new cw.File([], result.name), path: result.path, token: result.token });
  };

  const routeDownload = (anchor: HTMLAnchorElement) => {
    void (async () => {
      try {
        const response = await cw.fetch(anchor.href);
        if (!response.ok) throw new Error(`Could not read exported file (${response.status})`);
        await bridge.saveFile(child, anchor.download || "download", await response.blob());
      } catch (error) {
        cw.console.error("Dragon86 could not save this export to ZenFS", error);
      }
    })();
  };
  const anchorProto = cw.HTMLAnchorElement.prototype;
  const nativeAnchorClick = anchorProto.click;
  anchorProto.click = function(this: HTMLAnchorElement): void {
    if (!this.download || !/^(blob:|data:)/i.test(this.href)) { nativeAnchorClick.call(this); return; }
    routeDownload(this);
  };
  cw.document.addEventListener("click", (event) => {
    const target = event.target;
    const anchor = target instanceof cw.Element ? target.closest("a[download]") : null;
    if (!(anchor instanceof cw.HTMLAnchorElement) || !/^(blob:|data:)/i.test(anchor.href)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    routeDownload(anchor);
  }, true);
}

