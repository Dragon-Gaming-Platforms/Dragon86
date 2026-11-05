/**
 * Terminal — xterm.js front end.
 *
 * The machine behind it is an in-page emulator (bridge/v86.ts) chosen by
 * the architecture in Settings: 32-bit x86 (the v86 build) or x86-64 (the
 * v64 build), both booting the installed distro from the OS filesystem's
 * own `/`. ARM64 is emulatable (v64) but no ARM64 distro is installed, so
 * it refuses honestly instead of pretending.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { el } from "../core/dom";
import { getSettings, onSettingsChange, type MachineArch } from "../core/settings";
import type { Win } from "../core/wm";
import type { TerminalBackend } from "../bridge/engine";
import { getV86Backend } from "../bridge/v86";
import { isolationReport, logInfo, logWarn } from "../core/log";
import { rememberEngine } from "./engine-viewer";

const ARCH_LABEL: Record<MachineArch, string> = {
  x86_32: "x86 (32-bit)",
  x86_64: "x86-64",
  arm64: "ARM64",
};

const GREEN = "\x1b[38;2;46;204;113m";
const RED = "\x1b[38;2;231;76;60m";
const DIM = "\x1b[38;2;102;102;102m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export interface TerminalOptions {
  /**
   * A shell script to *print* into the console. Not run: nothing here feeds
   * the guest's stdin, because a script pasted into a root shell is a
   * command, not a document. The console is where you read it.
   */
  print?: { path: string; text: string };
}

