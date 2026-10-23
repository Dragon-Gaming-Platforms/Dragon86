import { existsSync, readFileSync } from "node:fs";
import { fs } from "@zenfs/core";
import { ImageStore, VENDORED_LIST } from "../../src/bridge/image-store";

const doc = JSON.stringify({ fsroot: [["etc",0,0,16877,0,0,[["hostname",9,0,33188,0,0,"aaaaaaaaaa.bin"],["passwd",9,0,33188,0,0,"bbbbbbbbbb.bin"]]],["boot",0,0,16877,0,0,[["vmlinuz-linux",9,0,33188,0,0,"cccccccccc.bin"]]]] });
const calls: string[] = [];
let shipped: string | null = null;
let live: string | null = null;
let originBlobs = true;
let mirrorBlobs = true;
let originStatus = 403;
let mirrorMissing = new Set<string>();
globalThis.fetch = (async (url: string, init?: any) => {
  const u = String(url);
  calls.push(`${(init?.method ?? "GET")} ${u}`);
  const html = (ok: boolean, body: string | null) => ({ ok, status: ok ? 200 : 404, text: async () => body ?? "", json: async () => JSON.parse(body ?? "null") });
  if (u.includes("/arch/")) {
    /* The real quarrel: the origin refuses (403), the mirror serves. */
    const fromMirror = u.includes("mirror.example");
    const allowed = fromMirror ? mirrorBlobs : originBlobs;
    if (fromMirror && mirrorMissing.has(u.split("/").pop()!)) {
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } as any;
    }
    return {
      ok: allowed,
      status: allowed ? 200 : fromMirror ? 404 : originStatus,
      arrayBuffer: async () => new TextEncoder().encode("CONTENT:" + u.split("/").pop()).buffer,
    } as any;
  }
  if (u.endsWith("v86/fs.json")) return html(shipped !== null, shipped) as any;
  if (u.endsWith("/fs.json")) return html(live !== null, live) as any;
  return html(false, null) as any;
}) as any;

const root = "/home/v86";
function check(name: string, cond: boolean) { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) process.exitCode = 1; }

// 1. shipped wins and no vendoring happens
shipped = doc; live = doc;
let st = await ImageStore.load("https://i.copy.sh/", { root });
check("shipped list preferred", st.source === "shipped");
check("indexed all paths", st.paths().length === 5);
check("nothing vendored when shipped exists", (fs as any).__files.size === 0);

// 2. no shipped -> live, and it is kept
shipped = null;
st = await ImageStore.load("https://i.copy.sh/", { root });
check("live used when not shipped", st.source === "live");
await new Promise((r) => setTimeout(r, 50));
check("live list persisted to ZenFS", (fs as any).__files.has(VENDORED_LIST(root)));

// 3. origin dead -> vendored copy still boots
live = null;
st = await ImageStore.load("https://i.copy.sh/", { root });
check("vendored list used offline", st.source === "vendored");
check("vendored tree identical", st.paths().slice().sort().join(",") === ["/boot","/boot/vmlinuz-linux","/etc","/etc/hostname","/etc/passwd"].join(","));

// 4. explicit vendoring action
live = doc;
const r = await ImageStore.vendorList("https://i.copy.sh/", root);
check("vendorList counts", r.paths === 5 && r.blobs === 3);
check("vendoredInfo reports size", (await ImageStore.vendoredInfo(root))?.bytes === doc.length);
check("clearVendored removes it", (await ImageStore.clearVendored(root)) === true);

// 4b. no shipped/vendored list and the origin refuses -> the mirror's list
{
  shipped = null; live = null;
  const realFetch = globalThis.fetch as any;
  globalThis.fetch = (async (url: string, init?: any) => {
    const u = String(url);
    if (u === "https://mirror.example/fs.json") {
      return { ok: true, status: 200, text: async () => doc } as any;
    }
    return realFetch(url, init);
  }) as any;
  const st = await ImageStore.load("https://i.copy.sh/", { root, fallbackBase: "mirror.example" });
  check("list falls back to the mirror", st.source === "live" && st.paths().length === 5);
  globalThis.fetch = realFetch;
  await ImageStore.clearVendored(root);
}

