#!/usr/bin/env node
/**
 * Tests for the Preview app's parsers (public/system-apps/preview/parsers.js),
 * run against files built here byte by byte.
 *
 * Preview is the default app for pictures, sound, video, PDFs, 3D models and
 * disc images. The pictures/sound/video/PDF half is the browser's own
 * decoders, so there is nothing to test; everything Preview itself parses —
 * STL, OBJ, PLY, glTF/GLB and ISO9660 — is tested here, because a parser bug
 * shows up as a blank window and a shrug.
 *
 *   node tools/test-preview.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../public/system-apps/preview/parsers.js"), "utf8");

/* parsers.js attaches itself to `window` (or globalThis) and to module.exports. */
const sandbox = { TextDecoder, atob, console, Uint8Array, Float32Array, DataView, JSON, Math, Error, parseInt, parseFloat, isNaN, Infinity };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const P = sandbox.PreviewParsers;

let failures = 0;
function check(name, ok, extra = "") {
  if (ok) console.log(`[PASS] ${name}`);
  else {
    failures++;
    console.log(`[FAIL] ${name}${extra ? `  (${extra})` : ""}`);
  }
}

/* ---------- STL ---------- */

function binarySTL(triangles) {
  const buf = new ArrayBuffer(84 + triangles.length * 50);
  const dv = new DataView(buf);
  new Uint8Array(buf, 0, 80).set(new TextEncoder().encode("test part".padEnd(80, "\0")));
  dv.setUint32(80, triangles.length, true);
  triangles.forEach((tri, i) => {
    const at = 84 + i * 50;
    dv.setFloat32(at, 0, true); // normal — ignored by the parser, recomputed later
    dv.setFloat32(at + 4, 0, true);
    dv.setFloat32(at + 8, 1, true);
    tri.forEach((v, j) => {
      dv.setFloat32(at + 12 + j * 12, v[0], true);
      dv.setFloat32(at + 12 + j * 12 + 4, v[1], true);
      dv.setFloat32(at + 12 + j * 12 + 8, v[2], true);
    });
  });
  return new Uint8Array(buf);
}

