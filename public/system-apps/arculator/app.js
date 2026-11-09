"use strict";
/**
 * Archimedes (Arculator WASM) — Dragon86 front-end.
 *
 * The emulator is upstream pdjstone/arculator-wasm (GPL-2.0), vendored by
 * .github/workflows/build-arculator.yml with NO operating system: the user
 * supplies an Arthur / RISC OS ROM image once, and it is kept in IndexedDB
 * in THIS browser (never uploaded anywhere — there is no server).
 *
 * Boot contract with the emulator (same as upstream's own front-end):
 *  - a global `Module` must exist before arculator.data.js / arculator.js
 *    load; `noInitialRun` so MEMFS can be provisioned first;
 *  - MEMFS needs /configs/<machine>.cfg, /arc.cfg, /cmos/<family>/cmos.bin,
 *    /roms/<rom_set>/<rom file>, /roms/arcrom_ext (GPL support ROM: HostFS
 *    + absolute mouse sync — this is why the pointer just works, uncaptured);
 *  - then callMain([fps, machineName]); fps "0" = requestAnimationFrame.
 *
 * CMOS (the machine's settings memory) is persisted back to IndexedDB every
 * few seconds and on exit, so *Configure* changes survive reopening the app.
 * No COOP/COEP/SharedArrayBuffer anywhere: the emulator runs on the main
 * thread, exactly like upstream's site.
 */

/* ---------- tiny IndexedDB layer (this app's own database) ---------- */

const DB_NAME = "dragon86-arculator";
const DB_STORE = "files";

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE).objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}
async function dbSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbDel(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- machine presets (mirrors upstream's MachineConfigBuilder) ---------- */

const FAMILIES = {
  arthur: { machine: "a310", mem: 1024, cpu: 0, memc: 0, fdc: 0, romSet: "arthur120", cmos: "arthur", label: "A310 · Arthur 1.20" },
  riscos2: { machine: "a310", mem: 4096, cpu: 0, memc: 0, fdc: 0, romSet: "riscos201", cmos: "riscos2", label: "A310 · RISC OS 2" },
  "riscos3-a3000": { machine: "a3000", mem: 4096, cpu: 0, memc: 1, fdc: 0, romSet: "riscos311", cmos: "riscos3_old", label: "A3000 · RISC OS 3" },
  "riscos3-a5000": { machine: "a5000", mem: 4096, cpu: 3, memc: 2, fdc: 1, romSet: "riscos311", cmos: "riscos3_new", label: "A5000 · RISC OS 3" },
};

function machineCfg(p) {
  return `machine = ${p.machine}
disc_name_0 = 
disc_name_1 = 
disc_name_2 = 
disc_name_3 = 
mem_size = ${p.mem}
cpu_type = ${p.cpu}
memc_type = ${p.memc}
fpa = 0
fpu_type = 1
display_mode = 0
double_scan = 1
video_scale = 1
video_fullscreen_scale = 0
video_linear_filtering = 0
fdc_type = ${p.fdc}
st506_present = 1
rom_set = ${p.romSet}
monitor_type = multisync
joystick_if = none
unique_id = -490017344
hd4_fn = 
hd4_sectors = 63
hd4_heads = 16
hd4_cylinders = 100
hd5_fn = 
hd5_sectors = 63
hd5_heads = 16
hd5_cylinders = 100
renderer_driver = auto
podule_0 = arculator_rom
podule_1 = 
podule_2 = 
podule_3 = 
5th_column_fn = 
support_rom_enabled = 1

[Joysticks]
joystick_0_nr = 0
joystick_1_nr = 0
`;
}

const ARC_CFG = `sound_enable = 1
first_fullscreen = 0
stereo = 1
sound_gain = 0
sound_filter = 0
disc_noise_gain = 0
`;

/* ---------- UI handles ---------- */

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
function say(text, isErr) {
  statusEl.textContent = text;
  statusEl.classList.toggle("err", !!isErr);
  if (isErr) console.error("[arculator]", text);
}

/* ---------- setup screen ---------- */

const MIN_ROM = 256 * 1024;
const MAX_ROM = 8 * 1024 * 1024;

async function showSetup() {
  $("setup").classList.remove("hidden");
  say("no ROM saved yet — the machine cannot start without one");
  const fileInput = $("romfile");
  const startBtn = $("start");
  fileInput.onchange = () => {
    startBtn.disabled = !fileInput.files?.length;
  };
  startBtn.onclick = async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    if (f.size < MIN_ROM || f.size > MAX_ROM) {
      say(`${f.name} is ${f.size} bytes — an Archimedes OS ROM is between 512 KB and 4 MB, this cannot be one`, true);
      return;
    }
    startBtn.disabled = true;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      await dbSet("rom", { name: f.name, family: $("family").value, bytes });
      $("setup").classList.add("hidden");
      await boot();
    } catch (err) {
      startBtn.disabled = false;
      say(`could not save the ROM: ${err?.message ?? err}`, true);
    }
  };
}

/* ---------- boot ---------- */

let preset = null;
let cmosMachinePath = null;
let lastSavedCmos = null;

