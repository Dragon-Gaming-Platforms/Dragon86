#!/usr/bin/env node
/**
 * Tests for the guest-side scripts in public/v86/scripts/.
 *
 * These scripts run inside the v86 guest, where the only tools are bash,
 * GNU coreutils, busybox and a static git — a combination that cannot be
 * exercised end-to-end from here (there is no emulator in this environment,
 * and no relay). What *can* be tested is everything that has bitten us:
 *
 *   - the GitHub URL → codeload URL mapping (owner/repo, .git, /tree/<ref>,
 *     -b, commit shas, and the "that is not github" refusal)
 *   - the 404, download-failure and "that is 900 MB" paths — the ones where a
 *     wrong message sends people hunting for a network problem that is not
 *     there
 *   - the unpack step, with real tar and real git, including dotfiles
 *   - the /etc/profile helpers: d86-clone and d86-net exist as functions, the
 *     `git clone` wrapper catches only http(s) URLs, and every other git
 *     command still goes to the real git
 *
 *   node tools/test-guest-scripts.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const scripts = resolve(repo, "public/v86/scripts");

let failures = 0;
function check(name, ok, extra = "") {
  if (ok) console.log(`[PASS] ${name}`);
  else {
    failures++;
    console.log(`[FAIL] ${name}${extra ? `  (${extra})` : ""}`);
  }
}
const read = (f) => readFileSync(resolve(scripts, f), "utf8");
const sh = (args, opts = {}) =>
  spawnSync("bash", args, { encoding: "utf8", ...opts, env: { ...process.env, LC_ALL: "C", ...opts.env } });

/* ---- 1. they parse ---- */
for (const [file, shell] of [
  ["d86-clone.sh", "sh"],
  ["d86-net.sh", "sh"],
  ["guest-helpers.sh", "bash"],
]) {
  const r = spawnSync(shell, ["-n", resolve(scripts, file)], { encoding: "utf8" });
  check(`${file} parses under ${shell}`, r.status === 0, (r.stderr || "").trim().slice(0, 200));
}

/* ---- 2. a fake wget we can direct ---- */
const work = mkdtempSync(join(tmpdir(), "d86-guest-"));
const bin = join(work, "bin");
mkdirSync(bin, { recursive: true });

