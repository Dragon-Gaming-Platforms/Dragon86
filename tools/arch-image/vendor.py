#!/usr/bin/env python3
"""Vendor as much of copy.sh's Arch root filesystem as can be hosted for free.

The image is 70,661 content-addressed blobs, ~5.3 GB — far past any GitHub
size limit — so this does not mirror everything and does not pretend to. It
mirrors a *curated* subset (the boot files, the whole userland, the libraries
those need) and leaves the rest to the upstream store, which the app uses as a
fallback and which still works in browsers that talk to it.

Why a mirror at all: i.copy.sh serves `Access-Control-Allow-Origin: *` but
requires a `Referer` that a page cannot forge, so a browser whose referrer is
stripped (Safari, tracking protection, strict policies) gets a connection
error on every blob. A copy on GitHub has no such opinion.

    python3 tools/arch-image/vendor.py --plan            # what would be mirrored
    python3 tools/arch-image/vendor.py --out site        # download it into site/arch

Selection rules (edit SKIP / MAX_FILE_BYTES / BUDGET below):
  * everything under /boot, /etc, /usr/bin, /usr/libexec, /usr/local is kept;
  * big toolchains and GPU/Docker/Rust/Java/Firefox trees are skipped —
    they are most of the bytes and none of the boot;
  * no single file over MAX_FILE_BYTES;
  * then the largest remaining files are dropped until the total fits BUDGET.

The result is deterministic (paths sorted, sizes fixed by the image), so a
re-run against an unchanged fs.json downloads nothing and commits nothing.
"""
import argparse
import concurrent.futures
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("V86_IMAGE_BASE", "https://i.copy.sh/")
ARCH = os.environ.get("V86_ARCH_DIR", "arch")

# What we never vendor. Everything here is either machine-local, a package
# cache, documentation, or a toolchain measured in hundreds of megabytes that
# no part of booting or shelling in touches.
SKIP = (
    "/var/",
    "/tmp/",
    "/usr/share/",
    "/usr/include/",
    "/usr/src/",
    "/opt/",
    "/root/",
    "/home/",
    "/usr/lib/modules",   # the kernel boots from its own initramfs
    "/usr/lib/firmware",
    "/usr/lib/debug",
    "/usr/lib/rustlib",   # 386 MB
    "/usr/lib/dri",       # 410 MB of GPU drivers; v86 has no GPU
    "/usr/lib/firefox",   # 308 MB
    "/usr/lib/jvm",       # 148 MB
    "/usr/lib/gcc",       # 133 MB
    "/usr/lib/clang",
    "/usr/lib/docker",
    "/usr/lib/cni",
    "/usr/lib/ocaml",
    "/usr/lib/guile",
    "/usr/lib/bellagio",
    "/usr/lib/d3d",
)

# Individual libraries that drag in a whole toolchain.
SKIP_FILE = (
    "libLLVM-",
    "libclang",
    "librustc_driver",
    "libgo.so",
    "libnode.so",
    "libicudata",
    "libOSMesa",
)

MAX_FILE_BYTES = 12 * 1024 * 1024

# Bytes we are willing to publish. A GitHub Pages site is capped at 1 GB and
# this repo already publishes ~60 MB of engine and apps; a git branch has no
# such cap but gets slow to clone, so stay well under.
BUDGET = 700 * 1024 * 1024

HEADERS = {
    "User-Agent": "dragon86-vendor/1",
    "Accept": "*/*",
    "Referer": "https://copy.sh/v86/",
}


def load_tree(path):
    with open(path, "rb") as fh:
        doc = json.load(fh)
    root = doc.get("fsroot") if isinstance(doc, dict) else doc
    if not isinstance(root, list) or not root:
        raise SystemExit(f"{path}: no fsroot array")
    return root


def walk(node, prefix, out):
    if not isinstance(node, list) or len(node) < 7:
        return
    name, size, _mtime, _mode, _uid, _gid, last = node[:7]
    path = f"{prefix}/{name}"
    if isinstance(last, str):
        if last.endswith(".bin") or last.endswith(".bin.zst"):
            out.append((path, last, int(size)))
    elif isinstance(last, list):
        for child in last:
            walk(child, path, out)


