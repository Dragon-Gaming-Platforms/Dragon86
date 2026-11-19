#!/usr/bin/env node
import assert from "node:assert/strict";

const storage = new Map([
  ["dragon86.settings", JSON.stringify({ v86Network: "wss://relay.widgetry.org/" })],
]);
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
};
globalThis.document = {
  documentElement: {
    setAttribute() {},
    style: { setProperty() {} },
  },
};

const { SHARED_WISP_WSS, SHARED_WISP_V86, getSettings } = await import("../src/core/settings.ts");
const { displayV86Relay, normalizeV86Relay, relayBackendName } = await import("../src/bridge/v86-relay.ts");

assert.equal(SHARED_WISP_WSS, "wss://anura.pro/");
assert.equal(SHARED_WISP_V86, "wisps://anura.pro/");
assert.equal(getSettings().v86Network, SHARED_WISP_V86);
assert.equal(JSON.parse(storage.get("dragon86.settings")).v86Network, SHARED_WISP_V86);
assert.equal(normalizeV86Relay(SHARED_WISP_WSS), SHARED_WISP_V86);
assert.equal(displayV86Relay(SHARED_WISP_V86), SHARED_WISP_WSS);
assert.equal(relayBackendName(SHARED_WISP_WSS), "wisp");
assert.equal(relayBackendName(SHARED_WISP_V86), "wisp");
assert.equal(relayBackendName("wss://relay.widgetry.org/"), "wsproxy");
assert.equal(normalizeV86Relay("off"), "off");
const { setSettings } = await import("../src/core/settings.ts");
setSettings({ v86Network: "wss://custom.example/" });
assert.equal(getSettings().v86Network, "wss://custom.example/");
assert.equal(normalizeV86Relay(getSettings().v86Network), "wss://custom.example/");
assert.equal(relayBackendName(getSettings().v86Network), "wsproxy");
console.log("v86/Scramjet shared WSS relay checks passed");
