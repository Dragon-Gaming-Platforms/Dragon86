#!/usr/bin/env node
/**
 * Headless smoke test for the desktop shell.
 *
 * There is no browser in CI here, so the whole OS is bundled as one IIFE and
 * loaded into jsdom with the few APIs it needs stubbed (IndexedDB, service
 * workers, layout measurements). It is not a substitute for looking at it —
 * it catches the class of mistake that is invisible until it throws: an
 * undefined function on boot, a menu that never appears, an install that
 * writes nothing.
 *
 *   node tools/ui-smoke/run.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { indexedDB, IDBKeyRange, IDBFactory, IDBDatabase, IDBRequest, IDBTransaction, IDBObjectStore, IDBCursor } from "fake-indexeddb";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = readFileSync(resolve(here, "out/os.js"), "utf8");

const css = readFileSync(resolve(here, "out/dragon86.css"), "utf8");

const dom = new JSDOM(
  `<!doctype html><html lang="en" data-theme="dragon"><head><style>${css}</style></head>
  <body>
    <div id="boot"><div class="boot-logo"><div class="boot-bar"><div class="boot-bar-fill"></div></div><p class="boot-status">Initializing…</p></div></div>
    <div id="os" hidden><div id="desktop"></div><div id="windows"></div><div id="taskbar"></div></div>
  </body></html>`,
  { url: "https://example.test/Dragon86/", runScripts: "outside-only", pretendToBeVisual: true },
);

const { window } = dom;
const { document } = window;

/* ---- the platform bits jsdom does not have ---- */
window.indexedDB = indexedDB;
window.IDBKeyRange = IDBKeyRange;
window.IDBFactory = IDBFactory;
window.IDBDatabase = IDBDatabase;
window.IDBRequest = IDBRequest;
window.IDBTransaction = IDBTransaction;
window.IDBObjectStore = IDBObjectStore;
window.IDBCursor = IDBCursor;
Object.defineProperty(window, "crypto", { configurable: true, value: globalThis.crypto });
window.structuredClone ??= globalThis.structuredClone;
window.fetch = async (input) => {
  const url = String(input);
  const rel = url.replace(/^https:\/\/example\.test/, "").replace(/^\/(Dragon86\/)?/, "");
  const path = resolve(here, "../..", "public", rel);
  try {
    const body = readFileSync(path);
    return {
      ok: true,
      status: 200,
      async json() {
        return JSON.parse(body.toString("utf8"));
      },
      async text() {
        return body.toString("utf8");
      },
      async arrayBuffer() {
        return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      },
    };
  } catch {
    return { ok: false, status: 404, async text() { return "not found"; }, async json() { throw new Error("404"); } };
  }
};
window.URL.createObjectURL = () => "blob:stub";
window.URL.revokeObjectURL = () => {};
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.HTMLElement.prototype.setPointerCapture = function () {};
window.HTMLElement.prototype.releasePointerCapture = function () {};
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.defineProperty(window.navigator, "serviceWorker", {
  configurable: true,
  value: {
    controller: null,
    addEventListener() {},
    register: async () => ({ scope: "https://example.test/Dragon86/" }),
    getRegistrations: async () => [],
  },
});
/* jsdom lays everything out at 0×0; give the desktop a size so the icon grid
   has somewhere to put things. */
for (const [prop, value] of [
  ["clientWidth", 1280],
  ["clientHeight", 800],
]) {
  Object.defineProperty(window.HTMLElement.prototype, prop, {
    configurable: true,
    get() {
      if (this.id === "desktop" || this.classList?.contains("desktop-icons")) return value;
      return 0;
    },
  });
}

window.console = console;
const errors = [];
window.addEventListener("error", (e) => errors.push(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => errors.push(e.reason));

/* ---- run it ---- */
window.eval(bundle);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => wait(60);
let failures = 0;
function check(name, ok, extra = "") {
  if (ok) console.log(`[PASS] ${name}`);
  else {
    failures++;
    console.log(`[FAIL] ${name}${extra ? `  (${extra})` : ""}`);
  }
}

await wait(1600);

check("boot finished", !document.getElementById("os").hidden);
const icons = document.querySelectorAll(".desktop-icon");
check("desktop icons rendered", icons.length > 0, `${icons.length} icons`);
check("App Store is on the desktop", [...icons].some((n) => n.textContent.includes("App Store")));
check("no boot errors", errors.length === 0, errors.map(String).join(" | ").slice(0, 300));

/* icon positions: absolute, snapped to the grid */
const first = icons[0];
check("icons are positioned", first.style.left !== "" && first.style.top !== "", `${first.style.left},${first.style.top}`);
check("icons have no border until selected", !first.classList.contains("selected"));

/* selecting shows the frame */
first.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await tick();
check("click selects an icon", first.classList.contains("selected"));

/* Make a file on the desktop through the UI (right-click → New Text File), so
   the icon menu has real file actions to test. */
document.getElementById("desktop").dispatchEvent(
  new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }),
);
await tick();
const newText = [...document.querySelectorAll(".ctx-item")].find((b) =>
  b.textContent.includes("New Text File"),
);
check("desktop menu offers New Text File", Boolean(newText));
newText?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await tick();
const nameInput = document.querySelector(".dlg input");
check("New Text File asks for a name", Boolean(nameInput));
nameInput.value = "notes.txt";
[...document.querySelectorAll(".dlg-actions .btn")].find((b) => b.textContent === "OK")?.click();
await wait(400);

