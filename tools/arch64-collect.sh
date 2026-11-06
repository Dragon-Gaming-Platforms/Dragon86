#!/bin/bash
# Runs INSIDE the official archlinux:latest container (see
# tools/build-arch64-guest.sh). Installs Arch's own x86_64 packages and
# copies the curated guest file set into /stage:
#
#   /stage/vmlinuz                   the `linux` package's kernel
#   /stage/kver                      its version string
#   /stage/usr/bin, /stage/usr/lib   bash/coreutils/… + glibc closure,
#                                    busybox symlinks, 9p/virtio modules
#                                    (decompressed) with modules.dep
#
# Everything here is Arch's binary as shipped — nothing is rebuilt.
set -eux

pacman -Sy --noconfirm archlinux-keyring >/dev/null || true
pacman -Syu --noconfirm --needed linux bash coreutils grep sed gawk kmod util-linux busybox zstd findutils which >/dev/null

KVER=$(basename "$(dirname "$(find /usr/lib/modules -maxdepth 2 -name vmlinuz | head -1)")")
[ -n "$KVER" ]
echo "$KVER" > /stage/kver
cp "/usr/lib/modules/$KVER/vmlinuz" /stage/vmlinuz
depmod "$KVER"

mkdir -p /stage/usr/bin /stage/usr/lib /stage/etc

# ---- real binaries (same set the 32-bit guest carries, minus what it only
# ---- had because the copy/v86 image shipped it: no systemd, no e2fsck) ----
BINS="bash ls cat cp mv rm ln mkdir rmdir chmod chown stat touch df du sort wc
date tail head tr cut tee dirname basename sleep sync true false echo printf
env pwd uname id chroot stty grep sed gawk kmod setsid mountpoint readlink
realpath mktemp dd od sha256sum md5sum xargs find which uniq expr seq comm"
for b in $BINS; do
  cp -L "/usr/bin/$b" "/stage/usr/bin/$b"
done
ln -sf gawk /stage/usr/bin/awk
for k in modprobe insmod rmmod lsmod depmod modinfo; do ln -sf kmod "/stage/usr/bin/$k"; done

# busybox fills in everything else (ash for /init, mount, ip, udhcpc, vi…)
cp -L /usr/bin/busybox /stage/usr/bin/busybox
for want in ash sh udhcpc ip mount umount; do
  busybox --list | grep -qx "$want" || { echo "busybox is missing applet: $want" >&2; exit 1; }
done
set +x
busybox --list | while read -r a; do
  [ -e "/stage/usr/bin/$a" ] || ln -sf busybox "/stage/usr/bin/$a"
done
set -x

# ---- shared-library closure of every real ELF above ----
set +x
for f in /stage/usr/bin/*; do
  [ -f "$f" ] && [ ! -L "$f" ] || continue
  ldd "$f" 2>/dev/null | while read -r line; do
    lib=$(echo "$line" | sed -n 's/.*=> \(\/[^ ]*\) .*/\1/p')
    [ -z "$lib" ] && lib=$(echo "$line" | sed -n 's/^\s*\(\/[^ ]*ld-linux[^ ]*\) .*/\1/p')
    [ -n "$lib" ] || continue
    name=$(basename "$lib")
    [ -e "/stage/usr/lib/$name" ] || cp -L "$lib" "/stage/usr/lib/$name"
  done
done
ls /stage/usr/lib
set -x
# NSS: getpwnam()/getgrnam() load these at runtime; ldd never lists them.
for n in /usr/lib/libnss_files.so.2; do
  [ -e "$n" ] && cp -L "$n" "/stage/usr/lib/$(basename "$n")"
done

# /etc/os-release in the initrd is a symlink to /usr/lib/os-release — ship
# Arch's real one (the 32-bit target said "Arch Linux 32"; this says "Arch Linux")
cp -L /usr/lib/os-release /stage/usr/lib/os-release

# ---- terminfo for TERM=xterm-256color / linux / vt100 ----
for t in x/xterm-256color l/linux v/vt100 d/dumb; do
  d="/usr/share/terminfo/$t"
  [ -e "$d" ] && install -D "$d" "/stage/usr/share/terminfo/$t"
done

# ---- kernel modules the guest actually loads (plus their dependencies),
# ---- decompressed: the init's busybox/kmod must not depend on .ko.zst ----
MODS="virtio_pci virtio_pci_legacy_dev virtio_pci_modern_dev 9pnet 9pnet_virtio
9p netfs virtio_net net_failover failover ne2k-pci 8390 virtio_blk serio
libps2 i8042 atkbd psmouse serio_raw crc32c_generic"
for m in $MODS; do
  modprobe --show-depends --set-version "$KVER" "$m" 2>/dev/null | while read -r kind path rest; do
    [ "$kind" = insmod ] || continue
    # modprobe prints /lib/modules/... (via the /lib symlink) on Arch
    rel=${path#/usr/lib/modules/}; rel=${rel#/lib/modules/}
    dest="/stage/usr/lib/modules/${rel%.zst}"
    [ -e "$dest" ] && continue
    mkdir -p "$(dirname "$dest")"
    case "$path" in
      *.zst) unzstd -q -o "$dest" "$path" ;;
      *) cp "$path" "$dest" ;;
    esac
  done || echo "note: module $m not found for $KVER (may be built-in)"
done
mkdir -p "/stage/usr/lib/modules/$KVER"
cp "/usr/lib/modules/$KVER/modules.builtin" "/usr/lib/modules/$KVER/modules.builtin.modinfo" \
   "/usr/lib/modules/$KVER/modules.order" "/stage/usr/lib/modules/$KVER/" 2>/dev/null || true
# depmod's -b expects <basedir>/lib/modules; point it at usr/lib for a moment
ln -s usr/lib /stage/lib
depmod -b /stage "$KVER"
rm /stage/lib

# ---- ld.so.cache for the staged tree (glibc also finds /usr/lib via the
# ---- lib64 symlinks the initrd carries, this just makes it quick) ----
: > /stage/etc/ld.so.conf
ldconfig -r /stage 2>/dev/null || true

du -sh /stage
touch /stage/.done
