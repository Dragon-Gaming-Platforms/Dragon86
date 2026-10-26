/**
 * Headless v86 boot harness — boots the actual guest in Node.
 *
 * This is a development tool, not shipped code: it exists so the 9p mount,
 * the guest's /etc/profile hooks and the shell can be observed without a
 * browser. `npm run test:vm` compiles the 9p server for Node and boots it.
 *
 * It runs the *real* pieces — public/v86/libv86.js, the real kernel and
 * initramfs, and the real src/bridge/p9.ts server — against a filesystem that
 * is the host's own (instead of ZenFS), extracted from the initramfs the same
 * way guest-root.ts does it.
 *
 *   node tools/vm/boot.mjs            boot and report
 *   node tools/vm/boot.mjs --keep     reuse an already-extracted root
 *   node tools/vm/boot.mjs --cmd "ls /" --cmd "d86-net"
 *
 * Env: INITRD=<path> to boot a rebuilt initramfs, CMDLINE=<kernel line> to
 * change the command line, BOOT_TIMEOUT=<ms>, VERBOSE=1 to watch the console.
 */
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import * as fsp from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const p9 = require("./build/p9.cjs");

const ROOT = process.env.V86_ROOT ?? "/tmp/d86-v86root";
const KEEP = process.argv.includes("--keep");
const CMDS = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--cmd") CMDS.push(process.argv[i + 1]);
}
const BOOT_TIMEOUT = Number(process.env.BOOT_TIMEOUT ?? 180000);

/* ---------- unpack the initramfs into a directory ---------- */

function cpioEntries(buf) {
  const out = [];
  let at = 0;
  while (at + 110 <= buf.length) {
    const magic = buf.subarray(at, at + 6).toString("latin1");
    if (magic !== "070701" && magic !== "070702") break;
    const h = (k) => parseInt(buf.subarray(at + 6 + 8 * k, at + 6 + 8 * (k + 1)).toString("latin1"), 16);
    const mode = h(1);
    const size = h(6);
    const namesize = h(11);
    const name = buf.subarray(at + 110, at + 110 + namesize - 1).toString("utf8");
    const headerLen = Math.ceil((110 + namesize) / 4) * 4;
    const body = buf.subarray(at + headerLen, at + headerLen + size);
    at += Math.ceil((headerLen + size) / 4) * 4;
    if (name === "TRAILER!!!") break;
    out.push({ name, mode, body: Buffer.from(body) });
  }
  return out;
}

async function unpack() {
  const gz = await fsp.readFile(resolve(repo, "public/v86/initrd.gz"));
  const archive = gunzipSync(gz);
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  let files = 0;
  for (const entry of cpioEntries(archive)) {
    const target = join(ROOT, entry.name);
    const kind = entry.mode & 0o170000;
    if (kind === 0o040000) {
      mkdirSync(target, { recursive: true });
    } else if (kind === 0o120000) {
      mkdirSync(dirname(target), { recursive: true });
      try {
        const { symlinkSync } = require("node:fs");
        symlinkSync(entry.body.toString(), target);
      } catch {
        /* already there */
      }
    } else if (kind === 0o100000) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.body, { mode: entry.mode & 0o7777 });
      files++;
    }
  }
  return { files, archive };
}

/* ---------- the fs surface p9.ts expects (ZenFS promises, on node:fs) ---- */

let nextIno = 1;
const inos = new Map();
const ino = (p) => {
  if (!inos.has(p)) inos.set(p, nextIno++);
  return inos.get(p);
};

function makeStat(st, path) {
  return {
    mode: st.mode,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    atimeMs: st.atimeMs,
    ino: st.ino || ino(path),
    uid: st.uid,
    gid: st.gid,
    nlink: st.nlink,
    isDirectory: () => st.isDirectory(),
    isFile: () => st.isFile(),
    isSymbolicLink: () => st.isSymbolicLink(),
  };
}

const fsImpl = {
  async stat(p) {
    const st = await fsp.lstat(p);
    return makeStat(st, p);
  },
  async open(p, flags) {
    const map = { r: "r", "r+": "r+", w: "w", "w+": "w+", a: "a", "a+": "a+" };
    const fh = await fsp.open(p, map[flags] ?? "r+");
    return {
      async read(buf, off, len, position) {
        const { bytesRead } = await fh.read(buf, off, len, position);
        return bytesRead;
      },
      async write(buf, off, len, position) {
        const { bytesWritten } = await fh.write(buf, off, len, position ?? null);
        return bytesWritten;
      },
      async truncate(len) {
        await fh.truncate(len);
      },
      async close() {
        await fh.close();
      },
    };
  },
  /* ZenFS's readdir yields names; p9.ts reads it as string[]. */
  async readdir(p) {
    return fsp.readdir(p);
  },
  async mkdir(p) {
    await fsp.mkdir(p);
  },
  async rmdir(p) {
    await fsp.rmdir(p);
  },
  async unlink(p) {
    await fsp.unlink(p);
  },
  async rename(a, b) {
    await fsp.rename(a, b);
  },
  async chmod(p, mode) {
    await fsp.chmod(p, mode);
  },
  async truncate(p, len) {
    await fsp.truncate(p, len);
  },
  async utimes(p, a, m) {
    await fsp.utimes(p, a, m);
  },
  async writeFile(p, data) {
    await fsp.writeFile(p, data);
  },
  async readlink(p) {
    return fsp.readlink(p);
  },
  async symlink(target, p) {
    await fsp.symlink(target, p);
  },
};

