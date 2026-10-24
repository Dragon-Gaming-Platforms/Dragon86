#!/bin/sh
# Rebuild public/v86/initrd.gz with the guest init from tools/guest-init/init.
#
# The initramfs is vendored (Arch's mkinitcpio output: busybox, the
# virtio/9p modules) and never regenerated here — only /init is replaced,
# byte-for-byte around the rest of the archive. Keep tools/initrd-append.py
# next to this script; it does the cpio surgery.
#
#   tools/build-initrd.sh [source-initrd.gz] [output-initrd.gz]
#
# Defaults: source = public/v86/initrd.gz (its current /init is replaced),
#           output = public/v86/initrd.gz
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
src=${1:-$repo/public/v86/initrd.gz}
out=${2:-$repo/public/v86/initrd.gz}

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp "$here/guest-init/init" "$stage/init"
# The kernel refuses to run /init when the mode says it is not executable
# ("Failed to execute /init (error -13)"), and staging into a temp dir can
# drop the bit — set it explicitly.
chmod 755 "$stage/init"

tmp="$stage/initrd.gz"
python3 "$here/initrd-append.py" "$src" "$stage" "$tmp" --replace --drop init
mv "$tmp" "$out"
echo "wrote $out ($(wc -c < "$out") bytes, /init from tools/guest-init/init)"
