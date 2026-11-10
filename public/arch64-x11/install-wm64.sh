#!/bin/sh
# X11 + IceWM for the x86-64 machine — the second half of the App Store
# install.
#
# The App Store dumped this script and /opt/dragon86/xgfx64.tar.gz.part*
# into the OS filesystem, where the machine sees them over 9p. This script
# lays the payload into /usr, indexes the display/input kernel modules, and
# leaves a `startwm` command behind. Run it inside the machine (Terminal):
#
#   sh /install-wm64.sh             install
#   sh /install-wm64.sh --remove    delete exactly what the install unpacked
#
# Every file the payload writes is recorded in /opt/dragon86/xgfx64.files,
# which is what --remove walks — your own files are never touched.
set -e
P=/opt/dragon86
LIST="$P/xgfx64.files"

if [ "${1:-}" = "--remove" ]; then
  [ -f "$LIST" ] || { echo "no $LIST - nothing recorded, nothing removed"; exit 1; }
  while read -r f; do
    case "$f" in */) ;; *) rm -f "/${f#./}" ;; esac
  done < "$LIST"
  # directories deepest-first, and only when now empty — rmdir refuses
  # anything that still holds files, so shared paths like /usr/bin survive
  sort -r "$LIST" | while read -r d; do
    case "$d" in */) rmdir "/${d%/}" 2>/dev/null || true ;; esac
  done
  rm -f "$LIST"
  echo "removed what install-wm64.sh had unpacked; everything else was left alone"
  exit 0
fi

[ "$(uname -m)" = "x86_64" ] || {
  echo "this machine is $(uname -m) - the pack is built for x86-64 only."
  echo "Settings -> Machine -> x86_64, install Arch Linux (x86-64) from the App Store, reboot, retry."
  exit 1
}
# the KERNEL being 64-bit is not enough - the 32-bit distro runs fine on the
# x86-64 machine, and unpacking 64-bit libraries over a 32-bit /usr/lib
# destroys it (found the hard way in the boot harness). Check the userland:
# byte 5 of an ELF is its class, 2 = 64-bit.
[ "$(head -c5 /usr/bin/bash | tail -c1 | od -An -tu1 | tr -d ' ')" = "2" ] || {
  echo "the installed userland is 32-bit (Arch Linux x86) - these are 64-bit binaries."
  echo "Install Arch Linux (x86-64) from the App Store first, reboot, then retry."
  exit 1
}
set -- "$P"/xgfx64.tar.gz.part*
[ -e "$1" ] || {
  echo "payload missing under $P - install install-wm64.sh from the App Store first"
  exit 1
}
KV=$(cat "$P/xgfx64.kver" 2>/dev/null || echo unknown)
[ "$(uname -r)" = "$KV" ] || {
  echo "this kernel is $(uname -r), but the pack's display modules are built for $KV."
  echo "Reinstall Arch Linux (x86-64) from the App Store (that updates /boot too),"
  echo "reboot the machine (close and reopen the Terminal), then run this again."
  exit 1
}

echo "unpacking X11 + IceWM into / (over 9p - this takes a while) ..."
cat "$P"/xgfx64.tar.gz.part* | tar -xzv -C / > "$LIST"
echo "indexing kernel modules (depmod $KV) ..."
depmod "$KV"
sync
echo
echo "Installed. Open the Engine Viewer (the machine's own screen) and run:"
echo
echo "    startwm"
echo
echo "The desktop appears there - the mouse and keyboard work on that screen."
echo "An xterm opens with the desktop. More terminals: right-click the"
echo "desktop (or press Ctrl+Esc) for the menu and pick xterm, or Ctrl+Alt+T."
echo "This serial terminal keeps working alongside it."
