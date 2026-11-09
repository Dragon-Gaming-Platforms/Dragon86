/**
 * Headless rv64 boot harness — boots the RISC-V 64 guest in Node.
 *
 * The riscv64 counterpart of tools/vm/boot.mjs: it runs the *real* pieces —
 * public/rv64/rv64.js + rv64_wasm.wasm, the real kernel and initramfs, and
 * the real src/bridge/p9.ts server — against a host directory extracted from
 * the initramfs the same way guest-root.ts does it. No browser, no display:
 * this machine's only console is the serial line, which is also true in the
 * app.
 *
 *   node tools/vm/boot-rv64.mjs            boot and report
 *   node tools/vm/boot-rv64.mjs --keep     reuse an already-extracted root
 *   node tools/vm/boot-rv64.mjs --cmd "ls /"
 *   node tools/vm/boot-rv64.mjs --no-root  boot the initramfs alone (no 9p)
 *
 * Env: KERNEL=<path> (default public/rv64/Image), INITRD=<path> (default
 * public/rv64/initrd.gz), MEMORY_MB=<n> (default 256), CMDLINE=<line>,
 * BOOT_TIMEOUT=<ms>, VERBOSE=1 to watch the console.
 */
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import * as fsp from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const p9 = require("./build/p9.cjs");

const ROOT = process.env.RV64_ROOT ?? "/tmp/d86-rv64root";
const KEEP = process.argv.includes("--keep");
const NO_ROOT = process.argv.includes("--no-root");
const CMDS = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--cmd") CMDS.push(process.argv[i + 1]);
}
const BOOT_TIMEOUT = Number(process.env.BOOT_TIMEOUT ?? 300000);

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

async function unpack(initrdPath) {
  const gz = await fsp.readFile(initrdPath);
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
  return { files };
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
  /* Faithful to production ZenFS: stat FOLLOWS symlinks, lstat does not
     (see the note in boot.mjs — an lstat-shaped stat here once masked a
     real symlink bug in the production wrapper). */
  async stat(p) {
    const st = await fsp.stat(p);
    return makeStat(st, p);
  },
  async lstat(p) {
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

const ENGINE_DIR = process.env.ENGINE_DIR ?? "public/rv64";

let serial = "";
function onConsole(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  serial += text;
  if (process.env.VERBOSE) process.stdout.write(text);
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
  const { RV64 } = await import(pathToFileURL(resolve(repo, `${ENGINE_DIR}/rv64.js`)).href);
  console.log(`[harness] engine: ${ENGINE_DIR} (rv64.js)`);

  const wasm = await fsp.readFile(resolve(repo, `${ENGINE_DIR}/rv64_wasm.wasm`));
  const kernelPath = process.env.KERNEL ? resolve(process.env.KERNEL) : resolve(repo, `${ENGINE_DIR}/Image`);
  const kernel = await fsp.readFile(kernelPath);
  const initrdPath = process.env.INITRD ? resolve(process.env.INITRD) : resolve(repo, `${ENGINE_DIR}/initrd.gz`);
  const initrd = await fsp.readFile(initrdPath);

  if (!NO_ROOT) {
    const reuse = KEEP && existsSync(join(ROOT, "bin"));
    if (reuse) {
      console.log(`[harness] reusing the extracted root at ${ROOT}`);
    } else {
      const res = await unpack(initrdPath);
      console.log(`[harness] extracted ${res.files} files into ${ROOT}`);
    }
  }

  /* Same line the app's bridge builds: serial console, the fetch network
     flag the guest's profile.d checks, and the terminal size in-band. */
  const cmdline =
    process.env.CMDLINE ?? "console=ttyS0 rv64.network=fetch d86cols=100 d86rows=32";

  /* src/bridge/p9.ts answers (req, reply); rv64.js asks handle(req) → bytes.
     Same 9p2000.L frames either way — only the calling convention differs. */
  const rawHandler = NO_ROOT ? null : p9.createP9Handler(ROOT, fsImpl);
  const p9Config = rawHandler
    ? { tag: "host9p", handle: (req) => new Promise((res) => rawHandler(req, res)) }
    : undefined;

  const vm = await RV64.create({
    wasm,
    memoryMB: process.env.MEMORY_MB ? Number(process.env.MEMORY_MB) : 256,
    boot: {
      mode: "linux-direct",
      kernel,
      initrd,
      cmdline,
      ...(p9Config ? { p9: p9Config } : {}),
    },
    network: { mode: "fetch" },
    events: {
      console: onConsole,
      error(err) {
        console.error("[harness] emulator error:", (err && err.message) || err);
        process.exit(1);
      },
    },
  });
  globalThis.__vm = vm;
  void vm.start();

  const shell = await waitFor(/dragon86:.*[#$]|recovery shell/i, BOOT_TIMEOUT);
  const recovery = /recovery shell/i.test(serial);
  console.log(`[harness] booted=${shell} recovery=${recovery} (${(BOOT_TIMEOUT / 1000) | 0}s budget)`);
  const problems = [];
  if (!shell) problems.push("the guest never produced a shell prompt");
  if (recovery && !NO_ROOT) problems.push("the guest fell back to its recovery shell");

  if (!CMDS.length) CMDS.push("echo HARNESS-OK", "ls /", "git --version");
  const answers = [];
  if (shell) {
    for (const cmd of CMDS) {
      await new Promise((r) => setTimeout(r, 300));
      serial = "";
      vm.console.send(`${cmd}\n`);
      await waitFor(/\n[^\n]*[#$] ?$/, 30000);
      const clean = serial
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
        .split("\n")
        .filter((line) => line.trim() && !line.startsWith(cmd))
        .join("\n");
      answers.push(clean);
      console.log(`[harness] $ ${cmd}\n${clean}`);
    }
    for (let i = 0; i < CMDS.length; i++) {
      const failed = !answers[i] || /not found|No such file/i.test(answers[i]);
      console.log(`[harness] ${failed ? "FAIL" : "ok  "} ${CMDS[i]}`);
      if (failed) problems.push(`command failed: ${CMDS[i]}`);
    }
  }

  await vm.stop();
  await vm.destroy();

  if (!serial.length) problems.push("no console output at all");
  if (problems.length) {
    console.error(`[harness] PROBLEMS:\n - ${problems.join("\n - ")}`);
    if (process.env.VERBOSE !== "1") {
      console.error("[harness] last console output:\n" + serial.slice(-4000));
    }
    process.exit(1);
  }
  console.log("[harness] PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("[harness] fatal:", err);
  process.exit(1);
});
