/**
 * Reading a v86 machine's VGA text screen.
 *
 * This used to be guessed at, and guessed wrong: the emulator object does
 * *not* carry `get_text_screen` or `screen` — libv86 keeps the text buffer in
 * its screen adapter, which it assigns to `screen_adapter` a few milliseconds
 * after the constructor returns (the assignment happens once the emulator's
 * own init has run, so it is not there at `new V86(...)` time either).
 *
 *     emu.screen_adapter.get_text_screen()   ← the real API
 *       → one string per row, 80 columns wide, ANSI truecolour escapes
 *         (`\x1b[48;2;r;g;bm` for the cell background, `\x1b[38;2;r;g;bm`
 *         for the character), ending in `\x1b[0m`
 *
 * The build also accepts `screen`/`get_text_screen` on the emulator itself if
 * a future libv86 forwards them, so this keeps working when the vendored
 * file is bumped.
 *
 * No DOM and no imports beyond types: tools/test-engine-viewer.mjs runs the
 * real file in Node, and tools/vm/boot.mjs checks it against a booted machine.
 */

import type { EngineScreen } from "./hoster";

/** Anything that might hold a text screen — the real emulator, or a stand-in. */
export interface TextScreenSource {
  get_text_screen?: () => string[];
  screen?: { get_text_screen?: () => string[] };
  /** What libv86 exposes (see the header): where the VGA actually draws. */
  screen_adapter?: { get_text_screen?: () => string[] };
}

/** Colour escapes, for measuring a row's real width. */
const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** A row's characters, escapes removed. */
export function stripEscapes(row: string): string {
  return row.replace(SGR, "");
}

/**
 * True when a remembered emulator can still answer: the adapter is only
 * assigned once the machine has finished constructing, so "no adapter yet"
 * is a boot state, not an error.
 */
export function hasTextScreen(emu: TextScreenSource | null | undefined): boolean {
  return typeof readerFor(emu) === "function";
}

/** Pairs of [object holding the method, method]. */
type Reader = () => string[];

function readerFor(emu: TextScreenSource | null | undefined): Reader | null {
  if (!emu) return null;
  const holders: Array<[object, (() => string[]) | undefined]> = [
    [emu.screen_adapter!, emu.screen_adapter?.get_text_screen],
    [emu.screen!, emu.screen?.get_text_screen],
    [emu, emu.get_text_screen],
  ];
  for (const [holder, method] of holders) {
    /* `this` matters: the adapter's method reads its own text buffer, so a
       detached function (`.bind(null)`, a stored reference) reads nothing. */
    if (typeof method === "function") return () => method.call(holder);
  }
  return null;
}

/**
 * The machine's display as rows, or null when there is nothing to read yet.
 * Rows come back padded to the screen width, so the widest row (escapes
 * removed) is the column count — there is no size getter in the API.
 */
export function textScreenFrom(emu: TextScreenSource | null | undefined): EngineScreen | null {
  const read = readerFor(emu);
  if (!read) return null;

  let lines: string[];
  try {
    lines = read();
  } catch {
    return null;
  }
  if (!Array.isArray(lines) || !lines.length) return null;

  let cols = 0;
  for (const line of lines) {
    const plain = stripEscapes(String(line));
    if (plain.length > cols) cols = plain.length;
  }
  return { cols: Math.max(cols, 1), rows: lines.length, lines };
}

/** How many rows actually have something on them. */
export function rowsWithText(screen: EngineScreen): number {
  let count = 0;
  for (const line of screen.lines) if (stripEscapes(line).trim()) count++;
  return count;
}