def select(root):
    files = []
    for node in root:
        walk(node, "", files)
    files.sort()

    skipped_bytes = 0
    kept = []
    for path, blob, size in files:
        if path.startswith(SKIP) or any(f in path for f in SKIP_FILE):
            skipped_bytes += size
            continue
        if size > MAX_FILE_BYTES:
            skipped_bytes += size
            continue
        kept.append((path, blob, size))

    total = sum(s for _, _, s in kept)
    dropped = []
    if total > BUDGET:
        # Keep /boot no matter what: without the kernel there is no guest.
        droppable = sorted(
            (k for k in kept if not k[0].startswith("/boot/")),
            key=lambda k: (-k[2], k[0]),
        )
        keep = {p for p, _, _ in kept}
        for path, blob, size in droppable:
            if total <= BUDGET:
                break
            keep.discard(path)
            total -= size
            dropped.append((path, size))
            skipped_bytes += size
        kept = [k for k in kept if k[0] in keep]

    blobs = {}
    for path, blob, _size in kept:
        blobs[blob] = path
    return kept, blobs, total, skipped_bytes, dropped


def human(n):
    return f"{n / 1048576:.1f} MB"


def fetch(url, dest, retries=5):
    last = None
    for attempt in range(retries):
        if attempt:
            time.sleep(2 ** attempt)
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=180) as res:
                data = res.read()
            tmp = dest + ".part"
            with open(tmp, "wb") as fh:
                fh.write(data)
            os.replace(tmp, dest)
            return len(data)
        except Exception as err:  # noqa: BLE001 - retry anything transient
            last = err
    raise SystemExit(f"failed: {url}: {last}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fs-json", default="public/v86/fs.json")
    ap.add_argument("--out", default="site", help="directory to vendor into (arch/ inside it)")
    ap.add_argument("--plan", action="store_true", help="report the selection, download nothing")
    ap.add_argument("--jobs", type=int, default=int(os.environ.get("JOBS", "16")))
    ap.add_argument("--list", metavar="PATH", help="write the selected blob names here (for tests)")
    args = ap.parse_args()

    root = load_tree(args.fs_json)
    kept, blobs, total, skipped, dropped = select(root)

    print(f"image: {args.fs_json}")
    print(f"selected: {len(kept)} files, {len(blobs)} distinct blobs, {human(total)}")
    print(f"not vendored: {human(skipped)} ({len(dropped)} dropped for budget)")
    print(f"budget: {human(BUDGET)}")
    if args.list:
        with open(args.list, "w") as fh:
            fh.write("\n".join(sorted(blobs)) + "\n")

    if args.plan:
        return 0

    out = os.path.join(args.out, ARCH)
    # The branch doubles as a complete image store: the list lives beside the
    # blobs, so pointing Settings at it needs no other setup.
    import shutil

    shutil.copyfile(args.fs_json, os.path.join(args.out, "fs.json"))
    os.makedirs(out, exist_ok=True)
    todo = [(b, p) for b, p in sorted(blobs.items()) if not os.path.exists(os.path.join(out, b))]
    print(f"to download: {len(todo)} (resumable: existing files are kept)")

    done = 0
    bytes_done = 0
    lock = __import__("threading").Lock()

    def one(item):
        nonlocal done, bytes_done
        blob, path = item
        n = fetch(f"{BASE}{ARCH}/{blob}", os.path.join(out, blob))
        with lock:
            done += 1
            bytes_done += n
            if done % 1000 == 0:
                print(f"  {done}/{len(todo)}  {human(bytes_done)}", flush=True)

    if todo:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            for fut in concurrent.futures.as_completed([pool.submit(one, t) for t in todo]):
                fut.result()

    manifest = {
        "source": BASE,
        "fs_json_entries": len(kept),
        "blobs": len(blobs),
        "bytes": total,
        "rules": {
            "skip_prefixes": list(SKIP),
            "skip_substrings": list(SKIP_FILE),
            "max_file_bytes": MAX_FILE_BYTES,
            "budget_bytes": BUDGET,
        },
    }
    with open(os.path.join(args.out, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    with open(os.path.join(out, ".nojekyll"), "w"):
        pass
    print(f"done: {human(total)} in {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
