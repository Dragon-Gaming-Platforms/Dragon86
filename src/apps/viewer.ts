/**
 * Viewer — the built-in "System" opener.
 *
 * It exists so that "Open with" always has something honest to offer for a
 * file no app claims: a picture is shown as a picture, a page is rendered, a
 * PDF is handed to the browser's own viewer, anything else gets a hex dump
 * and its size. No app folder, no manifest — it is part of the OS.
 *
 * Everything is read once and rendered from a blob or a data URL, so the
 * viewer works for files anywhere in the home tree, including ones outside
 * any app's folder.
 */

import { el, icon } from "../core/dom";
import * as vfs from "../core/vfs";
import { logInfo, logWarn } from "../core/log";
import { notify } from "../core/toast";
import { isArchiveName } from "../core/archive";
import { extractArchive, readArchive, extractDirFor } from "../core/archive-fs";
import type { Win } from "../core/wm";

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const PAGE = /\.(html?|xhtml)$/i;
const PDF = /\.pdf$/i;
const AUDIO = /\.(mp3|wav|ogg|oga|m4a|flac|aac)$/i;
const VIDEO = /\.(mp4|webm|ogv|mov|mkv)$/i;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  html: "text/html",
  htm: "text/html",
  xhtml: "application/xhtml+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
};

export function openViewer(win: Win, path: string): void {
  const root = el("div", "app-root");
  const body = el("div", "viewer-body");
  const status = el("div", "app-statusbar");
  const name = vfs.baseName(path);
  status.textContent = path;
  root.append(body, status);
  win.el.append(root);
  win.setTitle(`System — ${name}`);

  /* An archive is answered before the bytes are read: listing one means
     parsing it, and the hex dump of a zip tells nobody anything useful. */
  if (isArchiveName(name)) {
    void openArchiveView(win, path, body, status);
    return;
  }

  void (async () => {
    let bytes: Uint8Array;
    try {
      bytes = await vfs.readBytes(path);
    } catch (err) {
      logWarn("os", `viewer could not read ${path}`, err);
      body.append(message("file", `Could not open ${name}`));
      return;
    }

    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    status.textContent = `${path} · ${vfs.formatSize(bytes.byteLength, false)} · ${mime}`;

    if (IMAGE.test(name) || PDF.test(name) || AUDIO.test(name) || VIDEO.test(name)) {
      /* A blob URL is the honest way to show bytes the browser already has;
         it also keeps the viewer working for files outside the service
         worker's routes. */
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
      win.setOnClose(() => URL.revokeObjectURL(url));
      if (IMAGE.test(name)) {
        const img = el("img", "viewer-image");
        img.src = url;
        img.alt = name;
        body.append(img);
        return;
      }
      if (PDF.test(name)) {
        body.append(object(url, "application/pdf", name));
        return;
      }
      if (AUDIO.test(name)) {
        body.append(media("audio", url, name));
        return;
      }
      body.append(media("video", url, name));
      return;
    }

    if (PAGE.test(name)) {
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "text/html" }));
      win.setOnClose(() => URL.revokeObjectURL(url));
      const frame = document.createElement("iframe");
      frame.className = "viewer-frame";
      frame.src = url;
      /* Pages from the filesystem run with no scripting and no access to the
         OS origin: this is a preview, not the App Launcher. */
      frame.setAttribute("sandbox", "allow-forms allow-popups");
      frame.title = name;
      body.append(frame);
      return;
    }

    /* Anything else: what is it, how big is it, and what does it start with. */
    body.append(hexDump(name, bytes));
  })();
}

function message(ic: string, text: string): HTMLElement {
  const box = el("div", "viewer-empty");
  box.append(icon(ic), el("div", undefined, text));
  return box;
}

function object(url: string, type: string, title: string): HTMLElement {
  const node = document.createElement("object");
  node.className = "viewer-frame";
  node.data = url;
  node.type = type;
  node.title = title;
  const fallback = el("div", "viewer-empty", "This browser will not display PDFs inline. ");
  const link = el("a", "btn", "Open it in a new tab");
  link.setAttribute("href", url);
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noopener");
  fallback.append(link);
  node.append(fallback);
  return node;
}

function media(kind: "audio" | "video", url: string, name: string): HTMLElement {
  const wrap = el("div", "viewer-media");
  const node = kind === "audio" ? document.createElement("audio") : document.createElement("video");
  node.controls = true;
  node.src = url;
  node.title = name;
  wrap.append(node);
  return wrap;
}