async function boot() {
  const rom = await dbGet("rom");
  if (!rom) return showSetup();
  preset = FAMILIES[rom.family] ?? FAMILIES["riscos3-a3000"];
  $("screenwrap").classList.remove("hidden");
  $("controls").classList.remove("hidden");
  say(`fetching machine parts… (${preset.label})`);

  /* Fetch the support ROM and default CMOS while the runtime loads. The
     saved CMOS from a previous session wins over the default. */
  const fetchBin = async (name) => {
    const res = await fetch(name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  const partsPromise = Promise.all([fetchBin("arcrom_ext"), fetchBin(`cmos-${preset.cmos}.bin`), dbGet("cmos")]);

  cmosMachinePath = `cmos/${preset.machine}.${preset.cmos}.cmos.bin`;

  window.Module = {
    canvas: $("canvas"),
    noInitialRun: true,
    preRun: [() => {
      ENV.SDL_EMSCRIPTEN_KEYBOARD_ELEMENT = "#canvas";
    }],
    print: (t) => console.log("[arc]", t),
    printErr: (t) => console.warn("[arc]", t),
    onAbort: (what) => say(`the emulator aborted: ${what}`, true),
    setStatus: () => {},
    onRuntimeInitialized: async () => {
      try {
        const [supportRom, defaultCmos, savedCmos] = await partsPromise;
        FS.createPath("/", "configs");
        FS.createPath("/", `cmos/${preset.cmos}`);
        FS.createPath("/", `roms/${preset.romSet}`);
        FS.createPath("/", "hostfs");
        FS.createPath("/", "discs");
        FS.writeFile("arc.cfg", ARC_CFG);
        FS.writeFile(`configs/${preset.machine}.cfg`, machineCfg(preset));
        const cmos = savedCmos && savedCmos.family === preset.cmos ? savedCmos.bytes : defaultCmos;
        FS.writeFile(`cmos/${preset.cmos}/cmos.bin`, cmos);
        FS.writeFile(cmosMachinePath, cmos);
        FS.writeFile("roms/arcrom_ext", supportRom);
        FS.writeFile(`roms/${preset.romSet}/${sanitize(preset.romSet, rom.name)}`, rom.bytes);
        say(`switching on — ${preset.label}, ROM “${rom.name}”. Sound starts after your first click or key.`);
        callMain(["0", preset.machine]);
        startCmosPersistence();
      } catch (err) {
        say(`boot failed: ${err?.message ?? err}`, true);
      }
    },
  };

  wireControls();

  /* Script order matters: .data.js registers the preload with Module,
     arculator.js starts the runtime. */
  await injectScript("arculator.data.js");
  await injectScript("arculator.js");
}

/** The ROM loader reads every non-.txt file in the rom_set directory, so a
 *  name that collides with nothing else is enough. Strip path separators. */
function sanitize(romSet, name) {
  const clean = String(name).split(/[\\/]/).pop()?.replace(/[^\w.!-]+/g, "_") || "rom";
  return clean.toLowerCase().endsWith(".txt") ? clean + ".rom" : clean;
}

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`${src} failed to load — is the app fully installed?`));
    document.body.append(s);
  });
}

/* ---------- CMOS persistence (Configure changes survive reopening) ---------- */

function startCmosPersistence() {
  const save = () => {
    try {
      const bytes = FS.readFile(cmosMachinePath);
      const key = Array.from(bytes).join(",");
      if (key === lastSavedCmos) return;
      lastSavedCmos = key;
      void dbSet("cmos", { family: preset.cmos, bytes });
    } catch {
      /* file not written yet — nothing to save */
    }
  };
  setInterval(save, 5000);
  addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save();
  });
}

/* ---------- controls ---------- */

function wireControls() {
  const discInput = $("discfile");
  $("insert").onclick = () => discInput.click();
  discInput.onchange = async () => {
    const f = discInput.files?.[0];
    if (!f) return;
    try {
      const path = `/discs/${sanitize("", f.name)}`;
      FS.writeFile(path, new Uint8Array(await f.arrayBuffer()));
      ccall("arc_disc_change", null, ["number", "string"], [0, path]);
      $("eject").disabled = false;
      say(`disc “${f.name}” in drive :0`);
    } catch (err) {
      say(`could not insert the disc: ${err?.message ?? err}`, true);
    }
    discInput.value = "";
  };
  $("eject").onclick = () => {
    try {
      ccall("arc_disc_eject", null, ["number"], [0]);
      $("eject").disabled = true;
      say("drive :0 is empty");
    } catch (err) {
      say(`eject failed: ${err?.message ?? err}`, true);
    }
  };
  $("reset").onclick = () => {
    try {
      ccall("arc_do_reset", null, [], []);
      say("machine reset");
    } catch (err) {
      say(`reset failed: ${err?.message ?? err}`, true);
    }
  };
  $("fullscreen").onclick = () => {
    $("canvas").requestFullscreen?.().catch((err) => say(`fullscreen refused: ${err?.message ?? err}`, true));
  };
  $("changerom").onclick = async () => {
    if (!confirm("Remove the saved ROM (and the machine's CMOS settings) from this browser? The app reloads and asks for a ROM again.")) return;
    await dbDel("rom");
    await dbDel("cmos");
    location.reload();
  };

  /* Browsers only let audio start after a user gesture; SDL's context is
     created suspended. Resume it on the first interaction. */
  const unlock = () => {
    const ctx = window.Module?.SDL2?.audioContext;
    if (ctx && ctx.state === "suspended") void ctx.resume();
    $("canvas").focus();
  };
  addEventListener("pointerdown", unlock);
  addEventListener("keydown", unlock, { once: true });
}

/* ---------- go ---------- */

window.addEventListener("error", (e) => {
  if (String(e.message).includes("ResizeObserver")) return;
  say(`error: ${e.message}`, true);
});

boot().catch((err) => say(`startup failed: ${err?.message ?? err}`, true));
