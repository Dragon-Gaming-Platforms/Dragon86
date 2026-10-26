#!/bin/sh
# d86-net — is this guest actually on the internet?
#
# The reason this exists: inside v86, `ping 1.1.1.1` always succeeds. The
# emulator answers ICMP itself, on its own virtual link, without a packet ever
# leaving the browser. A ping reply therefore says nothing about whether the
# relay, DNS or TLS work — and "ping is fine but nothing else is" is the most
# common way to be misled here.
#
# This checks the chain that actually matters and stops at the first broken
# link:
#
#   1. the interface, its address, the default route, /etc/resolv.conf
#   2. DNS      nslookup github.com        (a real resolver round trip)
#   3. TCP+TLS  wget --spider https://github.com   (a real connection)
#   4. git      git ls-remote https://github.com/git/git HEAD
#               (the transport a clone actually uses: git's own helper,
#                its libcurl, and the CA bundle it verifies against)
#
# Usage: d86-net [check]      exit 0 = internet works, 1 = something is off

set -u

WGET=${D86_WGET:-wget}
GIT=${D86_GIT:-git}
HOST=${D86_NET_HOST:-github.com}

say() { printf 'd86-net: %s\n' "$*"; }
ok() { printf '  [ ok ] %s\n' "$*"; }
bad() { printf '  [fail] %s\n' "$*"; }

iface=$(ip -o link show 2>/dev/null | awk -F': ' '$2 != "lo" {print $2; exit}' | sed 's/@.*//')
if [ -z "${iface:-}" ]; then
    bad "no network interface at all"
    say "run /networking.sh, or check Settings → v86 network (the relay must not be 'off')"
    exit 1
fi

say "interface $iface"
ip addr show "$iface" 2>/dev/null | sed -n 's/^ *inet /    inet /p'
route=$(ip route show default 2>/dev/null)
[ -n "$route" ] && printf '    route  %s\n' "$route" || { bad "no default route"; exit 1; }
ns=$(sed -n 's/^nameserver //p' /etc/resolv.conf 2>/dev/null | tr '\n' ' ')
printf '    dns    %s\n' "${ns:-none}"
[ -n "$ns" ] || { bad "no nameserver in /etc/resolv.conf"; exit 1; }

# ---- 2. DNS ----
res=$(nslookup "$HOST" 2>&1)
# Only an Address line *after* the Name line is an answer — the first ones in
# busybox's output are the resolver's own address, which is present even when
# the lookup fails.
a=$(printf '%s\n' "$res" | sed -n '/^Name:/,$p' | awk '/^Address/{print $NF; exit}')
if [ -n "$a" ]; then
    ok "DNS resolves $HOST → $a"
else
    bad "DNS does not resolve $HOST"
    printf '%s\n' "$res" | sed 's/^/        /'
    say "DNS goes through v86 (DoH from the page). If that fails, the relay is the
  usual culprit: Settings → v86 network."
    exit 1
fi

# ---- 3. TCP + TLS ----
probe=$("$WGET" --spider -S -T 20 -t 1 "https://$HOST" 2>&1)
code=$(printf '%s\n' "$probe" | tr -d '\r' | awk '/^[[:space:]]*HTTP\//{c=$2} END{print c}')
if [ -n "$code" ]; then
    ok "TLS to https://$HOST (HTTP $code)"
else
    bad "could not open TLS to https://$HOST"
    printf '%s\n' "$probe" | sed 's/^/        /'
    say "TCP goes through v86's relay. Check Settings → v86 network, then try again."
    exit 1
fi

# ---- 4. git's own transport ----
# The step above proves the card, the resolver and TLS. This proves the piece
# a clone uses: git's HTTPS helper (/usr/lib/git-core/git-remote-http) talking
# to the server through libcurl, with the shipped CA bundle.
if command -v "$GIT" >/dev/null 2>&1; then
    g=$(timeout 30 "$GIT" ls-remote "https://$HOST/git/git" HEAD 2>&1)
    case "$g" in
        *"unable to find remote helper"*|*"not a git command"*)
            bad "git has no HTTPS helper in $( "$GIT" --exec-path )"
            say "that is a Dragon86 install problem: /usr/lib/git-core/git-remote-http
  should have been written at boot. Reconnect the Terminal to reinstall it."
            exit 1
            ;;
        *[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ok "git transport to https://$HOST" ;;
        *)
            bad "git could not reach https://$HOST"
            printf '%s\n' "$g" | sed 's/^/        /'
            say "TLS worked with wget but git failed, so the difference is git's helper
  or its CA bundle. Check /usr/lib/git-core and /etc/ssl/certs."
            exit 1
            ;;
    esac
fi

say "the chain works: DNS, TLS, and git's own HTTPS transport are real."
say "note: ping is not part of this — v86 answers ICMP itself, so it works"
say "      even with the network completely dead."
exit 0
