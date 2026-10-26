/**
 * Taskbar + Start menu.
 */

import { el, icon } from "./dom";
import { getSettings, onSettingsChange, THEMES, setSettings } from "./settings";
import type { WindowManager } from "./wm";
import { IFRAME_APPS } from "../apps/iframe-app";

export interface AppShortcut {
  id: string;
  name: string;
  icon: string;
  sub?: string;
  /** False when the app's manifest says it does not start on the desktop. */
  onDesktop?: boolean;
  launch: () => void;
}

export function buildTaskbar(wm: WindowManager, getApps: () => AppShortcut[]): void {
  const bar = document.getElementById("taskbar")!;

  /* ---- start button ---- */
  const startBtn = el("button", "start-btn");
  startBtn.innerHTML = `<img class="dragon" src="${import.meta.env.BASE_URL}icons/dragon-gaming.png" alt="" draggable="false" /><span>Dragon86</span>`;
  bar.append(startBtn);

  /* ---- window buttons ---- */
  const taskButtons = el("div", "task-buttons");
  bar.append(taskButtons);

  /* ---- tray / clock ---- */
  const tray = el("div", "tray");
  const clock = el("div", "tray-clock");
  const timeEl = el("div", "time");
  const dateEl = el("div", "date");
  clock.append(timeEl, dateEl);
  tray.append(clock);
  bar.append(tray);

  const tick = () => {
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    dateEl.textContent = now.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    clock.title = now.toLocaleString();
  };
  tick();
  setInterval(tick, 10_000);

  /* ---- start menu ---- */
  let startMenu: HTMLElement | null = null;

  function closeStart(): void {
    startMenu?.remove();
    startMenu = null;
    startBtn.classList.remove("open");
  }

  function toggleStart(): void {
    if (startMenu) {
      closeStart();
      return;
    }
    startBtn.classList.add("open");
    const menu = el("div", "start-menu");
    const header = el("div", "header");
    const brand = el("div", "brand");
    brand.innerHTML = "DRAGON<span>86</span>";
    header.append(brand, el("div", "sub", "Web Desktop Environment"));
    const list = el("div", "start-apps");
    for (const app of getApps()) {
      const b = el("button", "start-app");
      b.append(icon(app.icon), el("span", undefined, app.name));
      if (app.sub) b.append(el("span", "app-sub", app.sub));
      b.addEventListener("click", () => {
        closeStart();
        app.launch();
      });
      list.append(b);
    }
    const footer = el("div", "start-footer");
    const settingsBtn = el("button", "btn", "Settings");
    settingsBtn.addEventListener("click", () => {
      closeStart();
      const s = getApps().find((a) => a.id === "settings");
      s?.launch();
    });
    const reloadBtn = el("button", "btn", "Reload");
    reloadBtn.addEventListener("click", () => location.reload());
    footer.append(settingsBtn, reloadBtn);

    menu.append(header, list, footer);
    bar.parentElement!.append(menu);
    startMenu = menu;

    setTimeout(
      () => window.addEventListener("mousedown", onAway, { capture: true, once: true }),
      0,
    );
  }

  function onAway(e: Event): void {
    if (startMenu && !startMenu.contains(e.target as Node) && e.target !== startBtn) {
      closeStart();
    } else if (startMenu) {
      setTimeout(
        () => window.addEventListener("mousedown", onAway, { capture: true, once: true }),
        0,
      );
    }
  }

  startBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleStart();
  });

  /* ---- live window buttons ---- */
  wm.onChange((wins) => {
    taskButtons.textContent = "";
    for (const w of wins) {
      const b = el("button", "task-btn");
      if (w.focused && !w.minimized) b.classList.add("active");
      if (w.minimized) b.classList.add("minimized");
      b.append(icon(w.icon), el("span", "label", w.title));
      b.title = w.title;
      b.addEventListener("click", () => {
        const handle = wm.getWindows().find((h) => h.id === w.id);
        if (!handle) return;
        if (w.minimized || !w.focused) {
          handle.focus();
        } else {
          handle.minimize();
        }
      });
      taskButtons.append(b);
    }
  });
}

/** Primary apps shown in the start menu / desktop: built-ins, then the
 *  JSON-defined iframe apps (src/apps/iframe-apps.json), then Settings. */
export function coreApps(launch: Record<string, () => void>): AppShortcut[] {
  return [
    { id: "files", name: "Files", icon: "folder", sub: "Explorer", launch: launch["files"]! },
    { id: "terminal", name: "Terminal", icon: "terminal", sub: "Arch Linux · v86", launch: launch["terminal"]! },
    { id: "editor", name: "Text Editor", icon: "editor", sub: "Notes", launch: launch["editor"]! },
    { id: "store", name: "App Store", icon: "store", sub: "Get apps", launch: launch["store"]! },
    ...IFRAME_APPS.map((def) => ({
      id: def.id,
      name: def.name,
      icon: def.icon,
      sub: def.sub,
      onDesktop: def.onDesktop ?? true,
      launch: launch[def.id]!,
    })),
    /* Part of the OS, but it is a place you go *from a terminal*: no icon on
       the desktop, and it stays in the start menu for the last machine. */
    {
      id: "engine-viewer",
      name: "Engine Viewer",
      icon: "linux",
      sub: "v86 screen",
      onDesktop: false,
      launch: launch["engine-viewer"]!,
    },
    { id: "settings", name: "Settings", icon: "settings", sub: "System", launch: launch["settings"]! },
  ];
}

/** Small helper used by Settings to keep theme chip live — re-export. */
export { getSettings, onSettingsChange, THEMES, setSettings, icon };
