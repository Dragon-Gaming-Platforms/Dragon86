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
   has somewhere to put things — but only once the boot screen is gone, which
   is what a real browser effectively does. The shell is built while `#os` is
   hidden, and a hidden desktop measures 0×0; the smoke test has to reproduce
   that, because a one-cell grid is what used to stack every icon in the
   top-left corner. */
window.__desktopSized = false;
for (const [prop, value] of [
  ["clientWidth", 1280],
  ["clientHeight", 800],
]) {
  Object.defineProperty(window.HTMLElement.prototype, prop, {
    configurable: true,
    get() {
      if (this.id === "desktop" || this.classList?.contains("desktop-icons")) {
        return window.__desktopSized ? value : 0;
      }
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

/* The boot screen disappears at the end of boot; that is also when the desktop
   starts having a size. */
new window.MutationObserver(() => {
  if (!document.getElementById("os").hidden) window.__desktopSized = true;
}).observe(document.getElementById("os"), { attributes: true, attributeFilter: ["hidden"] });

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
/* The "everything crammed into one tile" bug: with a 0×0 desktop the grid is
   one cell wide, so every icon is placed at the same spot. */
const iconSpots = [...icons].map((n) => `${n.style.left},${n.style.top}`);
check(
  "no two icons share a cell on load",
  new Set(iconSpots).size === iconSpots.length,
  `${new Set(iconSpots).size} distinct of ${iconSpots.length}`,
);
/* Icons must sit on the grid's pitch, not at arbitrary offsets. With this
   build's app list they fit in a single column, so a "more than one column"
   assertion would only be testing how many apps happen to ship — the pitch
   is the thing that proves a grid was used. */
const tops = [...new Set([...icons].map((n) => parseFloat(n.style.top) || 0))].sort((a, b) => a - b);
const pitches = tops.slice(1).map((t, i) => t - tops[i]);
check(
  "icons sit on the real grid pitch",
  tops.length > 1 && pitches.every((g) => Math.abs(g - pitches[0]) < 0.5 && g > 40),
  `${iconSpots.join(" ").slice(0, 120)} · pitches ${pitches.join(",")}`,
);
check("the desktop laid out once, not twice", icons.length === new Set([...icons].map((n) => n.dataset.key)).size);
check("icons have no border until selected", !first.classList.contains("selected"));
/* NES is an App Store app, not something that ships installed — and Preview
   is a fixed page now, so neither has a folder or an icon on a fresh device. */
check(
  "NES is not installed by default",
  ![...icons].some((n) => n.textContent.trim().startsWith("NES")),
  [...icons].map((n) => n.textContent.trim()).join(" | ").slice(0, 200),
);
check(
  "Preview is not installed by default",
  ![...icons].some((n) => n.textContent.trim().startsWith("Preview")),
);

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

/* The catalog has no statistics to show, so the store must not print any. */
const storeWindowEl = () =>
  [...document.querySelectorAll(".d86-window")].find((w) => w.querySelector(".store-body"));
check("store renders no star ratings", !document.querySelector(".store-stars"));
const storeTextNow = storeWindowEl()?.textContent ?? "";
check(
  "store shows no review or download counts",
  !/reviews|downloads/i.test(storeTextNow),
  (storeTextNow.match(/.{0,20}(reviews|downloads).{0,20}/i) ?? [])[0] ?? "",
);
check(
  "store explains that it has no ratings",
  /no star ratings/.test(storeTextNow),
  storeTextNow.slice(0, 120),
);
const catalogJson = JSON.parse(readFileSync(resolve(here, "../../public/store.json"), "utf8"));
const invented = new Set();
for (const app of catalogJson.apps) {
  for (const key of ["rating", "reviews", "downloads", "size", "version", "updated", "highlights", "screenshots"]) {
    if (key in app) invented.add(`${app.id}.${key}`);
  }
}
for (const key of ["updated", "featured", "categories"]) if (key in catalogJson) invented.add(key);
check("store.json carries no invented metadata", invented.size === 0, [...invented].join(", "));

check(
  "the store never offers Preview",
  ![...cards].some((n) => /Preview/.test(n.textContent)),
  [...cards].map((n) => n.textContent.slice(0, 24)).join(" | ").slice(0, 200),
);

/* NES is in the catalog but not on the device: Install is what puts it there. */
const nesCardCatalog = [...cards].find((n) => n.textContent.includes("NES"));
check("catalog has NES", Boolean(nesCardCatalog));
const nesCatalogButtons = [...(nesCardCatalog?.querySelectorAll("button") ?? [])].map((b) =>
  b.textContent.trim(),
);
check(
  "NES offers Install, not Open",
  nesCatalogButtons.includes("Install") && !nesCatalogButtons.includes("Open"),
  nesCatalogButtons.join(" | "),
);
nesCardCatalog.querySelector("button").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(1400);
check(
  "installing NES confirms itself",
  [...document.querySelectorAll(".toast")].some((n) => /NES installed/.test(n.textContent)),
  [...document.querySelectorAll(".toast")].map((n) => n.textContent).join(" | ").slice(0, 200),
);
check(
  "…and puts it on the desktop",
  [...document.querySelectorAll(".desktop-icon")].some((n) => n.textContent.trim().startsWith("NES")),
  [...document.querySelectorAll(".desktop-icon")].map((n) => n.textContent.trim()).join(" | ").slice(0, 200),
);

/* ---- the proxies are normal App Store apps now ----
   GUST and Sandstone used to be hardcoded iframe deployments in public/.
   They are catalog apps, installed into ~/system/apps like everything else,
   and they bring their own assets (nested folders included). */
{
  const names = [...cards].map((n) => n.textContent);
  check(
    "the catalog offers GUST and Sandstone",
    names.some((t) => t.includes("GUST")) && names.some((t) => t.includes("Sandstone")),
    names.map((t) => t.slice(0, 20)).join(" | "),
  );
  check(
    "…and they are not installed until asked",
    ![...document.querySelectorAll(".desktop-icon")].some((n) => /^(GUST|Sandstone)/.test(n.textContent.trim())),
  );
  const sandCard = [...cards].find((n) => n.textContent.includes("Sandstone"));
  sandCard.querySelector("button").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(2000);
  check(
    "installing Sandstone confirms itself",
    [...document.querySelectorAll(".toast")].some((n) => /Sandstone installed/.test(n.textContent)),
  );
  check(
    "…and puts it on the desktop",
    [...document.querySelectorAll(".desktop-icon")].some((n) => n.textContent.trim().startsWith("Sandstone")),
  );
  /* Nested asset folders have to survive the install: sandboxed-iframe
     proxying is useless without resources/main.css. The catalog lists it… */
  const sandListing = (catalogJson.apps.find((a) => a.id === "sandstone")?.files ?? []);
  check(
    "the store listing includes the nested assets",
    sandListing.includes("resources/main.css") && sandListing.includes("index.html"),
    sandListing.join(" "),
  );
  /* …and the installed app opens from its folder. */
  [...storeWindowEl().querySelectorAll(".store-tab")].find((b) => b.textContent.includes("Installed"))?.click();
  await wait(500);
  const sandInstalled = [...storeWindowEl().querySelectorAll(".store-card")].find((n) =>
    n.textContent.includes("Sandstone"),
  );
  [...(sandInstalled?.querySelectorAll(".store-actions .btn") ?? [])]
    .find((b) => b.textContent.trim() === "Open")
    ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(700);
  check(
    "the installed proxy opens from its own folder",
    [...document.querySelectorAll(".d86-window iframe")].some((f) =>
      String(f.getAttribute("src")).includes("9pf/sandstone/index.html"),
    ),
    [...document.querySelectorAll(".d86-window iframe")].map((f) => f.getAttribute("src")).join(" | ").slice(0, 200),
  );
  /* Back to the tab the rest of the suite expects: the whole catalog. */
  [...storeWindowEl().querySelectorAll(".store-tab")].find((b) => /\bHome\b/.test(b.textContent))?.click();
  await wait(500);
}

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
const installedSnakeIcon =
  [...(storeWindowEl()?.querySelectorAll(".store-card") ?? [])]
    .find((n) => n.textContent.includes("Snake"))
    ?.querySelector(".store-app-icon img")
    ?.getAttribute("src") ?? "";
check(
  "an installed app shows the icon its folder ships",
  installedSnakeIcon.includes("9pf/snake/icon.svg"),
  installedSnakeIcon,
);

/* The ask toast queues behind the install toast (both are toasts, and they
   are shown one at a time), so give it time to reach the front. */
const askToast = await (async () => {
  for (let i = 0; i < 24; i++) {
    const hit = [...document.querySelectorAll(".toast")]
      .map((n) => n.textContent)
      .find((t) => /can open \.nes files/.test(t));
    if (hit) return hit;
    await wait(500);
  }
  return toasts.join(" | ");
})();
check("installed apps ask to be the default opener", /can open \.nes files/.test(askToast), askToast.slice(0, 200));

/* The detail page: real facts only, including a measured download size. */
const calcCard = [...document.querySelectorAll(".store-card")].find((n) =>
  n.textContent.includes("Calculator"),
);
calcCard.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(600);
const detailWin = storeWindowEl();
const detailFacts = [...(detailWin?.querySelectorAll(".store-fact") ?? [])].map((f) => f.textContent);
const downloadFact = detailFacts.find((t) => t.startsWith("Download"));
check(
  "detail page invents no version number",
  !detailFacts.some((t) => t.startsWith("Version")),
  detailFacts.join(" | "),
);
check(
  "detail page reports a measured download size",
  Boolean(downloadFact) && /(bytes|KB|MB)/.test(downloadFact),
  downloadFact ?? detailFacts.join(" | "),
);
detailWin.querySelector(".store-back")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(300);

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

/* ---- App Store: installed apps get an explicit Uninstall button ---- */
const storeWin = [...document.querySelectorAll(".d86-window")].find((w) => w.querySelector(".store-body"));
check("store window still open", Boolean(storeWin));
[...storeWin.querySelectorAll(".store-tab")]
  .find((b) => b.textContent.includes("Installed"))
  ?.click();
await wait(400);
const instCards = [...storeWin.querySelectorAll(".store-card")];
const snakeCard2 = instCards.find((n) => n.textContent.includes("Snake"));
check("installed tab lists the app", Boolean(snakeCard2));
const actionLabels = [...(snakeCard2?.querySelectorAll(".store-actions .btn") ?? [])].map((b) =>
  b.textContent.trim(),
);
check("installed app has an Uninstall button", actionLabels.includes("Uninstall"), actionLabels.join(" | "));
check("installed app has an Open button", actionLabels.includes("Open"), actionLabels.join(" | "));

/* Open actually launches it. */
[...snakeCard2.querySelectorAll(".store-actions .btn")]
  .find((b) => b.textContent.trim() === "Open")
  .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(300);
check(
  "Open launches the app from the store",
  [...document.querySelectorAll(".d86-window iframe")].some((f) => String(f.getAttribute("src")).includes("9pf/snake")),
);

/* Uninstall: confirm, then the folder and the entry are both gone. */
[...snakeCard2.querySelectorAll(".store-actions .btn")]
  .find((b) => b.textContent.trim() === "Uninstall")
  .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(300);
const confirmDlg = document.querySelector(".dlg");
check("uninstall asks first", Boolean(confirmDlg));
check(
  "the confirmation says it is permanent",
  /not moved to the trash/i.test(confirmDlg?.textContent ?? ""),
  confirmDlg?.textContent?.slice(0, 160),
);
[...confirmDlg.querySelectorAll(".dlg-actions .btn")]
  .find((b) => b.textContent.trim() === "Uninstall")
  ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(600);
check(
  "uninstalled app leaves the desktop",
  ![...document.querySelectorAll(".desktop-icon")].some((n) => n.textContent.includes("Snake")),
);
[...storeWin.querySelectorAll(".store-tab")]
  .find((b) => b.textContent.includes("Installed"))
  ?.click();
await wait(400);
check(
  "uninstalled app is gone from the Installed tab",
  ![...storeWin.querySelectorAll(".store-card")].some((n) => n.textContent.includes("Snake")),
);
const snakeFolderGone = await (async () => {
  /* The folder must be gone, not merely unregistered: ask the Files app to
     list ~/system/apps and look for it. */
  const filesWindow = [...document.querySelectorAll(".d86-window")].find((w) => w.querySelector(".fm-root"));
  const pathInput = filesWindow.querySelector(".fm-path-input");
  pathInput.value = "/home/user/system/apps";
  pathInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(400);
  return ![...filesWindow.querySelectorAll(".fm-row")].some((r) => r.textContent.includes("snake"));
})();
check("the app folder is deleted (not trashed)", snakeFolderGone);

/* After an uninstall the catalog card must offer Install again — not a stale
   Open/Uninstall pair, and not a blank button. */
[...storeWin.querySelectorAll(".store-tab")]
  .find((b) => b.textContent.includes("Games"))
  ?.click();
await wait(400);
const catalogSnake = [...storeWin.querySelectorAll(".store-card")].find((n) =>
  n.textContent.includes("Snake"),
);
const catalogLabels = [...(catalogSnake?.querySelectorAll(".store-actions .btn") ?? [])].map((b) =>
  b.textContent.trim(),
);
check("the Install button comes back after uninstalling", catalogLabels.includes("Install"), catalogLabels.join(" | ") || "(no card)");

/* ---- an app installed by hand (a folder, no catalog entry) can be removed
        from the store too ---- */
const filesWin2 = [...document.querySelectorAll(".d86-window")].find((w) => w.querySelector(".fm-root"));
const newFolder = [...filesWin2.querySelectorAll(".tool-btn")].find((b) => b.title === "New Folder");
newFolder.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(200);
document.querySelector(".dlg input").value = "handmade";
[...document.querySelectorAll(".dlg-actions .btn")].find((b) => b.textContent === "OK")?.click();
await wait(400);
const handmadeRow = [...filesWin2.querySelectorAll(".fm-row")].find((r) => r.textContent.includes("handmade"));
check("hand-made app folder created", Boolean(handmadeRow));
handmadeRow.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await wait(300);
[...filesWin2.querySelectorAll(".tool-btn")]
  .find((b) => b.title === "New File")
  .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(200);
document.querySelector(".dlg input").value = "index.html";
[...document.querySelectorAll(".dlg-actions .btn")].find((b) => b.textContent === "OK")?.click();
await wait(400);
[...storeWin.querySelectorAll(".store-tab")]
  .find((b) => b.textContent.includes("Installed"))
  ?.click();
await wait(500);
const handmadeCard = [...storeWin.querySelectorAll(".store-card")].find((n) => /Handmade/i.test(n.textContent));
check("Apps installed by hand appear in the store", Boolean(handmadeCard));
check(
  "…and can be uninstalled from here",
  [...(handmadeCard?.querySelectorAll(".store-actions .btn") ?? [])].some(
    (b) => b.textContent.trim() === "Uninstall",
  ),
);

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
const listedApps = [...settingsWindow.querySelectorAll(".app-list-row")].map((r) => r.textContent);
check(
  "Settings lists installed apps",
  listedApps.some((t) => t.includes("NES")),
  listedApps.join(" | ").slice(0, 160),
);
check(
  "the uninstalled app is gone from Settings too",
  !listedApps.some((t) => t.includes("Snake")),
  listedApps.join(" | ").slice(0, 160),
);
check(
  "Settings shows claimed file types",
  [...settingsWindow.querySelectorAll(".app-list-opens")].some((n) => n.textContent.includes(".nes")),
);
check(
  "default apps table exists",
  settingsWindow.querySelectorAll(".defaults-row").length > 0,
);

/* ---- an app whose folder disappears behind the store's back ----
   The card used to keep offering Open/Uninstall because the registry still
   listed the app, even though the folder was gone — so "Install" never came
   back. What is installed is now answered by the disk, not the registry. */
[...storeWin.querySelectorAll(".store-tab")]
  .find((b) => b.textContent.includes("Apps"))
  ?.click();
await wait(400);
const calcCatalogCard = [...storeWin.querySelectorAll(".store-card")].find((n) =>
  n.textContent.includes("Calculator"),
);
calcCatalogCard?.querySelector(".store-actions .btn")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(1400);

const filesWin3 = [...document.querySelectorAll(".d86-window")].find((w) => w.querySelector(".fm-root"));
const pathInput3 = filesWin3.querySelector(".fm-path-input");
pathInput3.value = "/home/user/system/apps";
pathInput3.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await wait(400);
const calcRow = [...filesWin3.querySelectorAll(".fm-row")].find((r) => r.textContent.includes("calculator"));
check("the installed app folder is visible in Files", Boolean(calcRow));
calcRow?.dispatchEvent(
  new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 80 }),
);
await wait(120);
[...document.querySelectorAll(".ctx-item")]
  .find((b) => b.textContent.includes("Move to Trash"))
  ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(700);

[...storeWin.querySelectorAll(".store-tab")]
  .find((b) => b.textContent.includes("Apps"))
  ?.click();
await wait(400);
const calcAfter = [...storeWin.querySelectorAll(".store-card")].find((n) =>
  n.textContent.includes("Calculator"),
);
const calcLabels = [...(calcAfter?.querySelectorAll(".store-actions .btn") ?? [])].map((b) =>
  b.textContent.trim(),
);
check(
  "Install returns when the app folder is deleted elsewhere",
  calcLabels.includes("Install"),
  calcLabels.join(" | ") || "(no card)",
);

/* ---- Preview: the default app for pictures, sound, video, models ---- */
/* It is a bundled system app with no desktop icon of its own: it is reached
   by opening a file, and the start menu still lists it. */
const previewOnDesktop = [...document.querySelectorAll(".desktop-icon")].some((n) =>
  n.textContent.trim().startsWith("Preview"),
);
check("Preview ships without a desktop icon", !previewOnDesktop);

const startMenuHasPreview = await (async () => {
  document.querySelector(".start-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(200);
  const found = [...document.querySelectorAll(".start-app")].some((n) => n.textContent.includes("Preview"));
  document.querySelector(".start-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(150);
  return found;
})();
check("…but the start menu lists it", startMenuHasPreview);

/* A .png made through the desktop menu: double-clicking it must land in
   Preview, titled after the file. */
document.getElementById("desktop").dispatchEvent(
  new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 700, clientY: 500 }),
);
await tick();
[...document.querySelectorAll(".ctx-item")]
  .find((b) => b.textContent.includes("New Text File"))
  ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await tick();
document.querySelector(".dlg input").value = "photo.png";
[...document.querySelectorAll(".dlg-actions .btn")].find((b) => b.textContent === "OK")?.click();
await wait(500);

const pngIcon = [...document.querySelectorAll(".desktop-icon")].find((n) => n.textContent.includes("photo.png"));
check("a picture file shows on the desktop", Boolean(pngIcon));
pngIcon?.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
await wait(600);
const previewWin = [...document.querySelectorAll(".d86-window")].find((w) => {
  const frame = w.querySelector("iframe");
  return frame && /\/preview\/(index\.html)?(\?|$)/.test(String(frame.getAttribute("src")));
});
check("opening a .png goes to Preview", Boolean(previewWin));
check(
  "the Preview window is titled after the file",
  /Preview - photo\.png/.test(previewWin?.querySelector(".titlebar, .win-title, header")?.textContent ?? previewWin?.textContent ?? ""),
  previewWin?.textContent?.slice(0, 80),
);
check(
  "Preview is handed the file path",
  String(previewWin?.querySelector("iframe")?.getAttribute("src")).includes("file=%2Fhome%2Fuser%2FDesktop%2Fphoto.png") ||
    String(previewWin?.querySelector("iframe")?.getAttribute("src")).includes("file=/home/user/Desktop/photo.png"),
  String(previewWin?.querySelector("iframe")?.getAttribute("src")),
);

/* ---- Remove from Desktop / Add to Desktop ---- */
const nesDesktopIcon = [...document.querySelectorAll(".desktop-icon")].find((n) =>
  n.textContent.trim().startsWith("NES"),
);
check("NES has a desktop icon to start with", Boolean(nesDesktopIcon));
nesDesktopIcon?.dispatchEvent(
  new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }),
);
await tick();
const removeItem = [...document.querySelectorAll(".ctx-item")].find((b) =>
  b.textContent.includes("Remove from Desktop"),
);
check("an app's menu offers Remove from Desktop", Boolean(removeItem));
removeItem?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(500);
check(
  "the app leaves the desktop",
  ![...document.querySelectorAll(".desktop-icon")].some((n) => n.textContent.trim().startsWith("NES")),
);
const stillInMenu = await (async () => {
  document.querySelector(".start-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(200);
  const found = [...document.querySelectorAll(".start-app")].some((n) => n.textContent.includes("NES"));
  document.querySelector(".start-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(150);
  return found;
})();
check("…but stays installed and in the start menu", stillInMenu);
check(
  "the choice is written to the filesystem",
  await (async () => {
    const filesWinX = [...document.querySelectorAll(".d86-window")].find((w) => w.querySelector(".fm-root"));
    const pathInputX = filesWinX.querySelector(".fm-path-input");
    pathInputX.value = "/home/user/system";
    pathInputX.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(400);
    return [...filesWinX.querySelectorAll(".fm-row")].some((r) => r.textContent.includes("desktop-apps.json"));
  })(),
);

/* Put it back from the app's own page: Files → system/apps/nes → index.html */
const filesWinY = [...document.querySelectorAll(".d86-window")].find((w) => w.querySelector(".fm-root"));
const pathInputY = filesWinY.querySelector(".fm-path-input");
pathInputY.value = "/home/user/system/apps/nes";
pathInputY.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await wait(400);
const nesIndexRow = [...filesWinY.querySelectorAll(".fm-row")].find((r) => r.textContent.includes("index.html"));
check("the app's html is visible in Files", Boolean(nesIndexRow));
nesIndexRow?.dispatchEvent(
  new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 70, clientY: 70 }),
);
await tick();
const addItem = [...document.querySelectorAll(".ctx-item")].find((b) =>
  b.textContent.includes("Add to Desktop"),
);
check("the app's page offers Add to Desktop", Boolean(addItem));
addItem?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(600);
check(
  "Add to Desktop brings the icon back",
  [...document.querySelectorAll(".desktop-icon")].some((n) => n.textContent.trim().startsWith("NES")),
  [...document.querySelectorAll(".desktop-icon")].map((n) => n.textContent.trim()).join(" | ").slice(0, 160),
);

