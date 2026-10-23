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
import {
  getBackend,
  getTabBackend,
  DEFAULT_HOSTER_URL,
  type TerminalBackend,
} from "../bridge/hoster";
import { getV86Backend } from "../bridge/v86";
import { normalizeImageBase, probeImage } from "../bridge/v86-image";
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

  /* engine status lives in the status bar (bottom) — no toolbar badge */
  const setChip = (_state: "offline" | "connecting" | "online", label: string) => {
    status.textContent = `Engine: ${label}`;
  };

  const reconnectBtn = el("button", "tool-btn", "Reconnect");
  const saveStateBtn = el("button", "tool-btn", "Save State");
  saveStateBtn.title = "Save the v86 machine state on this device; the next v86 start resumes from it";
  saveStateBtn.style.display = "none";
  const openTabBtn = el("button", "tool-btn", "Open Engine Tab");
  openTabBtn.title = "Open (or focus) the separate engine tab";
  openTabBtn.style.display = "none";
  const prepareBtn = el("button", "tool-btn", "Prepare Shell");
  prepareBtn.title =
    "Full Arch only: mount /dev, /proc and /sys in the guest and set PATH — " +
    "the steps a normal login would have done";
  prepareBtn.style.display = "none";
  const checkBtn = el("button", "tool-btn", "Check Image");
  checkBtn.title = "Fetch the Arch image store's fs.json and one blob, and report what happens";
  checkBtn.style.display = "none";
  const devBtn = el("button", "tool-btn", "Dev Console");
  devBtn.title = "Toggle the built-in developer console (Eruda)";
  toolbar.append(reconnectBtn, saveStateBtn, prepareBtn, checkBtn, openTabBtn, devBtn);

  prepareBtn.addEventListener("click", () => {
    backend?.prepareShell?.();
    term.focus();
  });

  /* Cross-origin reachability of the image store is the one thing that can
     stop the full Arch guest, and it can only be answered from this browser.
     Report the exact HTTP/CORS outcome instead of a silent non-boot. */
  checkBtn.addEventListener("click", () => {
    const base = getSettings().v86ImageBase;
    checkBtn.disabled = true;
    term.writeln(`${DIM}Checking ${normalizeImageBase(base)} …${RESET}`);
    void probeImage(base)
      .then((r) => {
        const colour = r.ok ? GREEN : RED;
        term.writeln(`${colour}${r.message}${RESET}`);
        if (r.ok) {
          term.writeln(
            `${DIM}fs.json ${r.fsStatus}, ${r.blobs} blobs, sample blob HTTP ${r.blobStatus}.${RESET}`,
          );
        }
        logInfo("terminal", "image probe:", r);
      })
      .catch((err) => term.writeln(`${RED}probe failed: ${(err as Error).message}${RESET}`))
      .finally(() => {
        checkBtn.disabled = false;
      });
  });
  saveStateBtn.addEventListener("click", () => {
    if (!backend?.saveState) return;
    saveStateBtn.disabled = true;
    status.textContent = "Engine: saving state…";
    backend
      .saveState()
      .then(() => {
        status.textContent = "Engine: state saved — the next v86 start resumes here";
      })
      .catch((err) => {
        logWarn("terminal", "save state failed:", err);
        status.textContent = "Engine: state save failed (see Dev Console)";
      })
      .finally(() => {
        saveStateBtn.disabled = false;
      });
  });

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

  const connect = async (freshBoot = false) => {
    if (getSettings().engineMode === "v86") {
      const archGuest = getSettings().v86Guest === "arch";
      openTabBtn.style.display = "none";
      /* Snapshots cannot hold an HTTP-served root filesystem. */
      saveStateBtn.style.display = archGuest ? "none" : "";
      prepareBtn.style.display = archGuest ? "" : "none";
      checkBtn.style.display = archGuest ? "" : "none";
      logInfo(
        "terminal",
        `connect mode=v86 (in-page compatibility engine, no isolation needed) boot=${freshBoot ? "image" : "saved-state-if-present"}`,
      );
      backend?.dispose();
      backend = null;
      setChip("connecting", "Connecting…");
      term.clear();
      if (archGuest) {
        term.writeln(`${DIM}Starting the v86 compatibility engine with the full Arch Linux image.${RESET}`);
        term.writeln(`${DIM}Root filesystem streams from ${normalizeImageBase(getSettings().v86ImageBase)} over 9p.${RESET}`);
        term.writeln(`${DIM}First boot pulls a few MB of blobs, then only what you run. Give it a minute.${RESET}`);
        term.writeln(`${DIM}When the prompt appears, hit "Prepare Shell" once to mount /dev, /proc, /sys.${RESET}`);
        term.writeln(`${DIM}The whole Arch root is your Files folder at v86/ — edit there, the guest sees it.${RESET}`);
        term.writeln(`${DIM}Guest /shared is v86/shared (your Files stay visible underneath it).${RESET}`);
      } else {
        term.writeln(`${DIM}Starting the v86 compatibility engine (tiny Linux, in-page).${RESET}`);
      }
      if (freshBoot) {
        term.writeln(`${DIM}Reconnect: fresh boot from the guest image — saved state is not loaded.${RESET}`);
      }
      term.writeln(`${DIM}No cross-origin isolation needed — this is the WebView-friendly engine.${RESET}`);
      if (!archGuest) term.writeln(`${DIM}Your Files folder appears in the guest as /shared, both ways.${RESET}`);
      const vb = getV86Backend({
        onData: (data) => term.write(filterOutput(data)),
        onNotice: (text) => term.writeln(`${DIM}[v86] ${text}${RESET}`),
        onStatus: (s) => {
          if (s === "ready") {
            setChip("online", archGuest ? "Arch online" : "v86 online");
            term.focus();
          } else {
            setChip("connecting", "Still starting…");
            term.writeln(`${RED}The v86 engine is still booting.${RESET}`);
            term.writeln(`${DIM}Keep this window open — bash appears automatically when ready, or hit Reconnect.${RESET}`);
          }
        },
      }, freshBoot);
      backend = vb;
      vb.connect();
      return;
    }
    const url = getSettings().hosterUrl.trim() || DEFAULT_HOSTER_URL;
    saveStateBtn.style.display = "none";
    const tabMode = getSettings().engineMode === "tab";
    openTabBtn.style.display = tabMode ? "" : "none";
    logInfo(
      "terminal",
      `connect url=${url || "(none)"} mode=${tabMode ? "tab (separate engine tab)" : "embedded (iframe)"} coi=${window.crossOriginIsolated}`,
    );
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
    if (tabMode) {
      term.writeln(
        `${DIM}Engine mode: separate tab. If no engine tab opened, click "Open Engine Tab" above (popup blockers trust direct clicks).${RESET}`,
      );
    }
    const b = (tabMode ? getTabBackend : getBackend)(url, {
      onData: (data) => term.write(filterOutput(data)),
      onFsLive: () => {
        term.writeln(`${GREEN}Shared folder live: guest /home/user/shared is your Dragon86 Files folder.${RESET}`);
      },
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

  reconnectBtn.addEventListener("click", () => void connect(true));
  openTabBtn.addEventListener("click", () => backend?.openTab?.());

  term.onData((data) => backend?.write(data));
  term.onResize(({ cols, rows }) => backend?.resize(cols, rows));

  void connect();
}
