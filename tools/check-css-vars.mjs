#!/usr/bin/env node
/**
 * CSS custom-property guard.
 *
 * Catches the failure mode that made the whole desktop collapse into a
 * narrow column on desktop Chrome: a design token defined *only* inside a
 * media query. `#desktop { inset: 0 0 calc(var(--taskbar-h) + …) 0 }` is
 * fine on a tablet (pointer: coarse defines the token) but on a desktop it
 * becomes an invalid declaration, the element loses its `inset`, and it
 * shrink-wraps to its content instead of filling the screen.
 *
 * A token must be defined outside any @media block (i.e. always in force),
 * or every `var()` that uses it must carry a fallback.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "src/styles";
const files = readdirSync(DIR).filter((f) => f.endsWith(".css"));

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const globalDefs = new Set();
const mediaDefs = new Map(); // token -> [file]
const uses = []; // { token, file, line, hasFallback }

for (const file of files) {
  const css = strip(readFileSync(join(DIR, file), "utf8"));
  const stack = [];
  const re = /@media[^{]*\{|\{|\}|(--[\w-]+)\s*:|var\(\s*(--[\w-]+)\s*(,)?/g;
  let m;
  while ((m = re.exec(css))) {
    const tok = m[0];
    if (tok.startsWith("@media")) stack.push("media");
    else if (tok === "{") stack.push("block");
    else if (tok === "}") stack.pop();
    else if (m[1]) {
      if (stack.includes("media")) {
        if (!mediaDefs.has(m[1])) mediaDefs.set(m[1], []);
        mediaDefs.get(m[1]).push(file);
      } else {
        globalDefs.add(m[1]);
      }
    } else if (m[2]) {
      const line = css.slice(0, m.index).split("\n").length;
      uses.push({ token: m[2], file, line, hasFallback: Boolean(m[3]) });
    }
  }
}

const problems = [];
for (const u of uses) {
  if (globalDefs.has(u.token) || u.hasFallback) continue;
  if (mediaDefs.has(u.token)) {
    problems.push(
      `${u.file}:${u.line} var(${u.token}) has no fallback, but the token is only ` +
        `defined inside a media query (${mediaDefs.get(u.token).join(", ")}) — it is ` +
        `undefined at desktop width and the declaration will be dropped`,
    );
  } else {
    problems.push(`${u.file}:${u.line} var(${u.token}) is never defined`);
  }
}

if (problems.length) {
  console.error("CSS custom-property check failed:\n");
  for (const p of problems) console.error("  " + p);
  console.error(
    `\n${problems.length} problem(s). Define the token outside any @media block ` +
      `(e.g. in :root) or pass a fallback: var(--token, 0px).`,
  );
  process.exit(1);
}

console.log(
  `CSS custom properties OK — ${globalDefs.size} global tokens, ` +
    `${uses.length} uses, ${mediaDefs.size} media-only overrides.`,
);
