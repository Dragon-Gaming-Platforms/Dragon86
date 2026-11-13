import { fs } from "@zenfs/core";
import { initVfs, ensureDir, listDir, readText, stat, writeBytes, writeText } from "../core/vfs";

const HOME = "/home/user";
const GAMES = `${HOME}/PS2-Web-Recomp/games`;
const MANIFEST = "dragon86-game.json";
const RELOAD_KEY = "d86-ps2-isolation-reloads";
const app = document.querySelector<HTMLElement>("#app")!;

type Game = {
  v: 1;
  id: string;
  name: string;
  webRoot: string;
  entry: string;
  discPath: string | null;
  sourceArchive: string;
  installedAt: number;
  files: number;
  bytes: number;
};

async function start(): Promise<void> {
  try {
    await ensurePs2Isolation();
    await initVfs();
    const id = new URL(location.href).searchParams.get("game");
    if (id) await launchGame(id);
    else await renderLibrary();
  } catch (error) {
    showState(
      "Could not start the isolated game tab",
      errorText(error),
      "This page is under /ps2/ only. Dragon86's main OS page and service-worker scope are unchanged.",
      [{ label: "Retry", action: () => location.reload() }],
    );
  }
}

async function ensurePs2Isolation(): Promise<void> {
  if (!isSecureContext || !("serviceWorker" in navigator)) {
    throw new Error("Cross-origin isolation needs a secure context and service-worker support (use the HTTPS Dragon86 site in a current browser).");
  }
  const workerUrl = new URL("./ps2-coi-sw.js", location.href);
  const scope = new URL("./", location.href).pathname;
  const registration = await navigator.serviceWorker.register(workerUrl.href, { scope });
  if (registration.installing) {
    await new Promise<void>((resolve, reject) => {
      registration.installing!.addEventListener("statechange", () => {
        if (registration.installing?.state === "activated" || registration.active?.state === "activated") resolve();
        else if (registration.installing?.state === "redundant") reject(new Error("The PS2-only isolation worker failed to activate."));
      });
    });
  }
  const controllerPath = navigator.serviceWorker.controller
    ? new URL(navigator.serviceWorker.controller.scriptURL).pathname
    : "";
  const ownsThisScope = controllerPath === workerUrl.pathname;
  if (!ownsThisScope || !window.crossOriginIsolated || typeof SharedArrayBuffer !== "function") {
    const attempts = Number(sessionStorage.getItem(RELOAD_KEY) || "0");
    if (attempts >= 2) {
      sessionStorage.removeItem(RELOAD_KEY);
      throw new Error("The PS2-only service worker did not isolate this tab after reload. Check that browser service workers are allowed, then retry.");
    }
    sessionStorage.setItem(RELOAD_KEY, String(attempts + 1));
    location.reload();
    await new Promise<never>(() => {});
  }
  sessionStorage.removeItem(RELOAD_KEY);
}

async function renderLibrary(): Promise<void> {
  const shell = element("section", "library-state");
  shell.append(element("div", "eyebrow", "ISOLATED PS2 GAME TAB"));
  shell.append(element("h1", "", "Choose a recompiled game"));
  shell.append(element("p", "", "This is a standalone game launcher, not the Dragon86 desktop. The tab uses a PS2-only COOP/COEP service-worker scope; the rest of the OS stays non-isolated."));
  const list = element("div", "library-list");
  shell.append(list);
  app.replaceChildren(shell);
  await ensureDir(GAMES);
  const dirs = (await listDir(GAMES)).filter((entry) => entry.isDirectory);
  const games = (await Promise.all(dirs.map((dir) => readGame(dir.name).catch(() => null))))
    .filter((game): game is Game => Boolean(game))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!games.length) {
    list.append(element("p", "muted", "No imported game builds were found in this browser's ZenFS library."));
    return;
  }
  for (const game of games) {
    const row = element("article", "library-game");
    const copy = element("div");
    copy.append(element("h2", "", game.name));
    copy.append(element("p", "muted", game.discPath ? `${game.files} build files · disc linked` : "Disc image not linked"));
    const open = link("Launch game", gameUrl(game.id), "btn primary");
    row.append(copy, open);
    list.append(row);
  }
}

async function launchGame(id: string): Promise<void> {
  if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error("Invalid library game ID.");
  const game = await readGame(id);
  const entry = safeRelativePath(game.entry);
  if (!entry) throw new Error("The saved build entry path is invalid.");
  if (!game.discPath || !safeAbsolutePath(game.discPath)) {
    showState(
      "Link a disc image first",
      `${game.name} is in the library, but it has no linked .iso disc image yet. Return to Dragon86's PS2 library and choose the ISO there; the large image remains in its existing ZenFS location.`,
      "The game was not copied or uploaded.",
      [{ label: "Open the game library", action: () => { location.href = libraryUrl(); } }],
    );
    return;
  }
  const entryPath = `${GAMES}/${game.id}/${entry}`;
  const entryInfo = await stat(entryPath);
  if (entryInfo.isDirectory()) throw new Error("The saved web entry points to a folder, not an HTML file.");
  await stat(game.discPath);

  app.replaceChildren();
  document.title = `${game.name} · PS2 Web Recomp`;
  // The compiled game document is the top-level page: no Dragon86 desktop and
  // no iframe. Its URL remains under the narrowly scoped /ps2/ worker.
  location.replace(gameFileUrl(game.id, entry));
}

async function readGame(id: string): Promise<Game> {
  const game = JSON.parse(await readText(`${GAMES}/${id}/${MANIFEST}`)) as Game;
  if (game.v !== 1 || game.id !== id || !/^[a-z0-9-]{1,64}$/.test(game.id)) throw new Error("This folder is not a valid PS2 library entry.");
  if (!safeRelativePath(game.entry)) throw new Error("The saved entry path is invalid.");
  return game;
}

