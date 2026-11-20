#!/usr/bin/env node
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { isGranted } from "../src/core/fs-access.ts";
import { connectAppFrame, injectAppBridge, installAppBridge, registerAppFrame } from "../src/apps/app-bridge.ts";

const html = '<!doctype html><html><head><title>App</title></head><body></body></html>';
const injected = injectAppBridge(html, "cheerpj");
assert.match(injected, /<head><script>try\{parent\.__d86AppBridge&&parent\.__d86AppBridge\.install\(window,"cheerpj"\)/);
assert.equal(injectAppBridge(injected, "cheerpj"), injected, "injection is idempotent");
assert.match(injectAppBridge("<p>no head</p>", "sample"), /^<script>/);

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://example.test/Dragon86/" });
globalThis.window = dom.window;
const frame = window.document.createElement("iframe");
frame.src = "https://example.test/Dragon86/9pf/cheerpj/index.html";
window.document.body.append(frame);
const child = frame.contentWindow;
assert.ok(child);

let maximized = false;
let focused = 0;
let patched = 0;
let wrote = null;
window.d86 = { version: "test", home: "/home/user", fs: { readText: async () => "ok" } };
const selectedFile = new window.File(["jar bytes"], "program.jar", { type: "application/java-archive" });
window.__d86ZenFSFiles = {
  open: async (target, options) => {
    assert.equal(target, child);
    assert.deepEqual(options, { accept: ".jar" });
    return [{ file: selectedFile, path: "/home/user/Downloads/program.jar", token: "open-token" }];
  },
  saveAs: async (_target, name) => ({ name, path: `/home/user/Documents/${name}`, token: "save-token" }),
  saveFile: async (_target, name, data) => { wrote = { name, data }; return true; },
  write: async (_target, token, data) => { wrote = { token, data }; },
  install: () => { patched++; },
};
const win = {
  focus: () => { focused++; },
  maximize: () => { maximized = true; },
  toggleMaximize: () => { maximized = !maximized; },
  isMaximized: () => maximized,
};
let readyDetail = null;
child.addEventListener("d86-ready", (event) => { readyDetail = event.detail; }, { once: true });
registerAppFrame(frame, "cheerpj", win, "/Dragon86/");
installAppBridge();
connectAppFrame(child, "not-cheerpj");
assert.equal(child.d86, undefined, "a mismatched app id is not connected");
connectAppFrame(child, "cheerpj");
const api = child.d86;
assert.equal(api.app.id, "cheerpj");
assert.equal(child.Dragon86, api, "the API has a readable Dragon86 alias");
assert.deepEqual(readyDetail, { appId: "cheerpj" }, "static apps get a d86-ready event");
assert.equal(api.fs, window.d86.fs, "the familiar ZenFS API remains available to app authors");
assert.equal(patched, 1, "the file-picker bridge is installed once");

const picked = await api.files.open({ accept: ".jar" });
assert.equal(picked[0].file, selectedFile);
assert.equal(picked[0].name, "program.jar");
assert.equal(picked[0].path, "/home/user/Downloads/program.jar");
assert.equal(picked[0].token, "open-token");
assert.equal(picked[0].url, "https://example.test/Dragon86/9pf/@open/%2Fhome%2Fuser%2FDownloads%2Fprogram.jar");
assert.equal(isGranted("cheerpj", picked[0].path), true, "picked files are authorized on the app's @open route");

const handle = await api.files.saveAs("result.bin");
assert.equal(handle.path, "/home/user/Documents/result.bin");
await handle.write(new Blob(["output"]));
assert.equal(wrote.token, "save-token");
assert.equal(await api.files.save("output.txt", new Blob(["saved"])), true);
assert.equal(wrote.name, "output.txt");

await api.window.requestFullscreen();
assert.equal(maximized, true);
assert.equal(focused, 1);
assert.equal(api.window.isFullscreen(), true);
api.window.exitFullscreen();
assert.equal(maximized, false);
api.window.toggleFullscreen();
assert.equal(maximized, true);

dom.window.close();
console.log("Dragon86 app API and ZenFS bridge tests passed");