/** Build a GitHub-shaped tarball: <top>/ with files, incl. a dotfile. */
function makeTarball(top, files) {
  const stage = join(work, `stage-${top}`);
  rmSync(stage, { recursive: true, force: true });
  for (const [name, body] of Object.entries(files)) {
    const p = join(stage, top, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  const out = join(work, `${top}.tar.gz`);
  const r = spawnSync("tar", ["-czf", out, "-C", stage, top], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  return out;
}

/**
 * The stub. Behaviour is driven by env:
 *   FAKE_WGET_TARBALL   file to "download"
 *   FAKE_WGET_STATUS    HTTP status for the --spider probe (default 200)
 *   FAKE_WGET_LEN       Content-Length for the probe
 *   FAKE_WGET_LOG       every URL it was asked for, one per line
 */
writeFileSync(
  join(bin, "wget"),
  `#!/bin/sh
url=""
out=""
spider=0
while [ $# -gt 0 ]; do
  case "$1" in
    --spider) spider=1 ;;
    -O) shift; out=$1 ;;
    -T|-t) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
[ -n "\${FAKE_WGET_LOG:-}" ] && printf '%s\\n' "$url" >> "$FAKE_WGET_LOG"
status=\${FAKE_WGET_STATUS:-200}
if [ -n "\${FAKE_WGET_404_FOR:-}" ]; then
  case "$url" in *"$FAKE_WGET_404_FOR"*) status=404 ;; esac
fi
if [ "$spider" -eq 1 ]; then
  printf 'Connecting to host...\\n' >&2
  printf '  HTTP/1.1 %s Whatever\\r\\n' "$status" >&2
  [ -n "\${FAKE_WGET_LEN:-}" ] && printf '  Content-Length: %s\\r\\n' "$FAKE_WGET_LEN" >&2
  exit 0
fi
if [ "$status" != "200" ]; then
  printf 'wget: server returned error: HTTP/1.1 %s\\n' "$status" >&2
  exit 1
fi
cp "\${FAKE_WGET_TARBALL:?}" "$out" || exit 1
exit 0
`,
  { mode: 0o755 },
);
chmodSync(join(bin, "wget"), 0o755);

const baseEnv = () => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, LC_ALL: "C" });

function clone(args, env = {}) {
  return spawnSync("bash", [resolve(scripts, "d86-clone.sh"), ...args], {
    encoding: "utf8",
    cwd: work,
    env: { ...baseEnv(), HOME: work, ...env },
  });
}

/* ---- 3. URL → codeload mapping ---- */
const log = join(work, "urls.log");
const urlCases = [
  ["https://github.com/owner/repo", "https://codeload.github.com/owner/repo/tar.gz/HEAD"],
  ["https://github.com/owner/repo.git", "https://codeload.github.com/owner/repo/tar.gz/HEAD"],
  ["https://github.com/owner/repo/", "https://codeload.github.com/owner/repo/tar.gz/HEAD"],
  ["owner/repo", "https://codeload.github.com/owner/repo/tar.gz/HEAD"],
  ["https://github.com/owner/repo/tree/dev", "https://codeload.github.com/owner/repo/tar.gz/refs/heads/dev"],
  ["https://github.com/owner/repo -b v1.2.3", "https://codeload.github.com/owner/repo/tar.gz/refs/heads/v1.2.3"],
  // A branch that merely looks like hex is still a branch…
  ["https://github.com/owner/repo -b decafbad", "https://codeload.github.com/owner/repo/tar.gz/refs/heads/decafbad"],
  // …while a real commit sha is used as a ref of its own.
  [
    "https://github.com/owner/repo -b 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a",
    "https://codeload.github.com/owner/repo/tar.gz/3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a",
  ],
  // refs/… is passed through untouched.
  ["https://github.com/owner/repo -b refs/tags/v2", "https://codeload.github.com/owner/repo/tar.gz/refs/tags/v2"],
];
for (const [args, want] of urlCases) {
  rmSync(log, { force: true });
  // No tarball: the download fails, but it fails *after* the URL is chosen.
  clone(args.split(" "), { FAKE_WGET_STATUS: "500", FAKE_WGET_LOG: log, FAKE_WGET_TARBALL: "/nonexistent" });
  const got = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n")[0] : "";
  const label = args.includes(" -b ") ? `${args.split(" ")[0]} ${args.split(" -b ")[1]}` : args.split(" ")[0];
  check(`maps ${label}`, got === want, got || "(nothing fetched)");
}

/* ---- 4. refusals ---- */
const notGithub = clone(["https://gitlab.com/owner/repo"]);
check("refuses a non-GitHub host", notGithub.status === 1 && /only github\.com/.test(notGithub.stderr));
const notRepo = clone(["notarepo"]);
check("refuses nonsense", notRepo.status === 1 && /not a repository/.test(notRepo.stderr));
const badFlag = clone(["--nope"]);
check("refuses an unknown flag", badFlag.status === 1 && /unknown option/.test(badFlag.stderr));

const notFound = clone(["https://github.com/owner/gone", join(work, "gone")], {
  FAKE_WGET_STATUS: "404",
  FAKE_WGET_TARBALL: "/nonexistent",
});
check(
  "404 is reported as a missing repo/branch, not a network fault",
  notFound.status === 1 && /404/.test(notFound.stderr) && !/DNS/.test(notFound.stderr),
  (notFound.stderr || "").trim().slice(0, 200),
);

/* An abbreviated sha is not a branch: the first probe 404s, the script retries
   the bare ref, and the download must use the URL that worked. */
const shaLog = join(work, "sha.log");
rmSync(shaLog, { force: true });
const shortShaDest = join(work, "shortsha");
const shortSha = clone(["https://github.com/owner/repo", shortShaDest, "-b", "abc1234"], {
  FAKE_WGET_TARBALL: makeTarball("repo-abc1234", { "a.txt": "a\n" }),
  FAKE_WGET_404_FOR: "refs/heads/abc1234",
  FAKE_WGET_LOG: shaLog,
});
const shaUrls = existsSync(shaLog) ? readFileSync(shaLog, "utf8").trim().split("\n") : [];
check(
  "a 404 branch falls back to the bare ref",
  shortSha.status === 0 && shaUrls.includes("https://codeload.github.com/owner/repo/tar.gz/abc1234"),
  shaUrls.join(" | ") || (shortSha.stderr || "").trim(),
);
check("…and the files land where they were asked for", existsSync(join(shortShaDest, "a.txt")));

/* ---- 5. the size guard ---- */
const bigTarball = makeTarball("repo-HEAD", { "README.md": "hello\n" });
const huge = clone(["https://github.com/owner/repo", join(work, "huge")], {
  FAKE_WGET_TARBALL: bigTarball,
  FAKE_WGET_LEN: "900000000",
});
check(
  "a huge tarball needs --force",
  huge.status === 1 && /--force/.test(huge.stderr),
  (huge.stderr || "").trim().slice(0, 160),
);
const hugeForced = clone(["https://github.com/owner/repo", join(work, "huge2"), "--force"], {
  FAKE_WGET_TARBALL: bigTarball,
  FAKE_WGET_LEN: "900000000",
});
check("--force overrides it", hugeForced.status === 0, (hugeForced.stderr || "").trim().slice(0, 200));

/* ---- 6. the real thing: tar + git ---- */
const tarball = makeTarball("repo-HEAD", {
  "README.md": "# hi\n",
  "src/main.js": "console.log(1)\n",
  ".gitignore": "node_modules\n",
  "docs/guide.md": "guide\n",
});
const dest = join(work, "repo");
const ok = clone(["https://github.com/owner/repo", dest], {
  FAKE_WGET_TARBALL: tarball,
  FAKE_WGET_LEN: "1200",
});
check("clone succeeds", ok.status === 0, (ok.stderr || ok.stdout || "").trim().slice(0, 300));
check("the tree is there", existsSync(join(dest, "src/main.js")));
check("dotfiles survive the unpack", existsSync(join(dest, ".gitignore")));
check("no leftover download or staging dir", !existsSync(join(dest, ".d86-download.tar.gz")) && !existsSync(join(dest, ".d86-unpack")));

const gitq = (args) => spawnSync("git", ["-C", dest, ...args], { encoding: "utf8" });
const logOut = gitq(["log", "--oneline"]).stdout.trim();
check("it is a real repository with one commit", logOut.split("\n").length === 1, logOut);
check("the work tree is clean", gitq(["status", "--porcelain"]).stdout.trim() === "", gitq(["status", "--porcelain"]).stdout);
const tracked = gitq(["ls-files"]).stdout.trim().split("\n").sort().join(",");
check(
  "every file is tracked, dotfiles included",
  tracked === ".gitignore,README.md,docs/guide.md,src/main.js",
  tracked,
);
check("the commit records where it came from", /codeload\.github\.com\/owner\/repo/.test(gitq(["log", "-1", "--format=%B"]).stdout));
check(
  "it says it is a snapshot, not a clone",
  /snapshot/i.test(ok.stdout) && /no upstream history/i.test(ok.stdout),
  ok.stdout.trim().split("\n").slice(-3).join(" | "),
);
const branch = gitq(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
check("the branch is main", branch === "main", branch);

/* A second run into the same directory must not restage or re-commit. */
const again = clone(["https://github.com/owner/repo", dest], { FAKE_WGET_TARBALL: tarball });
check("a second run leaves the history alone", again.status === 0 && /left its history alone/.test(again.stdout), again.stdout.trim().slice(-160));

/* ---- 7. the /etc/profile helpers ---- */
const helperStub = join(work, "helpers");
mkdirSync(helperStub, { recursive: true });
writeFileSync(join(helperStub, "git"), '#!/bin/sh\nprintf "REAL-GIT %s\\n" "$*"\n', { mode: 0o755 });
chmodSync(join(helperStub, "git"), 0o755);

/* Where the helpers think the guest scripts live — a stand-in for /usr/bin. */
const fakeBin = join(work, "guestbin");
mkdirSync(fakeBin, { recursive: true });
for (const name of ["d86-clone", "d86-net"]) {
  writeFileSync(join(fakeBin, name), `#!/bin/sh\nprintf "STUB-${name.toUpperCase()} %s\\n" "$*"\n`, {
    mode: 0o755,
  });
  chmodSync(join(fakeBin, name), 0o755);
}

const profile = `
export PATH="${helperStub}:$PATH"
export D86_BIN="${fakeBin}"
. "${resolve(scripts, "guest-helpers.sh")}"
type -t d86-clone >/dev/null && echo HAS-CLONE
type -t d86-net >/dev/null && echo HAS-NET
echo "--- wrapper:"; git clone https://github.com/owner/repo
echo "--- passthrough local:"; git clone ./somewhere
echo "--- passthrough other:"; git status
`;
const helperRun = spawnSync("bash", ["-c", profile], {
  encoding: "utf8",
  env: { ...baseEnv(), HOME: work },
});
const hout = helperRun.stdout;
check("the helpers define d86-clone and d86-net", /HAS-CLONE/.test(hout) && /HAS-NET/.test(hout));
check(
  "the git wrapper explains itself for a clone URL",
  /no HTTPS support/.test(hout) && /snapshot import/.test(hout),
  hout.split("\n").slice(0, 4).join(" | "),
);
check(
  "the wrapper then runs d86-clone rather than real git",
  /STUB-D86-CLONE https:\/\/github\.com\/owner\/repo/.test(hout) && !/REAL-GIT clone https/.test(hout),
  hout.slice(hout.indexOf("--- wrapper"), hout.indexOf("--- passthrough local")).slice(0, 300),
);
check(
  "a local clone still goes to the real git",
  /REAL-GIT clone \.\/somewhere/.test(hout),
  hout.slice(hout.indexOf("--- passthrough local")).slice(0, 120),
);
check(
  "every other git command is untouched",
  /REAL-GIT status/.test(hout),
  hout.slice(hout.indexOf("--- passthrough other")).slice(0, 120),
);

/* ---- 8. d86-net tells the truth about ping ---- */
const netOk = spawnSync("bash", [resolve(scripts, "d86-net.sh")], {
  encoding: "utf8",
  env: { ...baseEnv(), PATH: `${bin}:${helperStub}:${process.env.PATH}`, HOME: work },
});
/* This machine is not the guest: there is no relay, so the chain must break —
   and the script has to say where, exit 1, and never claim success. */
const netOut = netOk.stdout + netOk.stderr;
check("d86-net exits non-zero when the chain is broken", netOk.status === 1, netOut.trim().slice(0, 160));
check("d86-net names the link that broke", /\[fail\]/.test(netOut), netOut.trim().split("\n").slice(-3).join(" | "));
check("d86-net never reports success it did not have", !/the chain works/.test(netOut));
check(
  "the guest readme explains the ping trap",
  /v86 .*answers ICMP|answers ICMP on its own/i.test(read("guest-readme.txt")),
);
const net = read("d86-net.sh");
check("d86-net says why ping is not a test", /emulator answers ICMP|answers ICMP itself/i.test(net));

/* ---- 9. the installer installs files that exist ---- */
/* A rename on either side of this would silently leave the guest without the
   scripts, so read the asset names straight out of the bridge. */
const bridge = readFileSync(resolve(repo, "src/bridge/v86.ts"), "utf8");
const assets = [...bridge.matchAll(/installHostFile\(\s*"([^"]+)"/g)].map((m) => m[1]);
check("the bridge installs at least the guest scripts", assets.length >= 4, assets.join(", "));
for (const asset of assets) {
  check(`public/v86/scripts/${asset} exists`, existsSync(resolve(scripts, asset)));
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
