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
 * The rows arrive with ANSI colour escapes (v86 is asked for `ansi: true`),
 * so the parser below understands the subset a console actually emits.
 */

import { el } from "../core/dom";
import { logInfo, logWarn } from "../core/log";
import type { Win } from "../core/wm";
import type { EngineScreen, TerminalBackend } from "../bridge/hoster";

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

export function openEngineViewer(win: Win, backend: TerminalBackend | null): void {
  const root = el("div", "app-root engine-viewer");
  const stage = el("div", "engine-stage");
  const canvas = document.createElement("canvas");
  canvas.className = "engine-canvas";
  stage.append(canvas);
  const status = el("div", "app-statusbar");
  status.textContent = "Engine Viewer — waiting for a v86 machine";
  const hint = el(
    "div",
    "engine-hint",
    "This is the machine's VGA display. The shell itself is on the serial console in the Terminal window.",
  );
  root.append(stage, hint, status);
  win.el.append(root);

  const ctx = canvas.getContext("2d");
  const seen = { text: "" };
  let timer: number | null = null;
  let alive = true;

  const paint = (screen: EngineScreen | null) => {
    const width = stage.clientWidth || 640;
    const height = stage.clientHeight || 400;
    if (!ctx) {
      /* No canvas support (or a test harness): still tell the truth. */
      status.textContent = screen
        ? `VGA text screen · ${screen.cols}×${screen.rows} · this browser cannot draw on a canvas`
        : "Engine Viewer — no v86 machine running in this window";
      return;
    }
    if (!screen) {
      status.textContent = "Engine Viewer — no v86 machine running; start one with Terminal";
      if (seen.text !== "∅") {
        seen.text = "∅";
        ctx.fillStyle = DEFAULT_BG;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#7a7a7a";
        ctx.font = "13px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillText("No machine. Open a Terminal with the v86 engine.", 16, 28);
      }
      return;
    }

    const key = `${screen.cols}x${screen.rows}:${screen.lines.join("\n")}`;
    if (key === seen.text) return;
    seen.text = key;

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
    status.textContent = `VGA text screen · ${screen.cols}×${screen.rows} · last write on row ${maxUsedRow + 1}`;
  };

  const tick = () => {
    if (!alive) return;
    try {
      paint(backend?.getScreen?.() ?? null);
    } catch (err) {
      logWarn("engine-viewer", "could not read the screen", err);
      alive = false;
      if (timer !== null) window.clearInterval(timer);
    }
  };

  logInfo("engine-viewer", backend ? "showing the machine's VGA screen" : "opened with no machine");
  tick();
  timer = window.setInterval(tick, FRAME_MS);

  /* Repaint when the window is resized: the grid is fitted to the stage. */
  const observer =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          seen.text = "";
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
