/**
 * Headless ARM boot harness — boots the vendored disk-image OSes on the
 * real v64 ARM machines in Node.
 *
 * This is the browser-side proof a QEMU boot test cannot give: the app
 * boots these packs on v64's virt board (cpu_type "arm64"/"arm32", one
 * wasm core), and QEMU's board is not v64's board — NetBSD/armv7 boots
 * QEMU's 32-bit virt (GICv2 default) and dies silently on v64's (GICv3
 * only), which is exactly the failure this harness exists to catch. It
 * runs the same public/v64/libv86.js + v86-arm64.wasm against the
 * committed pack and fails unless the OS reaches its login prompt and
 * answers a command as root — mirroring src/bridge/v86.ts startArm()
 * option for option, except the disk: the app streams it into OPFS
 * (browser-only), here it is a raw file the engine opens by path (libv86
 * under Node takes file paths as urls). cpu_worker is also browser-only
 * (it exists for the OPFS write-back handle), so the machine runs on the
 * main thread here.
 *
 *   node tools/vm/boot-arm.mjs --arch arm32      Alpine pack  (default)
 *   node tools/vm/boot-arm.mjs --arch arm64      NetBSD pack
 *
 * The raw disk is inflated to /tmp/d86-<pack>-root.img on first run and
 * reused after (delete it to force a fresh one; the guest writes into it).
 * Env: BOOT_TIMEOUT=<ms> (default 600000 — a wasm-interpreted kernel boot
 * takes minutes), VERBOSE=1 to watch the console.
 */
import { createRequire } from "node:module";
import { createGunzip, gunzipSync } from "node:zlib";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

const ARCH = process.argv.includes("--arch") ? process.argv[process.argv.indexOf("--arch") + 1] : "arm32";
if (ARCH !== "arm32" && ARCH !== "arm64") {
  console.error(`unknown --arch ${ARCH} (arm32 or arm64)`);
  process.exit(1);
}
/* One pack per machine — the same map src/bridge/netbsd64.ts ships. */
const PACK_DIR = ARCH === "arm32" ? "alpine32" : "netbsd64";
const PACK = resolve(repo, `public/${PACK_DIR}`);
const DISK = `/tmp/d86-${PACK_DIR}-root.img`;
const BOOT_TIMEOUT = Number(process.env.BOOT_TIMEOUT ?? 600000);

const manifest = JSON.parse(readFileSync(resolve(PACK, "manifest.json"), "utf8"));

/* The split .gz parts, inflated through one stream — the same byte stream
   the App Store install pipes into OPFS. */
async function inflateDisk() {
  if (existsSync(DISK) && statSync(DISK).size === manifest.root.rawBytes) {
    console.log(`[harness] reusing ${DISK}`);
    return;
  }
  console.log(`[harness] inflating ${manifest.root.parts.length} parts into ${DISK} ...`);
  const out = createWriteStream(DISK);
  const gunzip = createGunzip();
  gunzip.pipe(out);
  for (const part of manifest.root.parts) {
    await new Promise((res, rej) => {
      const s = createReadStream(resolve(PACK, part.file));
      s.on("end", res);
      s.on("error", rej);
      s.pipe(gunzip, { end: false });
    });
  }
  gunzip.end();
  await new Promise((r) => out.on("finish", r));
  const size = statSync(DISK).size;
  if (size !== manifest.root.rawBytes) {
    console.error(`[harness] inflated ${size} bytes, manifest says ${manifest.root.rawBytes}`);
    process.exit(1);
  }
}

/* libv86.js is a classic script; require it under a .cjs name (same trick
   as boot.mjs, same reason). */
const LIBV86 = resolve(here, "build/libv86.cjs");
mkdirSync(dirname(LIBV86), { recursive: true });
writeFileSync(LIBV86, readFileSync(resolve(repo, "public/v64/libv86.js")));
const { V86 } = require(LIBV86);

let serial = "";
function onByte(b) {
  serial += String.fromCharCode(b);
  if (process.env.VERBOSE) process.stdout.write(String.fromCharCode(b));
}
const waitFor = async (pattern, timeoutMs) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (pattern.test(serial)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

async function main() {
  await inflateDisk();
  const kernel = gunzipSync(readFileSync(resolve(PACK, manifest.kernel.file)));
  if (kernel.byteLength !== manifest.kernel.rawBytes) {
    console.error(`[harness] kernel is ${kernel.byteLength} bytes, manifest says ${manifest.kernel.rawBytes}`);
    process.exit(1);
  }

  /* The initrd ships as the kernel wants it (a compressed cpio the kernel
     inflates itself) — fetched whole, passed whole, like the bridge. */
  const initrd = manifest.initrd ? readFileSync(resolve(PACK, manifest.initrd.file)) : null;

  /* Mirrors bridge/v86.ts startArm(), minus the browser-only pieces
     (cpu_worker + the opfs: disk url — see the header). */
  const emu = new V86({
    cpu_type: ARCH,
    wasm_path: resolve(repo, "public/v64/v86-arm64.wasm"),
    memory_size: 512 * 1024 * 1024,
    kernel: { buffer: kernel.buffer.slice(kernel.byteOffset, kernel.byteOffset + kernel.byteLength) },
    ...(initrd ? { initrd: { buffer: initrd.buffer.slice(initrd.byteOffset, initrd.byteOffset + initrd.byteLength) } } : {}),
    cmdline: `root=${manifest.root.rootArg}${manifest.root.extraCmdline ? " " + manifest.root.extraCmdline : ""}`,
    virtio_disks: [{ url: DISK, disk_option: "read_write", size: manifest.root.rawBytes }],
    virtio_rng: true,
    /* The virt board has no display; the app's worker path defaults this,
       the main-thread path wants it said out loud. */
    graphics_adapter: "none",
    autostart: true,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
  });
  emu.add_listener("serial0-output-byte", onByte);
  emu.add_listener("emulator-error", (err) => {
    console.error("[harness] emulator-error:", (err && err.message) || err);
    process.exit(1);
  });
  globalThis.__emu = emu;

  console.log(`[harness] booting ${manifest.os} ${manifest.version} (${ARCH}) — waiting for login: (${(BOOT_TIMEOUT / 1000) | 0}s budget)`);
  if (!(await waitFor(/login:/, BOOT_TIMEOUT))) {
    console.error("[harness] FAILED: no login prompt. Last serial output:");
    console.error(serial.slice(-4000) || "(none at all)");
    process.exit(1);
  }
  console.log("[harness] login prompt reached — logging in as root");
  serial = "";
  emu.serial0_send("root\n");
  if (!(await waitFor(/# /, 120000))) {
    console.error("[harness] FAILED: no root shell after login. Output:");
    console.error(serial.slice(-2000));
    process.exit(1);
  }
  serial = "";
  emu.serial0_send("uname -a && df -h / && echo D86-ARM-OK\n");
  if (!(await waitFor(/D86-ARM-OK/, 120000))) {
    console.error("[harness] FAILED: the shell did not answer. Output:");
    console.error(serial.slice(-2000));
    process.exit(1);
  }
  console.log(serial.split("\n").filter((l) => l.trim()).slice(0, 6).join("\n"));
  console.log(`\nOK: ${manifest.os} (${ARCH}) boots on v64's virt board to a usable root shell`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[harness] error:", err);
  process.exit(1);
});
