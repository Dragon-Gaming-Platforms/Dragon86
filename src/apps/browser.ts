/**
 * Browser — embeds the standalone Scramjet proxy site that ships with
 * Dragon86 at <base>/scramjet/ (public/scramjet/, vendored — see
 * public/scramjet/VENDORED.md).
 *
 * The proxy page is deliberately standalone (its service worker scope,
 * controller and proxied-content prefix all live under /scramjet/), and
 * this app simply iframes the deployed URL: on GitHub Pages that's
 * https://dragon-gaming-platforms.github.io/Dragon86/scramjet/.
 * In tab engine mode (no COI on this document) the same embed works
 * identically — Scramjet doesn't need cross-origin isolation.
 */

import { el } from "../core/dom";
import type { Win } from "../core/wm";
import { logInfo } from "../core/log";

/** Absolute URL of the Scramjet site relative to the OS base path. */
export function scramjetUrl(): string {
  return new URL("scramjet/", new URL(import.meta.env.BASE_URL, window.location.origin)).href;
}

export function openBrowser(win: Win): void {
  const root = el("div", "app-root");
  const toolbar = el("div", "app-toolbar");
  const status = el("div", "app-statusbar");

  const label = el("span", "tool-btn", "🌐 Scramjet proxy");
  const reloadBtn = el("button", "tool-btn", "Reload page");
  const openBtn = el("button", "tool-btn", "Open standalone ↗");
  toolbar.append(label, reloadBtn, openBtn);
  status.textContent = "Browser: Scramjet (traffic routes via the Wisp server set in the page's ⚙ panel)";

  const frame = document.createElement("iframe");
  frame.className = "browser-frame";
  frame.src = scramjetUrl();
  frame.title = "Browser";
  // Proxied pages want the usual web platform features. `allow` here is
  // about powerful features, not security relaxation — the frame stays
  // same-origin to Dragon86 by URL.
  frame.allow = "clipboard-read; clipboard-write; fullscreen";
  frame.addEventListener("load", () => {
    logInfo("os", `browser iframe loaded: ${frame.src}`);
  });

  reloadBtn.addEventListener("click", () => {
    frame.src = scramjetUrl();
  });
  openBtn.addEventListener("click", () => {
    window.open(scramjetUrl(), "_blank");
  });

  root.append(toolbar, frame, status);
  win.el.append(root);
}