const cubeCorner = [
  [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
  [[0, 0, 0], [0, 10, 0], [0, 0, 10]],
];
const stl = P.parseSTL(binarySTL(cubeCorner));
check("binary STL: triangle count", stl.triangles === 2, String(stl.triangles));
check("binary STL: 18 floats out", stl.positions.length === 18, String(stl.positions.length));
check("binary STL: bounds are real", stl.bounds.max[0] === 10 && stl.bounds.max[1] === 10 && stl.bounds.max[2] === 10, JSON.stringify(stl.bounds));

const ascii = `solid tri
 facet normal 0 0 1
  outer loop
   vertex 0 0 0
   vertex 2 0 0
   vertex 0 2 1
  endloop
 endfacet
endsolid tri`;
const stlA = P.parseSTL(new TextEncoder().encode(ascii));
check("ASCII STL: triangle count", stlA.triangles === 1, String(stlA.triangles));
check("ASCII STL: coordinates survive", stlA.positions[8] === 1, String(stlA.positions[8]));

let threw = "";
try {
  P.parseSTL(new TextEncoder().encode("not a model at all, just prose"));
} catch (err) {
  threw = err.message;
}
check("STL: garbage is refused with a reason", /too short|neither a binary nor an ASCII STL/.test(threw), threw);

/* ---------- OBJ ---------- */

const obj = `# a square
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
f 1 2 3
f 1 3 4
`;
const o = P.parseOBJ(obj);
check("OBJ: two triangles", o.triangles === 2, String(o.triangles));
check("OBJ: quad split into triangles", o.positions.length === 18, String(o.positions.length));
const objQuad = P.parseOBJ("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n");
check("OBJ: an n-gon fans out", objQuad.triangles === 2, String(objQuad.triangles));
threw = "";
try {
  P.parseOBJ("v 0 0 0\nf 9 9 9\n");
} catch (err) {
  threw = err.message;
}
check("OBJ: out-of-range faces are refused", /vertices it does not define/.test(threw), threw);

/* ---------- PLY (ASCII) ---------- */

const ply = `ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
element face 1
property list uchar int vertex_indices
end_header
0 0 0
1 0 0
0 1 0
3 0 1 2
`;
const pl = P.parsePLY(new TextEncoder().encode(ply));
check("PLY: one triangle", pl.triangles === 1, String(pl.triangles));
check("PLY: coordinates survive", pl.positions[3] === 1, String(pl.positions[3]));

/* ---------- GLB ---------- */

function glb(positions, indices) {
  const bin = new ArrayBuffer(positions.length * 4 + indices.length * 2);
  new Float32Array(bin, 0, positions.length).set(positions);
  new Uint16Array(bin, positions.length * 4, indices.length).set(indices);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length * 4 },
      { buffer: 0, byteOffset: positions.length * 4, byteLength: indices.length * 2 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: indices.length, type: "SCALAR" },
    ],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.length + jsonPad);
    padded.set(jsonBytes);
    padded.fill(0x20, jsonBytes.length);
    jsonBytes = padded;
  }
  const binBytes = new Uint8Array(bin);
  const binPad = (4 - (binBytes.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length + binPad;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  let at = 20 + jsonBytes.length;
  dv.setUint32(at, binBytes.length, true);
  dv.setUint32(at + 4, 0x004e4942, true);
  out.set(binBytes, at + 8);
  return out;
}

const g = P.parseGLB(glb([0, 0, 0, 2, 0, 0, 0, 2, 0], [0, 1, 2]));
check("GLB: one triangle", g.triangles === 1, String(g.triangles));
check("GLB: positions read through the accessor", g.bounds.max[0] === 2 && g.bounds.max[1] === 2, JSON.stringify(g.bounds));

/* A node transform must move the geometry — that is how most exports put a
   model on the floor rather than at the origin. */
const moved = {
  asset: { version: "2.0" },
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, translation: [0, 5, 0] }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  buffers: [{ byteLength: 36 }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
};
const bytes = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const c = P.parseGLTFText(JSON.stringify({
  ...moved,
  buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${Buffer.from(bytes.buffer).toString("base64")}` }],
}));
check("glTF with a data: URI buffer parses", c.triangles === 1, String(c.triangles));
check("glTF node translation is applied", c.bounds.min[1] === 5, JSON.stringify(c.bounds));

const external = P.parseGLTFText(JSON.stringify({
  ...moved,
  buffers: [{ byteLength: 36, uri: "model.bin" }],
}));
check(
  "glTF with a side-car .bin says so instead of drawing half a model",
  /separate \.bin/.test(external.warning),
  external.warning,
);

threw = "";
try {
  P.parseGLB(new TextEncoder().encode("this is not a glb at all"));
} catch (err) {
  threw = err.message;
}
check("GLB: bad magic is refused", /bad magic|too short/.test(threw), threw);

/* ---------- ISO 9660 ---------- */

function buildISO() {
  const SECTOR = 2048;
  const sectors = 24;
  const img = new Uint8Array(SECTOR * sectors);
  const dv = new DataView(img.buffer);
  const both = (at, value, size) => {
    if (size === 4) {
      dv.setUint32(at, value, true);
      dv.setUint32(at + 4, value, false);
    } else {
      dv.setUint16(at, value, true);
      dv.setUint16(at + 2, value, false);
    }
  };
  const dirRecord = (at, { lba, size, flags, name }) => {
    const nameBytes = typeof name === "string" ? new TextEncoder().encode(name) : name;
    const len = 33 + nameBytes.length + (nameBytes.length % 2 === 0 ? 1 : 0);
    img[at] = len;
    img[at + 1] = 0;
    both(at + 2, lba, 4);
    both(at + 10, size, 4);
    img[at + 25] = flags;
    both(at + 28, 1, 2);
    img[at + 32] = nameBytes.length;
    img.set(nameBytes, at + 33);
    return len;
  };

  /* Primary volume descriptor, sector 16. */
  const pvd = 16 * SECTOR;
  img[pvd] = 1;
  img.set(new TextEncoder().encode("CD001"), pvd + 1);
  img[pvd + 6] = 1;
  img.set(new TextEncoder().encode("D86TEST".padEnd(32, " ")), pvd + 40);
  dirRecord(pvd + 156, { lba: 20, size: SECTOR, flags: 2, name: new Uint8Array([0]) });
  img.set(new TextEncoder().encode("CD001"), 17 * SECTOR + 1); // terminator-ish

  /* Root directory, sector 20. */
  let at = 20 * SECTOR;
  at += dirRecord(at, { lba: 20, size: SECTOR, flags: 2, name: new Uint8Array([0]) });
  at += dirRecord(at, { lba: 20, size: SECTOR, flags: 2, name: new Uint8Array([1]) });
  at += dirRecord(at, { lba: 21, size: 5, flags: 0, name: "HELLO.TXT;1" });
  at += dirRecord(at, { lba: 22, size: SECTOR, flags: 2, name: "SUBDIR" });

  /* A second-level directory, so depth walking is covered. */
  let sub = 22 * SECTOR;
  sub += dirRecord(sub, { lba: 22, size: SECTOR, flags: 2, name: new Uint8Array([0]) });
  sub += dirRecord(sub, { lba: 20, size: SECTOR, flags: 2, name: new Uint8Array([1]) });
  sub += dirRecord(sub, { lba: 23, size: 3, flags: 0, name: "INNER.BIN;1" });

  img.set(new TextEncoder().encode("hello"), 21 * SECTOR);
  img.set(new TextEncoder().encode("abc"), 23 * SECTOR);
  return img;
}

const iso = P.parseISO(buildISO());
check("ISO: volume label read", iso.label === "D86TEST", iso.label);
const names = iso.entries.map((e) => e.name);
check("ISO: top-level file listed without the ;1 version", names.includes("HELLO.TXT"), names.join(", "));
check("ISO: directory listed", iso.entries.some((e) => e.isDir && e.name === "SUBDIR"));
check("ISO: file sizes come from the directory record", iso.entries.find((e) => e.name === "HELLO.TXT")?.size === 5);
check("ISO: one level down is walked", iso.entries.some((e) => e.name === "INNER.BIN" && e.depth === 1), JSON.stringify(iso.entries.map((e) => `${e.name}@${e.depth}`)));
check("ISO: dot and dot-dot are not listed", !names.includes(".") && !names.includes(".."));

threw = "";
try {
  P.parseISO(new Uint8Array(2048 * 40));
} catch (err) {
  threw = err.message;
}
check("ISO: a non-ISO image says why", /ISO9660|UDF/.test(threw), threw);

/* ---------- the manifest agrees with the code ---------- */

const html = readFileSync(resolve(here, "../public/system-apps/preview/index.html"), "utf8");
check("index.html loads the parsers first", html.indexOf("parsers.js") < html.indexOf("app.js"));
const appJs = readFileSync(resolve(here, "../public/system-apps/preview/app.js"), "utf8");
for (const ext of ["png", "jpg", "gif", "svg", "heif", "wav", "mp3", "ogg", "mp4", "mov", "pdf", "glb", "stl", "obj", "iso"]) {
  check(`app.js knows .${ext}`, new RegExp(`\\b${ext}\\b`).test(appJs));
}
const manifest = readFileSync(resolve(here, "../public/system-apps/preview/index.json"), "utf8");
for (const file of ["index.html", "app.js", "parsers.js", "icon.svg"]) {
  check(`the app's file list ships ${file}`, manifest.includes(file));
}

/* ---------- the app itself, in a real DOM ---------- */
/* Not a browser (jsdom has no WebGL, no media decoders), but enough to prove
   the wiring: the file arrives, the right branch runs, and the status line
   says something true about it. */
{
  const html = readFileSync(resolve(here, "../public/system-apps/preview/index.html"), "utf8");
  const appSource = readFileSync(resolve(here, "../public/system-apps/preview/app.js"), "utf8");
  const dom = new JSDOM(html.replace(/<script[^>]*><\/script>/g, ""), {
    url: "https://example.test/Dragon86/9pf/preview/index.html?file=%2Fhome%2Fuser%2FDesktop%2Fpart.stl",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.error ?? e.message));
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.fetch = async () => ({
    ok: true,
    status: 200,
    async arrayBuffer() {
      return binarySTL(cubeCorner).buffer.slice(0);
    },
  });
  window.eval(source);
  window.eval(appSource);
  await new Promise((r) => setTimeout(r, 300));

  check("the app boots with a file without throwing", errors.length === 0, errors.map(String).join(" | ").slice(0, 200));
  check(
    "it names the file it was given",
    window.document.getElementById("title").textContent === "part.stl",
    window.document.getElementById("title").textContent,
  );
  check(
    "an STL is parsed and reported as triangles",
    /2 triangles/.test(window.document.getElementById("meta").textContent),
    window.document.getElementById("meta").textContent,
  );
  check(
    "no WebGL means a plain explanation, not a blank pane",
    /no WebGL/i.test(window.document.getElementById("main").textContent),
    window.document.getElementById("main").textContent.trim().slice(0, 120),
  );
  check(
    "the app reads the file through the 9pf route",
    /9pf\/@open/.test(appSource),
  );
  dom.window.close();
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
