# Dragon86 guest helpers — sourced from /etc/profile.
#
# Written by Dragon86 into the guest root at /usr/share/d86/helpers.sh and
# pulled in by a marked block at the end of /etc/profile. Everything here is a
# shell function, so nothing needs an executable bit: each one runs its script
# through bash with the path as the argument. Delete the /etc/profile block and
# the functions are gone; the scripts are still there to run by hand.

# Where the scripts live. Overridable so they can be tested (and so a guest
# that keeps them somewhere else still gets the functions).
: "${D86_BIN:=/usr/bin}"

if [ -r "$D86_BIN/d86-clone" ]; then
    d86-clone() { bash "$D86_BIN/d86-clone" "$@"; }
fi
if [ -r "$D86_BIN/d86-net" ]; then
    d86-net() { bash "$D86_BIN/d86-net" "$@"; }
fi

# `git` is not wrapped. It used to be, because this git is a static build
# configured without curl and so had no HTTPS transport: a wrapper caught
# `git clone http(s)://…` and quietly turned it into a d86-clone snapshot
# import. That is fixed at the source instead — the guest's /usr/lib/git-core
# now holds git's own HTTPS helper (git-remote-http/https, static, with
# libcurl + mbedTLS, plus a CA bundle), so `git clone https://…` is a real
# clone with real history and the wrapper is gone.
#
# d86-clone is still here for the case the transport cannot help with: a
# repository so large that a tarball is the only sane way to get it down.

# Point git at the CA bundle explicitly as well. The helper was compiled with
# that path as its default, but an exported variable survives a helper being
# replaced by a locally built one.
if [ -r /etc/ssl/certs/ca-certificates.crt ] && [ -z "${CURL_CA_BUNDLE:-}" ]; then
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
    export CURL_CA_BUNDLE
fi