/* ---------- boot ---------- */

/* libv86.js is a classic script. Under "type": "module" a require() of a .js
   file is treated as ESM and its module.exports never lands, so hand the
   emulator the same bytes under a .cjs name. */
const LIBV86 = resolve(here, "build/libv86.cjs");
mkdirSync(dirname(LIBV86), { recursive: true });
writeFileSync(LIBV86, readFileSync(resolve(repo, "public/v86/libv86.js")));
const { V86 } = require(LIBV86);

let serial = "";
const decoder = new TextDecoder();
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
  let reuse = KEEP && existsSync(join(ROOT, "usr/bin/bash"));
  /* Exactly what the app hands the kernel: the .gz file itself (14.7 MB).
     The kernel decompresses the initramfs; passing the inflated 33 MB cpio
     overruns the ramfs in a 128 MB machine ("Initramfs unpacking failed:
     write error"). */
  const initrdPath = process.env.INITRD ? resolve(process.env.INITRD) : resolve(repo, "public/v86/initrd.gz");
  const archive = await fsp.readFile(initrdPath);
  const cmdlineBase = process.env.CMDLINE ?? "console=ttyS0 tsc=reliable initcall_blacklist=mcheck_init_device d86cols=100 d86rows=32";
  if (reuse) {
    console.log(`[harness] reusing the extracted root at ${ROOT}`);
  } else {
    const res = await unpack();
    console.log(`[harness] extracted ${res.files} files into ${ROOT}`);
  }

  const kernel = await fsp.readFile(resolve(repo, "public/v86/bzImage"));

  const emu = new V86({
    wasm_path: resolve(repo, "public/v86/v86.wasm"),
    memory_size: 128 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    bios: { url: resolve(repo, "public/v86/bios/seabios.bin") },
    vga_bios: { url: resolve(repo, "public/v86/bios/vgabios.bin") },
    bzimage: { buffer: kernel.buffer.slice(kernel.byteOffset, kernel.byteOffset + kernel.byteLength) },
    initrd: { buffer: archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) },
    cmdline: cmdlineBase,
    acpi: true,
    autostart: true,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
    filesystem: { handle9p: p9.createP9Handler(ROOT, fsImpl) },
  });
  emu.add_listener("serial0-output-byte", onByte);
  globalThis.__emu = emu;

  const shell = await waitFor(/dragon86:.*[#$]|recovery shell/i, BOOT_TIMEOUT);
  const recovery = /recovery shell/i.test(serial);
  /* The two faults this harness exists for: the 9p channel storm (a boot that
     ends in a shell nobody can use) and the recovery shell itself. */
  const storm = (serial.match(/no channels available for device host9p/g) || []).length;
  console.log(`[harness] booted=${shell} recovery=${recovery} (${(BOOT_TIMEOUT / 1000) | 0}s budget)`);
  console.log(`[harness] 9p channel errors: ${storm}`);
  const problems = [];
  if (!shell) problems.push("the guest never produced a shell prompt");
  if (recovery) problems.push("the guest fell back to its recovery shell");
  if (storm) problems.push(`${storm} × "no channels available for device host9p"`);

  if (!CMDS.length) CMDS.push("echo HARNESS-OK", "ls /", "git --version");
  const answers = [];
  for (const cmd of CMDS) {
    /* Let the previous prompt finish arriving before clearing the buffer,
       otherwise its trailing bytes satisfy the "wait for a prompt" below and
       the command looks like it printed nothing. */
    await new Promise((r) => setTimeout(r, 300));
    serial = "";
    emu.serial0_send(`${cmd}\n`);
    await waitFor(/\n[^\n]*[#$] ?$/, 20000);
    const clean = serial
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith(cmd))
      .join("\n");
    answers.push(clean);
    console.log(`\n$ ${cmd}\n${clean.trim()}`);
  }
  /* The guest's root is the share: /init and /newroot only exist in the
     initramfs, so seeing them means the 9p mount did not become /. */
  if (/\bnewroot\b/.test(answers[1] ?? "")) problems.push("the shell is running in the initramfs, not on the 9p root");
  if (!/HARNESS-OK/.test(answers[0] ?? "")) problems.push("the shell did not answer a command");
  if (!/git version 2\./.test(answers[2] ?? "")) problems.push("the guest's git does not run");

  emu.destroy();
  if (problems.length) {
    console.error(`\nFAIL\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("\nOK: booted straight to a shell on the 9p root, no 9p channel errors");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
