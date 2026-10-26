/**
 * VGA text-screen rows → coloured runs.
 *
 * v86 hands the machine's screen over as one string per row, with ANSI SGR
 * escapes for colour (see bridge/v86.ts). This module turns that into
 * something a canvas can draw, and nothing else: no DOM, no imports, so it
 * can be tested on its own (tools/test-engine-viewer.mjs).
 */

export const DEFAULT_FG = "#d6d6d6";
export const DEFAULT_BG = "#0a0a0c";

/** The 80-column VGA palette, plus the 16 bright ones. */
export const PALETTE = [
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

export interface Run {
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
    const rest = row.slice(i);
    /* ESC [ params m is colour. Anything else (a cursor move, an erase) is
       not something a text screen dump legitimately contains, and its
       parameters must not be left behind as characters — skip the whole
       sequence, letters and all. */
    const match = /^\x1b\[([0-9;]*)m/.exec(rest);
    if (!match) {
      const other = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(rest);
      i += other ? other[0].length : 1;
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

