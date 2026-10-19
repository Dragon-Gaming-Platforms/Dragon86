/**
 * Games — iframes the Dragon Gaming Platforms catalog player
 * (cdn.singlefile.html) as hosted on the org's own GitHub Pages site.
 *
 * That page is a standalone single-file player: engine inlined, catalog
 * streamed from cdn.games.js. We deliberately do NOT vendor a copy into
 * Dragon86 — the upstream file says "regenerate, do not hand-edit", it
 * references sibling assets (icons, ./singlefile.html) that only resolve
 * on its own site, and iframing the live org URL means catalog updates
 * land here with zero work. It's the same origin
 * (dragon-gaming-platforms.github.io), so the embed is same-origin.
 */

import { el } from "../core/dom";
import type { Win } from "../core/wm";
import { logInfo } from "../core/log";

export const GAMES_URL =
  "https://dragon-gaming-platforms.github.io/Dragon-Gaming-Platforms/cdn.singlefile.html";

export function openGames(win: Win): void {
  const root = el("div", "app-root");
  const status = el("div", "app-statusbar");
  status.textContent = "Games: Dragon Gaming Platforms catalog (live from the org site)";

  const frame = document.createElement("iframe");
  frame.className = "browser-frame";
  frame.src = GAMES_URL;
  frame.title = "Games";
  frame.allow = "clipboard-read; clipboard-write; fullscreen; gamepad";
  frame.addEventListener("load", () => {
    logInfo("os", `games iframe loaded: ${frame.src}`);
  });

  root.append(frame, status);
  win.el.append(root);
}
