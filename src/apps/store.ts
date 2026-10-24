/**
 * App Store — browse a catalog file and install apps into your filesystem.
 *
 * The catalog is a plain `store.json` next to the OS (or anywhere, via
 * Settings → App Store). Every entry lists its own files, and installing is
 * just: fetch each file, write it to `~/system/apps/<id>/`, then add the
 * entry to `user-apps.json`. That is the same shape the OS already uses for
 * bundled apps, so an installed app is an ordinary folder you can open,
 * edit, back up in Files, or delete from the Files app.
 *
 * The store is deliberately a normal app, not a privileged one: it has no
 * way to write outside `~/system/apps`, and everything it does is visible in
 * that folder afterwards.
 */

import { el, icon } from "../core/dom";
import * as vfs from "../core/vfs";
import { logInfo, logWarn } from "../core/log";
import { getSettings } from "../core/settings";
import { notify } from "../core/toast";
import { showConfirm } from "../core/dialog";
import { clearDefaultsForApp, requestDefaults } from "../core/filetypes";
import { refreshDesktops } from "../core/desktop";
import {
  APPS_DIRS,
  getFsApps,
  reloadFsApps,
  removeAppEntry,
  upsertAppEntry,
  normExt,
} from "../core/fs-apps";
import type { Win } from "../core/wm";

const BASE = import.meta.env.BASE_URL;

/**
 * One catalog entry. Nothing here is a statistic: the store used to show a
 * star rating, a review count and a download count, and every one of those
 * numbers was made up. A local catalog has no users to average, so it shows
 * only what can be checked — the publisher, the category, the files that get
 * written, and the real byte count of those files, measured when you open the
 * listing.
 */
interface StoreApp {
  id: string;
  name: string;
  sub?: string;
  category?: string;
  publisher?: string;
  icon?: string;
  base?: string;
  entry?: string;
  files?: string[];
  opens?: string[];
  width?: number;
  height?: number;
  description?: string;
  /** True for an app found on disk that the catalog does not list. */
  local?: boolean;
}

interface Catalog {
  name?: string;
  apps: StoreApp[];
}

type Tab = "home" | "apps" | "games" | "installed";

