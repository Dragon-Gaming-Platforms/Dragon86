/**
 * Terminal — xterm.js front end.
 *
 * The machine behind it is an in-page emulator chosen by the architecture
 * in Settings: the x86 machines (bridge/v86.ts, the v64 build) and the
 * RISC-V 64 machine (bridge/rv64.ts, the rv64.js build), all booting the
 * installed distro from the OS filesystem's own `/`. ARM64 is emulatable
 * (v64) but no ARM64 distro is installed, so it refuses honestly instead
 * of pretending.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { el } from "../core/dom";
import { getSettings, onSettingsChange, type MachineArch } from "../core/settings";
import type { Win } from "../core/wm";
import type { TerminalBackend } from "../bridge/engine";
import { getV86Backend } from "../bridge/v86";
import { getRV64Backend } from "../bridge/rv64";
import { netbsdInstalled } from "../bridge/netbsd64";
import { distroInstalled, installedDistro, DISTROS, type DistroId } from "../bridge/guest-root";
import * as vfs from "../core/vfs";
import { isolationReport, logInfo, logWarn } from "../core/log";
import { rememberEngine } from "./engine-viewer";

const ARCH_LABEL: Record<MachineArch, string> = {
  x86_32: "x86 (32-bit)",
  x86_64: "x86-64",
  arm64: "ARM64",
  arm32: "ARM32",
  riscv64: "RISC-V 64",
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

  /** Honest refusal: the ARM64 machine is real, but its OS is a disk image
      in browser storage, and that image has not been installed yet. */
  const noDistroBanner = (arch: MachineArch) => {
    term.clear();
    term.writeln(`${BOLD}${RED}  ╔══════════════════════════════════════════╗${RESET}`);
    term.writeln(`${BOLD}${RED}  ║        DRAGON86  ·  TERMINAL             ║${RESET}`);
    term.writeln(`${BOLD}${RED}  ╚══════════════════════════════════════════╝${RESET}`);
    term.writeln("");
    term.writeln(`  ${GREEN}●${RESET} Terminal emulator : ready`);
    term.writeln(`  ${GREEN}●${RESET} ${ARCH_LABEL[arch]} machine : ready`);
    term.writeln(`  ${RED}●${RESET} Operating system  : not installed`);
    term.writeln("");
    term.writeln(`  The machine has nothing to boot: no ${ARCH_LABEL[arch]} disk image is installed.`);
    term.writeln("");
    term.writeln(`  Open the ${BOLD}App Store${RESET} and install ${BOLD}NetBSD (${ARCH_LABEL[arch]})${RESET} — the OS built`);
    term.writeln(`  for this machine. Unlike the Linux distros it does not unpack`);
    term.writeln(`  into /: it boots from its own disk image in browser storage.`);
    term.writeln(`  Then hit ${BOLD}Reconnect${RESET} here.`);
    term.writeln("");
    setChip("offline", `No ${ARCH_LABEL[arch]} operating system installed — see the App Store`);
  };

  /** Honest refusal, the other kind: the machine is fine, but no operating
      system has been installed yet. The distro lives in the App Store. */
  const noOsBanner = (arch: MachineArch) => {
    term.clear();
    term.writeln(`${BOLD}${RED}  ╔══════════════════════════════════════════╗${RESET}`);
    term.writeln(`${BOLD}${RED}  ║        DRAGON86  ·  TERMINAL             ║${RESET}`);
    term.writeln(`${BOLD}${RED}  ╚══════════════════════════════════════════╝${RESET}`);
    term.writeln("");
    term.writeln(`  ${GREEN}●${RESET} Terminal emulator : ready`);
    term.writeln(`  ${GREEN}●${RESET} ${ARCH_LABEL[arch]} machine : ready`);
    term.writeln(`  ${RED}●${RESET} Operating system  : not installed`);
    term.writeln("");
    term.writeln(`  The machine has nothing to boot: no OS is installed in /.`);
    term.writeln("");
    if (arch === "riscv64") {
      term.writeln(`  Open the ${BOLD}App Store${RESET} and install ${BOLD}${DISTROS["alpine-rv64"].name}${RESET} —`);
      term.writeln(`  the OS built for this machine. It unpacks a real Alpine riscv64`);
      term.writeln(`  userland into your filesystem's /, and this machine boots it.`);
      term.writeln(`  Then hit ${BOLD}Reconnect${RESET} here.`);
    } else {
      term.writeln(`  Open the ${BOLD}App Store${RESET} and install ${BOLD}Arch Linux${RESET} — (x86) runs on both`);
      term.writeln(`  x86 machines, (x86-64) only on the x86-64 machine. It unpacks a`);
      term.writeln(`  real Arch userland into your filesystem's /, and this machine`);
      term.writeln(`  boots it. Then hit ${BOLD}Reconnect${RESET} here.`);
    }
    term.writeln("");
    setChip("offline", "No operating system installed — see the App Store");
  };

  /** Honest refusal, the third kind: an OS is installed, but this CPU
      cannot run it — Arch Linux (x86-64) on the 32-bit machine, Alpine
      (RISC-V 64) on any x86 machine, or Arch on the RISC-V machine. The
      same rule real hardware enforces (the one allowed direction, the
      32-bit x86 OS on the x86-64 machine, boots fine). */
  const wrongArchBanner = (arch: MachineArch, distro: DistroId) => {
    const distroName = DISTROS[distro].name;
    /* The machines whose CPU can actually boot this OS, by their labels. */
    const needs = DISTROS[distro].runsOn
      .map((a) => ARCH_LABEL[a as MachineArch] ?? a)
      .join(" or ");
    term.clear();
    term.writeln(`${BOLD}${RED}  ╔══════════════════════════════════════════╗${RESET}`);
    term.writeln(`${BOLD}${RED}  ║        DRAGON86  ·  TERMINAL             ║${RESET}`);
    term.writeln(`${BOLD}${RED}  ╚══════════════════════════════════════════╝${RESET}`);
    term.writeln("");
    term.writeln(`  ${GREEN}●${RESET} Terminal emulator : ready`);
    term.writeln(`  ${GREEN}●${RESET} ${ARCH_LABEL[arch]} machine : ready`);
    term.writeln(`  ${RED}●${RESET} Operating system  : ${distroName} — needs ${needs}`);
    term.writeln("");
    term.writeln(`  ${distroName} is installed in /, but this machine's CPU is`);
    term.writeln(`  ${ARCH_LABEL[arch]} — that kernel cannot run on it, here or on real`);
    term.writeln(`  hardware.`);
    term.writeln("");
    term.writeln(`  Switch Settings → Machine to ${BOLD}${needs}${RESET}, or install an OS`);
    term.writeln(`  built for this machine from the ${BOLD}App Store${RESET}.`);
    term.writeln("");
    setChip("offline", `${distroName} needs the ${needs} machine`);
  };

  /* The window title says which machine is behind this terminal. The user
     picks an architecture; the emulator behind it is an implementation
     detail (bridge/v86.ts). */
  const engineLabel = (): string => {
    const arch = getSettings().arch;
    if (arch === "arm64" || arch === "arm32") return `Terminal — ${ARCH_LABEL[arch]} · NetBSD`;
    if (arch === "riscv64") return `Terminal — ${ARCH_LABEL.riscv64} · Alpine Linux`;
    return `Terminal — ${ARCH_LABEL[arch]} · Arch Linux`;
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
    const isArm = arch === "arm64" || arch === "arm32";
    if (arch === "arm64" || arch === "arm32") {
      /* The ARM OSes are disk images in browser storage, not a userland
         in ZenFS / — so the / checks below do not apply to them. */
      if (!(await netbsdInstalled(arch))) {
        saveStateBtn.style.display = "none";
        viewEngineBtn.style.display = "none";
        flushPrint();
        noDistroBanner(arch);
        return;
      }
    } else {
      if (!(await distroInstalled(vfs.GUEST_ROOT))) {
        saveStateBtn.style.display = "none";
        viewEngineBtn.style.display = "none";
        flushPrint();
        noOsBanner(arch);
        return;
      }
      const distro = await installedDistro(vfs.GUEST_ROOT);
      if (distro && !DISTROS[distro].runsOn.includes(arch)) {
        saveStateBtn.style.display = "none";
        viewEngineBtn.style.display = "none";
        flushPrint();
        wrongArchBanner(arch, distro);
        return;
      }
    }
    /* The RISC-V machine has no snapshot API and no display device, and
       the ARM64 machine has neither snapshots nor a screen yet, so the
       buttons that promise those stay hidden instead of lying. */
    const isRv = arch === "riscv64";
    saveStateBtn.style.display = isRv || isArm ? "none" : "";
    viewEngineBtn.style.display = isRv || isArm ? "none" : "";
    logInfo(
      "terminal",
      `connect arch=${arch} (in-page engine, no isolation needed) boot=${freshBoot ? "image" : "saved-state-if-present"}`,
    );
    setChip("connecting", "Connecting…");
    term.clear();
    flushPrint();
    const osName = isArm ? "NetBSD" : isRv ? "Alpine" : "Arch";
    term.writeln(`${DIM}Starting the ${ARCH_LABEL[arch]} machine (${osName}, in-page).${RESET}`);
    if (isArm) {
      term.writeln(`${DIM}NetBSD boots from its own disk image in browser storage — its files are NOT in Files.${RESET}`);
      term.writeln(`${DIM}Changes persist inside that image. Log in as: root (no password).${RESET}`);
      term.writeln(`${DIM}This machine has no screen or network yet — the serial console here IS its console.${RESET}`);
      term.writeln(`${DIM}Shut down cleanly with: shutdown -p now${RESET}`);
    } else {
      term.writeln(`${DIM}Its root filesystem is YOUR filesystem: the guest's / is the / that Files shows.${RESET}`);
      term.writeln(`${DIM}It boots the ${osName} userland installed in / (App Store → ${isRv ? DISTROS["alpine-rv64"].name : "Arch Linux"}).${RESET}`);
      term.writeln(`${DIM}/home/user in the guest is your home — Documents, Downloads and Desktop included.${RESET}`);
    }
    if (arch === "x86_64") {
      term.writeln(`${DIM}x86-64 machine: the installed distro is 32-bit and boots the way it would on real 64-bit hardware.${RESET}`);
    }
    if (freshBoot) {
      term.writeln(`${DIM}Reconnect: fresh boot from the guest image${isRv || isArm ? "" : " — saved state is not loaded"}.${RESET}`);
    }
    if (isArm) {
      /* said above — nothing more to promise */
    } else if (isRv) {
      term.writeln(`${DIM}Network comes up by itself (the emulator's fetch backend): git clone https://… just works.${RESET}`);
      term.writeln(`${DIM}This machine has no screen — the serial console here IS its console.${RESET}`);
    } else {
      term.writeln(`${DIM}Network is emulated; in the guest run /networking.sh to bring the card up.${RESET}`);
      term.writeln(`${DIM}In the guest:  git clone https://…  works,  d86-net check  tests the link.${RESET}`);
    }
    const handlers = {
      onData: (data: string) => term.write(filterOutput(data)),
      onNotice: (text: string) => term.writeln(`${DIM}[engine] ${text}${RESET}`),
      onStatus: (s: "ready" | "offline") => {
        if (s === "ready") {
          setChip("online", `${osName} online · ${ARCH_LABEL[arch]}`);
          term.focus();
        } else {
          setChip("connecting", "Still starting…");
          term.writeln(`${RED}The machine is still booting.${RESET}`);
          term.writeln(`${DIM}Keep this window open — bash appears automatically when ready, or hit Reconnect.${RESET}`);
        }
      },
    };
    /* A snapshot can only be resumed safely within the session that took
       it: it remembers the guest's open files, and those are handles in a
       9p server that no longer exists after a reload. Resuming one was
       "Session ended" forever, so a new page always cold-boots. */
    if (isRv) {
      /* No rememberEngine: the Engine Viewer shows a machine's display,
         and this machine has none — registering it would make the viewer
         wait forever for a screen that cannot exist. */
      const rb = getRV64Backend(handlers);
      backend = rb;
      rb.connect();
    } else if (isArm) {
      /* Same engine module as x86, but no rememberEngine: the virt board
         runs without a display here (serial console only, for now). */
      const vb = getV86Backend(handlers, freshBoot);
      backend = vb;
      vb.connect();
    } else {
      const vb = getV86Backend(handlers, freshBoot);
      backend = vb;
      rememberEngine(vb);
      vb.connect();
    }
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
