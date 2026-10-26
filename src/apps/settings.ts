/**
 * Settings — a window with pages, not one long scroll.
 *
 * Left: a sidebar of categories. Top: a search box that reaches every
 * setting on every page (results say which page they live on and take you
 * there). Right: one page at a time, with room to breathe.
 */

import { el, icon } from "../core/dom";
import { showConfirm, showInput } from "../core/dialog";
import { probeRelay, relayBackendName } from "../bridge/v86-relay";
import { guestRootInfo, resetGuestRoot } from "../bridge/guest-root";
import {
  getSettings,
  setSettings,
  THEMES,
  WALLPAPERS,
  type ThemeId,
} from "../core/settings";
import { DEFAULT_HOSTER_URL } from "../bridge/hoster";
import * as vfs from "../core/vfs";
import type { Win } from "../core/wm";
import {
  BUILTIN,
  defaultFor,
  loadDefaults,
  appOpeners,
  setDefault,
  resetAsked,
} from "../core/filetypes";
import { fsAppsWithOpens, getFsApps, onFsAppsChange } from "../core/fs-apps";
import { staticIframeApps } from "./iframe-app";
import { loadDesktopPrefs, onDesktop, setOnDesktop } from "../core/desktop-apps";
import {
  hasPassword,
  setPassword,
  emptyTrash,
  trashCount,
  TRASH,
  checkPassword,
} from "../core/trash";
import { logInfo } from "../core/log";

interface Page {
  id: string;
  title: string;
  icon: string;
  group: string;
  /** Words the search box matches besides the title. */
  keywords: string;
  render: (host: HTMLElement) => void;
}

interface SearchHit {
  page: string;
  pageTitle: string;
  label: string;
  keywords: string;
}

const SEARCH_INDEX: SearchHit[] = [
  { page: "appearance", pageTitle: "Appearance", label: "Theme", keywords: "colour color dark red cyberpunk" },
  { page: "appearance", pageTitle: "Appearance", label: "Wallpaper", keywords: "background picture image" },
  { page: "appearance", pageTitle: "Appearance", label: "Icon size", keywords: "desktop grid small large" },
  { page: "apps", pageTitle: "Apps", label: "Default apps", keywords: "open with file types extension default opener" },
  { page: "apps", pageTitle: "Apps", label: "Installed apps", keywords: "uninstall list filesystem apps" },
  { page: "apps", pageTitle: "Apps", label: "App Store catalog", keywords: "store.json url source repo" },
  { page: "trash", pageTitle: "Trash", label: "Trash passphrase", keywords: "password lock bin delete" },
  { page: "trash", pageTitle: "Trash", label: "Empty the trash", keywords: "clear wipe bin" },
  { page: "engine", pageTitle: "Engine", label: "CheerpX hoster URL", keywords: "terminal linux bridge cheerpx" },
  { page: "engine", pageTitle: "Engine", label: "Where the engine runs", keywords: "embedded tab separate isolation" },
  { page: "v86", pageTitle: "v86", label: "Guest filesystem", keywords: "linux root unpack reset distro" },
  { page: "v86", pageTitle: "v86", label: "v86 network", keywords: "relay wisp network internet" },
  { page: "storage", pageTitle: "Storage", label: "Disk usage", keywords: "space quota bytes indexeddb" },
  { page: "storage", pageTitle: "Storage", label: "Factory reset", keywords: "erase wipe delete everything" },
  { page: "about", pageTitle: "About", label: "System information", keywords: "version build vendor engines" },
];

