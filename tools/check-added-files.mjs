#!/usr/bin/env node
/**
 * Fails when a change ADDS a file larger than the limit to the repository.
 *
 * The repository is already large (see README → "Repository size"); the goal
 * here is that it stops growing with build outputs. Files that were already
 * committed are not checked: only additions are. A deliberate exception goes
 * in `.large-files-allow` (one repo-relative path per line).
 *
 *   node tools/check-added-files.mjs [base-ref]     (default: origin/main)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const LIMIT_MB = 10;
const base = process.argv[2] || process.env.BASE_REF || "origin/main";
const allow = new Set(
  existsSync(".large-files-allow")
    ? readFileSync(".large-files-allow", "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
    : [],
);

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

let added;
try {
  added = git(["diff", "--name-only", "--diff-filter=A", "-z", `${base}...HEAD`]).split("\0").filter(Boolean);
} catch (err) {
  console.error(`[FAIL] could not diff against ${base}: ${err.message.split("\n")[0]}`);
  console.error("       CI needs a full clone (actions/checkout fetch-depth: 0).");
  process.exit(1);
}

const offenders = [];
for (const file of added) {
  if (allow.has(file)) continue;
  const size = Number(git(["cat-file", "-s", `HEAD:${file}`]).trim());
  if (size > LIMIT_MB * 1024 * 1024) offenders.push({ file, mb: (size / 1024 / 1024).toFixed(1) });
}

if (offenders.length) {
  console.error(`[FAIL] this change adds ${offenders.length} file(s) over ${LIMIT_MB} MB:`);
  for (const o of offenders) console.error(`       ${o.mb} MB  ${o.file}`);
  console.error("Build outputs belong in a release or external storage, not in git.");
  console.error("If this really must be committed, list the path in .large-files-allow.");
  process.exit(1);
}
console.log(`[PASS] no file added over ${LIMIT_MB} MB (${added.length} added files checked against ${base})`);
