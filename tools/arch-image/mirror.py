#!/usr/bin/env python3
"""Mirror copy/v86's Arch Linux image set into a directory we can publish.

copy/v86's Arch demo does not use a disk image. It boots with
`root=host9p`, and v86 serves the *whole root filesystem* over 9p from a
flat, content-addressed HTTP store:

    fs.json        a tree of [name, size, mtime, mode, uid, gid, child-or-file]
    arch/<hash>.bin[.zst]
                   one file per unique blob, named after the first 10 hex
                   digits of its sha256 (see tools/fs2json.py upstream)

v86 fetches only the blobs the guest actually touches, so the browser
pulls a few MB at boot rather than the whole tree.

This script copies that set somewhere it can be served from (a GitHub
Pages repo of its own, in our case) without needing to understand the
guest's contents:

    python3 mirror.py site            # writes site/fs.json + site/arch/*

Environment:
    V86_IMAGE_BASE   source root, default https://i.copy.sh/
    V86_ARCH_DIR     blob directory name under the root, default arch
    JOBS             parallel downloads, default 16
    SKIP_EXISTING    "1" to keep files already downloaded (resumable)

It refuses to write past --max-size (default 950 MB) so a Pages deploy
cannot silently blow through GitHub's 1 GB site limit.
"""
import argparse
import concurrent.futures
import json
import os
import sys
import time
import urllib.request

BASE = os.environ.get("V86_IMAGE_BASE", "https://i.copy.sh/")
ARCH = os.environ.get("V86_ARCH_DIR", "arch")


def fetch(url, dest=None, retries=5):
    last = None
    for attempt in range(retries):
        if attempt:
            time.sleep(2 ** attempt)  # 2s, 4s, 8s, 16s
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "dragon86-mirror/1"})
            with urllib.request.urlopen(req, timeout=120) as res:
                data = res.read()
            if dest:
                with open(dest + ".part", "wb") as fh:
                    fh.write(data)
                os.replace(dest + ".part", dest)
            return data
        except Exception as err:  # noqa: BLE001 - retry anything transient
            last = err
    raise SystemExit(f"failed: {url}: {last}")


BLOB_RE = __import__("re").compile(r"^[0-9a-f]{10}\.bin(\.zst)?$")


def blobs(node, out):
    """Walk the fs.json tree and collect every blob filename."""
    # A node is [name, size, mtime, mode, uid, gid, last]; upstream trims
    # trailing nulls, so short nodes are empty directories.
    if not isinstance(node, list) or not node or not isinstance(node[0], str):
        return
    if len(node) < 7:
        return
    last = node[6]
    if isinstance(last, str):
        if BLOB_RE.match(last):
            out.add(last)
    elif isinstance(last, list):
        for child in last:
            blobs(child, out)


def size_of(path):
    return sum(
        os.path.getsize(os.path.join(dp, f))
        for dp, _, fs in os.walk(path)
        for f in fs
    )


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}"
        n /= 1024


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dest", nargs="?", default="site")
    ap.add_argument("--max-size", type=float, default=950, help="MB")
    args = ap.parse_args()

    os.makedirs(os.path.join(args.dest, ARCH), exist_ok=True)
    print(f"source: {BASE}")

    print("fetching fs.json ...")
    raw = fetch(BASE + "fs.json")
    tree = json.loads(raw)
    with open(os.path.join(args.dest, "fs.json"), "wb") as fh:
        fh.write(raw)

    names = set()
    blobs(tree, names)
    names = sorted(names)
    print(f"{len(names)} blobs referenced")

    todo = []
    for name in names:
        dest = os.path.join(args.dest, ARCH, name)
        if os.environ.get("SKIP_EXISTING") == "1" and os.path.exists(dest):
            continue
        todo.append(name)
    print(f"{len(todo)} to download")

    done = 0
    jobs = int(os.environ.get("JOBS", "16"))

    def one(name):
        nonlocal done
        fetch(f"{BASE}{ARCH}/{name}", os.path.join(args.dest, ARCH, name))
        done += 1
        if done % 200 == 0:
            print(f"  {done}/{len(todo)}  ({human(size_of(args.dest))})", flush=True)

    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        for fut in concurrent.futures.as_completed([pool.submit(one, n) for n in todo]):
            fut.result()

    total = size_of(args.dest)
    print(f"done: {args.dest} is {human(total)}")
    if total > args.max_size * 1024 * 1024:
        sys.exit(
            f"ERROR: {human(total)} exceeds the {args.max_size:.0f} MB budget. "
            "GitHub Pages tops out at 1 GB per site."
        )


if __name__ == "__main__":
    main()
