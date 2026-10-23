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

    print("\n".join(out))


if __name__ == "__main__":
    sys.exit(main())
