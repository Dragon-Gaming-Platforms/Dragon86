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
    python3 mirror.py --list-only public/v86/fs.json
    python3 mirror.py --probe        # what does the origin say to whom?
                                      # vendor just the index into the app

Environment:
    V86_IMAGE_BASE   source root, default https://i.copy.sh/
                     (the store also answers on http://; if https returns 403
                     for a request with no referer, point this at
                     http://i.copy.sh/ instead)
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
import urllib.error
import urllib.request

BASE = os.environ.get("V86_IMAGE_BASE", "https://i.copy.sh/")
ARCH = os.environ.get("V86_ARCH_DIR", "arch")


# A browser-ish request. i.copy.sh answers 403 to clients it does not
# recognise, and a Referer is the header that most such filters look at, so
# send the one copy.sh's own page would send. (A browser cannot send this
# cross-origin, which is exactly why Safari gets 403 where curl does not.)
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Referer": "https://copy.sh/v86/",
}


def status(url, headers=None):
    """HTTP status for one URL, or the exception class — for --probe."""
    try:
        req = urllib.request.Request(url, headers=headers if headers is not None else HEADERS)
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status
    except urllib.error.HTTPError as err:
        return err.code
    except Exception as err:  # noqa: BLE001
        return type(err).__name__


def probe():
    """Explain what the image origin says to whom.

    403 is not a network failure: the host is up and is refusing this
    client. Which header (or scheme) it objects to decides what can be done
    about it, so print the matrix instead of guessing.
    """
    for scheme in ("https", "http"):
        base = f"{scheme}://i.copy.sh/"
        print(f"{base}")
        print(f"  fs.json   browser-ish headers : {status(base + 'fs.json')}")
        print(f"  fs.json   no referer          : {status(base + 'fs.json', {'User-Agent': HEADERS['User-Agent'], 'Accept': '*/*'})}")
        print(f"  fs.json   no headers at all   : {status(base + 'fs.json', {})}")


def fetch(url, dest=None, retries=5):
    last = None
    for attempt in range(retries):
        if attempt:
            time.sleep(2 ** attempt)  # 2s, 4s, 8s, 16s
        try:
            req = urllib.request.Request(url, headers=HEADERS)
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


def list_only(path):
    """Write fs.json to `path` — the whole file tree, minus any file contents.

    The app uses this copy to build the Arch filesystem in ZenFS without
    touching the network: paths, directories, symlinks, modes and sizes all
    come from it, and only file contents are streamed from the image store.
    Refuses to write something that is not an image index.
    """
    print(f"source: {BASE}")
    raw = fetch(BASE + "fs.json")
    try:
        tree = json.loads(raw)
    except ValueError as err:
        raise SystemExit(f"not JSON ({err}); got {len(raw)} bytes - wrong URL or an error page?")
    root = tree.get("fsroot") if isinstance(tree, dict) else tree
    if not isinstance(root, list) or not root:
        raise SystemExit("no fsroot array in that document")
    names = set()
    for node in root:
        blobs(node, names)
    if not names:
        raise SystemExit("fsroot has no file entries - refusing to write it")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(raw)
    print(f"wrote {path} ({human(len(raw))}), {len(names)} file contents referenced")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dest", nargs="?", default="site")
    ap.add_argument("--max-size", type=float, default=950, help="MB")
    ap.add_argument(
        "--list-only",
        metavar="PATH",
        help="download just fs.json and write it to PATH (vendor the index; no blobs)",
    )
    ap.add_argument("--probe", action="store_true", help="print the origin's status for several request shapes")
    args = ap.parse_args()

    if args.probe:
        probe()
        return

    if args.list_only:
        list_only(args.list_only)
        return

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