function gameUrl(id: string): string {
  const url = new URL(`${import.meta.env.BASE_URL}ps2/`, location.origin);
  url.searchParams.set("game", id);
  return url.href;
}

function libraryUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}ps2/`, location.origin).href;
}

function gameFileUrl(id: string, entry: string): string {
  const segments = entry.split("/").map(encodeURIComponent);
  const url = new URL(`${import.meta.env.BASE_URL}ps2/files/${encodeURIComponent(id)}/${segments.join("/")}`, location.origin);
  url.searchParams.set("disc", "disc.iso");
  url.searchParams.set("game", id);
  return url.href;
}

function safeRelativePath(value: string): string | null {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")) return null;
  const parts = value.split("/");
  return parts.some((part) => !part || part === "." || part === ".." || /[\0]/.test(part)) ? null : value;
}

function safeAbsolutePath(value: string): boolean {
  return typeof value === "string" && value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => part === ".." || part === ".");
}

function showState(title: string, message: string, note: string, actions: Array<{ label: string; action: () => void }>): void {
  const state = element("section", "state");
  state.append(element("div", "eyebrow", "PS2 WEB RECOMP"));
  state.append(element("h1", "", title));
  state.append(element("p", "error", message));
  state.append(element("small", "", note));
  const buttons = element("div", "actions");
  for (const item of actions) {
    const control = button(item.label, "btn primary");
    control.onclick = item.action;
    buttons.append(control);
  }
  state.append(buttons);
  app.replaceChildren(state);
}

function button(label: string, className: string): HTMLButtonElement {
  const control = document.createElement("button");
  control.type = "button";
  control.className = className;
  control.textContent = label;
  return control;
}

function link(label: string, href: string, className: string): HTMLAnchorElement {
  const control = document.createElement("a");
  control.className = className;
  control.href = href;
  control.textContent = label;
  return control;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
  const port = event.ports[0];
  if (!port || !event.data || event.data.type !== "d86-ps2-file-request") return;
  void handleFileRequest(event.data).then((result) => {
    const bytes = result.bytes
      ? result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength)
      : undefined;
    port.postMessage({ ...result, bytes }, bytes ? [bytes] : []);
  }).catch((error) => port.postMessage({ status: 500, error: errorText(error), length: 0 }));
});

async function handleFileRequest(message: {
  method: string;
  relativePath: string;
  range: { start: number; end: number | null } | null;
  body?: ArrayBuffer;
}): Promise<{ status: number; length: number; contentRange?: string; bytes?: Uint8Array }> {
  const relative = safeRelativePath(message.relativePath);
  if (!relative) return { status: 404, length: 0 };
  const pageUrl = new URL(location.href);
  const fileRoute = pageUrl.pathname.split("/ps2/files/")[1] || "";
  const gameId = pageUrl.searchParams.get("game") || decodeURIComponent(fileRoute.split("/")[0] || "");
  const game = await readGame(gameId);
  let path: string;
  if (message.method === "PUT") {
    if (!message.body) return { status: 400, length: 0 };
    if (/^vu1\/[A-F0-9]{16}_[A-F0-9]{4}\.bin$/.test(relative)) {
      path = `${GAMES}/${game.id}/${relative}`;
      await writeBytes(path, new Uint8Array(message.body));
      return { status: 201, length: 0, bytes: new Uint8Array(0) };
    }
    if (/^entry\/[A-Za-z0-9_.:-]{1,64}$/.test(relative)) {
      path = `${GAMES}/${game.id}/entries.txt`;
      const previous = await readText(path).catch(() => "");
      const token = relative.slice("entry/".length);
      if (!previous.split(/\s+/).includes(token)) await writeText(path, `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${token}\n`);
      return { status: 201, length: 0, bytes: new Uint8Array(0) };
    }
    return { status: 404, length: 0 };
  }
  path = relative.split("/").at(-1) === "disc.iso" ? game.discPath || "" : `${GAMES}/${game.id}/${relative}`;
  if (!path || (path !== game.discPath && !path.startsWith(`${GAMES}/${game.id}/`))) return { status: 404, length: 0 };
  const info = await stat(path);
  if (info.isDirectory()) return { status: 404, length: 0 };
  const range = message.range;
  if (!range) {
    if (message.method === "HEAD") return { status: 200, length: info.size, bytes: new Uint8Array(0) };
    const bytes = await readBytesInChunks(path, 0, info.size);
    return { status: 200, length: info.size, bytes };
  }
  const start = range.start;
  const end = range.end === null ? info.size - 1 : Math.min(range.end, info.size - 1);
  if (!Number.isSafeInteger(start) || start < 0 || start >= info.size || end < start) {
    return { status: 416, length: 0, contentRange: `bytes */${info.size}`, bytes: new Uint8Array(0) };
  }
  const bytes = await readBytesInChunks(path, start, end - start + 1);
  return { status: 206, length: bytes.byteLength, contentRange: `bytes ${start}-${end}/${info.size}`, bytes };
}

async function readBytesInChunks(path: string, start: number, length: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(length) || length < 0 || length > 1024 * 1024 * 1024) throw new Error("Requested file is too large for a single browser response.");
  const data = new Uint8Array(length);
  const handle = await fs.promises.open(path, "r") as unknown as {
    read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
    close(): Promise<void>;
  };
  try {
    let offset = 0;
    while (offset < length) {
      const result = await handle.read(data, offset, Math.min(length - offset, 4 * 1024 * 1024), start + offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    return offset === length ? data : data.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

void start();
