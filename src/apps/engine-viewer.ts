/**
 * Engine Viewer — the machine's own screen.
 *
 * The Terminal shows the v86 guest's *serial* console: a byte stream. The
 * machine also has a VGA display, which is what the BIOS draws on and what
 * the kernel logs to (the guest is booted with `console=tty0 console=ttyS0`).
 * This window mirrors that display, live, on a canvas.
 *
 * Why a canvas and not the emulator's own DOM: v86's screen adapter owns the
 * elements it creates, and reparenting them into a second window breaks the
 * terminal's rendering. Reading the text screen and drawing it ourselves
 * keeps the two windows independent — closing one cannot damage the other.
 *
 * The rows arrive with ANSI colour escapes (the machine is built with
 * `screen: { ansi: true }`), so ansi-text.ts understands the subset a console
 * actually emits; bridge/v86-screen.ts knows where libv86 keeps them.
 *
 * The window never holds a machine *snapshot*: it asks for the current one on
 * every frame. So it can be opened before the Terminal (it attaches when the
 * machine appears), after it (it attaches straight away), and it keeps
 * telling the truth while the machine is booting or after its Terminal has
 * been closed.
 */

import { el } from "../core/dom";
import { logInfo, logWarn } from "../core/log";
import type { Win } from "../core/wm";
import type { EngineScreen, TerminalBackend } from "../bridge/hoster";
import { rowsWithText } from "../bridge/v86-screen";

/** The machine last handed to the viewer, so the start menu can find one. */
let lastEngine: TerminalBackend | null = null;

/** Called by whoever starts a v86 machine (the Terminal does). */
export function rememberEngine(backend: TerminalBackend | null): void {
  lastEngine = backend;
}

export function engineForViewer(): TerminalBackend | null {
  return lastEngine;
}

/* The colour parsing lives in ansi-text.ts: pure functions, no DOM. */
export { parseRow, plainRow } from "./ansi-text";
import { DEFAULT_BG, parseRow } from "./ansi-text";

/* ---------- the window ---------- */

const FRAME_MS = 140;

/** What the window can see right now. */
type Look =
  | { state: "none" }
  | { state: "stopped" }
  | { state: "waiting" }
  | { state: "screen"; screen: EngineScreen };