/* drag one icon to another cell (re-query: the desktop rebuilt after the file) */
check("PointerEvent exists", typeof window.PointerEvent === "function");
const dragIcon = [...document.querySelectorAll(".desktop-icon")][0];
const before = dragIcon.style.left;

dragIcon.dispatchEvent(
  new window.PointerEvent("pointerdown", { bubbles: true, clientX: 30, clientY: 30, button: 0, pointerId: 1 }),
);
dragIcon.dispatchEvent(
  new window.PointerEvent("pointermove", { bubbles: true, clientX: 300, clientY: 220, pointerId: 1 }),
);
/* jsdom has no layout, so the *snap* cannot be checked here — what matters is
   that the drag path runs and the arrangement is written. */
check("dragging marks the icon", dragIcon.classList.contains("dragging"));
dragIcon.dispatchEvent(
  new window.PointerEvent("pointerup", { bubbles: true, clientX: 300, clientY: 220, pointerId: 1 }),
);
await tick();
check("drag ends cleanly", !dragIcon.classList.contains("dragging"));
check("the drop is stored", Boolean(window.localStorage.getItem("dragon86.desktop.layout")));

/* right-click a desktop file -> "Move to Trash" + "Open with" */
const deskFile = [...document.querySelectorAll(".desktop-icon")].find((n) => n.textContent.includes("notes.txt"));
check("desktop shows a new file without a reload", Boolean(deskFile));
deskFile.dispatchEvent(
  new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
);
await tick();
const ctx = document.querySelectorAll(".ctx-menu");
check("context menu opens", ctx.length === 1);
const menuLabels = [...document.querySelectorAll(".ctx-item")].map((b) => b.textContent.trim());

check("desktop menu offers Move to Trash", menuLabels.some((t) => t.includes("Move to Trash")));
check("desktop menu has no plain Delete", !menuLabels.some((t) => t === "Delete"));
const openWith = [...document.querySelectorAll(".ctx-item.has-sub")].find((b) =>
  b.textContent.includes("Open with"),
);
check("file menu has Open with ›", Boolean(openWith));
openWith.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: true }));
await tick();
const subItems = [...document.querySelectorAll(".ctx-sub .ctx-item")].map((b) => b.textContent.trim());
check("Open with lists openers", subItems.length > 0, subItems.join(" | "));
check("one opener is marked (default)", subItems.some((t) => t.includes("(default)")), subItems.join(" | "));
document.querySelectorAll(".ctx-menu").forEach((n) => n.remove());

/* open Settings and check the pages + search */
const settingsIcon = [...document.querySelectorAll(".desktop-icon")].find((n) =>
  n.textContent.trim().startsWith("Settings"),
);
settingsIcon.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await wait(300);
const win = document.querySelector(".d86-window");
check("Settings window opened", Boolean(win));
const navItems = document.querySelectorAll(".settings-nav-item");
check("settings has a sidebar of pages", navItems.length >= 6, `${navItems.length} pages`);
const search = document.querySelector(".settings-search input");
search.value = "trash";
search.dispatchEvent(new window.Event("input", { bubbles: true }));
await tick();
check("settings search finds pages", document.querySelectorAll(".settings-result").length > 0);

/* App Store: open it and install from the catalog */
const storeIcon = [...document.querySelectorAll(".desktop-icon")].find((n) =>
  n.textContent.trim().startsWith("App Store"),
);
storeIcon.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await wait(600);
const cards = document.querySelectorAll(".store-card");
check("store catalog rendered", cards.length >= 3, `${cards.length} cards`);

const snakeCard = [...cards].find((n) => n.textContent.includes("Snake"));
check("catalog has Snake", Boolean(snakeCard));
snakeCard.querySelector("button").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(1200);
const toasts = [...document.querySelectorAll(".toast")].map((n) => n.textContent);
check(
  "installing confirms itself",
  toasts.some((t) => /Snake installed/.test(t)),
  toasts.join(" | ").slice(0, 200),
);
check(
  "installed apps ask to be the default opener",
  toasts.some((t) => /can open .nes files/.test(t)),
  toasts.join(" | ").slice(0, 200),
);

check(
  "the installed app appears on the desktop",
  [...document.querySelectorAll(".desktop-icon")].some((n) => n.textContent.includes("Snake")),
);

