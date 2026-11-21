#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../public/scramjet/${path}`, import.meta.url), "utf8");
const [runtime, controller, controllerSw, epoxy, libcurl, app, utility, notes] = await Promise.all([
  read("scramjet/scramjet.js"),
  read("controller/controller.api.js"),
  read("controller/controller.sw.js"),
  read("transport/epoxy.mjs"),
  read("transport/libcurl.mjs"),
  read("app.js"),
  read("utils/scramjet-utils.mjs"),
  read("VENDORED.md"),
]);

assert.match(runtime, /version:\"2\.1\.0\"/);
assert.match(controller, /version:\"0\.1\.0\"/);
assert.match(controller, /"2\.1\.0"/);
assert.match(controllerSw, /shouldRoute/);
assert.match(controllerSw, /route/);
assert.match(epoxy, /EpoxyTransport as default/);
assert.match(libcurl, /LibcurlClient as default/);
assert.match(app, /await transport\.init\(\)/);
assert.match(app, /new EpoxyTransport\(\{ wisp: settings\.wisp \}\)/);
assert.match(app, /new LibcurlTransport\(\{ wisp: settings\.wisp \}\)/);
assert.ok(notes.includes("releases/tag/v2.1.0") && notes.includes("@mercuryworkshop/scramjet` | `2.1.0`"));
assert.ok(notes.includes("@mercuryworkshop/scramjet-controller` | `0.1.0`"));
assert.match(utility, /"2\.1\.0",\$scramjet\.versionInfo\.version/);
assert.match(utility, /"0\.1\.0",\$scramjetController\.versionInfo\.version/);
assert.doesNotMatch(utility, /\$scramjetController\.VERSION/);

// Import the published utility bundle with the global interfaces it expects.
globalThis.$scramjet = { versionInfo: { version: "2.1.0" } };
globalThis.$scramjetController = {
  ManagedPlugin: class ManagedPlugin {
    constructor(name) { this.name = name; }
  },
  Controller: class {},
  Frame: class {},
  config: {},
  versionInfo: { version: "0.1.0" },
};
const utils = await import(new URL(`../public/scramjet/utils/scramjet-utils.mjs?test=${Date.now()}`, import.meta.url));
assert.equal(typeof utils.UrlWatcherPlugin, "function");
assert.equal(typeof utils.HttpCachePlugin, "function");
assert.equal(new utils.UrlWatcherPlugin(() => {}).name, "url-watcher");
assert.equal(new utils.HttpCachePlugin().name, "scramjet-http-cache");

console.log("Scramjet v2.1.0 vendor and controller integration checks passed");
