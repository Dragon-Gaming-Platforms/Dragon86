#!/usr/bin/env node
/**
 * Tests for the Engine Viewer's two pure pieces:
 *   - src/apps/ansi-text.ts     — the VGA text-row parser (colour escapes)
 *   - src/bridge/v86-screen.ts  — where the machine's screen is read from
 *
 * The second one is the bug this file now guards: the emulator does not
 * expose `get_text_screen` where it looks obvious. It lives on the screen
 * adapter under `screen_adapter`, the method reads its own buffer (so it
 * cannot be detached from `this`), and the adapter appears a few
 * milliseconds after the constructor — all three states have to be handled
 * without claiming "no v86 machine".
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

/* ---- where the screen comes from (src/bridge/v86-screen.ts) ---- */
const screenModule = await import("../src/bridge/v86-screen.ts");
const { textScreenFrom, hasTextScreen, rowsWithText, stripEscapes } = screenModule;
{
  /* A stand-in for libv86's adapter: a method that needs its own `this`,
     exactly like the real one (which reads `this.text_screen`). */
  const adapter = {
    text_screen: ["\x1b[48;2;0;0;0m\x1b[38;2;168;168;168mhello\x1b[0m", "  world", ""],
    get_text_screen() {
      return this.text_screen;
    },
  };

  check("the adapter is where the screen is read", textScreenFrom({ screen_adapter: adapter })?.rows === 3);
  let detached = "no throw";
  try {
    detached = adapter.get_text_screen.call(null);
  } catch (err) {
    /* This is the bug that made the viewer read nothing: a method taken off
       the adapter and called without it cannot see the screen. */
    detached = `threw: ${err.message}`;
  }
  check("…so the detached method does not work", detached.startsWith("threw:"), detached);
  check("…and it is still called with its owner", textScreenFrom({ screen_adapter: adapter })?.lines[1] === "  world");
  check("hasTextScreen is true with an adapter", hasTextScreen({ screen_adapter: adapter }));
  check("hasTextScreen: the old emu.screen path still works", hasTextScreen({ screen: adapter }));
  check("hasTextScreen: a top-level get_text_screen still works", hasTextScreen(adapter));
  check("no adapter yet → null, not a throw", textScreenFrom({}) === null);
  check("no emulator → null", textScreenFrom(null) === null && textScreenFrom(undefined) === null);
  check("hasTextScreen is false before the adapter exists", !hasTextScreen({}));

  const blank = { get_text_screen: () => [] };
  check("an empty screen is null, not an exception", textScreenFrom(blank) === null);
  const thrower = {
    get_text_screen() {
      throw new Error("not in text mode");
    },
  };
  check("a throwing adapter is null, not a crash", textScreenFrom(thrower) === null);
  check("a non-array answer is null", textScreenFrom({ get_text_screen: () => "nope" }) === null);

  /* Column count: there is no size getter, so it is the widest row after the
     escapes are removed. Padded rows from a real screen make this exact. */
  const wide = { get_text_screen: () => ["\x1b[31mabc\x1b[0m", "abcdefgh"] };
  const measured = textScreenFrom(wide);
  check("columns = the widest row, escapes excluded", measured?.cols === 8, String(measured?.cols));
  const narrow = textScreenFrom({ get_text_screen: () => [""] });
  check("a screen of blank rows still has a width", narrow?.cols === 1 && narrow?.rows === 1);

  check("stripEscapes leaves the characters", stripEscapes("\x1b[1;32mok\x1b[0m") === "ok");
  check("rowsWithText counts the written rows", rowsWithText(textScreenFrom(wide)) === 2);
  check(
    "rowsWithText ignores whitespace",
    rowsWithText({ cols: 4, rows: 2, lines: ["    ", "\x1b[2J  "] }) === 0,
  );
}

/* ---- the viewer really uses it ---- */
{
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const source = read("../src/apps/engine-viewer.ts");
  const bridge = read("../src/bridge/v86.ts");
  check("the Engine Viewer draws from the parser", /from "\.\/ansi-text"/.test(source));
  check("…cell by cell", /parseRow\(screen\.lines\[row\]\)/.test(source));
  check("…on a canvas", /createElement\("canvas"\)/.test(source));
  check("…reading the machine's screen", /getScreen\?\.\(\)/.test(source));
  check("…through the shared screen reader", /from "\.\.\/bridge\/v86-screen"/.test(source));
  check("…asking each machine on every frame", /engineForViewer\(\)/.test(source));

  /* The three states must be distinguishable: "no machine", "a machine whose
     Terminal was closed", "a machine still booting". One message for all
     three is exactly the bug that was reported. */
  check("the viewer knows a machine may be stopped", /state: "stopped"/.test(source));
  check("the viewer knows a machine may be booting", /state: "waiting"/.test(source));
  check("…and only says \"no machine\" for none", /No v86 machine has been started yet/.test(source));

  check("the bridge reads the screen through v86-screen", /textScreenFrom\(this\.emu\)/.test(bridge));
  check("the bridge tells the truth about liveness", /isRunning\(\): boolean/.test(bridge));

  /* v86 draws its own screen into a container we give it — that element is
     what the viewer mounts. Screen options must be under `opts.screen`: a
     top-level `container`/`ansi` is silently ignored by libv86. */
  check("the machine is given a screen container", /screen: \{ container: this\.ensureScreenHost\(\) \}/.test(bridge));
  check("…created before the machine starts", /ensureScreenHost\(\): HTMLDivElement/.test(bridge));
  check("…and handed to the viewer", /screenElement\(\): HTMLElement \| null/.test(bridge));
  check("…not a top-level screen option", !/^\s*ansi: true,/m.test(bridge) && !/^\s*container:/m.test(bridge));

  /* The viewer must show that element, not a re-drawing of the screen. */
  check("the viewer mounts the machine's screen", /screenElement\?\.\(\)/.test(source));
  check("…scaled to the window", /translate\(-50%, -50%\) scale\(/.test(source));
  check("…and takes it back out when the window closes", /mount\(null\)/.test(source));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