/** 512 bytes, sixteen to a line — enough to recognise a file, cheap to draw. */
function hexDump(name: string, bytes: Uint8Array): HTMLElement {
  const wrap = el("div", "viewer-hex");
  const head = el("div", "viewer-hex-head");
  head.append(
    el("strong", undefined, name),
    el(
      "span",
      undefined,
      ` ${vfs.formatSize(bytes.byteLength, false)} · ${peekType(bytes)} · first 512 bytes`,
    ),
  );
  const pre = el("pre", "viewer-hex-body");
  const slice = bytes.subarray(0, 512);
  const lines: string[] = [];
  for (let i = 0; i < slice.length; i += 16) {
    const row = slice.subarray(i, i + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${i.toString(16).padStart(6, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  pre.textContent = lines.join("\n");
  wrap.append(head, pre);
  return wrap;
}

function peekType(bytes: Uint8Array): string {
  const at = (offset: number, text: string): boolean =>
    text.split("").every((ch, i) => bytes[offset + i] === ch.charCodeAt(0));
  if (bytes.length >= 4 && bytes[0] === 0x7f && at(1, "ELF")) return "ELF executable";
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip archive";
  if (bytes.length >= 4 && at(0, "PK\u0003\u0004")) return "zip archive";
  if (bytes.length >= 4 && at(0, "NES\u001a")) return "NES ROM";
  if (bytes.length >= 5 && at(0, "%PDF-")) return "PDF document";
  if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, "PNG")) return "PNG image";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "JPEG image";
  return "unknown bytes";
}

/**
 * What an archive shows: what is inside it, and the one action that matters —
 * unpacking it next to itself. Extraction is native (core/archive.ts): the
 * browser's own zip/gzip codec plus a tar parser, no library.
 */
async function openArchiveView(
  win: Win,
  path: string,
  body: HTMLElement,
  status: HTMLElement,
): Promise<void> {
  const name = vfs.baseName(path);
  let listing;
  try {
    listing = await readArchive(path);
  } catch (err) {
    logWarn("os", `viewer could not read the archive ${path}`, err);
    status.textContent = `${path} · cannot be read`;
    body.append(message("archive", `${name}: ${(err as Error).message}`));
    return;
  }

  const target = extractDirFor(path);
  const wrap = el("div", "viewer-archive");
  const head = el("div", "viewer-archive-head");
  const files = listing.entries.filter((e) => !e.isDirectory);
  const total = files.reduce((sum, e) => sum + e.size, 0);
  head.append(
    el("strong", undefined, name),
    el(
      "span",
      undefined,
      ` · ${files.length} file${files.length === 1 ? "" : "s"}, ${listing.entries.length - files.length} folder${listing.entries.length - files.length === 1 ? "" : "s"} · ${vfs.formatSize(total, false)} unpacked`,
    ),
  );

  const actions = el("div", "viewer-archive-actions");
  const here = el("button", "btn", "Extract into this folder");
  const into = el("button", "btn primary", `Extract to ${vfs.baseName(target)}/`);
  actions.append(here, into);
  head.append(actions);

  const list = el("div", "viewer-archive-list");
  for (const entry of listing.entries) {
    const row = el("div", "viewer-archive-row");
    row.append(
      icon(entry.isDirectory ? "folder" : "file"),
      el("span", "viewer-archive-path", entry.path || "(single file)"),
      el("span", "viewer-archive-size", entry.isDirectory ? "" : vfs.formatSize(entry.size, false)),
    );
    list.append(row);
  }

  const run = async (dir: string) => {
    here.disabled = true;
    into.disabled = true;
    status.textContent = `Extracting ${name} → ${dir} …`;
    try {
      const result = await extractArchive(path, dir, { overwrite: true });
      const skipped = result.skipped.length
        ? ` ${result.skipped.length} entr${result.skipped.length === 1 ? "y was" : "ies were"} skipped.`
        : "";
      status.textContent = `Extracted ${result.files} file(s) into ${dir}${skipped}`;
      notify({
        title: `${name} extracted`,
        body: `${result.files} file${result.files === 1 ? "" : "s"} in ${dir}.${skipped}`,
        icon: "archive",
        timeout: 6000,
      });
      logInfo("os", `archive: ${name} → ${dir}`);
      window.dispatchEvent(new CustomEvent("d86-fs-changed"));
    } catch (err) {
      status.textContent = `Could not extract ${name}: ${(err as Error).message}`;
      notify({ title: `${name} did not extract`, body: (err as Error).message, icon: "info", timeout: 0 });
    } finally {
      here.disabled = false;
      into.disabled = false;
    }
  };
  here.addEventListener("click", () => void run(vfs.parentOf(path)));
  into.addEventListener("click", () => void run(target));

  status.textContent = `${path} · ${listing.kind}${listing.tarInside ? " (tar inside)" : ""} · ${files.length} file(s)`;
  wrap.append(head, list);
  body.append(wrap);
  win.setTitle(`Archive — ${name}`);
}
