import { fs } from "@zenfs/core";
import { ImageStore, VENDORED_LIST } from "../../src/bridge/image-store";

const doc = JSON.stringify({ fsroot: [["etc",0,0,16877,0,0,[["hostname",9,0,33188,0,0,"aaaaaaaaaa.bin"],["passwd",9,0,33188,0,0,"bbbbbbbbbb.bin"]]],["boot",0,0,16877,0,0,[["vmlinuz-linux",9,0,33188,0,0,"cccccccccc.bin"]]]] });
const calls: string[] = [];
let shipped: string | null = null;
let live: string | null = null;
globalThis.fetch = (async (url: string, init?: any) => {
  const u = String(url);
  calls.push(`${(init?.method ?? "GET")} ${u}`);
  const html = (ok: boolean, body: string | null) => ({ ok, status: ok ? 200 : 404, text: async () => body ?? "", json: async () => JSON.parse(body ?? "null") });
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

// 5. SPA fallback (200 + index.html) must not be mistaken for a list
shipped = "<!doctype html><html></html>"; live = null;
let fallbackMsg = "";
try { await ImageStore.load("https://i.copy.sh/", { root }); } catch (e) { fallbackMsg = (e as Error).message; }
check("html 200 ignored as a list", /public\/v86\/fs.json/.test(fallbackMsg));

// 6. nothing anywhere -> clear error
live = null; shipped = null;
let msg = "";
try { await ImageStore.load("https://i.copy.sh/", { root }); } catch (e) { msg = (e as Error).message; }
check("explains how to fix a missing list", /public\/v86\/fs.json/.test(msg) && /Settings/.test(msg));
console.log("fetch calls:", calls.length);