export function openTerminal(win: Win, options: TerminalOptions = {}): void {
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
  saveStateBtn.title = "Save the machine state on this device; the next start resumes from it";
  saveStateBtn.style.display = "none";
  const viewEngineBtn = el("button", "tool-btn", "View Engine");
  viewEngineBtn.title =
    "Open the Engine Viewer: the VGA display of this terminal's machine, live";
  viewEngineBtn.style.display = "none";
  const devBtn = el("button", "tool-btn", "Dev Console");
  devBtn.title = "Toggle the built-in developer console (Eruda)";
  toolbar.append(reconnectBtn, saveStateBtn, viewEngineBtn, devBtn);

  viewEngineBtn.addEventListener("click", () => {
    if (!backend?.getScreen) {
      logWarn("terminal", "this engine has no display to show");
      return;
    }
    /* The viewer mirrors the machine that owns this terminal, not "a" machine:
       two terminals are two v86 instances, and each asks for its own. */
    rememberEngine(backend);
    /* The launcher owns window creation; this is the same seam the App Store
       uses to open an app nobody here has a handle on. */
    window.dispatchEvent(new CustomEvent("d86-launch-app", { detail: "engine-viewer" }));
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
     page's console — including all [D86] diagnostics. */
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
     The guest sends bare \n (LF) and an emulated serial console does NOT
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

  /* A script printed into the console: shown once, right after the console
     is cleared for a connection, so it is not wiped by the engine's banner. */
  let pendingPrint = options.print ?? null;
  const flushPrint = (): void => {
    if (!pendingPrint) return;
    const { path, text } = pendingPrint;
    pendingPrint = null;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const body = text.replace(/\r\n/g, "\n");
    const lines = body.split("\n");
    term.writeln("");
    term.writeln(`${DIM}── ${path} — printed, not run ─────────────────${RESET}`);
    for (const line of lines) term.writeln(line);
    if (lines[lines.length - 1] === "") lines.pop();
    term.writeln(`${DIM}── end of ${name} · ${lines.length} line(s) · nothing was executed ──${RESET}`);
    term.writeln("");
    setChip("offline", `Printed ${name} (not run)`);
  };

  /** Honest refusal: v64 can emulate an ARM64 machine, but Dragon86 ships
      no ARM64 kernel or distro, so there is nothing truthful to boot. */
  const noDistroBanner = (arch: MachineArch) => {
    term.clear();
    term.writeln(`${BOLD}${RED}  ╔══════════════════════════════════════════╗${RESET}`);
    term.writeln(`${BOLD}${RED}  ║        DRAGON86  ·  TERMINAL             ║${RESET}`);
    term.writeln(`${BOLD}${RED}  ╚══════════════════════════════════════════╝${RESET}`);
    term.writeln("");
    term.writeln(`  ${GREEN}●${RESET} Terminal emulator : ready`);
    term.writeln(`  ${RED}●${RESET} ${ARCH_LABEL[arch]} machine : no operating system installed`);
    term.writeln("");
    term.writeln(`  The ${ARCH_LABEL[arch]} machine can be emulated, but Dragon86 does not`);
    term.writeln(`  ship a kernel or distro for it yet — there is nothing to boot.`);
    term.writeln("");
    term.writeln(`  Pick ${BOLD}x86 (32-bit)${RESET} or ${BOLD}x86-64${RESET} in Settings → Engine: both boot`);
    term.writeln(`  the installed Arch userland from your filesystem's own /.`);
    term.writeln("");
    setChip("offline", `No ${ARCH_LABEL[arch]} operating system installed`);
  };

  /* The window title says which machine is behind this terminal. The user
     picks an architecture; the emulator behind it is an implementation
     detail (bridge/v86.ts). */
  const engineLabel = (): string => {
    const arch = getSettings().arch;
    return arch === "arm64"
      ? `Terminal — ${ARCH_LABEL.arm64} (no OS installed)`
      : `Terminal — ${ARCH_LABEL[arch]} · Arch Linux`;
  };
  const refreshTitle = () => win.setTitle(engineLabel());
  refreshTitle();
  let offSettings: (() => void) | null = onSettingsChange(() => {
    /* A closed window leaves the element detached; drop the subscription
       instead of holding the whole terminal alive. */
    if (!win.el.isConnected) {
      offSettings?.();
      offSettings = null;
      return;
    }
    refreshTitle();
  });

  const connect = async (freshBoot = false) => {
    refreshTitle();
    const arch = getSettings().arch;
    backend?.dispose();
    backend = null;
    if (arch === "arm64") {
      saveStateBtn.style.display = "none";
      viewEngineBtn.style.display = "none";
      flushPrint();
      noDistroBanner(arch);
      return;
    }
    saveStateBtn.style.display = "";
    viewEngineBtn.style.display = "";
    logInfo(
      "terminal",
      `connect arch=${arch} (in-page engine, no isolation needed) boot=${freshBoot ? "image" : "saved-state-if-present"}`,
    );
    setChip("connecting", "Connecting…");
    term.clear();
    flushPrint();
    term.writeln(`${DIM}Starting the ${ARCH_LABEL[arch]} machine (Arch userland, in-page).${RESET}`);
    term.writeln(`${DIM}Its root filesystem is YOUR filesystem: the guest's / is the / that Files shows.${RESET}`);
    term.writeln(`${DIM}First boot unpacks the distro into / once; after that it just boots.${RESET}`);
    term.writeln(`${DIM}/home/user in the guest is your home — Documents, Downloads and Desktop included.${RESET}`);
    if (arch === "x86_64") {
      term.writeln(`${DIM}x86-64 machine: the installed distro is 32-bit and boots the way it would on real 64-bit hardware.${RESET}`);
    }
    if (freshBoot) {
      term.writeln(`${DIM}Reconnect: fresh boot from the guest image — saved state is not loaded.${RESET}`);
    }
    term.writeln(`${DIM}Network is emulated; in the guest run /networking.sh to bring the card up.${RESET}`);
    term.writeln(`${DIM}In the guest:  git clone https://…  works,  d86-net check  tests the link.${RESET}`);
    /* A snapshot can only be resumed safely within the session that took
       it: it remembers the guest's open files, and those are handles in a
       9p server that no longer exists after a reload. Resuming one was
       "Session ended" forever, so a new page always cold-boots. */
    const vb = getV86Backend({
      onData: (data) => term.write(filterOutput(data)),
      onNotice: (text) => term.writeln(`${DIM}[engine] ${text}${RESET}`),
      onStatus: (s) => {
        if (s === "ready") {
          setChip("online", `Arch online · ${ARCH_LABEL[arch]}`);
          term.focus();
        } else {
          setChip("connecting", "Still starting…");
          term.writeln(`${RED}The machine is still booting.${RESET}`);
          term.writeln(`${DIM}Keep this window open — bash appears automatically when ready, or hit Reconnect.${RESET}`);
        }
      },
    }, freshBoot);
    backend = vb;
    rememberEngine(vb);
    vb.connect();
  };

  reconnectBtn.addEventListener("click", () => void connect(true));

  /* Closing the window must shut the engine down. Without this the machine
     kept running invisibly: reopening the Terminal started a *second* emulator
     beside the first one, both writing to the same ZenFS root, and the guest's
     shell died on boot ("Session ended … Respawning in 2s"). */
  win.setOnClose(() => {
    offSettings?.();
    offSettings = null;
    ro.disconnect();
    backend?.dispose();
    backend = null;
    try {
      term.dispose();
    } catch {
      /* already gone */
    }
  });

  term.onData((data) => backend?.write(data));
  term.onResize(({ cols, rows }) => backend?.resize(cols, rows));

  void connect();
}
