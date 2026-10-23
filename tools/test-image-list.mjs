#!/usr/bin/env node
/**
 * Precedence test for the Arch image list (src/bridge/image-store.ts).
 *
 * The full Arch guest's filesystem is described by `fs.json`. There are
 * three possible sources — one shipped in the build, one vendored onto the
 * device, one fetched live — and getting the order wrong is expensive: a
 * live fetch per boot, or a boot that fails offline, or (the nasty one) an
 * SPA fallback serving index.html with a 200 and being parsed as a list.
 *
 * This bundles the real module (ZenFS stubbed for a Map) and asserts:
 * shipped wins, live is remembered, vendored works with the origin dead,
 * vendoring is explicit and clearable, and HTML is never accepted.
 *
 *   node tools/test-image-list.mjs
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const vite = path.join(here, "..", "node_modules", ".bin", "vite");
const out = path.join(here, "test-image-list", ".out");

execFileSync(vite, ["build", "--logLevel", "warn", "--config", path.join(here, "test-image-list", "vite.config.ts")], {
  stdio: ["ignore", "ignore", "inherit"],
});
try {
  execFileSync(process.execPath, [path.join(out, "t.mjs")], { stdio: "inherit" });
} finally {
  rmSync(out, { recursive: true, force: true });
}
