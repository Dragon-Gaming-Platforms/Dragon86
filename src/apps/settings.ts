/**
 * Settings — themes, wallpaper, engine host, system info, factory reset.
 */

import { el, icon } from "../core/dom";
import { showConfirm } from "../core/dialog";
import { DEFAULT_IMAGE_BASE, probeImage, probeRelay, relayBackendName } from "../bridge/v86-image";
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

  /* ---------- Engine location (embedded vs separate tab) ---------- */
  const modeRow = el("div", "settings-row");
  modeRow.append(el("label", undefined, "Engine runs"));
  const embeddedBtn = el("button", "btn", "Embedded (in this page)");
  const tabBtn = el("button", "btn", "In a separate tab");
  const v86Btn = el("button", "btn", "v86 (compatibility)");
  const refreshModeBtns = () => {
    const mode = getSettings().engineMode;
    embeddedBtn.classList.toggle("active", mode === "embedded");
    tabBtn.classList.toggle("active", mode === "tab");
    v86Btn.classList.toggle("active", mode === "v86");
  };
  const setMode = (mode: "embedded" | "tab" | "v86") => {
    if (getSettings().engineMode === mode) return;
    setSettings({ engineMode: mode });
    refreshModeBtns();
    modeNote.textContent =
      mode === "tab"
        ? "Saved. Reloading — cross-origin isolation will be turned OFF for Dragon86 (the engine tab isolates itself). The Terminal will talk to the engine tab directly; no terminal UI appears over there."
        : mode === "v86"
          ? "Saved. Reloading — cross-origin isolation will be turned OFF for Dragon86 (v86 doesn't need it). The Terminal will boot a tiny Linux right here in the page; your Files folder shows up in it as /shared."
          : "Saved. Reloading — cross-origin isolation will be turned ON for Dragon86 so the embedded engine can run…";
    /* Isolation is decided when the document loads, so applying a mode
       change IS a reload. Leaving isolation needs the worker gone BEFORE
       that reload: otherwise the reloaded document is still controlled and
       still carries COOP/COEP, and coi-serviceworker has to unregister and
       reload a second time. Doing it here means one reload and an
       unrestrained page immediately. */
    if (mode === "embedded") {
      setTimeout(() => location.reload(), 900);
      return;
    }
    const sw = navigator.serviceWorker;
    const drop = sw && typeof sw.getRegistrations === "function"
      ? sw.getRegistrations().then((regs) => Promise.all(regs.map((r) => r.unregister())))
      : Promise.resolve();
    void drop.catch(() => {}).then(() => setTimeout(() => location.reload(), 400));
  };
  embeddedBtn.addEventListener("click", () => setMode("embedded"));
  tabBtn.addEventListener("click", () => setMode("tab"));
  v86Btn.addEventListener("click", () => setMode("v86"));
  refreshModeBtns();
  modeRow.append(embeddedBtn, tabBtn, v86Btn);
  const modeNote = el(
    "div",
    "settings-note",
    "Embedded: CheerpX engine hidden inside Dragon86 (default; needs isolation ON for this page). Separate tab: the engine opens as its own browser tab with no terminal UI in it — the Dragon86 Terminal still renders everything — and Dragon86 isolation turns OFF, leaving this page unrestricted for other apps. v86 (compatibility): a tiny Linux that runs right in this page with no isolation at all — the pick for Android WebView and locked-down browsers where the other two can't run; your Files folder is its /shared folder, synced both ways. Switching reloads the page.",
  );
  engineSection.append(modeRow, modeNote);

  /* ---------- v86 guest image (mini vs full Arch) ---------- */
  const guestRow = el("div", "settings-row");
  guestRow.append(el("label", undefined, "v86 guest"));
  const miniBtn = el("button", "btn", "Dragon86 mini (fast)");
  const archBtn = el("button", "btn", "Full Arch Linux 32");
  const refreshGuestBtns = () => {
    const g = getSettings().v86Guest;
    miniBtn.classList.toggle("active", g !== "arch");
    archBtn.classList.toggle("active", g === "arch");
  };
  miniBtn.addEventListener("click", () => {
    setSettings({ v86Guest: "dragon" });
    refreshGuestBtns();
  });
  archBtn.addEventListener("click", () => {
    setSettings({ v86Guest: "arch" });
    refreshGuestBtns();
  });
  refreshGuestBtns();
  guestRow.append(miniBtn, archBtn);

  const imageRow = el("div", "settings-row");
  imageRow.append(el("label", undefined, "Arch image"));
  const imageInput = el("input", "input");
  imageInput.placeholder = DEFAULT_IMAGE_BASE;
  imageInput.value = getSettings().v86ImageBase;
  const saveImage = el("button", "btn", "Save");
  saveImage.addEventListener("click", () => {
    setSettings({ v86ImageBase: imageInput.value.trim() || DEFAULT_IMAGE_BASE });
    imageInput.value = getSettings().v86ImageBase;
    saveImage.textContent = "Saved ✓";
    setTimeout(() => (saveImage.textContent = "Save"), 1500);
  });
  imageRow.append(imageInput, saveImage);

  const testImage = el("button", "btn", "Test");
  const imageResult = el("div", "settings-note");
  testImage.addEventListener("click", () => {
    testImage.disabled = true;
    imageResult.textContent = "Checking cross-origin reachability…";
    void probeImage(getSettings().v86ImageBase)
      .then((r) => {
        imageResult.textContent = r.message;
        imageResult.style.color = r.ok ? "var(--text-primary)" : "var(--theme-bright)";
      })
      .finally(() => {
        testImage.disabled = false;
      });
  });
  imageRow.append(testImage);

  /* ---------- v86 network (emulator side) ---------- */
  const netRow = el("div", "settings-row");
  netRow.append(el("label", undefined, "v86 network"));
  const netInput = el("input", "input");
  netInput.placeholder = "wss://relay.widgetry.org/";
  netInput.value = getSettings().v86Network;
  const saveNet = el("button", "btn", "Save");
  saveNet.addEventListener("click", () => {
    setSettings({ v86Network: netInput.value.trim() });
    netInput.value = getSettings().v86Network;
    saveNet.textContent = "Saved ✓";
    setTimeout(() => (saveNet.textContent = "Save"), 1500);
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
    netResult.style.color = "";
    netResult.textContent = `Checking ${relayBackendName(getSettings().v86Network)} relay…`;
    void probeRelay(getSettings().v86Network)
      .then((r) => {
        netResult.textContent = `${r.message} (${r.ms} ms, backend: ${r.backend})`;
        netResult.style.color = r.ok ? "var(--text-primary)" : "var(--theme-bright)";
      })
      .finally(() => {
        testNet.disabled = false;
      });
  });
  netRow.append(netInput, saveNet, offNet, testNet);

  const netNote = el(
    "div",
    "settings-note",
    "The network card is emulated by v86, not by the guest: v86 provides the NIC and the backend behind it, including DHCP. " +
      "Inside the guest, /root/networking.sh only loads the driver and asks for a lease (the same job as that script in copy.sh's images). " +
      "wss:// = wsproxy (copy.sh's own backend, rate-limited when public), wisp:// = your own wisp server, fetch = in-page with no server. " +
      "Press Test to check reachability from this browser; changes take effect on the next Terminal Reconnect.",
  );
  engineSection.append(netRow, netResult, netNote);

  const guestNote = el(
    "div",
    "settings-note",
    "Dragon86 mini: the vendored Arch kernel with bash, coreutils and git — boots in seconds, and /shared is your Files folder. " +
      "Full Arch Linux 32: copy.sh/v86's complete Arch root filesystem — real pacman and the whole userland, slower to start. " +
      "Its root is your Files folder at v86/: the image is a read-only floor, anything you edit is copied there and persists, so edits in Files appear in the guest. " +
      "Guest /shared is v86/shared. " +
      "The image is fetched straight from the origin below, so its CORS policy matters: press Test to check from this browser. " +
      "Changes take effect on the next Terminal Reconnect.",
  );
  engineSection.append(guestRow, imageRow, imageResult, guestNote);

  /* ---------- System ---------- */
  const systemSection = el("div", "settings-section");
  systemSection.append(el("h2", undefined, "System"));
  const table = el("table", "about-table");
  const facts: [string, string][] = [
    ["OS", "Dragon86 0.9.0 (dev build)"],
    ["Build", "GUST + Sandstone vendored · Monaco editor · v86 (bash + coreutils + git, live 9p share, save state) · desktop layout fix"],
    ["Engines", "CheerpX (embedded / separate tab) · v86 (mini guest with /shared, or full Arch Linux streamed from an image store)"],
    ["Vendor", "Dragon Gaming Platforms"],
    ["Terminal", "xterm.js 6 · bridge protocol v1"],
    [
      "Isolation",
      window.crossOriginIsolated
        ? "ON — COOP/COEP from the coi service worker (CheerpX needs it)"
        : "off — no COOP/COEP, no service worker required for this engine",
    ],
    [
      "Service worker",
      navigator.serviceWorker?.controller
        ? `controlling this page (${navigator.serviceWorker.controller.scriptURL.split("/").pop()})`
        : "not controlling this page",
    ],
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