// 5b. blob names are a *prefix* of a sha256, and the prefix length is the
// builder's choice: copy.sh's current Arch image uses 8 hex digits, older
// ones used 10. Pinning it made every file look like a symlink.
{
  const real = JSON.stringify({ fsroot: [
    ["bin", 0, 0, 16877, 0, 0, [
      ["bash", 8, 0, 33261, 0, 0, "e3b0c442.bin"],
      ["sh", 8, 0, 33261, 0, 0, "0123456789.bin"],
      ["zstd-thing", 8, 0, 33261, 0, 0, "aabbccdd.bin.zst"],
      ["reboot", 12, 0, 41471, 0, 0, "/sbin/real-reboot"],
    ]],
  ] });
  const st = ImageStore.parse(real, "https://i.copy.sh/", "shipped");
  const st8 = await st.stat("/bin/bash");
  check("8-hex blob is a regular file", st8?.isFile() === true);
  check("8-hex blob has its real size", st8?.size === 8);
  check("10-hex blob still works", (await st.stat("/bin/sh"))?.isFile() === true);
  check(".bin.zst is still a blob", (await st.stat("/bin/zstd-thing"))?.isFile() === true);
  const link = await st.stat("/bin/reboot");
  check("a symlink is still a symlink", link?.isSymbolicLink() === true);
  check("a symlink's target is readable", (await st.readlink("/bin/reboot")) === "/sbin/real-reboot");
  check("a missing path is still null", (await st.stat("/bin/nope")) === null);
}

// 5c. The mirror is the source, not a fallback: the origin refuses our
// referer in every browser (it only answers copy.sh's own), and Referer is a
// forbidden header, so a page cannot work around it.
{
  const store = ImageStore.parse(doc, "https://i.copy.sh/", "shipped", "https://mirror.example/");
  originBlobs = true;
  originStatus = 403; // reachable, but refuses us
  mirrorBlobs = true;
  calls.length = 0;
  const a = await store.readFile("/etc/hostname");
  check("mirror is asked before the origin", calls[0]?.includes("mirror.example/arch/") === true);
  check("blob served by the mirror", !!a && new TextDecoder().decode(a).includes("aaaaaaaaaa.bin"));

  // A blob the mirror does not carry still comes from the origin.
  mirrorMissing.add("bbbbbbbbbb.bin");
  calls.length = 0;
  await store.readFile("/etc/passwd");
  check("mirror miss falls back to the origin", calls.some((c) => c.includes("i.copy.sh/arch/")));
  mirrorMissing.clear();

  // Nothing anywhere: the error names both hosts.
  mirrorBlobs = false;
  originBlobs = false;
  let err = "";
  try { await store.readFile("/boot/vmlinuz-linux"); } catch (e) { err = (e as Error).message; }
  check("both hosts named when nothing serves the blob", /mirror\.example/.test(err) && /i\.copy\.sh/.test(err));
  mirrorBlobs = true;
  originBlobs = true;
}

// 6. SPA fallback (200 + index.html) must not be mistaken for a list
shipped = "<!doctype html><html></html>"; live = null;
let fallbackMsg = "";
try { await ImageStore.load("https://i.copy.sh/", { root }); } catch (e) { fallbackMsg = (e as Error).message; }
check("html 200 ignored as a list", /public\/v86\/fs.json/.test(fallbackMsg));

// 7. nothing anywhere -> clear error
live = null; shipped = null;
let msg = "";
try { await ImageStore.load("https://i.copy.sh/", { root }); } catch (e) { msg = (e as Error).message; }
check("explains how to fix a missing list", /public\/v86\/fs.json/.test(msg) && /Settings/.test(msg));
// 8. The real, committed image list, when the repo has one. This is the
// regression that mattered: the list was fetched correctly and then discarded
// because blob names were assumed to be ten hex digits.
const realList = "public/v86/fs.json";
if (existsSync(realList)) {
  const real = ImageStore.parse(readFileSync(realList, "utf8"), "https://i.copy.sh/", "shipped");
  const kernel = real.findKernel();
  check("committed fs.json parses", real.paths().length > 50_000);
  check("committed fs.json references blobs", real.blobCount > 10_000);
  check("committed fs.json has a kernel and an initrd", !!kernel.kernel && !!kernel.initrd);
  check("committed fs.json: /usr/bin/bash is a file", (await real.stat("/usr/bin/bash"))?.isFile() === true);
  const bin = await real.stat("/bin");
  check(
    "committed fs.json: /bin is a symlink to usr/bin",
    bin?.isSymbolicLink() === true && (await real.readlink("/bin")) === "usr/bin",
  );
} else {
  console.log("skip: no public/v86/fs.json committed yet");
}

console.log("fetch calls:", calls.length);