/* Icon art: an app that ships icon.svg shows that image, not a generic glyph. */
const snakeCardIcon = (async () => {
  const storeW = [...document.querySelectorAll(".d86-window")].find((w) => w.querySelector(".store-body"));
  [...storeW.querySelectorAll(".store-tab")].find((b) => b.textContent.includes("Games"))?.click();
  await wait(400);
  const cardEl = [...storeW.querySelectorAll(".store-card")].find((n) => n.textContent.includes("Snake"));
  return cardEl?.querySelector(".store-app-icon img")?.getAttribute("src") ?? "";
})();
check(
  "store cards draw the catalog's icon image before install",
  String(await snakeCardIcon).includes("icons/apps/snake.svg"),
  String(await snakeCardIcon),
);

const nesCardIcon = await (async () => {
  const storeW = [...document.querySelectorAll(".d86-window")].find((w) => w.querySelector(".store-body"));
  const cardEl = [...storeW.querySelectorAll(".store-card")].find((n) => n.textContent.includes("NES"));
  return cardEl?.querySelector(".store-app-icon img")?.getAttribute("src") ?? "";
})();
check(
  "…and the app's own installed icon afterwards",
  nesCardIcon.includes("9pf/nes/icon.svg"),
  nesCardIcon || (() => {
    const storeW = [...document.querySelectorAll(".d86-window")].find((w) => w.querySelector(".store-body"));
    return [...storeW.querySelectorAll(".store-card")].map((n) => n.querySelector(".store-card-head")?.innerHTML?.slice(0, 120)).join(" || ");
  })(),
);