export function openStore(win: Win): void {
  const root = el("div", "app-root");
  const status = el("div", "app-statusbar", "App Store");

  /* ---- top bar: brand + search ---- */
  const top = el("div", "store-top");
  const brand = el("div", "store-brand");
  brand.innerHTML = `${icon("store").outerHTML}<div><strong>App Store</strong><span>Dragon86</span></div>`;
  const search = el("div", "store-search");
  search.innerHTML = icon("search").innerHTML;
  const searchInput = el("input", "input");
  searchInput.type = "search";
  searchInput.placeholder = "Search apps";
  searchInput.spellcheck = false;
  search.append(searchInput);
  top.append(brand, search);

  /* ---- body: sidebar + content ---- */
  const body = el("div", "store-body");
  const side = el("div", "store-side");
  const content = el("div", "store-content");
  body.append(side, content);
  root.append(top, body, status);
  win.el.append(root);

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "home", label: "Home", icon: "home" },
    { id: "apps", label: "Apps", icon: "grid" },
    { id: "games", label: "Games", icon: "games" },
    { id: "installed", label: "Installed", icon: "check" },
  ];

  let tab: Tab = "home";
  let query = "";
  let catalog: Catalog | null = null;
  let loadError = "";
  /** Apps found on disk that the catalog does not mention (installed by hand). */
  let localApps: StoreApp[] = [];
  /** id → done/total while an install is running. */
  const progress = new Map<string, { done: number; total: number }>();
  const installedIds = new Set<string>();

  async function catalogUrl(): Promise<string> {
    const custom = getSettings().storeUrl.trim();
    return new URL(custom || `${BASE}store.json`, window.location.href).href;
  }

  async function loadCatalog(): Promise<void> {
    content.textContent = "";
    content.append(spinner("Loading the catalog…"));
    try {
      const url = await catalogUrl();
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = (await res.json()) as Catalog;
      if (!Array.isArray(parsed.apps)) throw new Error("store.json has no apps array");
      catalog = parsed;
      loadError = "";
      logInfo("store", `catalog loaded: ${parsed.apps.length} apps from ${url}`);
    } catch (err) {
      catalog = null;
      loadError =
        `Could not read the store catalog (${(err as Error).message}). ` +
        `Expected store.json next to Dragon86, or a URL set in Settings → App Store.`;
      logWarn("store", "catalog failed:", err);
    }
    await refreshInstalled();
    render();
  }

  /**
   * Work out what is actually installed, from the two places that can know:
   * the registry (user-apps.json) and the disk itself. An app can be in
   * either without the other — a folder dropped in with Files has no entry,
   * and an entry can outlive its folder — and the Installed tab has to be
   * honest about both, because that list is what you can uninstall from.
   */
  async function refreshInstalled(): Promise<void> {
    installedIds.clear();
    localApps = [];
    const byId = new Map(getFsApps().map((a) => [a.id, a]));

    for (const app of byId.values()) installedIds.add(app.id);
    for (const app of catalog?.apps ?? []) {
      if (await vfs.exists(`${APPS_DIRS[0]}/${app.id}/${app.entry ?? "index.html"}`)) {
        installedIds.add(app.id);
      }
    }

    /* Folders with no catalog listing and no registry entry. */
    const known = new Set((catalog?.apps ?? []).map((a) => a.id));
    let names: vfs.Entry[] = [];
    try {
      names = await vfs.listDir(APPS_DIRS[0]);
    } catch {
      names = [];
    }
    for (const entry of names) {
      if (!entry.isDirectory || known.has(entry.name)) continue;
      const registered = byId.get(entry.name);
      const hasEntry = await vfs.exists(`${entry.path}/index.html`);
      if (!registered && !hasEntry) continue;
      installedIds.add(entry.name);
      if (registered) continue; /* the catalog card covers it */
      localApps.push({
        id: entry.name,
        name: prettyName(entry.name),
        sub: "Installed on this device",
        category: "Installed",
        publisher: "Local",
        icon: "grid",
        entry: "index.html",
        description:
          "This folder was added to system/apps directly rather than installed from the catalog, so the store knows nothing else about it. Uninstalling removes the folder and any registry entry that points at it.",
        local: true,
      });
    }
  }

  function prettyName(id: string): string {
    return id
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Catalog apps plus anything found only on disk. */
  function allApps(): StoreApp[] {
    return [...(catalog?.apps ?? []), ...localApps];
  }

  /* ---------- rendering ---------- */

  function renderSide(): void {
    side.textContent = "";
    for (const t of tabs) {
      const b = el("button", `store-tab ${tab === t.id ? "active" : ""}`.trim());
      b.innerHTML = icon(t.icon).outerHTML;
      b.append(el("span", undefined, t.label));
      if (t.id === "installed") {
        const count = installedIds.size;
        if (count) b.append(el("span", "store-count", String(count)));
      }
      b.addEventListener("click", () => {
        tab = t.id;
        query = "";
        searchInput.value = "";
        /* The Installed list is a *disk* question, and the disk can change
           while this window is open (an install, a folder dropped in with
           Files). Re-scan before showing it. */
        if (t.id === "installed") void refreshInstalled().then(render);
        else render();
      });
      side.append(b);
    }
    const foot = el("div", "store-side-foot");
    foot.textContent = catalog
      ? `${catalog.apps.length} app${catalog.apps.length === 1 ? "" : "s"} in ${catalog.name ?? "this catalog"}`
      : "Offline catalog";
    side.append(foot);
  }

  function visibleApps(): StoreApp[] {
    const apps = allApps();
    const q = query.trim().toLowerCase();
    return apps.filter((app) => {
      if (tab === "installed" && !installedIds.has(app.id)) return false;
      if (tab === "games" && (app.category ?? "").toLowerCase() !== "games") return false;
      if (tab === "apps" && (app.category ?? "").toLowerCase() === "games") return false;
      if (!q) return true;
      return `${app.name} ${app.sub ?? ""} ${app.publisher ?? ""} ${app.category ?? ""}`
        .toLowerCase()
        .includes(q);
    });
  }

  function render(): void {
    renderSide();
    content.textContent = "";
    content.scrollTop = 0;

    if (loadError) {
      const box = el("div", "store-error");
      box.append(icon("info"), el("p", undefined, loadError));
      const retry = el("button", "btn", "Try again");
      retry.addEventListener("click", () => void loadCatalog());
      box.append(retry);
      content.append(box);
      return;
    }
    if (!catalog) return;

    const list = visibleApps();

    if (tab === "home" && !query) {
      /* No "featured" list and no "top picks this week": the catalog has no
         way to know what is popular, so it just shows what it has, in the
         order it lists it. */
      const first = catalog.apps[0];
      if (first) content.append(featured(first));
      const row = el("div", "store-row");
      row.append(el("h2", "store-h2", `Everything in ${catalog.name ?? "the catalog"}`));
      const grid = el("div", "store-grid");
      for (const app of list) grid.append(card(app));
      row.append(grid);
      content.append(row);
      content.append(
        el(
          "p",
          "store-muted store-note",
          "This catalog is a file that ships with Dragon86, not a server. There are no star ratings, review counts or download counts here — nobody is generating them, so the store does not print them. What it does show is checkable: the publisher, the files that get written, and the measured size of the download.",
        ),
      );
      return;
    }

    const head = el("div", "store-row-head");
    head.append(
      el(
        "h2",
        "store-h2",
        query
          ? `Results for “${query}”`
          : tab === "installed"
            ? "Your apps"
            : tab === "games"
              ? "Games"
              : "All apps",
      ),
    );
    head.append(el("span", "store-muted", `${list.length} app${list.length === 1 ? "" : "s"}`));
    content.append(head);

    if (!list.length) {
      const empty = el("div", "store-empty");
      empty.append(icon(tab === "installed" ? "downloadCloud" : "search"));
      empty.append(
        el(
          "p",
          undefined,
          tab === "installed"
            ? "Nothing installed yet. Anything you install from here becomes a normal folder in system/apps."
            : "No app matches that. Try a shorter search.",
        ),
      );
      content.append(empty);
      return;
    }

    const grid = el("div", "store-grid");
    for (const app of list) grid.append(card(app));
    content.append(grid);
  }

  function featured(app: StoreApp): HTMLElement {
    const box = el("div", "store-feature");
    const left = el("div", "store-feature-text");
    left.append(
      el("div", "store-eyebrow", "Start here"),
      el("h2", undefined, app.name),
      el("p", undefined, app.description ?? app.sub ?? ""),
    );
    const actions = el("div", "store-feature-actions");
    actions.append(appActions(app, true));
    box.append(left, icon(app.icon ?? "store", "store-feature-icon"));
    box.append(actions);
    box.addEventListener("dblclick", () => openDetail(app));
    return box;
  }

  function card(app: StoreApp): HTMLElement {
    const node = el("div", "store-card");
    const head = el("div", "store-card-head");
    head.append(icon(app.icon ?? "grid", "store-app-icon"));
    const title = el("div", "store-card-title");
    title.append(el("strong", undefined, app.name), el("span", undefined, app.sub ?? ""));
    head.append(title);
    node.append(head);

    const meta = el("div", "store-card-meta");
    meta.append(el("span", undefined, app.category ?? "App"));
    if (app.local) meta.append(el("span", "store-dot", "·"), el("span", undefined, "Installed here"));
    else {
      const count = app.files?.length ?? 0;
      if (count) {
        meta.append(
          el("span", "store-dot", "·"),
          el("span", undefined, `${count} file${count === 1 ? "" : "s"}`),
        );
      }
    }
    node.append(meta);

    const foot = el("div", "store-card-foot");
    foot.append(appActions(app, false));
    node.append(foot);

    node.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      openDetail(app);
    });
    return node;
  }

  /**
   * The real size of the download, in bytes, measured from the files the
   * catalog says it will fetch. Shown on the detail page because it costs one
   * request per file, and a card grid should not fire off a dozen of them.
   */
  async function measureBytes(app: StoreApp): Promise<number | null> {
    const files = app.files ?? [];
    if (!files.length) return null;
    const base = new URL(app.base ?? `${app.id}/`, catalogBase());
    try {
      let total = 0;
      for (const file of files) {
        const res = await fetch(new URL(file, base).href, { cache: "no-cache" });
        if (!res.ok) return null;
        total += (await res.arrayBuffer()).byteLength;
      }
      return total;
    } catch {
      return null;
    }
  }

  function humanBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * The install / open / uninstall controls for one app.
   *
   * Installed apps always get two buttons — "Open" and "Uninstall" — because
   * a single button that changes meaning ("Installed" that actually deletes
   * things) is a trap. Uninstalling is permanent: the folder is deleted, not
   * trashed, and the entry is taken out of user-apps.json.
   */
  function appActions(app: StoreApp, large: boolean): HTMLElement {
    const wrap = el("div", `store-actions ${large ? "lg" : "sm"}`.trim());
    const state = progress.get(app.id);
    const installed = installedIds.has(app.id);
    const size = large ? "" : "sm";

    if (state) {
      const busy = el("button", `btn ${size}`.trim(), `Installing… ${state.done}/${state.total}`);
      busy.disabled = true;
      wrap.append(busy);
      return wrap;
    }

    if (installed) {
      const openBtn = el("button", `btn ${size} ghost`.trim(), "Open");
      openBtn.title = `Open ${app.name}`;
      openBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent("d86-launch-app", { detail: app.id }));
      });
      const removeBtn = el("button", `btn ${size} danger`.trim(), "Uninstall");
      removeBtn.title = `Delete ~/system/apps/${app.id}/ and its registry entry`;
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void uninstall(app);
      });
      wrap.append(openBtn, removeBtn);
      return wrap;
    }

    const btn = el("button", `btn ${size} primary`.trim(), "Install");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void install(app);
    });
    wrap.append(btn);
    return wrap;
  }

  /* ---------- the detail page ---------- */

  function openDetail(app: StoreApp): void {
    content.textContent = "";
    content.scrollTop = 0;

    const back = el("button", "store-back");
    back.innerHTML = `${icon("back").outerHTML}<span>Back</span>`;
    back.addEventListener("click", () => render());
    content.append(back);

    const head = el("div", "store-detail-head");
    head.append(icon(app.icon ?? "grid", "store-detail-icon"));
    const info = el("div", "store-detail-info");
    info.append(el("h1", undefined, app.name), el("div", "store-publisher", app.publisher ?? "Unknown publisher"));
    const meta = el("div", "store-card-meta");
    meta.append(el("span", undefined, app.category ?? "App"));
    const fileCount = app.files?.length ?? 0;
    if (fileCount) {
      meta.append(
        el("span", "store-dot", "·"),
        el("span", undefined, `${fileCount} file${fileCount === 1 ? "" : "s"}`),
      );
    }
    info.append(meta);
    head.append(info, appActions(app, true));
    content.append(head);

    const facts = el("div", "store-facts");
    facts.append(fact("Category", app.category ?? "App"));
    facts.append(fact("Publisher", app.publisher ?? "Unknown"));
    facts.append(fact("Installs to", `~/system/apps/${app.id}/`));
    if (app.opens?.length) {
      facts.append(fact("Opens", app.opens.map((o) => `.${normExt(o)}`).join(", ")));
    }
    if (!app.local) {
      /* Measured, not invented: the sum of the bytes actually downloaded. */
      const sizeFact = fact("Download", "measuring…");
      facts.append(sizeFact);
      void measureBytes(app).then((bytes) => {
        const value = sizeFact.querySelector("strong");
        if (!value) return;
        if (bytes === null) sizeFact.remove();
        else value.textContent = humanBytes(bytes);
      });
    }
    content.append(facts);

    if (app.description) content.append(el("p", "store-desc", app.description));

    const files = el("div", "store-files");
    files.append(el("h3", undefined, "What gets installed"));
    for (const file of app.files ?? []) files.append(el("code", undefined, `system/apps/${app.id}/${file}`));
    content.append(files);

    status.textContent = `${app.name} · from ${catalog?.name ?? "store.json"}`;
  }

  function fact(label: string, value: string): HTMLElement {
    const box = el("div", "store-fact");
    box.append(el("span", undefined, label), el("strong", undefined, value));
    return box;
  }

  /* ---------- install / remove ---------- */

  function catalogBase(): string {
    const custom = getSettings().storeUrl.trim();
    return new URL(custom || `${BASE}store.json`, window.location.href).href;
  }

  async function install(app: StoreApp): Promise<void> {
    const files = app.files ?? [];
    if (!files.length) {
      notify({ title: `${app.name} has nothing to install`, body: "Its store listing lists no files.", icon: "info" });
      return;
    }
    const baseUrl = new URL(app.base ?? `${app.id}/`, catalogBase());
    const dir = `${APPS_DIRS[0]}/${app.id}`;
    progress.set(app.id, { done: 0, total: files.length });
    render();

    let written = 0;
    try {
      await vfs.ensureDir(dir);
      for (const file of files) {
        const url = new URL(file, baseUrl).href;
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
        await vfs.writeBytes(`${dir}/${file}`, new Uint8Array(await res.arrayBuffer()));
        written++;
        progress.set(app.id, { done: written, total: files.length });
        render();
      }
      await upsertAppEntry({
        id: app.id,
        name: app.name,
        sub: app.sub,
        icon: app.icon ?? "grid",
        entry: app.entry ?? "index.html",
        "folder-isolated": true,
        width: app.width,
        height: app.height,
        opens: app.opens,
      });
      await reloadFsApps();
      await refreshInstalled();
      refreshDesktops();
      notify({
        title: `${app.name} installed`,
        body: `${written} file${written === 1 ? "" : "s"} in system/apps/${app.id}/. It is on your desktop and in the start menu.`,
        icon: app.icon ?? "grid",
        timeout: 7000,
      });
      logInfo("store", `installed ${app.id}: ${written} files`);
      /* A freshly installed app may claim file types — let it ask now, not
         at the next boot, so the answer arrives while the user is looking. */
      if (app.opens?.length) void requestDefaults();
    } catch (err) {
      logWarn("store", `install of ${app.id} failed`, err);
      notify({
        title: `${app.name} did not install`,
        body: (err as Error).message,
        icon: "info",
        timeout: 0,
      });
    } finally {
      progress.delete(app.id);
      render();
    }
  }

  /**
   * Uninstall: a real delete, not a trip to the trash.
   *
   * Both halves have to go — the folder under ~/system/apps and the entry in
   * user-apps.json — or the app comes back as a broken icon. Any "default
   * app" choice that pointed at it is cleared too, so double-clicking that
   * file type afterwards falls back to something that exists.
   */
  async function uninstall(app: StoreApp): Promise<void> {
    const dir = `${APPS_DIRS[0]}/${app.id}`;
    const ok = await showConfirm(
      "Uninstall app",
      `Uninstall ${app.name}? This deletes ${dir.replace(vfs.HOME, "~")}/ and removes its entry from user-apps.json. It is not moved to the trash, so it cannot be undone.`,
      true,
      "Uninstall",
    );
    if (!ok) return;

    const hadFolder = await vfs.exists(dir);
    try {
      await vfs.removePath(dir);
    } catch (err) {
      logWarn("store", `could not delete ${dir}`, err);
      notify({
        title: `${app.name} could not be removed`,
        body: `${dir.replace(vfs.HOME, "~")}/ is still on disk. Close any window running it and try again.`,
        icon: "info",
        timeout: 0,
      });
      return;
    }
    await removeAppEntry(app.id);
    const cleared = await clearDefaultsForApp(app.id);
    await reloadFsApps();
    await refreshInstalled();
    refreshDesktops();

    logInfo("store", `uninstalled ${app.id}${hadFolder ? "" : " (folder was already gone)"}`);
    notify({
      title: `${app.name} uninstalled`,
      body: [
        "Its folder and its entry are gone.",
        cleared.length ? `Default app for ${cleared.map((e) => `.${e}`).join(", ")} reset.` : "",
      ]
        .filter(Boolean)
        .join(" "),
      icon: "trash",
      timeout: 6000,
    });
    render();
  }

  function spinner(text: string): HTMLElement {
    const box = el("div", "store-empty");
    box.append(el("div", "spinner"), el("p", undefined, text));
    return box;
  }

  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    render();
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      query = "";
      render();
    }
  });

  void loadCatalog();
}
