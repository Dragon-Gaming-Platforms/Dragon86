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

/* ---------- colours ---------- */

const DEFAULT_FG = "#d6d6d6";
const DEFAULT_BG = "#0a0a0c";

/** The 80-column VGA palette, plus the 16 bright ones. */
const PALETTE = [
  "#1a1a1a",
  "#c14a4a",
  "#5fa85f",
  "#c8a24a",
  "#4a7fc1",
  "#a55fb0",
  "#4aa6b0",
  "#c8c8c8",
  "#5a5a5a",
  "#ff6b6b",
  "#7ee787",
  "#ffd479",
  "#79b8ff",
  "#e39ff6",
  "#79e0e8",
  "#ffffff",
];

interface Run {
  text: string;
  fg: string;
  bg: string;
  bold: boolean;
}

/**
 * Split one row into coloured runs. Unknown or malformed escapes are
 * dropped rather than shown — a console that prints garbage is worse than
 * one that loses an unsupported attribute.
 */
export function parseRow(row: string): Run[] {
  const runs: Run[] = [];
  let fg = DEFAULT_FG;
  let bg = "transparent";
  let bold = false;
  let text = "";
  let i = 0;

  const flush = () => {
    if (!text) return;
    runs.push({ text, fg, bg, bold });
    text = "";
  };

  while (i < row.length) {
    const ch = row[i];
    if (ch !== "\x1b") {
      text += ch;
      i++;
      continue;
    }
    /* ESC [ params m — everything else (cursor moves and the like) is not
       something a text screen dump legitimately contains; skip it. */
    const match = /^\x1b\[([0-9;]*)m/.exec(row.slice(i));
    if (!match) {
      i += 2;
      continue;
    }
    flush();
    const params = match[1] ? match[1].split(";").map((n) => Number(n) || 0) : [0];
    for (let p = 0; p < params.length; p++) {
      const code = params[p];
      if (code === 0) {
        fg = DEFAULT_FG;
        bg = "transparent";
        bold = false;
      } else if (code === 1) {
        bold = true;
      } else if (code === 22) {
        bold = false;
      } else if (code === 39) {
        fg = DEFAULT_FG;
      } else if (code === 49) {
        bg = "transparent";
      } else if (code >= 30 && code <= 37) {
        fg = PALETTE[code - 30];
      } else if (code >= 90 && code <= 97) {
        fg = PALETTE[code - 90 + 8];
      } else if (code >= 40 && code <= 47) {
        bg = PALETTE[code - 40];
      } else if (code >= 100 && code <= 107) {
        bg = PALETTE[code - 100 + 8];
      } else if (code === 38 || code === 48) {
        /* 38;2;r;g;b (truecolour) and 38;5;n (256-colour). */
        if (params[p + 1] === 2 && p + 4 < params.length) {
          const colour = `rgb(${params[p + 2]},${params[p + 3]},${params[p + 4]})`;
          if (code === 38) fg = colour;
          else bg = colour;
          p += 4;
        } else if (params[p + 1] === 5 && p + 2 < params.length) {
          const n = params[p + 2];
          const colour = n < 16 ? PALETTE[n] : n >= 232 ? `rgb(${8 + (n - 232) * 10},${8 + (n - 232) * 10},${8 + (n - 232) * 10})` : "#888888";
          if (code === 38) fg = colour;
          else bg = colour;
          p += 2;
        }
      }
    }
    i += match[0].length;
  }
  flush();
  return runs;
}

/** The characters of a row, escapes removed. */
export function plainRow(row: string): string {
  return parseRow(row)
    .map((run) => run.text)
    .join("");
}

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
