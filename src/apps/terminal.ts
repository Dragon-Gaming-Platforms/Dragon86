/**
 * Terminal — xterm.js front end.
 *
 * v1 behavior (per spec): show "engine not connected" until a CheerpX hoster
 * URL is configured in Settings. The bridge protocol lives in bridge/hoster.ts
 * and is the only thing that changes when the hoster repo lands.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { el } from "../core/dom";
import { getSettings } from "../core/settings";
import type { Win } from "../core/wm";
import { getBackend, DEFAULT_HOSTER_URL, type TerminalBackend } from "../bridge/hoster";
import { isolationReport, logInfo, logWarn } from "../core/log";

const GREEN = "\x1b[38;2;46;204;113m";
const RED = "\x1b[38;2;231;76;60m";
const DIM = "\x1b[38;2;102;102;102m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export function openTerminal(win: Win): void {
  const root = el("div", "app-root");
  const toolbar = el("div", "app-toolbar");
  const status = el("div", "app-statusbar");

  const termHost = el("div", "term-wrap");
  const devHost = el("div", "term-devtools");
  devHost.style.display = "none";
  root.append(toolbar, termHost, devHost, status);
  win.el.append(root);

  const term = new Terminal({
    fontFamily: '"Cascadia Code", "Fira Code", Consolas, monospace',
    fontSize: 14,
    theme: {
      background: "#050505",
      foreground: "#f0f0f0",
      cursor: "#e60012",
      selectionBackground: "rgba(230,0,18,0.4)",
    },
    cursorBlink: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termHost);
  requestAnimationFrame(() => fit.fit());

  const ro = new ResizeObserver(() => fit.fit());
  ro.observe(termHost);

  /* toolbar: engine status */
  const engineChip = el("span", "tool-btn");
  const setChip = (state: "offline" | "connecting" | "online", label: string) => {
    engineChip.innerHTML = `<span class="status-dot ${state === "online" ? "ok" : state === "connecting" ? "warn" : ""}"></span>${label}`;
    status.textContent = `Engine: ${label}`;
  };

  const reconnectBtn = el("button", "tool-btn", "Reconnect");
  const devBtn = el("button", "tool-btn", "Dev Console");
  devBtn.title = "Toggle the built-in developer console (Eruda)";
  toolbar.append(engineChip, reconnectBtn, devBtn);

  /* --- Eruda developer console, contained in this window ---
     Loaded lazily on first click so it costs nothing until needed. It lives
     inside `devHost` (inside this terminal window only) and captures this
     page's console — including all [D86:bridge] diagnostics. Note: logs from
     *inside* the hoster iframe appear in the real browser DevTools console,
     not in Eruda (which instruments this frame only). */
  let erudaMod: typeof import("eruda")["default"] | null = null;
  let devOpen = false;
  devBtn.addEventListener("click", () => {
    void (async () => {
      try {
        if (!erudaMod) {
          logInfo("terminal", "loading Eruda dev console…");
          erudaMod = (await import("eruda")).default;
          erudaMod.init({
            container: devHost,
            tool: ["console", "elements", "network", "resources", "info"],
            defaults: { theme: "Dark" },
          });
          /* Inline inside our panel instead of a floating overlay. */
          erudaMod.show();
          logInfo("terminal", "Eruda ready. Environment:", isolationReport());
        }
        devOpen = !devOpen;
        devHost.style.display = devOpen ? "" : "none";
        devBtn.classList.toggle("active", devOpen);
        if (devOpen) {
          erudaMod.show("console");
          logInfo(
            "terminal",
            "Dev Console open — watch for [D86:bridge] lines. " +
              "Key facts: OS crossOriginIsolated, iframe probe result, " +
              "hello counts, and any ignored messages.",
          );
        }
        requestAnimationFrame(() => fit.fit());
      } catch (err) {
        logWarn("terminal", "Eruda failed to load:", err);
      }
    })();
  });

  let backend: TerminalBackend | null = null;

  /* Output display filter — fixes the "staircase" output.
     The guest sends bare \n (LF) and CheerpX's emulated console does NOT
     perform the ONLCR translation a real TTY does (\n → \r\n). xterm.js
     therefore moves the cursor down but never back to column 0, so every
     line starts where the previous one ended and output stairs rightward
     (looks like a growing tab indent — it isn't one). Here we do the ONLCR
     job ourselves: a \n not immediately preceded by \r gets a \r inserted.
     Stateful across chunks (a chunk may end with \r and start with \n).
     Also drops a genuine leading TAB at line start, defensively. */
  let prevChar = "";
  let atLineStart = true;
  let fixNoticeShown = false;
  const filterOutput = (data: string): string => {
    let out = "";
    for (const ch of data) {
      if (atLineStart && ch === "\t") {
        continue; // stray leading tab — drop
      }
      if (ch === "\n" && prevChar !== "\r") {
        out += "\r";
        if (!fixNoticeShown) {
          fixNoticeShown = true;
          logInfo(
            "terminal",
            "applying ONLCR fix: guest sends bare LF, inserting CR (staircase fix)",
          );
        }
      }
      out += ch;
      prevChar = ch;
      atLineStart = ch === "\n" || ch === "\r";
    }
    return out;
  };

  const banner = () => {
    term.clear();
    term.writeln(`${BOLD}${RED}  ╔══════════════════════════════════════════╗${RESET}`);
    term.writeln(`${BOLD}${RED}  ║        DRAGON86  ·  CHEERPX TERMINAL     ║${RESET}`);
    term.writeln(`${BOLD}${RED}  ╚══════════════════════════════════════════╝${RESET}`);
    term.writeln("");
    term.writeln(`  ${DIM}xterm.js is online. The Linux engine is not.${RESET}`);
    term.writeln("");
    term.writeln(`  ${GREEN}●${RESET} Terminal emulator : ready`);
    term.writeln(`  ${RED}●${RESET} CheerpX engine     : not connected`);
    term.writeln("");
    term.writeln(`  The engine lives in the CheerpX-Bridge hoster repo and connects`);
    term.writeln(`  over the message bridge. It is usually found automatically at:`);
    term.writeln("");
    term.writeln(`    ${BOLD}${DEFAULT_HOSTER_URL}${RESET}`);
    term.writeln("");
    term.writeln(`  If it never comes up, check ${BOLD}Settings → Engine${RESET} (a custom`);
    term.writeln(`  URL overrides the default) and hit ${BOLD}Reconnect${RESET}.`);
    term.writeln("");
    term.writeln(`  ${DIM}Engine protocol: v1 · PTY byte-stream + control channel${RESET}`);
    term.writeln("");
    setChip("offline", "Not connected");
  };

  const connect = async () => {
    const url = getSettings().hosterUrl.trim() || DEFAULT_HOSTER_URL;
    backend?.dispose();
    backend = null;
    if (!url) {
      banner();
      return;
    }
    setChip("connecting", "Connecting…");
    term.clear();
    term.writeln(`${DIM}Connecting to engine: ${url}${RESET}`);
    term.writeln(`${DIM}First boot builds the engine and can take ~20 s — later opens are instant.${RESET}`);
    term.writeln(`${DIM}Diagnostics: open the "Dev Console" button above and watch [D86:bridge] logs.${RESET}`);
    const b = getBackend(url, {
      onData: (data) => term.write(filterOutput(data)),
      onStatus: (s) => {
        if (s === "ready") {
          setChip("online", "CheerpX online");
          term.writeln(`${GREEN}Engine handshake complete.${RESET}`);
          term.writeln(`${DIM}Debian bash — have fun.${RESET}`);
          term.write("\r\n");
          /* Tell the PTY its real size so wrapping and full-screen apps
             are correct from the very first prompt. */
          b.resize(term.cols, term.rows);
          term.focus();
        } else {
          setChip("connecting", "Still starting…");
          term.writeln(`${RED}The engine is still booting.${RESET}`);
          term.writeln(
            `${DIM}Keep this window open — bash will appear here automatically` +
              ` when the engine is ready (cold boot can take ~20 s), or hit Reconnect.\x1b[0m`,
          );
        }
      },
    });
    backend = b;
    b.connect();
  };

  reconnectBtn.addEventListener("click", () => void connect());

  term.onData((data) => backend?.write(data));
  term.onResize(({ cols, rows }) => backend?.resize(cols, rows));

  void connect();
}
