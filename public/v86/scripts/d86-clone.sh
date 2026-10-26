#!/bin/sh
# d86-clone — bring a GitHub repository into this filesystem.
#
# This is the fallback, not the way in. `git clone https://…` works in this
# guest: git's HTTPS helper ships with it (/usr/lib/git-core/git-remote-http,
# a static build with libcurl + mbedTLS, plus a CA bundle), so a real clone
# brings real history.
#
# This script exists for the case a clone is the wrong tool: a repository so
# large, or a branch you only want the files from. It downloads GitHub's own
# tarball for a branch with busybox wget, unpacks it, and hands the result to
# the guest's git, which makes a repository out of it — one commit, current
# files, no upstream log. The import commit says exactly that.
#
# Usage:
#   d86-clone <github-url> [directory] [-b branch] [--force]
#
#   d86-clone https://github.com/owner/repo
#   d86-clone https://github.com/owner/repo my-copy -b dev
#   d86-clone owner/repo /Documents/repo
#
#   -b, --branch <ref>   branch, tag or commit sha (default: the default branch)
#       --force          download even when the tarball looks very large
#   -h, --help
#
# Exit status: 0 on success, 1 on any failure (with the reason printed).

set -u

WGET=${D86_WGET:-wget}
GIT=${D86_GIT:-git}
TAR=${D86_TAR:-tar}
# Refuse, by default, to pull a tarball bigger than this into browser storage.
LIMIT=${D86_CLONE_LIMIT:-250000000}

say() { printf 'd86-clone: %s\n' "$*"; }
die() {
    printf 'd86-clone: %s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
d86-clone <github-url> [directory] [-b branch] [--force]

  d86-clone https://github.com/owner/repo
  d86-clone https://github.com/owner/repo my-copy -b dev
  d86-clone owner/repo /Documents/repo

  -b, --branch <ref>   branch, tag or commit sha (default: default branch)
      --force          download even when the tarball is very large

Fetches a snapshot of one branch (GitHub's own tarball), unpacks it and makes a
local git repository with one commit. Upstream history is not included: this
guest's git can speak HTTPS (git clone works); this is for when the files are
all you want.
EOF
}

url=""
dest=""
branch=""
force=0

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        -b|--branch)
            shift
            branch=${1:-}
            [ -n "$branch" ] || die "--branch needs a value"
            ;;
        --force) force=1 ;;
        -*) die "unknown option: $1 (try --help)" ;;
        *)
            if [ -z "$url" ]; then url=$1
            elif [ -z "$dest" ]; then dest=$1
            else die "too many arguments (try --help)"
            fi
            ;;
    esac
    shift
done

[ -n "$url" ] || { usage; exit 1; }

# "owner/repo" is accepted as a shorthand; anything without a scheme is GitHub.
case "$url" in
    *://*) ;;
    */*) url="https://github.com/$url" ;;
    *) die "that is not a repository: $url" ;;
esac

host=$(printf '%s' "$url" | sed -e 's|^[a-z]*://||' -e 's|/.*||' -e 's|:.*||')
case "$host" in
    github.com|www.github.com) ;;
    *) die "only github.com is supported by this script (got $host)" ;;
esac

# /owner/repo(.git)(/tree/<ref>)(/…)
rest=$(printf '%s' "$url" | sed -e 's|^[a-z]*://[^/]*||' -e 's|^/||' -e 's|[?#].*$||')
owner=${rest%%/*}
rest=${rest#*/}
repo=${rest%%/*}
rest=${rest#*/}
repo=$(printf '%s' "$repo" | sed 's|\.git$||')

