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

# `git clone <http(s) url>` cannot work in this guest: the bundled git is a
# static build with no curl and no OpenSSL, so it has no HTTPS transport at
# all. That is why it either says "repository 'https://…' does not exist"
# (git never got as far as the network) or "unable to find remote helper".
#
# So this one case is handed to d86-clone, which uses busybox's TLS instead,
# and says plainly what it does differently. Everything else — local paths,
# file:// URLs, bundles, and every other git command — goes straight to the
# real git, untouched.
if [ -r "$D86_BIN/d86-clone" ]; then
    git() {
        case "${1:-}:${2:-}" in
            clone:http://*|clone:https://*)
                printf '%s\n' \
                    'guest git has no HTTPS support (static build: no curl, no OpenSSL),' \
                    'so this is a snapshot import rather than a history clone — one' \
                    'commit, current files, no upstream log.  d86-clone --help'
                shift
                d86-clone "$@"
                return $?
                ;;
        esac
        command git "$@"
    }
fi
