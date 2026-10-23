#!/usr/bin/env python3
"""Ask the image origin what it will and will not serve, and write it down.

`i.copy.sh` answers 403 to some clients — Safari in a browser, and our own
fetch in GitHub Actions — while serving `http://` to others. 403 means "I
understand you and I am refusing", so which *request shape* is refused
decides the fix: a header we can add, a scheme we can switch to, or a mirror.

This prints a matrix (scheme x user-agent x referer) and the response
headers for the first combination that works, as markdown:

    python3 tools/arch-image/probe-origin.py > /tmp/probe.md

The repository's `probe-origin` workflow runs it and commits the result, so
the answer can be read without shell access to a runner.
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "i.copy.sh"
PATH = "/fs.json"

UAS = {
    "dragon86": "dragon86-vendor/1",
    "chrome": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "safari-ios": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
    ),
    "curl": "curl/8.5.0",
}

REFERERS = {
    "none": None,
    "copy.sh": "https://copy.sh/v86/",
    "same-origin": f"https://{BASE}/",
    # What our own pages actually send. If this is refused while copy.sh's is
    # allowed, the store has a referer allowlist and no browser-side fix
    # exists (a page cannot forge Referer) — a mirror is the only answer.
    "our-pages": "https://dragon-gaming-platforms.github.io/Dragon86/",
    "random-site": "https://example.com/",
}


def attempt(scheme, ua, referer, extra=None, method="GET"):
    url = f"{scheme}://{BASE}{PATH}"
    headers = {"User-Agent": UAS[ua], "Accept": "*/*"}
    if referer:
        headers["Referer"] = REFERERS[referer]
    if extra:
        headers.update(extra)
    req = urllib.request.Request(url, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as res:
            body = res.read(64) if method == "GET" else b""
            return {
                "status": res.status,
                "final": res.geturl(),
                "type": res.headers.get("Content-Type", "-"),
                "len": res.headers.get("Content-Length", "-"),
                "cors": res.headers.get("Access-Control-Allow-Origin", "-"),
                "head": body[:16].decode("latin-1", "replace"),
                "headers": dict(res.headers),
            }
    except urllib.error.HTTPError as err:
        return {
            "status": err.code,
            "final": err.geturl() if hasattr(err, "geturl") else url,
            "type": err.headers.get("Content-Type", "-") if err.headers else "-",
            "len": err.headers.get("Content-Length", "-") if err.headers else "-",
            "cors": "-",
            "head": "",
            "headers": dict(err.headers) if err.headers else {},
        }
    except Exception as err:  # noqa: BLE001
        return {"status": type(err).__name__, "final": url, "type": "-", "len": "-", "cors": "-", "head": "", "headers": {}}


MIRROR = "https://raw.githubusercontent.com/Dragon-Gaming-Platforms/Dragon86/arch-image/"


def mirror_check():
    """Is the vendored mirror actually serving, and does it allow CORS?"""
    out = ["", "## The vendored mirror (`arch-image` branch)", "", f"- base: `{MIRROR}`"]
    try:
        req = urllib.request.Request(MIRROR + "manifest.json", headers={"User-Agent": HEADERS["User-Agent"]})
        with urllib.request.urlopen(req, timeout=60) as res:
            body = res.read()
            out.append(f"- manifest.json: **HTTP {res.status}**, {len(body)} bytes")
            out.append(f"- CORS header: `{res.headers.get('Access-Control-Allow-Origin', 'MISSING')}`")
            out.append(f"- content-type: `{res.headers.get('Content-Type')}`")
            try:
                doc = json.loads(body)
                out.append(f"- mirrored: {doc.get('blobs')} blobs, {doc.get('bytes', 0) / 1048576:.1f} MB")
            except ValueError:
                out.append("- manifest.json is not JSON")
    except Exception as err:  # noqa: BLE001
        out.append(f"- manifest.json: **failed** — {type(err).__name__}: `{err}`")
    return out


def vendor_check():
    """Run the *exact* fetch the vendor workflow uses, and say what it did.

    The probe matrix reads 64 bytes and stops; the workflow reads the whole
    file (5.8 MB). Those can behave differently through a CDN, so test the
    real thing rather than assuming the matrix settles it.
    """
    out = ["", "## The vendor workflow's own fetch (`mirror.py`)", ""]
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        import mirror
    except Exception as err:  # noqa: BLE001
        out.append(f"- could not import mirror.py: `{err}`")
        return out

    out.append(f"- base: `{mirror.BASE}`")
    try:
        raw = mirror.fetch(mirror.BASE + "fs.json")
    except SystemExit as err:
        out.append(f"- fs.json: **failed** — `{err}`")
        return out
    except Exception as err:  # noqa: BLE001
        out.append(f"- fs.json: **failed** — {type(err).__name__}: `{err}`")
        return out
    out.append(f"- fs.json: **{len(raw)} bytes**")
    try:
        doc = json.loads(raw)
    except ValueError as err:
        out.append(f"- fs.json is not JSON: `{err}`")
        return out
    root = doc.get("fsroot") if isinstance(doc, dict) else doc
    out.append(f"- fsroot entries: {len(root) if isinstance(root, list) else 'none'}")

    # One real blob, to prove contents are reachable too (not just the index).
    best = None
    def walk(node):
        nonlocal best
        if not isinstance(node, list) or len(node) < 7:
            return
        last = node[6]
        if isinstance(last, str) and (last.endswith(".bin") or last.endswith(".bin.zst")):
            if best is None or node[1] < best[0]:
                best = (node[1], last)
        elif isinstance(last, list):
            for child in last:
                walk(child)
    for node in root if isinstance(root, list) else []:
        walk(node)
    if best:
        size, name = best
        try:
            data = mirror.fetch(f"{mirror.BASE}{mirror.ARCH}/{name}")
            out.append(f"- smallest blob `{name}`: **{len(data)} bytes** (listed size {size})")
        except SystemExit as err:
            out.append(f"- smallest blob `{name}`: **failed** — `{err}`")
    return out


def main():
    out = ["# What the image origin says", "", f"Target: `{BASE}{PATH}`", "", "| scheme | user-agent | referer | status | content-type | length | CORS |", "|---|---|---|---|---|---|---|"]
    winner = None
    for scheme in ("https", "http"):
        for ua in UAS:
            for referer in REFERERS:
                r = attempt(scheme, ua, referer)
                out.append(
                    f"| {scheme} | {ua} | {referer} | **{r['status']}** | {r['type']} | {r['len']} | {r['cors']} |"
                )
                if winner is None and isinstance(r["status"], int) and 200 <= r["status"] < 300 and r["head"].lstrip().startswith("{"):
                    winner = (scheme, ua, referer, r)

    out.append("")
    if winner:
        scheme, ua, referer, r = winner
        out += [
            f"## First combination that works: `{scheme}` / UA `{ua}` / referer `{referer}`",
            "",
            f"- final URL: `{r['final']}`",
            f"- content-type: `{r['type']}`",
            f"- Access-Control-Allow-Origin: `{r['cors']}`",
            f"- first bytes: `{r['head']}`",
            "",
            "Response headers:",
            "",
            "```",
            *[f"{k}: {v}" for k, v in r["headers"].items()],
            "```",
        ]
    else:
        out += [
            "## Nothing worked",
            "",
            "Every shape was refused or unreachable from this runner. The image list has to come from",
            "somewhere else: a mirror (see tools/arch-image/README.md) or a browser.",
        ]

    # HEAD and cache-buster, using the winning shape when we have one.
    if winner:
        scheme, ua, referer = winner[0], winner[1], winner[2]
        out += ["", "## Variations on the working shape", "", "| variation | status |", "|---|---|"]
        for label, kw in (
            ("HEAD", {"method": "HEAD"}),
            ("cache-buster query", {"extra": {"Cache-Control": "no-cache"}}),
            ("Accept: application/json", {"extra": {"Accept": "application/json"}}),
        ):
            r = attempt(scheme, ua, referer, **kw)
            out.append(f"| {label} | **{r['status']}** |")

    out += mirror_check()
    out += vendor_check()
    print("\n".join(out))


if __name__ == "__main__":
    sys.exit(main())