# .../tree/<branch> or .../blob/<branch>/<file> names the ref in the URL.
urlref=""
case "$rest" in
    tree/*) urlref=${rest#tree/} ;;
    blob/*) urlref=${rest#blob/} ;;
esac
urlref=${urlref%%/*}
[ -n "$branch" ] || branch=$urlref

[ -n "${owner:-}" ] && [ -n "${repo:-}" ] || die "could not read owner/repo out of $url"

case "$owner$repo" in
    *[!A-Za-z0-9._-]*) die "that does not look like a repository name: $owner/$repo" ;;
esac

# codeload.github.com is the endpoint behind GitHub's "Download ZIP" button.
# HEAD means "whatever the default branch is".
if [ -n "$branch" ]; then
    case "$branch" in
        refs/*) ref=$branch ;;
        *)
            # A bare commit sha is a ref codeload understands as-is; anything
            # else is a branch (or tag) name. Only *all*-hex, long-enough
            # strings count, so a branch called "decafbad" still maps to
            # refs/heads/decafbad.
            is_sha=0
            case "$branch" in
                *[!0-9a-f]*) ;;
                *) [ "${#branch}" -eq 40 ] && is_sha=1 ;;
            esac
            if [ "$is_sha" -eq 1 ]; then ref=$branch; else ref="refs/heads/$branch"; fi
            ;;
    esac
else
    ref="HEAD"
fi
# Ask for one ref; sets tar_url, code and bytes.
probe_ref() {
    tar_url="https://codeload.github.com/$owner/$repo/tar.gz/$1"
    probe=$("$WGET" --spider -S -T 20 -t 1 "$tar_url" 2>&1)
    code=$(printf '%s\n' "$probe" | tr -d '\r' | awk '/^[[:space:]]*HTTP\//{c=$2} END{print c}')
    bytes=$(printf '%s\n' "$probe" | tr -d '\r' | awk 'tolower($1)=="content-length:"{v=$2} END{print v}')
}

probe_ref "$ref"
# An abbreviated commit sha pasted as a branch name is not a branch; codeload
# takes it as a ref of its own. One retry, then the 404 below decides.
if [ "${code:-}" = "404" ]; then
    case "$ref" in
        refs/heads/*)
            alt=${ref#refs/heads/}
            say "$alt is not a branch — trying it as a tag or commit"
            probe_ref "$alt"
            [ "${code:-}" = "200" ] && ref=$alt
            ;;
    esac
fi

[ -n "$dest" ] || dest="./$repo"

say "$owner/$repo ($ref) → $dest"

# ---- how big is it, and did the ref exist? ----
# The probe above is the difference between "that failed" and "that is a
# one-gigabyte repository and your browser storage will not take it".
if [ -n "$code" ] && [ "$code" != "200" ]; then
    case "$code" in
        404) die "GitHub has no $owner/$repo at $ref (404): check the name, the branch, and whether the repository is private" ;;
        401|403) die "GitHub refused the request ($code): the repository is private or rate-limited" ;;
        *) die "GitHub answered HTTP $code for $tar_url" ;;
    esac
fi

case "${bytes:-}" in
    ''|*[!0-9]*)
        # GitHub's archives are generated on the fly and often go out chunked,
        # with no Content-Length. Ask the API how big the repository is
        # instead (~1 KB units of packed history) — best effort: if this fails
        # for any reason, carry on and download.
        kb=$("$WGET" -q -O - -T 15 -t 1 "https://api.github.com/repos/$owner/$repo" 2>/dev/null \
            | sed -n 's/.*"size": *\([0-9][0-9]*\).*/\1/p' | head -1)
        case "${kb:-}" in
            ''|*[!0-9]*) ;;
            *)
                limit_kb=$((LIMIT / 1000))
                if [ "$kb" -gt "$limit_kb" ] && [ "$force" -eq 0 ]; then
                    die "GitHub reports $owner/$repo as about $((kb / 1000)) MB of repository. That is
  a lot for browser storage, so this needs your say-so: re-run with --force
  if you mean it, or fetch a smaller branch with -b.
  (D86_CLONE_LIMIT=$LIMIT bytes is the current limit.)"
                fi
                ;;
        esac
        say "downloading (GitHub gives no Content-Length)"
        ;;
    *)
        mb=$((bytes / 1000000))
        if [ "$bytes" -gt "$LIMIT" ] && [ "$force" -eq 0 ]; then
            die "the $ref tarball is about ${mb} MB. That is a lot of browser storage, so this
  needs your say-so: re-run with --force, or take a smaller branch.
  (D86_CLONE_LIMIT=$LIMIT bytes is the current limit.)"
        fi
        say "downloading about ${mb} MB"
        ;;
esac

# ---- download ----
mkdir -p "$dest" || die "cannot create $dest"
tgz="$dest/.d86-download.tar.gz"
tmp="$dest/.d86-unpack"
rm -rf "$tmp" "$tgz" 2>/dev/null

say "fetching $tar_url"
if ! "$WGET" -O "$tgz" -T 60 -t 2 "$tar_url"; then
    rm -f "$tgz"
    printf '%s\n' "" \
        "d86-clone: the download failed. Run  d86-net check  to see whether this" \
        "  guest has DNS and TLS at all (a reply to 'ping' proves nothing: v86" \
        "  answers ICMP itself). If that passes, the repository may simply be too" \
        "  big for browser storage." >&2
    exit 1
fi
[ -s "$tgz" ] || { rm -f "$tgz"; die "the download was empty"; }

# ---- unpack ----
mkdir -p "$tmp" || die "cannot create $tmp"
if ! "$TAR" -xzf "$tgz" -C "$tmp" --strip-components=1; then
    rm -rf "$tmp" "$tgz"
    die "the archive did not unpack (is it really a tar.gz?)"
fi

# Copy rather than mv: keeps hidden files (a plain glob would miss them) and
# works on this tar.
if ! ( cd "$tmp" && "$TAR" -cf - . ) | ( cd "$dest" && "$TAR" -xf - ); then
    rm -rf "$tmp" "$tgz"
    die "could not write the files into $dest (browser storage full?)"
fi
rm -rf "$tmp" "$tgz"

files=$(cd "$dest" && ls -A 2>/dev/null | grep -v '^\.git$' | wc -l | tr -d ' ')
say "unpacked $files top-level entr$( [ "$files" = "1" ] && echo y || echo ies )"

# ---- make it a repository ----
# The guest's git is perfectly good at local work; it just cannot reach the
# network. Init, stage and commit are all local.
if [ -d "$dest/.git" ]; then
    say "$dest already had a .git — left its history alone"
else
    (
        cd "$dest" || exit 1
        "$GIT" init -q -b main 2>/dev/null || "$GIT" init -q || exit 1
        "$GIT" add -A || exit 1
        "$GIT" -c user.name="${GIT_AUTHOR_NAME:-dragon}" \
               -c user.email="${GIT_AUTHOR_EMAIL:-dragon@dragon86.local}" \
               commit -q --allow-empty -m "Import $owner/$repo as a snapshot

Source: $tar_url
Fetched: $(date -u '+%Y-%m-%d %H:%M UTC')
This is a snapshot of one branch, not a clone: the upstream history is not
included (the tarball has none). Use `git clone` for real history." || exit 1
    ) || die "the files are in $dest, but git could not make a repository of them"
fi

sha=$("$GIT" -C "$dest" rev-parse --short HEAD 2>/dev/null)

say "done: $dest"
say "  source  https://github.com/$owner/$repo ($ref)"
[ -n "$sha" ] && say "  commit  $sha (snapshot import — no upstream history)"
say "  next    cd $dest && git status     /  ls /Documents to see it in Files"
exit 0