export function openSettings(win: Win, startPage?: string): void {
  const root = el("div", "app-root");
  const status = el("div", "app-statusbar", "Dragon86 · stored locally in your browser");

  const shell = el("div", "settings-shell");
  const nav = el("div", "settings-nav");
  const navScroll = el("div", "settings-nav-scroll");
  nav.append(navScroll);
  const pane = el("div", "settings-pane");

  const searchWrap = el("div", "settings-search");
  searchWrap.innerHTML = icon("search").innerHTML;
  const searchInput = el("input", "input");
  searchInput.type = "search";
  searchInput.placeholder = "Search settings";
  searchInput.spellcheck = false;
  searchWrap.append(searchInput);

  const content = el("div", "settings-content");
  const header = el("div", "settings-header");
  header.append(el("h1", undefined, "Settings"), searchWrap);
  pane.append(header, content);

  shell.append(nav, pane);
  root.append(shell, status);
  win.el.append(root);

  let current = startPage ?? "appearance";

  /* ---------- pages ---------- */

  const pages: Page[] = [
    {
      id: "appearance",
      title: "Appearance",
      icon: "wallpaper",
      group: "Personal",
      keywords: "theme colour wallpaper icons",
      render: renderAppearance,
    },
    {
      id: "apps",
      title: "Apps",
      icon: "store",
      group: "Apps",
      keywords: "default apps installed store",
      render: renderApps,
    },
    {
      id: "trash",
      title: "Trash",
      icon: "trash",
      group: "Apps",
      keywords: "trash password lock bin",
      render: renderTrash,
    },
    {
      id: "engine",
      title: "Engine",
      icon: "terminal",
      group: "System",
      keywords: "cheerpx terminal hoster isolation",
      render: renderEngine,
    },
    {
      id: "v86",
      title: "v86 Linux",
      icon: "linux",
      group: "System",
      keywords: "linux guest filesystem network relay",
      render: renderV86,
    },
    {
      id: "storage",
      title: "Storage",
      icon: "save",
      group: "System",
      keywords: "disk space reset wipe",
      render: renderStorage,
    },
    {
      id: "about",
      title: "About",
      icon: "info",
      group: "System",
      keywords: "version build facts",
      render: renderAbout,
    },
  ];

  function renderNav(): void {
    navScroll.textContent = "";
    let group = "";
    for (const page of pages) {
      if (page.group !== group) {
        group = page.group;
        navScroll.append(el("div", "settings-nav-group", group));
      }
      const b = el("button", `settings-nav-item ${page.id === current ? "active" : ""}`.trim());
      b.innerHTML = icon(page.icon).outerHTML;
      b.append(el("span", undefined, page.title));
      b.addEventListener("click", () => {
        current = page.id;
        searchInput.value = "";
        renderNav();
        renderPage();
      });
      navScroll.append(b);
    }
  }

  function renderPage(hits?: SearchHit[]): void {
    content.textContent = "";
    content.scrollTop = 0;

    if (hits) {
      content.append(el("h2", "settings-page-title", `${hits.length} result${hits.length === 1 ? "" : "s"}`));
      if (!hits.length) {
        content.append(note("Nothing matches that. Try “theme”, “default apps” or “trash”."));
        return;
      }
      const list = el("div", "settings-results");
      for (const hit of hits) {
        const row = el("button", "settings-result");
        row.append(el("strong", undefined, hit.label), el("span", undefined, hit.pageTitle));
        row.addEventListener("click", () => {
          current = hit.page;
          searchInput.value = "";
          renderNav();
          renderPage();
          /* A result is a promise: land on the page with the control visible. */
          setTimeout(() => {
            const target = content.querySelector<HTMLElement>(`[data-setting="${hit.label}"]`);
            target?.scrollIntoView({ block: "center", behavior: "smooth" });
            target?.classList.add("flash");
          }, 60);
        });
        list.append(row);
      }
      content.append(list);
      return;
    }

    const page = pages.find((p) => p.id === current) ?? pages[0]!;
    const wrap = el("div", "settings-page");
    wrap.append(el("h2", "settings-page-title", page.title));
    page.render(wrap);
    content.append(wrap);
    win.setTitle(`Settings — ${page.title}`);
    status.textContent = "Dragon86 · stored locally in your browser";
  }

  /* ---------- Appearance ---------- */

  function renderAppearance(host: HTMLElement): void {
    host.append(section("Theme", "The colours every window, menu and control uses."));
    const themeGrid = el("div", "theme-grid");
    for (const t of THEMES) {
      const card = el("div", "theme-card");
      const swatch = el("div", "theme-swatch");
      swatch.style.background = t.swatch;
      card.append(swatch, el("div", "name", t.name));
      if (getSettings().theme === t.id) card.classList.add("selected");
      card.addEventListener("click", () => {
        setSettings({ theme: t.id as ThemeId });
        themeGrid.querySelectorAll(".theme-card").forEach((n) => n.classList.remove("selected"));
        card.classList.add("selected");
      });
      themeGrid.append(card);
    }
    host.append(themeGrid);

    host.append(section("Wallpaper", "Applies behind your desktop icons."));
    const wallGrid = el("div", "wall-grid");
    for (const w of WALLPAPERS) {
      const thumb = el("div", "wall-thumb");
      thumb.title = w.name;
      thumb.dataset.setting = "Wallpaper";
      if (w.id === "ember" || w.id === "obsidian") thumb.style.backgroundImage = `var(--wall-${w.id})`;
      else thumb.style.background = w.css;
      if (getSettings().wallpaper === w.id) thumb.classList.add("selected");
      thumb.addEventListener("click", () => {
        setSettings({ wallpaper: w.id });
        wallGrid.querySelectorAll(".wall-thumb").forEach((n) => n.classList.remove("selected"));
        thumb.classList.add("selected");
      });
      wallGrid.append(thumb);
    }
    host.append(wallGrid);

    host.append(section("Desktop", "How much room each icon takes on the grid."));
    const row = el("div", "settings-row");
    row.dataset.setting = "Icon size";
    row.append(el("label", undefined, "Icon size"));
    const choices: { id: "small" | "medium" | "large"; label: string }[] = [
      { id: "small", label: "Small" },
      { id: "medium", label: "Medium" },
      { id: "large", label: "Large" },
    ];
    const seg = el("div", "segmented");
    for (const choice of choices) {
      const b = el("button", `seg ${getSettings().iconSize === choice.id ? "active" : ""}`.trim(), choice.label);
      b.addEventListener("click", () => {
        setSettings({ iconSize: choice.id });
        seg.querySelectorAll(".seg").forEach((n) => n.classList.remove("active"));
        b.classList.add("active");
      });
      seg.append(b);
    }
    row.append(seg);
    host.append(row);
    host.append(note("Icons snap to the grid; drag one anywhere and the drop finds the nearest free cell. “Tidy up icons” on the desktop menu resets the arrangement."));
  }

  /* ---------- Apps ---------- */

  function renderApps(host: HTMLElement): void {
    host.append(
      section(
        "Default apps",
        "What opens each file type when you double-click it. An installed app that declares a type can ask to become its default — this is where you change your mind.",
      ),
    );

    const table = el("div", "defaults-table");
    let redraw = (): void => {};
    const refresh = (): void => {
      redraw();
    };

    redraw = () => {
      table.textContent = "";
      const exts = new Set<string>();
      for (const app of fsAppsWithOpens()) for (const ext of app.opens) exts.add(ext);
      for (const ext of ["txt", "json", "html", "nes", "png", "mp4"]) exts.add(ext);

      if (![...exts].length) {
        table.append(note("No app has claimed a file type yet. Install one from the App Store and it may ask."));
        return;
      }

      for (const ext of [...exts].sort()) {
        const row = el("div", "defaults-row");
        row.append(el("code", "defaults-ext", `.${ext}`));

        const select = el("select", "input defaults-select");
        const candidates = [
          { id: BUILTIN.editor, name: "Text Editor (built-in)" },
          { id: BUILTIN.system, name: "System (built-in viewer)" },
          ...appOpeners(ext).map((o) => ({ id: o.id, name: o.name })),
        ];
        const seen = new Set<string>();
        for (const candidate of candidates) {
          if (seen.has(candidate.id)) continue;
          seen.add(candidate.id);
          const option = el("option", undefined, candidate.name);
          option.value = candidate.id;
          select.append(option);
        }
        const chosen = defaultFor(ext) ?? "";
        select.value = chosen;
        select.addEventListener("change", async () => {
          await setDefault(ext, select.value || null);
        });
        row.append(select);

        const tag = el(
          "span",
          "defaults-tag",
          appOpeners(ext).some((o) => o.id === chosen) ? "app" : "built-in",
        );
        row.append(tag);
        table.append(row);
      }
    };
    refresh();
    host.append(table);

    const askRow = el("div", "settings-row");
    askRow.dataset.setting = "Default apps";
    const askBtn = el("button", "btn", "Let apps ask again");
    askBtn.title = "Clears the record of which apps have already asked to open a file type";
    askBtn.addEventListener("click", async () => {
      await resetAsked();
      askBtn.textContent = "Done ✓";
      setTimeout(() => (askBtn.textContent = "Let apps ask again"), 1400);
    });
    askRow.append(askBtn);
    host.append(askRow);

    host.append(
      section(
        "Installed apps",
        "Everything in ~/system/apps, with the types it opens — plus the fixed apps that ship with the OS.",
      ),
    );
    const listHost = el("div", "app-list");
    const redrawList = (): void => {
      listHost.textContent = "";
      /* Two kinds of app appear here: folders in ~/system/apps, and the fixed
         pages that come with the OS (iframe-apps.json) — Preview is one of
         those now, so it has no folder and no uninstall button, but it still
         deserves a desktop switch. */
      const fixed = staticIframeApps().map((def) => ({
        id: def.id,
        name: def.name,
        sub: def.sub ?? "Fixed app — ships with Dragon86",
        icon: def.icon,
        opens: def.opens ?? [],
        onDesktop: def.onDesktop ?? true,
        dir: null as string | null,
      }));
      const apps = [...fixed, ...getFsApps()];
      if (!apps.length) {
        listHost.append(note("No filesystem apps yet — the App Store has some."));
        return;
      }
      for (const app of apps) {
        const row = el("div", "app-list-row");
        row.append(icon(app.icon, "app-list-icon"));
        const text = el("div", "app-list-text");
        text.append(el("strong", undefined, app.name), el("span", undefined, app.sub || app.id));
        row.append(text);
        if (app.opens.length) {
          row.append(el("span", "app-list-opens", app.opens.map((o) => `.${o}`).join(" ")));
        }
        row.append(
          el(
            "code",
            "app-list-dir",
            app.dir ? app.dir.replace(vfs.HOME, "~") : "fixed page",
          ),
        );

        /* An app and a desktop icon are separate things: this is where you
           say which apps earn a shortcut, without uninstalling anything. */
        const shown = onDesktop(app.id, app.onDesktop);
        const toggle = el("button", "btn sm app-list-desktop", shown ? "On desktop" : "Off desktop");
        toggle.title = shown
          ? "Remove this app's icon from the desktop (the app stays installed)"
          : "Put this app's icon on the desktop";
        toggle.setAttribute("aria-pressed", String(shown));
        toggle.addEventListener("click", async () => {
          await setOnDesktop(app.id, !shown);
          redrawList();
        });
        row.append(toggle);
        listHost.append(row);
      }
    };
    void loadDesktopPrefs().then(redrawList);
    redrawList();
    const off = onFsAppsChange(redrawList);
    win.setOnClose(off);
    host.append(listHost);

    host.append(section("App Store", "Where the store reads its catalog from."));
    const storeRow = el("div", "settings-row");
    storeRow.dataset.setting = "App Store catalog";
    storeRow.append(el("label", undefined, "Catalog"));
    const storeInput = el("input", "input");
    storeInput.placeholder = "store.json next to the OS";
    storeInput.value = getSettings().storeUrl;
    const saveStore = el("button", "btn", "Save");
    saveStore.addEventListener("click", () => {
      setSettings({ storeUrl: storeInput.value.trim() });
      storeInput.value = getSettings().storeUrl;
      saveStore.textContent = "Saved ✓";
      setTimeout(() => (saveStore.textContent = "Save"), 1400);
    });
    storeRow.append(storeInput, saveStore);
    host.append(storeRow);
    host.append(
      note(
        "Leave it empty to use store.json beside Dragon86. It can be any URL or relative path that returns { \"apps\": [ … ] } — the store installs each app's listed files into system/apps/.",
      ),
    );
  }

  /* ---------- Trash ---------- */

  function renderTrash(host: HTMLElement): void {
    host.append(
      section(
        "Trash",
        "Deleting a file moves it to ~/trash instead of destroying it. The trash is emptied every time Dragon86 is opened, and it is locked: opening it needs a passphrase you set here.",
      ),
    );

    const count = el("div", "settings-note", "Counting…");
    void trashCount().then((n) => {
      count.textContent = n
        ? `${n} item${n === 1 ? "" : "s"} in the trash right now.`
        : "The trash is empty.";
    });

    const pwRow = el("div", "settings-row");
    pwRow.dataset.setting = "Trash passphrase";
    pwRow.append(el("label", undefined, "Passphrase"));
    const statusText = el("span", "settings-note", hasPassword() ? "Set" : "Not set yet");
    const setBtn = el("button", "btn", hasPassword() ? "Change" : "Set a passphrase");
    setBtn.addEventListener("click", async () => {
      if (hasPassword()) {
        const current = await showInput("Trash passphrase", "Enter your current passphrase:", "");
        if (current === null) return;
        if (!(await checkPassword(current))) {
          statusText.textContent = "That was not it — nothing changed.";
          return;
        }
      }
      const next = await showInput(
        "Trash passphrase",
        "New passphrase. It is stored as a hash on this device only; there is no recovery.",
        "",
      );
      if (!next || next.length < 3) {
        statusText.textContent = "Too short — nothing changed.";
        return;
      }
      await setPassword(next);
      statusText.textContent = "Set";
      logInfo("os", "trash passphrase updated");
    });
    pwRow.append(statusText, setBtn);
    host.append(pwRow);

    const emptyRow = el("div", "settings-row");
    emptyRow.dataset.setting = "Empty the trash";
    const emptyBtn = el("button", "btn danger", "Empty the trash now");
    emptyBtn.addEventListener("click", async () => {
      const ok = await showConfirm("Empty the trash", "Delete everything in the trash for good?", true);
      if (!ok) return;
      const n = await emptyTrash();
      count.textContent = n ? "Emptied." : "It was already empty.";
    });
    emptyRow.append(emptyBtn);
    host.append(emptyRow);
    host.append(count);
    host.append(
      note(
        `Files live in ${TRASH}. Anything in it disappears on the next page load, whether you emptied it or not.`,
      ),
    );
  }

  /* ---------- Engine (CheerpX) ---------- */

  function renderEngine(host: HTMLElement): void {
    host.append(section("CheerpX hoster", "The page that runs the Linux engine, and the URL the Terminal talks to."));
    const row = el("div", "settings-row");
    row.dataset.setting = "CheerpX hoster URL";
    row.append(el("label", undefined, "Hoster URL"));
    const hosterInput = el("input", "input");
    hosterInput.placeholder = DEFAULT_HOSTER_URL;
    hosterInput.value = getSettings().hosterUrl;
    const saveHost = el("button", "btn", "Save");
    saveHost.addEventListener("click", () => {
      setSettings({ hosterUrl: hosterInput.value.trim() });
      hosterInput.value = getSettings().hosterUrl;
      refreshEffective();
      saveHost.textContent = "Saved ✓";
      setTimeout(() => (saveHost.textContent = "Save"), 1400);
    });
    const defaultHost = el("button", "btn", "Use default");
    defaultHost.addEventListener("click", () => {
      setSettings({ hosterUrl: "" });
      hosterInput.value = "";
      refreshEffective();
    });
    row.append(hosterInput, saveHost, defaultHost);
    const effective = el("div", "settings-note");
    const refreshEffective = (): void => {
      const custom = getSettings().hosterUrl.trim();
      effective.textContent = custom ? `Using ${custom}` : `Using ${DEFAULT_HOSTER_URL}`;
    };
    refreshEffective();
    host.append(row, effective);

    host.append(section("Where it runs", "Isolation is decided when the page loads, so changing this reloads Dragon86."));
    const modeRow = el("div", "settings-row");
    modeRow.dataset.setting = "Where the engine runs";
    modeRow.append(el("label", undefined, "Mode"));
    const modes: { id: "embedded" | "tab" | "v86"; label: string; blurb: string }[] = [
      { id: "embedded", label: "Embedded", blurb: "CheerpX inside this page. Needs cross-origin isolation." },
      { id: "tab", label: "Separate tab", blurb: "CheerpX in its own tab; this page stays unrestricted." },
      { id: "v86", label: "v86", blurb: "A small Linux that runs right here, no isolation at all." },
    ];
    const seg = el("div", "segmented");
    const noteEl = el("div", "settings-note");
    const applyMode = (mode: "embedded" | "tab" | "v86", reload: boolean): void => {
      if (getSettings().engineMode !== mode) setSettings({ engineMode: mode });
      seg.querySelectorAll(".seg").forEach((n) => n.classList.remove("active"));
      seg.querySelector(`[data-mode="${mode}"]`)?.classList.add("active");
      noteEl.textContent = modes.find((m) => m.id === mode)?.blurb ?? "";
      if (!reload) return;
      noteEl.textContent += " Reloading…";
      /* Leaving isolation needs the worker gone before the reload, or the
         reloaded page is still controlled and still carries COOP/COEP. */
      if (mode === "embedded") {
        setTimeout(() => location.reload(), 700);
        return;
      }
      const sw = navigator.serviceWorker;
      const drop =
        sw && typeof sw.getRegistrations === "function"
          ? sw.getRegistrations().then((regs) => Promise.all(regs.map((r) => r.unregister())))
          : Promise.resolve();
      void drop.catch(() => {}).then(() => setTimeout(() => location.reload(), 400));
    };
    for (const mode of modes) {
      const b = el("button", `seg ${getSettings().engineMode === mode.id ? "active" : ""}`.trim(), mode.label);
      b.dataset.mode = mode.id;
      b.addEventListener("click", () => applyMode(mode.id, getSettings().engineMode !== mode.id));
      seg.append(b);
    }
    noteEl.textContent = modes.find((m) => m.id === getSettings().engineMode)?.blurb ?? "";
    modeRow.append(seg);
    host.append(modeRow, noteEl);
  }

  /* ---------- v86 ---------- */

  function renderV86(host: HTMLElement): void {
    host.append(
      section(
        "Guest filesystem",
        "The guest's / is ~/v86 in your files, unpacked from the vendored kernel and initramfs. Everything the distro runs is a file you can open here.",
      ),
    );
    const info = el("div", "settings-note");
    const refreshRoot = async (): Promise<void> => {
      const data = await guestRootInfo(vfs.ENGINE_ROOT.v86);
      info.textContent = data
        ? `${data.files.toLocaleString()} files, unpacked ${new Date(data.at).toLocaleString()}. /Documents, /Downloads and /Desktop inside the guest are your own folders.`
        : "Not unpacked yet — it happens the first time the Terminal connects.";
    };
    void refreshRoot();
    host.append(info);

    const row = el("div", "settings-row");
    row.dataset.setting = "Guest filesystem";
    const reseedBtn = el("button", "btn", "Re-unpack the distro");
    reseedBtn.title = "Extract the distro into ~/v86 again on the next boot";
    reseedBtn.addEventListener("click", () => {
      void resetGuestRoot(vfs.ENGINE_ROOT.v86).then(async () => {
        await refreshRoot();
        info.textContent = "It will be unpacked again the next time the Terminal connects.";
      });
    });
    row.append(reseedBtn);
    host.append(row);

    host.append(section("Network", "The emulated network card inside the guest."));
    const netRow = el("div", "settings-row");
    netRow.dataset.setting = "v86 network";
    netRow.append(el("label", undefined, "Relay"));
    const netInput = el("input", "input");
    netInput.placeholder = "wss://relay.widgetry.org/";
    netInput.value = getSettings().v86Network;
    const saveNet = el("button", "btn", "Save");
    saveNet.addEventListener("click", () => {
      setSettings({ v86Network: netInput.value.trim() });
      netInput.value = getSettings().v86Network;
      saveNet.textContent = "Saved ✓";
      setTimeout(() => (saveNet.textContent = "Save"), 1400);
    });
    const offNet = el("button", "btn", "Off");
    offNet.addEventListener("click", () => {
      setSettings({ v86Network: "off" });
      netInput.value = "off";
    });
    const testNet = el("button", "btn", "Test");
    const netResult = el("div", "settings-note");
    testNet.addEventListener("click", () => {
      testNet.disabled = true;
      netResult.textContent = `Checking ${relayBackendName(getSettings().v86Network)} relay…`;
      void probeRelay(getSettings().v86Network)
        .then((r) => {
          netResult.textContent = `${r.message} (${r.ms} ms)`;
        })
        .catch((err) => {
          netResult.textContent = `Failed: ${(err as Error).message}`;
        })
        .finally(() => {
          testNet.disabled = false;
        });
    });
    netRow.append(netInput, saveNet, offNet, testNet);
    host.append(netRow, netResult);
    host.append(note("The guest only has loopback unless a relay is set. In the guest, /networking.sh brings the card up."));
  }

  /* ---------- Storage ---------- */

  function renderStorage(host: HTMLElement): void {
    host.append(section("Disk", "Your files live in this browser's IndexedDB — no account, no server."));
    const usage = el("div", "settings-note", "Measuring…");
    host.append(usage);
    void (async () => {
      try {
        const estimate = await navigator.storage?.estimate?.();
        if (!estimate) {
          usage.textContent = "This browser does not report disk usage.";
          return;
        }
        const used = estimate.usage ?? 0;
        const quota = estimate.quota ?? 0;
        usage.textContent = quota
          ? `${formatBytes(used)} used of ${formatBytes(quota)} available (${Math.round((used / quota) * 100)}%).`
          : `${formatBytes(used)} used.`;
        if (quota) {
          const bar = el("div", "usage-bar");
          const fill = el("div", "usage-fill");
          fill.style.width = `${Math.min(100, Math.round((used / quota) * 100))}%`;
          bar.append(fill);
          usage.after(bar);
        }
      } catch {
        usage.textContent = "This browser does not report disk usage.";
      }
    })();

    host.append(section("Danger zone", "This cannot be undone."));
    const row = el("div", "settings-row");
    row.dataset.setting = "Factory reset";
    const resetBtn = el("button", "btn danger", "Factory reset");
    resetBtn.addEventListener("click", async () => {
      const ok = await showConfirm(
        "Factory reset",
        "Erase the virtual hard drive and all settings? This cannot be undone.",
        true,
      );
      if (ok) await vfs.factoryReset();
    });
    row.append(resetBtn);
    host.append(row);
    host.append(note("Wipes the filesystem (browser storage) and every Dragon86 setting, then reloads."));
  }

  /* ---------- About ---------- */

  function renderAbout(host: HTMLElement): void {
    host.append(section("About this machine", "What you are looking at."));
    const table = el("table", "about-table");
    const facts: [string, string][] = [
      ["OS", "Dragon86 0.15.0 (dev build)"],
      ["Vendor", "Dragon Gaming Platforms"],
      ["Engines", "CheerpX (embedded / separate tab) · v86 (guest whose / is ~/v86)"],
      ["Filesystem", "ZenFS · IndexedDB + /tmp in memory"],
      ["Storage", "Local to this browser — no account, no server"],
      [
        "Isolation",
        window.crossOriginIsolated
          ? "ON — COOP/COEP from the coi service worker"
          : "off — not needed by the current engine",
      ],
      [
        "Service worker",
        navigator.serviceWorker?.controller
          ? `controlling this page (${navigator.serviceWorker.controller.scriptURL.split("/").pop()})`
          : "not controlling this page",
      ],
      ["Filesystem apps", `${getFsApps().length} installed`],
      ["Themes", THEMES.map((t) => t.name).join(", ")],
      ["Terminal", "xterm.js 6 · bridge protocol v1"],
    ];
    for (const [k, v] of facts) {
      const tr = el("tr");
      tr.append(el("td", undefined, k), el("td", undefined, v));
      table.append(tr);
    }
    host.append(table);
  }

  /* ---------- shared bits ---------- */

  function section(title: string, blurb: string): HTMLElement {
    const box = el("div", "settings-section");
    box.append(el("h2", undefined, title), el("p", "settings-blurb", blurb));
    return box;
  }

  function note(text: string): HTMLElement {
    return el("div", "settings-note", text);
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
  }

  /* ---------- search ---------- */

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      renderPage();
      return;
    }
    const hits = SEARCH_INDEX.filter((hit) =>
      `${hit.label} ${hit.pageTitle} ${hit.keywords}`.toLowerCase().includes(q),
    );
    renderPage(hits);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      renderPage();
    }
  });

  void loadDefaults();
  /* Deep links (Settings → Default apps from a file's menu) land on a page. */
  if (startPage && pages.some((p) => p.id === startPage)) current = startPage;
  renderNav();
  renderPage();
}