/* Settings → Apps gives every app a desktop switch, including the ones that
   ship without an icon (Preview). */
const settingsWin2 = [...document.querySelectorAll(".d86-window")].find((w) =>
  w.textContent.includes("Settings"),
);
[...settingsWin2.querySelectorAll(".settings-nav-item")].find((b) => b.textContent.includes("Apps"))?.click();
await wait(400);
const previewRow = [...settingsWin2.querySelectorAll(".app-list-row")].find((r) =>
  r.textContent.includes("Preview"),
);
check("Settings lists Preview", Boolean(previewRow));
check(
  "…with a desktop switch that starts Off",
  previewRow?.querySelector(".app-list-desktop")?.textContent.includes("Off desktop"),
  previewRow?.querySelector(".app-list-desktop")?.textContent,
);
previewRow?.querySelector(".app-list-desktop")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(500);
check(
  "turning it on puts Preview on the desktop",
  [...document.querySelectorAll(".desktop-icon")].some((n) => n.textContent.trim().startsWith("Preview")),
  [...document.querySelectorAll(".desktop-icon")].map((n) => n.textContent.trim()).join(" | ").slice(0, 200),
);

/* ---- .d86 shortcuts: the fixed apps are visible where apps live ----
   Preview, Scramjet and the Engine Viewer are pages, not folders, so each one
   gets a shortcut file in ~/system/apps. The file holds the iframe markup and
   opening it launches the app. */
{
  const filesW = [...document.querySelectorAll(".d86-window")].find((w) => w.querySelector(".fm-root"));
  const pathInput = filesW.querySelector(".fm-path-input");
  pathInput.value = "/home/user/system/apps";
  pathInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(500);
  const names = [...filesW.querySelectorAll(".fm-row")].map((r) => r.textContent);
  for (const id of ["preview", "scramjet", "engine-viewer"]) {
    check(
      `${id}.d86 is in system/apps`,
      names.some((t) => t.includes(`${id}.d86`)),
      names.join(" | ").slice(0, 200),
    );
  }
  const previewRow = [...filesW.querySelectorAll(".fm-row")].find((r) =>
    r.textContent.includes("preview.d86"),
  );
  previewRow.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  await wait(700);
  const fromShortcut = [...document.querySelectorAll(".d86-window")].find((w) =>
    /\/preview\/(index\.html)?(\?|$)/.test(String(w.querySelector("iframe")?.getAttribute("src") ?? "")),
  );
  check("opening preview.d86 launches Preview", Boolean(fromShortcut));

  /* The file itself is the iframe code, which is what anything that reads it
     should get — not an empty placeholder. Read it the way a user would:
     right-click → Open with › Text Editor. */
  const scramRow = [...filesW.querySelectorAll(".fm-row")].find((r) =>
    r.textContent.includes("scramjet.d86"),
  );
  scramRow.dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }),
  );
  await tick();
  const withSub = [...document.querySelectorAll(".ctx-item.has-sub")].find((b) =>
    b.textContent.includes("Open with"),
  );
  withSub?.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: true }));
  await tick();
  [...document.querySelectorAll(".ctx-sub .ctx-item")]
    .find((b) => b.textContent.includes("Text Editor"))
    ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(700);
  /* The newest editor window: earlier tests leave editors open too. */
  const editorWin = [...document.querySelectorAll(".d86-window")]
    .filter((w) => w.querySelector(".editor-area"))
    .at(-1);
  const shortcutText = editorWin?.querySelector(".editor-area")?.value ?? "";
  check(
    "the shortcut holds the iframe markup",
    /<iframe[^>]+src="[^"]*scramjet\/"/.test(shortcutText),
    shortcutText.slice(0, 160) || "no editor",
  );
}

