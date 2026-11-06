#!/bin/sh
# Runs INSIDE an x86_64 alpine container (see tools/build-rv64-guest.sh).
# Assembles the RISC-V 64 guest userland in /stage and packs it as
# /stage/initrd.gz — without executing a single riscv64 instruction:
# apk is used purely as a cross-architecture package extractor, exactly
# the way rv64.js's own image build does it
# (tests/virt-smoke/mk-alpine-rootfs.sh in justwasm/rv64.js).
#
# What goes in:
#   - Alpine minirootfs for riscv64 (pinned version + sha256): busybox,
#     musl, apk — the complete, official Alpine base, symlinks included
#   - apk --arch riscv64 --no-scripts add: bash (the session shell),
#     git (Alpine's own riscv64 build, real HTTPS transport via libcurl),
#     ca-certificates + openssl (TLS trust, incl. the emulator proxy's CA)
#   - our /init (tools/guest-init/init-rv64), /etc/gitconfig and profile
#     bits — shell scripts and text, same content family as the x86 guests
#
# No kernel modules: the vendored rv64.js kernel is MODULES=n with 9p,
# virtio-mmio and the serial console built in.
set -eux

ALPINE_VERSION=${ALPINE_VERSION:-3.24.1}
ALPINE_SHA256=${ALPINE_SHA256:-7201513262d851f39105102cf95519410100259bd7996fca13bade517838d7b7}
BRANCH="v${ALPINE_VERSION%.*}"
MIRROR=${ALPINE_MIRROR:-https://dl-cdn.alpinelinux.org/alpine}
ROOT=/rootfs

apk add --no-cache python3 >/dev/null

# ---- the official riscv64 base, verified ----
TARBALL="alpine-minirootfs-$ALPINE_VERSION-riscv64.tar.gz"
wget -q -O "/tmp/$TARBALL" "$MIRROR/$BRANCH/releases/riscv64/$TARBALL"
echo "$ALPINE_SHA256  /tmp/$TARBALL" | sha256sum -c -
mkdir -p "$ROOT"
tar -xzf "/tmp/$TARBALL" -C "$ROOT"

# ---- riscv64 packages, cross-extracted (maintainer scripts skipped; the
# ---- few things they would have done are handled below / at boot) ----
cat > "$ROOT/etc/apk/repositories" <<EOF
$MIRROR/$BRANCH/main
$MIRROR/$BRANCH/community
EOF
apk --root "$ROOT" --arch riscv64 --no-scripts --no-cache \
  --repositories-file "$ROOT/etc/apk/repositories" \
  add bash git ca-certificates openssl

# ca-certificates' post-install would have built the bundle; the
# ca-certificates-bundle package (in the minirootfs) already ships it as a
# file, so HTTPS trust works from the first boot. Prove it's there:
test -s "$ROOT/etc/ssl/certs/ca-certificates.crt"
test -e "$ROOT/bin/bash" -o -e "$ROOT/usr/bin/bash"
test -e "$ROOT/usr/bin/git"

# ---- Dragon86 overlay ----
install -m 0755 /tools/guest-init/init-rv64 "$ROOT/init"

cat > "$ROOT/etc/gitconfig" <<'EOF'
# Dragon86 rv64 guest defaults: sensible identity so the first commit just
# works (override with: git config --global user.name "You").
[user]
	name = dragon
	email = dragon@dragon86.local
[init]
	defaultBranch = main
[maintenance]
	auto = false
[gc]
	auto = 0
[safe]
	directory = *
[core]
	pager = less -R
EOF

mkdir -p "$ROOT/etc/profile.d"
# The emulator's fetch backend proxies guest HTTP(S) through 10.0.2.2:8080;
# this is rv64.js's own documented guest configuration, gated on the same
# cmdline flag the host sets when that backend is active.
cat > "$ROOT/etc/profile.d/rv64-proxy.sh" <<'EOF'
if grep -qw 'rv64.network=fetch' /proc/cmdline 2>/dev/null; then
    export http_proxy=http://10.0.2.2:8080
    export https_proxy=http://10.0.2.2:8080
    export HTTP_PROXY="$http_proxy"
    export HTTPS_PROXY="$https_proxy"
else
    unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
fi
EOF
cat > "$ROOT/etc/profile.d/dragon86.sh" <<'EOF'
export TERM=${TERM:-xterm-256color}
PS1='dragon86:\w\$ '
alias ll='ls -l --color=auto'
EOF

mkdir -p "$ROOT/newroot" "$ROOT/run/rv64-proxy" "$ROOT/root"

# ---- pack ----
python3 /tools/make-rv64-initrd.py "$ROOT" /stage/initrd.gz
ls -la /stage
touch /stage/.done
