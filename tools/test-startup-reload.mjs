#!/usr/bin/env node
/** The legacy COI helper unregisters by reloading controlled pages. It must
 * not be loaded during OS/VM boot; app-sw.js now owns filesystem-app routing. */
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/core/fs-apps.ts", import.meta.url), "utf8");
const loadsLegacyReloadWorker = /<script\b[^>]*src=["'][^"']*coi-serviceworker\.js/i.test(html);
const registersFilesystemWorker = bridge.includes('register(`${BASE}app-sw.js`');
if (loadsLegacyReloadWorker) {
  console.error("[FAIL] index.html still loads coi-serviceworker.js, which can reload a controlled page during VM boot");
  process.exit(1);
}
if (!registersFilesystemWorker) {
  console.error("[FAIL] filesystem-app service worker registration is missing");
  process.exit(1);
}
console.log("[PASS] VM startup does not load the legacy COI deregistration/reload worker");
console.log("[PASS] filesystem-app routing remains registered by app-sw.js");
