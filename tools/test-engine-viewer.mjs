#!/usr/bin/env node
/**
 * Tests for src/apps/ansi-text.ts — the VGA text-row parser behind the
 * Engine Viewer.
 *
 * v86 hands the machine's screen over as text rows with ANSI SGR escapes
 * (truecolour, `\x1b[48;2;r;g;bm` for the background and
 * `\x1b[38;2;r;g;bm` for the character). Those rows go straight onto a
 * canvas, so the parser has to be exact: a dropped escape shows up as
 * garbage digits, and a merged run puts a colour in the wrong column.
 *
 * The module has no imports at all, which is what makes this possible: Node
 * strips the types and the real file runs unchanged (no bundle, no build).
 *
 *   node --experimental-strip-types tools/test-engine-viewer.mjs
 */
import { readFileSync } from "node:fs";

const module = await import("../src/apps/ansi-text.ts");
const { parseRow, plainRow, PALETTE, DEFAULT_FG } = module;

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}  ${detail}`);
  }
}

const text = (row) => plainRow(row);
const fgs = (row) => parseRow(row).map((r) => r.fg);
const bgs = (row) => parseRow(row).map((r) => r.bg);

/* ---- plain rows ---- */
{
  const runs = parseRow("Dragon86 Linux 6.12.0");
  check("a plain row is one run", runs.length === 1, JSON.stringify(runs));
  check("…in the default colour", runs[0]?.fg === DEFAULT_FG, runs[0]?.fg);
  check("…with no background", runs[0]?.bg === "transparent", runs[0]?.bg);
  check("…and keeps every character", runs[0]?.text === "Dragon86 Linux 6.12.0", runs[0]?.text);
  check("a blank row is empty", parseRow("").length === 0);
  check("a row of spaces is not", parseRow("   ").length === 1);
  check("plainRow leaves plain text alone", text("hello") === "hello");
}

/* ---- v86's own format: 24-bit colour, background first ---- */
{
  const row = "\x1b[48;2;0;0;128m\x1b[38;2;255;255;255mWelcome\x1b[0m";
  const runs = parseRow(row);
  check("v86 truecolour: one run", runs.length === 1, JSON.stringify(runs));
  check("v86 truecolour: background", runs[0]?.bg === "rgb(0,0,128)", runs[0]?.bg);
  check("v86 truecolour: foreground", runs[0]?.fg === "rgb(255,255,255)", runs[0]?.fg);
  check("v86 truecolour: no escape digits in the text", runs[0]?.text === "Welcome", runs[0]?.text);
  check("v86 truecolour: trailing reset adds nothing", plainRow(row) === "Welcome");
}

/* ---- classic attributes ---- */
{
  check("SGR 31 is red", fgs("\x1b[31mx")[0] === PALETTE[1], fgs("\x1b[31mx")[0]);
  check("SGR 32 is green", fgs("\x1b[32mx")[0] === PALETTE[2]);
  check("SGR 90 is bright", fgs("\x1b[90mx")[0] === PALETTE[8]);
  check("SGR 0 resets", fgs("a\x1b[31mb\x1b[0mc").join("|") === `${DEFAULT_FG}|${PALETTE[1]}|${DEFAULT_FG}`);
  check("SGR 39 resets the foreground only", fgs("\x1b[31ma\x1b[39mb").join("|") === `${PALETTE[1]}|${DEFAULT_FG}`);
  check("SGR 44 sets a blue background", bgs("\x1b[44mx")[0] === PALETTE[4], bgs("\x1b[44mx")[0]);
  check("SGR 49 clears the background", bgs("\x1b[44ma\x1b[49mb").join("|") === `${PALETTE[4]}|transparent`);
  check("bold is tracked", parseRow("\x1b[1mx")[0]?.bold === true);
  check("bold can be turned off", parseRow("\x1b[1ma\x1b[22mb").map((r) => r.bold).join(",") === "true,false");
}

/* ---- 256-colour ---- */
{
  check("38;5;n picks palette entry", fgs("\x1b[38;5;9mx")[0] === PALETTE[9], fgs("\x1b[38;5;9mx")[0]);
  check(
    "38;5;n above 232 is a grey ramp",
    /^rgb\(\d+,\d+,\d+\)$/.test(fgs("\x1b[38;5;240mx")[0] ?? ""),
    fgs("\x1b[38;5;240mx")[0],
  );
}

/* ---- things that must not leak into the drawing ---- */
{
  check("a cursor-control escape is dropped", plainRow("\x1b[2Ja") === "a", JSON.stringify(plainRow("\x1b[2Ja")));
  check("a bare escape byte is dropped", !plainRow("a\x1bb").includes("\x1b"));
  check("an unknown SGR code is ignored", parseRow("\x1b[38mx")[0]?.text === "x");
  check("column count survives escapes", text("\x1b[31mab\x1b[0m\x1b[32mcd\x1b[0m") === "abcd");
  check(
    "colours are per run, not per row",
    parseRow("\x1b[31ma\x1b[32mb").map((r) => r.text).join("") === "ab" &&
      fgs("\x1b[31ma\x1b[32mb").join("|") === `${PALETTE[1]}|${PALETTE[2]}`,
  );
}

/* ---- the viewer really uses it ---- */
{
  const source = readFileSync(new URL("../src/apps/engine-viewer.ts", import.meta.url), "utf8");
  check("the Engine Viewer draws from the parser", /from "\.\/ansi-text"/.test(source));
  check("…cell by cell", /parseRow\(screen\.lines\[row\]\)/.test(source));
  check("…on a canvas", /createElement\("canvas"\)/.test(source));
  check("…reading the machine's screen", /getScreen\?\.\(\)/.test(source));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
