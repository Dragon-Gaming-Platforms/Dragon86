/**
 * PS2 Web Recomp library frontend. It stores user-built web packages and disc
 * references in ZenFS; the native recompilation toolchain is intentionally
 * outside the browser app, and playback is disabled under Dragon86's no-COI
 * policy (see the in-app explanation).
 */
import { fs } from "@zenfs/core";
import { el, icon } from "../core/dom";
import * as vfs from "../core/vfs";
import { extractArchive } from "../core/archive-fs";
import { readArchive } from "../core/archive-fs";
import { notify } from "../core/toast";
import type { Win } from "../core/wm";

const ROOT = `${vfs.HOME}/PS2-Web-Recomp`;
const GAMES = `${ROOT}/games`;
const MANIFEST = "dragon86-game.json";
const MAX_GAMES = 100;

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

export function openPs2Library(win: Win): void {
  const root = el("div", "app-root ps2-app");
  const status = el("div", "app-statusbar", "Game builds and disc references stay in ZenFS");
  const shell = el("div", "ps2-library");
  const header = el("header", "ps2-header");
  const branding = el("div", "ps2-brand");
  branding.append(icon("games"));
  const heading = el("div");
  heading.append(el("div", "ps2-eyebrow", "DRAGON86 · LOCAL GAME LIBRARY"));
  heading.append(el("h1", "", "PS2 Web Recomp"));
  heading.append(el("p", "", "Keep your own recompiled game builds in ZenFS. Nothing is uploaded, and no copyrighted game data ships with Dragon86."));
  branding.append(heading);
  const actions = el("div", "ps2-actions");
  const add = el("button", "btn primary", "Add recompiled build");
  add.prepend(icon("archive"));
  const refresh = el("button", "btn ghost", "Refresh");
  refresh.prepend(icon("refresh"));
  actions.append(add, refresh);
  header.append(branding, actions);

  const notice = el("div", "ps2-notice");
  notice.innerHTML = `<strong>What this app does:</strong> import an already-built <code>.zip</code> from Dragon86 Files and keep the web build in <code>~/PS2-Web-Recomp/games/</code>. Recompilation itself uses the upstream native C++/Emscripten tools, not this browser UI.`;
  const list = el("div", "ps2-game-list");
  const loading = el("div", "ps2-loading-screen");
  loading.hidden = true;
  shell.append(header, notice, list, loading);
  root.append(shell, status);
  win.el.append(root);

  add.onclick = () => void openZipPicker((path, title) => void importPackage(path, title));
  refresh.onclick = () => void renderGames();
  void renderGames();

  async function renderGames(): Promise<void> {
    list.replaceChildren();
    await vfs.ensureDir(GAMES);
    let entries: vfs.Entry[];
    try { entries = await vfs.listDir(GAMES); }
    catch (error) { list.append(el("p", "ps2-error", `Could not read ${GAMES}: ${errorText(error)}`)); return; }
    const dirs = entries.filter((entry) => entry.isDirectory).slice(0, MAX_GAMES);
    const games: Game[] = [];
    for (const dir of dirs) {
      try {
        const game = JSON.parse(await vfs.readText(`${dir.path}/${MANIFEST}`)) as Game;
        if (game.v === 1 && game.id === dir.name) games.push(game);
      } catch { /* Not a library entry; leave user files untouched. */ }
    }
    if (!games.length) {
      const empty = el("div", "ps2-empty");
      empty.append(icon("games"), el("h2", "", "Your library is empty"));
      empty.append(el("p", "", "Add a .zip containing an already-recompiled PS2 Web Recomp build. Select a package already in your ZenFS files; use Files to place it there first."));
      list.append(empty);
      return;
    }
    for (const game of games.sort((a, b) => a.name.localeCompare(b.name))) list.append(gameCard(game));
  }

  function gameCard(game: Game): HTMLElement {
    const card = el("article", "ps2-game-card");
    const mark = el("div", "ps2-game-mark", "PS2");
    const details = el("div", "ps2-game-details");
    details.append(el("h2", "", game.name));
    details.append(el("p", "ps2-path", `ZenFS: ${GAMES}/${game.id}/${game.webRoot || ""}`));
    const discLine = el("p", `ps2-disc ${game.discPath ? "is-set" : "is-missing"}`);
    discLine.textContent = game.discPath ? `Disc: ${game.discPath}` : "Disc image not linked yet";
    details.append(discLine);
    const size = el("span", "ps2-size", `${game.files} files · ${vfs.formatSize(game.bytes, false)}`);
    details.append(size);
    const controls = el("div", "ps2-game-actions");
    const load = el("button", "btn primary sm", "Load game");
    load.prepend(icon("play"));
    load.onclick = () => void showLoadingScreen(game);
    const disc = el("button", "btn ghost sm", game.discPath ? "Change disc" : "Choose disc ISO");
    disc.onclick = () => void openZipPicker((path) => void setDisc(game, path), ".iso");
    controls.append(disc, load);
    card.append(mark, details, controls);
    return card;
  }

  async function importPackage(zipPath: string, requestedTitle = ""): Promise<void> {
    const title = requestedTitle || titleFromArchive(zipPath);
    const idBase = slug(title);
    const id = await uniqueId(idBase);
    const gameDir = `${GAMES}/${id}`;
    const busy = loadingView(title);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      const parsed = await readArchive(zipPath);
      busy.setPhase("Checking that this is a complete PS2 Web Recomp build…");
      if (parsed.kind !== "zip") throw new Error("Choose a ZIP package; tar archives are not supported by this importer.");
      const html = parsed.entries.find((entry) => !entry.isDirectory && /(^|\/)ps2web\.html$/i.test(entry.path));
      if (!html) throw new Error("This ZIP does not contain ps2web.html. Choose the web output from ps2-web-recomp's build/web-<game> folder.");
      const buildRoot = parentRel(html.path);
      const near = parsed.entries.filter((entry) => !entry.isDirectory && parentRel(entry.path) === buildRoot).map((entry) => entry.path.toLowerCase());
      if (!near.some((path) => path.endsWith(".js")) || !near.some((path) => path.endsWith(".wasm")) || !near.some((path) => path.endsWith(".data"))) {
        throw new Error("The build is incomplete: ps2web.html, its JavaScript, WebAssembly, and .data files must be together in the ZIP.");
      }
      if (await vfs.exists(gameDir)) throw new Error(`A game folder named ${id} already exists. Choose a different title, or remove the old folder in Files first.`);
      busy.setPhase("Extracting the verified build into ZenFS…");
      await vfs.ensureDir(gameDir);
      /* uniqueId created a fresh, empty target, so overwrite only resolves
         the extractor's existence checks inside this isolated staging folder. */
      const extracted = await extractArchive(zipPath, gameDir, { overwrite: true });
      if (extracted.skipped.length) throw new Error(`The ZIP contains ${extracted.skipped.length} unsafe or duplicate path(s); the build was not registered.`);
      const game: Game = {
        v: 1,
        id,
        name: title,
        webRoot: buildRoot,
        entry: html.path,
        discPath: null,
        sourceArchive: zipPath,
        installedAt: Date.now(),
        files: extracted.files,
        bytes: extracted.bytes,
      };
      await vfs.writeText(`${gameDir}/${MANIFEST}`, JSON.stringify(game, null, 2));
      notify({ title: `${title} saved in ZenFS`, body: "The recompiled web build is installed in your local PS2 library.", icon: "games" });
      await renderGames();
    } catch (error) {
      try { await vfs.removePath(gameDir); } catch { /* no partial package should be presented as installed */ }
      notify({ title: "Could not add this build", body: errorText(error), icon: "close" });
      await renderGames();
    } finally {
      busy.close();
    }
  }

  async function setDisc(game: Game, path: string): Promise<void> {
    if (!path.toLowerCase().endsWith(".iso")) {
      notify({ title: "Choose an .iso disc image", body: "The original disc image stays in its ZenFS location; it is not copied.", icon: "close" });
      return;
    }
    game.discPath = path;
    await vfs.writeText(`${GAMES}/${game.id}/${MANIFEST}`, JSON.stringify(game, null, 2));
    notify({ title: `Disc linked to ${game.name}`, body: "The ISO stays in its existing ZenFS path; no extra copy was made.", icon: "games" });
    await renderGames();
  }

  async function showLoadingScreen(game: Game): Promise<void> {
    loading.hidden = false;
    loading.replaceChildren();
    const panel = el("div", "ps2-loader-card");
    const ring = el("div", "ps2-loader-ring");
    const title = el("div", "ps2-eyebrow", "GAME LOADING SCREEN");
    const heading = el("h2", "", game.name);
    const step = el("p", "ps2-loader-step", "Checking the saved web build in ZenFS…");
    const checks = el("ul", "ps2-check-list");
    const close = el("button", "btn ghost", "Back to library");
    close.onclick = () => { loading.hidden = true; };
    panel.append(ring, title, heading, step, checks, close);
    loading.append(panel);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const checksRun: Array<[string, () => Promise<void>]> = [
      ["Build entry point", async () => { await fs.promises.stat(`${GAMES}/${game.id}/${game.entry}`); }],
      ["WebAssembly runtime", async () => { const found = await hasSibling(game, ".wasm"); if (!found) throw new Error("No .wasm runtime found beside ps2web.html."); }],
      ["Game data bundle", async () => { const found = await hasSibling(game, ".data"); if (!found) throw new Error("No .data bundle found beside ps2web.html."); }],
      ["Disc image", async () => { if (!game.discPath) throw new Error("Choose an .iso from ZenFS to finish the game package."); const st = await fs.promises.stat(game.discPath); if (st.isDirectory()) throw new Error("The selected disc path is a folder."); }],
    ];
    const results: Array<{ label: string; error?: string }> = [];
    for (const [label, run] of checksRun) {
      step.textContent = `Checking ${label.toLowerCase()}…`;
      const row = el("li", "ps2-check-pending", label);
      checks.append(row);
      try { await run(); row.className = "ps2-check-ok"; row.prepend(el("span", "", "✓ ")); results.push({ label }); }
      catch (error) { row.className = "ps2-check-fail"; row.prepend(el("span", "", "! ")); results.push({ label, error: errorText(error) }); }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const failed = results.filter((r) => r.error);
    if (failed.length) {
      step.className = "ps2-loader-step is-error";
      step.textContent = failed[0].error!;
      const hint = el("p", "ps2-loader-note", "The build remains stored in ZenFS. Use the disc button on the game card to link an existing ISO without copying it.");
      panel.insertBefore(hint, close);
      panel.append(close);
      return;
    }
    step.className = "ps2-loader-step is-blocked";
    step.textContent = "Build and disc are present in ZenFS — ready for a compatible runtime.";
    const blocked = el("div", "ps2-blocked-note");
    blocked.append(el("strong", "", "Playback is unavailable in Dragon86's current configuration."));
    blocked.append(el("p", "", "PS2 Web Recomp requires cross-origin isolation (COOP/COEP) for its browser runtime. Dragon86 deliberately keeps that feature disabled, so this frontend verifies and stores the game package but does not pretend it can start gameplay."));
    const pathNote = el("small", "", `Your build and disc are local in ZenFS: ${GAMES}/${game.id}`);
    panel.append(blocked, pathNote, close);
  }

  async function hasSibling(game: Game, extension: string): Promise<boolean> {
    const dir = vfs.parentOf(`${GAMES}/${game.id}/${game.entry}`);
    const entries = await vfs.listDir(dir);
    return entries.some((entry) => !entry.isDirectory && entry.name.toLowerCase().endsWith(extension));
  }

  function loadingView(title: string): { setPhase: (text: string) => void; close: () => void } {
    const overlay = el("div", "ps2-import-overlay");
    const panel = el("div", "ps2-loader-card ps2-import-card");
    panel.append(el("div", "ps2-loader-ring"), el("div", "ps2-eyebrow", "SAVING TO ZENFS"), el("h2", "", title));
    const current = el("p", "ps2-loader-step", "Reading the package from ZenFS…");
    const small = el("p", "ps2-loader-note", "Your ZIP stays where it is; the extracted web build is written under ~/PS2-Web-Recomp/games/.");
    panel.append(current, small);
    overlay.append(panel);
    shell.append(overlay);
    const setPhase = (text: string) => { current.textContent = text; };
    const close = () => overlay.remove();
    return { setPhase, close };
  }

  async function openZipPicker(onPick: (path: string, title: string) => void, extension = ".zip"): Promise<void> {
    let current = `${vfs.HOME}/Downloads`;
    let selected = "";
    const overlay = el("div", "ps2-picker");
    const dialog = el("section", "ps2-picker-dialog");
    const heading = el("h2", "", extension === ".iso" ? "Choose a disc image in ZenFS" : "Choose a recompiled ZIP in ZenFS");
    const helper = el("p", "", extension === ".iso" ? "Select an existing .iso. Dragon86 links it in place and does not duplicate the large image." : "Choose the ZIP you already placed in Dragon86 Files. Only the web build is extracted; the disc ISO is selected separately.");
    const nav = el("div", "ps2-picker-nav");
    const up = el("button", "btn ghost sm", "Up");
    const home = el("button", "btn ghost sm", "Home");
    const rootButton = el("button", "btn ghost sm", "Root");
    const location = el("span", "ps2-picker-path", current);
    nav.append(up, home, rootButton, location);
    const entries = el("div", "ps2-picker-entries");
    const name = el("input", "input ps2-name");
    name.placeholder = "Game title (optional)";
    name.dataset.gameName = "";
    name.hidden = extension === ".iso";
    const footer = el("div", "ps2-picker-footer");
    const cancel = el("button", "btn ghost", "Cancel");
    const choose = el("button", "btn primary", extension === ".iso" ? "Use this disc" : "Import build");
    choose.disabled = true;
    footer.append(el("span", "ps2-picker-selection", "Select a file"), cancel, choose);
    dialog.append(heading, helper, nav, entries, name, footer);
    overlay.append(dialog);
    shell.append(overlay);
    const close = () => overlay.remove();
    cancel.onclick = close;
    overlay.addEventListener("pointerdown", (event) => { if (event.target === overlay) close(); });
    up.onclick = () => { if (current !== "/") { current = vfs.parentOf(current); selected = ""; void render(); } };
    home.onclick = () => { current = vfs.HOME; selected = ""; void render(); };
    rootButton.onclick = () => { current = "/"; selected = ""; void render(); };
    choose.onclick = () => { if (!selected) return; const path = selected; const gameTitle = name.value.trim(); close(); onPick(path, gameTitle); };

    async function render(): Promise<void> {
      location.textContent = current;
      entries.replaceChildren();
      try {
        const items = await vfs.listDir(current);
        const visible = items.filter((item) => item.isDirectory || item.name.toLowerCase().endsWith(extension));
        if (!visible.length) entries.append(el("p", "ps2-picker-empty", extension === ".iso" ? "No ISO files here." : "No ZIP files here."));
        for (const item of visible) {
          const row = el("button", `ps2-picker-row ${selected === item.path ? "selected" : ""}`);
          row.append(icon(item.isDirectory ? "folder" : extension === ".iso" ? "disc" : "archive"));
          const text = el("span", "ps2-picker-name", item.name);
          const size = el("small", "", item.isDirectory ? "Folder" : vfs.formatSize(item.size, false));
          row.append(text, size);
          row.onclick = () => {
            if (item.isDirectory) { current = item.path; selected = ""; void render(); return; }
            selected = item.path;
            footer.querySelector(".ps2-picker-selection")!.textContent = item.path;
            choose.disabled = false;
            for (const other of entries.querySelectorAll(".ps2-picker-row")) other.classList.remove("selected");
            row.classList.add("selected");
          };
          row.ondblclick = () => { if (!item.isDirectory) choose.click(); };
          entries.append(row);
        }
      } catch (error) { entries.append(el("p", "ps2-error", `Cannot browse this folder: ${errorText(error)}`)); }
    }
    await render();
  }
}

function titleFromArchive(path: string): string {
  const base = vfs.baseName(path).replace(/\.zip$/i, "").replace(/^web[-_]/i, "").replace(/[-_]+/g, " ").trim();
  return base || "PS2 game";
}

function slug(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "ps2-game";
}

async function uniqueId(base: string): Promise<string> {
  let id = base;
  let n = 2;
  while (await vfs.exists(`${GAMES}/${id}`)) id = `${base}-${n++}`;
  return id;
}

function parentRel(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
