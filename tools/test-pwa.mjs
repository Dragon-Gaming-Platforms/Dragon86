#!/usr/bin/env node
/** Installability and offline-shell regression tests for Dragon86's PWA. */
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
const swSource = readFileSync(new URL("../public/app-sw.js", import.meta.url), "utf8");
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });

check("the OS page links the web app manifest", /rel="manifest" href="\.\/manifest\.webmanifest"/.test(html));
check("manifest declares a standalone app scoped to its deployment path", manifest.display === "standalone" && manifest.start_url === "./" && manifest.scope === "./");
check("manifest includes the Dragon86 launcher icon", manifest.icons?.some((icon) => icon.src === "./icons/dragon86-pwa-192.png" && icon.sizes === "192x192") && manifest.icons?.some((icon) => icon.src === "./icons/dragon86-pwa-512.png" && icon.sizes === "512x512") && existsSync(new URL("../public/icons/dragon86-pwa-192.png", import.meta.url)) && existsSync(new URL("../public/icons/dragon86-pwa-512.png", import.meta.url)));
check("the OS page includes mobile home-screen metadata", /apple-mobile-web-app-capable/.test(html) && /apple-touch-icon/.test(html));

const listeners = {};
const data = new Map();
const cache = {
  async match(key) { const item = data.get(typeof key === "string" ? key : key.url); return item?.clone() ?? undefined; },
  async put(key, value) { data.set(typeof key === "string" ? key : key.url, value.clone()); },
  async keys() { return [...data.keys()].map((url) => new Request(url)); },
  async delete(key) { return data.delete(typeof key === "string" ? key : key.url); },
};
const caches = {
  async open() { return cache; },
  async keys() { return []; },
  async delete() { return true; },
};
let offline = false;
const requests = [];
const fetcher = async (input) => {
  const url = typeof input === "string" ? input : input.url;
  requests.push(url);
  if (offline) throw new TypeError("offline");
  return new Response(`<html>${url.endsWith(".js") ? "bundle" : "Dragon86 shell"}</html>`, {
    status: 200,
    headers: { "Content-Type": url.includes("app.js") ? "text/javascript" : "text/html" },
  });
};
const self = {
  registration: { scope: "https://example.test/Dragon86/" },
  addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
  async skipWaiting() {},
  clients: { async claim() {} },
};
const context = vm.createContext({ self, caches, fetch: fetcher, URL, Request, Response, Headers, setTimeout, clearTimeout, console });
vm.runInContext(swSource, context);

const waitFor = (handler, event) => {
  let promise = Promise.resolve();
  handler({ ...event, waitUntil(p) { promise = p; } });
  return promise;
};
const install = await waitFor(listeners.install[0], {});
await install;
check("install precaches the app shell and activates the worker", data.has("https://example.test/Dragon86/") && requests.includes("https://example.test/Dragon86/"));

async function navigate(mode = "navigate") {
  let result;
  const event = {
    request: { url: "https://example.test/Dragon86/", method: "GET", mode, destination: "document" },
    respondWith(value) { result = value; },
  };
  listeners.fetch[0](event);
  return result ? await result : null;
}

const online = await navigate();
check("online navigation refreshes and caches the OS shell", online?.status === 200 && (await online.text()).includes("Dragon86 shell"));
offline = true;
const offlineResponse = await navigate();
check("offline navigation falls back to the cached OS shell", offlineResponse?.status === 200 && (await offlineResponse.text()).includes("Dragon86 shell"));

offline = false;
let staticResponse;
listeners.fetch[0]({
  request: { url: "https://example.test/Dragon86/assets/main.js", method: "GET", mode: "same-origin", destination: "script" },
  respondWith(value) { staticResponse = value; },
});
await staticResponse;
offline = true;
let cachedAsset;
listeners.fetch[0]({
  request: { url: "https://example.test/Dragon86/assets/main.js", method: "GET", mode: "same-origin", destination: "script" },
  respondWith(value) { cachedAsset = value; },
});
const assetResponse = await cachedAsset;
check("same-origin shell assets remain available offline", assetResponse?.status === 200 && (await assetResponse.text()).includes("bundle"), `status=${assetResponse?.status}; cache=${[...data.keys()].join(",")}`);

for (const result of results) console.log(`[${result.ok ? "PASS" : "FAIL"}] ${result.name}${result.detail ? ` (${result.detail})` : ""}`);
const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
