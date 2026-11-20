#!/usr/bin/env node
/**
 * Runs every unit suite that `npm run build` depends on, one after another.
 *
 * Unlike a `&&` chain, a failing suite does not hide the ones after it: all
 * suites run, then the failures are listed together, so one run shows every
 * broken check. The list here is the single source of truth for the unit
 * tests; add a suite here, not to package.json.
 *
 *   node tools/run-unit-tests.mjs           (npm run test:unit)
 */
import { spawnSync } from "node:child_process";

const STRIP = ["--experimental-strip-types"];

/** [label, node arguments]. Run with the repo root as the working directory. */
const SUITES = [
  ["scramjet app: syntax", ["--check", "public/scramjet/app.js"]],
  ["CSS variables", ["tools/check-css-vars.mjs"]],
  ["startup reload worker", ["tools/test-startup-reload.mjs"]],
  ["engine lifecycle", [...STRIP, "tools/test-engine-lifecycle.mjs"]],
  ["COI deregistration", ["tools/test-coi-deregister.mjs"]],
  ["filesystem-app service worker", ["tools/test-app-sw.mjs"]],
  ["PWA manifest", ["tools/test-pwa.mjs"]],
  ["@open access rules", [...STRIP, "tools/test-fs-access.mjs"]],
  ["Preview parsers", ["tools/test-preview.mjs"]],
  ["guest scripts", ["tools/test-guest-scripts.mjs"]],
  ["DrakeForge session", [...STRIP, "tools/test-drakeforge-session.mjs"]],
  ["engine viewer", [...STRIP, "tools/test-engine-viewer.mjs"]],
  ["v86 relay", [...STRIP, "tools/test-v86-relay.mjs"]],
  ["archives", [...STRIP, "tools/test-archive.mjs"]],
  ["downloads", [...STRIP, "tools/test-download.mjs"]],
  ["filesystem export", [...STRIP, "tools/test-fs-export.mjs"]],
  ["filesystem import", [...STRIP, "tools/test-fs-import.mjs"]],
  ["Puter files adapter", [...STRIP, "tools/test-puter-files.mjs"]],
  ["public asset URLs", [...STRIP, "tools/test-public-asset-url.mjs"]],
];

const failed = [];
const started = Date.now();
for (const [label, args] of SUITES) {
  console.log(`\n=== ${label}`);
  const res = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (res.status !== 0) failed.push(label);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
if (failed.length) {
  console.error(`\n${failed.length} of ${SUITES.length} unit suites FAILED (${secs}s):`);
  for (const label of failed) console.error(`  - ${label}`);
  process.exit(1);
}
console.log(`\nall ${SUITES.length} unit suites passed (${secs}s)`);
