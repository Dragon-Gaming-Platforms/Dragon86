#!/usr/bin/env node
/**
 * Unit checks for src/core/fs-access.ts — who may read which file through the
 * `9pf/@open/` route. Pure functions, no browser, no ZenFS.
 *
 *   node --experimental-strip-types tools/test-fs-access.mjs
 */
import {
  decideOpenRead,
  grantFile,
  isGranted,
  parseRequester,
  resolvePath,
} from "../src/core/fs-access.ts";

const HOME = "/home/user";
const results = [];
const check = (name, cond, detail = "") => results.push({ name, ok: !!cond, detail });

const os = { kind: "os" };
const unknown = { kind: "unknown" };
const app = (id) => ({ kind: "app", id });
const cheerpj = { id: "cheerpj", dir: "/home/user/system/apps/cheerpj", isolated: true };
const hello = { id: "hello", dir: "/home/user/system/apps/hello", isolated: false };
const decide = (rawPath, requester, appRef) => decideOpenRead({ rawPath, home: HOME, requester, app: appRef });
const allowed = (d) => d.ok === true;

/* resolvePath: the root of the traversal fix */
check("resolvePath folds ..", resolvePath("/home/user", "../x/./y") === "/home/x/y");
check("resolvePath refuses to climb past /", resolvePath("/", "../../etc") === null);

/* The OS */
check("OS reads a file in the home folder", allowed(decide("/home/user/Documents/a.txt", os)));
check("OS reads a file in /tmp", allowed(decide("/tmp/x.log", os)));
check("OS is refused /etc", !allowed(decide("/etc/passwd", os)));
check(
  "OS: traversal out of home is refused (the string starts with /home/user)",
  !allowed(decide("/home/user/../../etc/passwd", os)),
);
check(
  "OS: the refusal names the normalized /etc/passwd, not the raw string",
  decide("/home/user/../../etc/passwd", os).error?.includes('"/etc/passwd"'),
  decide("/home/user/../../etc/passwd", os).error,
);
check("OS: a sibling folder that shares the prefix is refused", !allowed(decide("/home/username/x", os)));
check("OS: a NUL byte is refused", !allowed(decide("/home/user/a\0b", os)));
check("OS: an empty path is refused", !allowed(decide("", os)));

/* A folder-isolated app (CheerpJ, store installs) */
check("isolated app reads its own folder", allowed(decide("/home/user/system/apps/cheerpj/app.js", app("cheerpj"), cheerpj)));
check("isolated app is refused the home folder", !allowed(decide("/home/user/Documents/secret.txt", app("cheerpj"), cheerpj)));
check(
  "isolated app: sibling 'cheerpj2' is not its folder",
  !allowed(decide("/home/user/system/apps/cheerpj2/x", app("cheerpj"), cheerpj)),
);
check(
  "isolated app: ../ out of its folder is refused",
  !allowed(decide("/home/user/system/apps/cheerpj/../hello/index.html", app("cheerpj"), cheerpj)),
);
grantFile("cheerpj", "/home/user/Downloads/game.jar");
check(
  "isolated app reads the one file the OS granted it",
  allowed(decide("/home/user/Downloads/game.jar", app("cheerpj"), cheerpj)),
);
check("the grant is exact: a neighbour is still refused", !allowed(decide("/home/user/Downloads/other.jar", app("cheerpj"), cheerpj)));
check(
  "a grant to one app does not open another",
  !allowed(decide("/home/user/Downloads/game.jar", app("hello"), { ...hello, isolated: true })),
);
grantFile("cheerpj", "/home/user/Downloads/../Downloads/game.jar");
check("grants are normalized before they are stored", isGranted("cheerpj", "/home/user/Downloads/game.jar"));

/* A filesystem app that is not isolated */
check("non-isolated app reads the home folder", allowed(decide("/home/user/Documents/a.txt", app("hello"), hello)));
check("non-isolated app is refused /etc", !allowed(decide("/etc/passwd", app("hello"), hello)));

/* Requesters that cannot be trusted */
check("an unidentified requester is refused", !allowed(decide("/home/user/a.txt", unknown)));
check("an unregistered app is refused", !allowed(decide("/home/user/a.txt", app("ghost"))));
check(
  "an app tag that does not match the registered app is refused",
  !allowed(decide("/home/user/a.txt", app("hello"), cheerpj)),
);

/* Requester parsing from the service worker's tag */
check("parses os", parseRequester("os").kind === "os");
check("parses app:<id>", parseRequester("app:cheerpj").id === "cheerpj");
check("anything else is unknown", parseRequester("app:").kind === "unknown" && parseRequester(7).kind === "unknown");

/* Grants are bounded */
for (let i = 0; i < 70; i++) grantFile("bulk", `/home/user/f${i}.bin`);
check("grants keep the newest 64", isGranted("bulk", "/home/user/f69.bin") && !isGranted("bulk", "/home/user/f0.bin"));

for (const r of results) console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}${r.detail ? "  (" + r.detail + ")" : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
