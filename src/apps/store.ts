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
import { requestDefaults } from "../core/filetypes";
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

interface StoreApp {
  id: string;
  name: string;
  sub?: string;
  category?: string;
  publisher?: string;
  version?: string;
  icon?: string;
  rating?: number;
  reviews?: number;
  downloads?: string;
  size?: string;
  base?: string;
  entry?: string;
  files?: string[];
  opens?: string[];
  width?: number;
  height?: number;
  description?: string;
  highlights?: string[];
  screenshots?: string[];
}

interface Catalog {
  name?: string;
  updated?: string;
  featured?: string[];
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

  async function refreshInstalled(): Promise<void> {
    installedIds.clear();
    for (const app of getFsApps()) installedIds.add(app.id);
    /* An app can also be installed by hand (a folder dropped in Files): count
       it as installed if its folder and entry exist, without a registry entry. */
    for (const app of catalog?.apps ?? []) {
      const dir = `${APPS_DIRS[0]}/${app.id}`;
      if (await vfs.exists(`${dir}/${app.entry ?? "index.html"}`)) installedIds.add(app.id);
    }
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
        render();
      });
      side.append(b);
    }
    const foot = el("div", "store-side-foot");
    foot.textContent = catalog?.updated ? `Catalog updated ${catalog.updated}` : "Offline catalog";
    side.append(foot);
  }

  function visibleApps(): StoreApp[] {
    const apps = catalog?.apps ?? [];
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
      const featuredApp =
        catalog.apps.find((a) => (catalog?.featured ?? []).includes(a.id)) ?? catalog.apps[0];
      if (featuredApp) content.append(featured(featuredApp));
      const row = el("div", "store-row");
      row.append(el("h2", "store-h2", "Top picks this week"));
      const grid = el("div", "store-grid");
      for (const app of list.slice(0, 8)) grid.append(card(app));
      row.append(grid);
      content.append(row);
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
      el("div", "store-eyebrow", "Featured"),
      el("h2", undefined, app.name),
      el("p", undefined, app.description ?? app.sub ?? ""),
    );
    const actions = el("div", "store-feature-actions");
    actions.append(installButton(app, true));
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
    meta.append(stars(app.rating ?? 0), el("span", undefined, ` ${(app.rating ?? 0).toFixed(1)}`));
    if (app.size) meta.append(el("span", "store-dot", "·"), el("span", undefined, app.size));
    node.append(meta);

    const foot = el("div", "store-card-foot");
    foot.append(installButton(app, false));
    node.append(foot);

    node.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      openDetail(app);
    });
    return node;
  }

  function stars(rating: number): HTMLElement {
    const wrap = el("span", "store-stars");
    for (let i = 1; i <= 5; i++) {
      const full = rating >= i - 0.25;
      wrap.innerHTML += icon(full ? "starFilled" : "star").innerHTML;
    }
    return wrap;
  }

  function installButton(app: StoreApp, large: boolean): HTMLButtonElement {
    const state = progress.get(app.id);
    const installed = installedIds.has(app.id);
    const btn = el("button", `btn ${large ? "" : "sm"} ${installed ? "ghost" : "primary"}`.trim());
    if (state) {
      btn.textContent = `Installing… ${state.done}/${state.total}`;
      btn.disabled = true;
    } else if (installed) {
      btn.textContent = "Installed";
      btn.title = "Click to remove it and its files";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        void uninstall(app);
      });
    } else {
      btn.textContent = "Install";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        void install(app);
      });
    }
    return btn;
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
    meta.append(stars(app.rating ?? 0), el("span", undefined, ` ${(app.rating ?? 0).toFixed(1)}`));
    if (app.reviews) meta.append(el("span", "store-dot", "·"), el("span", undefined, `${app.reviews} reviews`));
    if (app.downloads) meta.append(el("span", "store-dot", "·"), el("span", undefined, `${app.downloads} downloads`));
    if (app.size) meta.append(el("span", "store-dot", "·"), el("span", undefined, app.size));
    info.append(meta);
    head.append(info, installButton(app, true));
    content.append(head);

    const facts = el("div", "store-facts");
    facts.append(fact("Version", app.version ?? "1.0.0"));
    facts.append(fact("Category", app.category ?? "Utilities"));
    facts.append(fact("Installs to", `~/system/apps/${app.id}/`));
    if (app.opens?.length) {
      facts.append(fact("Opens", app.opens.map((o) => `.${normExt(o)}`).join(", ")));
    }
    content.append(facts);

    if (app.description) content.append(el("p", "store-desc", app.description));

    if (app.highlights?.length) {
      const ul = el("ul", "store-highlights");
      for (const h of app.highlights) ul.append(el("li", undefined, h));
      content.append(ul);
    }

    if (app.screenshots?.length) {
      const strip = el("div", "store-shots");
      for (const shot of app.screenshots) {
        const img = el("img", "store-shot");
        img.src = new URL(shot, new URL(app.base ?? "", catalogBase())).href;
        img.alt = `${app.name} screenshot`;
        strip.append(img);
      }
      content.append(strip);
    }

    const files = el("div", "store-files");
    files.append(el("h3", undefined, "What gets installed"));
    for (const file of app.files ?? []) files.append(el("code", undefined, `system/apps/${app.id}/${file}`));
    content.append(files);

    status.textContent = `${app.name} · ${app.version ?? "1.0.0"} · from ${catalog?.name ?? "store.json"}`;
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

  async function uninstall(app: StoreApp): Promise<void> {
    const ok = await showConfirm(
      "Remove app",
      `Remove ${app.name}? Its folder system/apps/${app.id}/ and all its files are deleted.`,
      true,
    );
    if (!ok) return;
    try {
      await vfs.removePath(`${APPS_DIRS[0]}/${app.id}`);
    } catch {
      /* already gone — the registry entry still has to go */
    }
    await removeAppEntry(app.id);
    await reloadFsApps();
    await refreshInstalled();
    refreshDesktops();
    notify({ title: `${app.name} removed`, icon: "trash", timeout: 5000 });
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
