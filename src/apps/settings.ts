/**
 * Settings — themes, wallpaper, engine host, system info, factory reset.
 */

import { el, icon } from "../core/dom";
import { showConfirm } from "../core/dialog";
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

export function openSettings(win: Win): void {
  const root = el("div", "app-root");
  const body = el("div", "settings-body");
  const status = el("div", "app-statusbar");
  status.textContent = "Dragon86 · stored locally in your browser";
  root.append(body, status);
  win.el.append(root);

  /* ---------- Appearance: theme ---------- */
  const themeSection = el("div", "settings-section");
  themeSection.append(el("h2", undefined, "Theme"));
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
  themeSection.append(themeGrid);

  /* ---------- Appearance: wallpaper ---------- */
  const wallSection = el("div", "settings-section");
  wallSection.append(el("h2", undefined, "Wallpaper"));
  const wallGrid = el("div", "wall-grid");
  for (const w of WALLPAPERS) {
    const thumb = el("div", "wall-thumb");
    thumb.title = w.name;
    if (w.id === "ember") thumb.style.backgroundImage = "var(--wall-ember)";
    else if (w.id === "obsidian") thumb.style.backgroundImage = "var(--wall-obsidian)";
    else thumb.style.background = w.css;
    if (getSettings().wallpaper === w.id) thumb.classList.add("selected");
    thumb.addEventListener("click", () => {
      setSettings({ wallpaper: w.id });
      wallGrid.querySelectorAll(".wall-thumb").forEach((n) => n.classList.remove("selected"));
      thumb.classList.add("selected");
    });
    wallGrid.append(thumb);
  }
  wallSection.append(wallGrid);

  /* ---------- Engine ---------- */
  const engineSection = el("div", "settings-section");
  engineSection.append(el("h2", undefined, "CheerpX Engine"));
  const row = el("div", "settings-row");
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
    setTimeout(() => (saveHost.textContent = "Save"), 1500);
  });
  const defaultHost = el("button", "btn", "Use Default");
  defaultHost.addEventListener("click", () => {
    setSettings({ hosterUrl: "" });
    hosterInput.value = "";
    refreshEffective();
  });
  row.append(hosterInput, saveHost, defaultHost);
  const effective = el(
    "div",
    "settings-note",
  );
  const refreshEffective = () => {
    const custom = getSettings().hosterUrl.trim();
    effective.textContent = custom
      ? `Using custom engine: ${custom}`
      : `Using default engine: ${DEFAULT_HOSTER_URL}`;
  };
  refreshEffective();
  const note = el(
    "div",
    "settings-note",
    "The CheerpX Linux engine runs in its own hoster page (CheerpX-Bridge) and connects to the Terminal over the message bridge. Leave this empty to use the default above. Changes take effect on the next Terminal Reconnect.",
  );
  engineSection.append(row, effective, note);

  /* ---------- System ---------- */
  const systemSection = el("div", "settings-section");
  systemSection.append(el("h2", undefined, "System"));
  const table = el("table", "about-table");
  const facts: [string, string][] = [
    ["OS", "Dragon86 0.1.0 (dev build)"],
    ["Vendor", "Dragon Gaming Platforms"],
    ["Terminal", "xterm.js 6 · bridge protocol v1"],
    [
      "Engine",
      getSettings().hosterUrl.trim()
        ? `Custom: ${getSettings().hosterUrl.trim()}`
        : "Default: CheerpX-Bridge (github.io)",
    ],
    ["Filesystem", "ZenFS · IndexedDB + /tmp in-memory"],
    ["Storage", "Local to this browser — no account, no server"],
    ["Themes", THEMES.map((t) => t.name).join(", ")],
  ];
  for (const [k, v] of facts) {
    const tr = el("tr");
    tr.append(el("td", undefined, k), el("td", undefined, v));
    table.append(tr);
  }
  systemSection.append(table);

  /* ---------- Danger zone ---------- */
  const dangerSection = el("div", "settings-section");
  dangerSection.append(el("h2", undefined, "Danger Zone"));
  const resetBtn = el("button", "btn danger", "Factory Reset");
  resetBtn.addEventListener("click", async () => {
    const ok = await showConfirm(
      "Factory Reset",
      "Erase the virtual hard drive and all settings? This cannot be undone.",
      true,
    );
    if (ok) await vfs.factoryReset();
  });
  const dangerNote = el(
    "div",
    "settings-note",
    "Wipes the virtual hard drive (browser storage) and resets all Dragon86 settings.",
  );
  dangerSection.append(resetBtn, dangerNote);

  body.append(themeSection, wallSection, engineSection, systemSection, dangerSection);
  void icon("settings");
}