/* ---- Engine Viewer: the machine's own screen ---- */
{
  const startBtn = document.querySelector(".start-btn");
  startBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(250);
  const entry = [...document.querySelectorAll(".start-app")].find((n) =>
    n.textContent.includes("Engine Viewer"),
  );
  check("the start menu offers the Engine Viewer", Boolean(entry));
  startBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(150);
  entry?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(700);
  const viewerWin = [...document.querySelectorAll(".d86-window")].find((w) =>
    w.textContent.includes("Engine Viewer"),
  );
  check("the Engine Viewer opens", Boolean(viewerWin));
  check("…with a canvas", Boolean(viewerWin?.querySelector("canvas.engine-canvas")));
  check(
    "…and says honestly that no machine is running",
    /no v86 machine/i.test(viewerWin?.textContent ?? ""),
    viewerWin?.textContent?.slice(0, 120),
  );
  check(
    "the Engine Viewer has no desktop icon",
    ![...document.querySelectorAll(".desktop-icon")].some((n) =>
      n.textContent.trim().startsWith("Engine Viewer"),
    ),
  );
}

/* ---- uninstalling an app that shipped installed ----
   Hello is seeded into ~/system/apps by the OS itself. Uninstalling it used to
   do nothing at all: the next load re-created the folder (writeIfMissing) and
   re-added the registry entry, so the store kept showing it. The seeded flag in
   user-apps.json now gates every write, so an uninstall is final — including
   for an app nobody installed by hand. */
{
  const storeW = [...document.querySelectorAll(".d86-window")].find((w) => w.querySelector(".store-body"));
  [...storeW.querySelectorAll(".store-tab")].find((b) => b.textContent.includes("Installed"))?.click();
  await wait(500);
  const helloCard = [...storeW.querySelectorAll(".store-card")].find((n) =>
    n.textContent.includes("Hello"),
  );
  check("the store lists Hello, which ships installed", Boolean(helloCard));
  check(
    "a default-installed app can be uninstalled too",
    [...(helloCard?.querySelectorAll(".store-actions .btn") ?? [])].some(
      (b) => b.textContent.trim() === "Uninstall",
    ),
  );
  [...helloCard.querySelectorAll(".store-actions .btn")]
    .find((b) => b.textContent.trim() === "Uninstall")
    ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(300);
  [...document.querySelectorAll(".dlg-actions .btn")]
    .find((b) => b.textContent.trim() === "Uninstall")
    ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(700);
  check(
    "uninstalling it removes the card",
    ![...storeW.querySelectorAll(".store-card")].some((n) => n.textContent.includes("Hello")),
    [...storeW.querySelectorAll(".store-card")].map((n) => n.textContent.slice(0, 20)).join(" | "),
  );
  check(
    "…and its desktop icon",
    ![...document.querySelectorAll(".desktop-icon")].some((n) => n.textContent.trim().startsWith("Hello")),
  );

  /* The filesystem has to agree: no folder, no entry. */
  const filesW = [...document.querySelectorAll(".d86-window")].find((w) => w.querySelector(".fm-root"));
  const pathInput = filesW.querySelector(".fm-path-input");
  pathInput.value = "/home/user/system/apps";
  pathInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(400);
  check(
    "…and its folder",
    ![...filesW.querySelectorAll(".fm-row")].some((r) => r.textContent.includes("hello")),
    [...filesW.querySelectorAll(".fm-row")].map((r) => r.textContent.slice(0, 16)).join(" | "),
  );
  pathInput.value = "/home/user/system/apps";
  pathInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(400);
  const manifestRow = [...filesW.querySelectorAll(".fm-row")].find((r) =>
    r.textContent.includes("user-apps.json"),
  );
  manifestRow?.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  await wait(1500);
  const editorWin = [...document.querySelectorAll(".d86-window")]
    .filter((w) => w.querySelector(".editor-area"))
    .at(-1);
  const manifestText = editorWin?.querySelector(".editor-area")?.value ?? "";
  check(
    "…and its entry in user-apps.json",
    Boolean(manifestText) && !/hello/.test(manifestText) && /"seeded": 4/.test(manifestText),
    manifestText
      ? manifestText.slice(0, 160)
      : `row=${Boolean(manifestRow)} windows=${[...document.querySelectorAll(".d86-window")]
          .map((w) => (w.querySelector(".titlebar-text")?.textContent ?? w.className).slice(0, 24))
          .join(" / ")}`,
  );
}