/* ---- trash: Move to Trash, then open the locked bin with a passphrase ---- */
const noteIcon = [...document.querySelectorAll(".desktop-icon")].find((n) => n.textContent.includes("notes.txt"));
noteIcon.dispatchEvent(
  new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
);
await tick();
[...document.querySelectorAll(".ctx-item")]
  .find((b) => b.textContent.includes("Move to Trash"))
  ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(400);
check(
  "trashed file leaves the desktop",
  ![...document.querySelectorAll(".desktop-icon")].some((n) => n.textContent.includes("notes.txt")),
);

/* Open Files at the trash: it must ask for a passphrase first. */
const filesIcon = [...document.querySelectorAll(".desktop-icon")].find((n) =>
  n.textContent.trim().startsWith("Files"),
);
filesIcon.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await wait(300);
const filesWin = [...document.querySelectorAll(".d86-window")].find((w) => w.querySelector(".fm-root"));
check("Files window opened", Boolean(filesWin));
const trashTab = [...filesWin.querySelectorAll(".fm-side-item")].find((b) => b.textContent.includes("Trash"));
trashTab.click();
await wait(200);
const passDialog = document.querySelector(".dlg input");
check("the trash asks for a passphrase", Boolean(passDialog), document.body.textContent.slice(-120));
passDialog.value = "dragon";
[...document.querySelectorAll(".dlg-actions .btn")].find((b) => b.textContent === "OK")?.click();
await wait(500);
check(
  "unlocked trash shows the trashed file",
  [...filesWin.querySelectorAll(".fm-row")].some((r) => r.textContent.includes("notes.txt")),
);

/* ---- marquee: a left-drag on empty wallpaper draws a box ---- */
const deskEl = document.getElementById("desktop");
deskEl.dispatchEvent(
  new window.PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 400, clientY: 300, pointerId: 2 }),
);
window.dispatchEvent(
  new window.PointerEvent("pointermove", { bubbles: true, clientX: 700, clientY: 600, pointerId: 2 }),
);
await tick();
const marquee = document.querySelector(".desktop-marquee");
check("dragging on the wallpaper draws a selection box", marquee && !marquee.hidden);
window.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, clientX: 700, clientY: 600, pointerId: 2 }));
await tick();
check("the box disappears on release", marquee.hidden);

/* ---- an .html file that is not an app: "App Launcher" ---- */
deskEl.dispatchEvent(
  new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 620, clientY: 420 }),
);
await tick();
[...document.querySelectorAll(".ctx-item")]
  .find((b) => b.textContent.includes("New Text File"))
  ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await tick();
document.querySelector(".dlg input").value = "demo.html";
[...document.querySelectorAll(".dlg-actions .btn")].find((b) => b.textContent === "OK")?.click();
await wait(400);
const htmlIcon = [...document.querySelectorAll(".desktop-icon")].find((n) => n.textContent.includes("demo.html"));
check("html file shows on the desktop", Boolean(htmlIcon));
htmlIcon.dispatchEvent(
  new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }),
);
await tick();
const withSub = [...document.querySelectorAll(".ctx-item.has-sub")].find((b) => b.textContent.includes("Open with"));
withSub.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: true }));
await tick();
const openerNames = [...document.querySelectorAll(".ctx-sub .ctx-item")].map((b) => b.textContent.trim());
check("html offers System", openerNames.some((t) => t.startsWith("System")), openerNames.join(" | "));
check("html offers App Launcher", openerNames.some((t) => t.includes("App Launcher")), openerNames.join(" | "));
const launcherItem = [...document.querySelectorAll(".ctx-sub .ctx-item")].find((b) =>
  b.textContent.includes("App Launcher"),
);
launcherItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(400);
const runFrame = [...document.querySelectorAll(".d86-window iframe")].find((f) =>
  String(f.getAttribute("src")).includes("9pf/d86-run"),
);
check("App Launcher runs the page through the app route", Boolean(runFrame), String(runFrame?.getAttribute("src")));

/* ---- Settings → Apps lists what is installed ---- */
settingsIcon.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await wait(300);
const settingsWindow = [...document.querySelectorAll(".d86-window")].find((w) =>
  w.textContent.includes("Settings"),
);
[...settingsWindow.querySelectorAll(".settings-nav-item")]
  .find((b) => b.textContent.includes("Apps"))
  ?.click();
await wait(300);
check(
  "Settings lists installed apps",
  [...settingsWindow.querySelectorAll(".app-list-row")].some((r) => r.textContent.includes("Snake")),
);
check(
  "Settings shows claimed file types",
  [...settingsWindow.querySelectorAll(".app-list-opens")].some((n) => n.textContent.includes(".nes")),
);
check(
  "default apps table exists",
  settingsWindow.querySelectorAll(".defaults-row").length > 0,
);

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