export function openEngineViewer(win: Win, backend?: TerminalBackend | null): void {
  const root = el("div", "app-root engine-viewer");
  const stage = el("div", "engine-stage");
  const canvas = document.createElement("canvas");
  canvas.className = "engine-canvas";
  stage.append(canvas);
  const status = el("div", "app-statusbar");
  status.textContent = "Engine Viewer — looking for a machine…";
  const hint = el(
    "div",
    "engine-hint",
    "The machine's VGA display (BIOS, kernel log, and anything drawn on screen). " +
      "The shell itself is on the serial console, in the Terminal window.",
  );
  root.append(stage, hint, status);
  win.el.append(root);

  const ctx = canvas.getContext("2d");
  const seen = { key: "" };
  let timer: number | null = null;
  let alive = true;

  /**
   * Which machine to show: the most recently attached one (attach is the
   * latest statement of intent — the Terminal calls it whenever it starts a
   * machine), falling back to the machine this window was opened from.
   * There is no chain past that: an older machine that is still running must
   * not stand in for the one that was just pointed at.
   */
  const current = (): TerminalBackend | null => engineForViewer() ?? backend ?? null;

  /** True when the backend still owns a live machine. */
  const running = (candidate: TerminalBackend): boolean =>
    candidate.isRunning?.() ?? typeof candidate.getScreen === "function";

  const look = (): Look => {
    const live = current();
    if (!live) return { state: "none" };
    if (!running(live)) return { state: "stopped" };
    const screen = live.getScreen?.() ?? null;
    return screen ? { state: "screen", screen } : { state: "waiting" };
  };

  const NO_MACHINE = "No v86 machine has been started yet — open the Terminal and pick the v86 engine.";
  const STOPPED = "That machine has stopped: its Terminal window was closed. Open a new Terminal (v86).";
  const WAITING = "The machine is running, but its display is not readable yet — it is probably still booting.";

  const blankNotice = (text: string): void => {
    if (!ctx) return;
    const width = stage.clientWidth || 640;
    ctx.fillStyle = DEFAULT_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#7c7c7c";
    ctx.font = "13px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "top";
    /* Wrap by hand: a message that runs off the canvas is not a message. */
    const maxChars = Math.max(24, Math.floor((width - 32) / 7.2));
    const words = text.split(" ");
    let line = "";
    let y = 20;
    for (const word of words) {
      if ((line + word).length > maxChars) {
        ctx.fillText(line.trim(), 16, y);
        y += 19;
        line = "";
      }
      line += `${word} `;
    }
    if (line.trim()) ctx.fillText(line.trim(), 16, y);
  };

  const paint = (view: Look): void => {
    const width = stage.clientWidth || 640;
    const height = stage.clientHeight || 400;

    if (view.state !== "screen") {
      const message =
        view.state === "none" ? NO_MACHINE : view.state === "stopped" ? STOPPED : WAITING;
      status.textContent = message;
      if (seen.key !== view.state) {
        seen.key = view.state;
        canvas.width = Math.max(1, Math.floor(width * (window.devicePixelRatio || 1)));
        canvas.height = Math.max(1, Math.floor(height * (window.devicePixelRatio || 1)));
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        if (ctx) ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
        blankNotice(message);
      }
      return;
    }

    const { screen } = view;
    const key = `${screen.cols}x${screen.rows}:${screen.lines.join("\n")}`;
    if (key === seen.key) return;
    seen.key = key;

    if (!ctx) {
      /* No canvas support (or a test harness): still tell the truth. */
      status.textContent = `VGA text screen · ${screen.cols}×${screen.rows} · ${rowsWithText(
        screen,
      )} row(s) with text · this browser cannot draw on a canvas`;
      return;
    }

    /* Fit the grid: a character cell is ~0.6em wide and ~1.2em tall, so the
       whole screen scales to the window without a scrollbar. */
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const fontSize = Math.max(
      6,
      Math.min(width / (screen.cols * 0.62), height / (screen.rows * 1.22)),
    );
    const cellW = fontSize * 0.62;
    const cellH = fontSize * 1.22;
    const gridW = Math.ceil(screen.cols * cellW);
    const gridH = Math.ceil(screen.rows * cellH);

    canvas.width = Math.max(1, Math.floor(gridW * dpr));
    canvas.height = Math.max(1, Math.floor(gridH * dpr));
    canvas.style.width = `${gridW}px`;
    canvas.style.height = `${gridH}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = DEFAULT_BG;
    ctx.fillRect(0, 0, gridW, gridH);
    ctx.textBaseline = "top";
    ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

    let maxUsedRow = 0;
    for (let row = 0; row < screen.lines.length; row++) {
      const runs = parseRow(screen.lines[row]);
      let col = 0;
      for (const run of runs) {
        if (run.bg !== "transparent") {
          ctx.fillStyle = run.bg;
          ctx.fillRect(col * cellW, row * cellH, run.text.length * cellW, cellH);
        }
        if (run.text.trim()) maxUsedRow = Math.max(maxUsedRow, row);
        ctx.fillStyle = run.fg;
        ctx.fillText(run.text, col * cellW, row * cellH + (cellH - fontSize) / 2);
        col += run.text.length;
      }
    }
    const filled = rowsWithText(screen);
    status.textContent =
      filled === 0
        ? `VGA text screen · ${screen.cols}×${screen.rows} · blank — the guest has not drawn anything here`
        : `VGA text screen · ${screen.cols}×${screen.rows} · ${filled} row(s) of text · last written row ${maxUsedRow + 1}`;
  };

  const tick = () => {
    if (!alive) return;
    try {
      paint(look());
    } catch (err) {
      logWarn("engine-viewer", "could not read the screen", err);
      alive = false;
      if (timer !== null) window.clearInterval(timer);
    }
  };

  tick();
  timer = window.setInterval(tick, FRAME_MS);
  {
    const live = current();
    logInfo(
      "engine-viewer",
      `opened; machine ${live ? (running(live) ? "running" : "stopped") : "none yet"}`,
    );
  }

  /* Repaint when the window is resized: the grid is fitted to the stage. */
  const observer =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          seen.key = "";
          tick();
        })
      : null;
  observer?.observe(stage);

  win.setOnClose(() => {
    alive = false;
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    observer?.disconnect();
  });
}