/* ---- Snake, played for real ---- */
/*
 * The shipped game used to auto-start and crawl into the wall in ~1.3s, which
 * looked exactly like "snake does not work". This loads the real files into a
 * canvas-less window and plays them: it must sit still until told to go, then
 * move, eat, pause on blur and die only when actually driven into a wall.
 */
{
  const snakeDir = resolve(here, "../../public/system-apps/snake");
  const snakeDom = new JSDOM(readFileSync(resolve(snakeDir, "index.html"), "utf8"), {
    url: "https://example.test/9pf/snake/index.html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const sWin = snakeDom.window;
  const sDoc = sWin.document;
  const drawn = { rects: 0 };
  sWin.HTMLCanvasElement.prototype.getContext = () => ({
    fillStyle: "",
    fillRect: () => drawn.rects++,
    beginPath() {},
    arc() {},
    fill() {},
  });
  /* Put the food two cells to the right of the start position, so the very
     first step is a guaranteed meal and the score can be checked. */
  /* jsdom logs "Not implemented" for focus(); the game only calls it so a
     real browser gives the frame the keyboard. */
  sWin.focus = () => {};
  let rand = 0;
  sWin.Math.random = () => (rand++ % 2 === 0 ? 0.45 : 0.5);
  const snakeErrors = [];
  sWin.addEventListener("error", (e) => snakeErrors.push(e.error ?? e.message));
  sWin.eval(readFileSync(resolve(snakeDir, "app.js"), "utf8"));

  const score = () => sDoc.getElementById("score").textContent;
  const overlayHidden = () => sDoc.getElementById("overlay").hidden;
  const overlayText = () => sDoc.getElementById("overlay").textContent;
  const key = (k) =>
    sDoc.dispatchEvent(new sWin.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

  await wait(1500);
  check("snake waits for the player", !overlayHidden() && /Tap to start/.test(overlayText()), overlayText());
  check("snake has not died on its own", !/Game over/i.test(overlayText()), overlayText());
  check("snake drew its board", drawn.rects > 20, `${drawn.rects} rects`);

  key("ArrowRight");
  await wait(120);
  check("a key starts the game", overlayHidden(), overlayText());
  await wait(450);
  check("snake moves and eats", /Score [1-9]/.test(score()), score());

  sWin.dispatchEvent(new sWin.Event("blur"));
  await wait(60);
  const pausedScore = score();
  await wait(600);
  check("snake pauses when the window loses focus", /Paused/.test(overlayText()), overlayText());
  check("…and the board does not move while paused", score() === pausedScore, `${pausedScore} → ${score()}`);

  key("ArrowDown");
  await wait(1600);
  check("snake only dies when driven into a wall", /Game over/i.test(overlayText()), overlayText());
  check("snake raised no errors", snakeErrors.length === 0, snakeErrors.join(" | "));

  key("ArrowRight");
  await wait(120);
  check("a key restarts an ended game", overlayHidden() && /Score 0/.test(score()), score());
  sWin.close();
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
