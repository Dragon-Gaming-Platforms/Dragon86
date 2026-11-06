#!/bin/sh
# NetSurf — a real graphical web browser for the x86-64 machine. Second half
# of the App Store install.
#
# Why NetSurf and not Chromium: Chromium needs a gigabyte of RAM and a GPU
# to be worth anything; this machine is a software-emulated x86-64 with
# 256 MB. NetSurf is a real browser engine (its own layout, CSS and image
# rendering) built to run at exactly this scale — so it is the honest
# version of "a browser in the Engine Viewer", not a pretend one.
#
#   sh /install-netsurf.sh            install (needs install-wm64.sh first)
#   sh /install-netsurf.sh --remove   delete exactly what the install unpacked
set -e
P=/opt/dragon86
LIST="$P/netsurf64.files"

if [ "${1:-}" = "--remove" ]; then
  [ -f "$LIST" ] || { echo "no $LIST - nothing recorded, nothing removed"; exit 1; }
  while read -r f; do
    case "$f" in */) ;; *) rm -f "/${f#./}" ;; esac
  done < "$LIST"
  sort -r "$LIST" | while read -r d; do
    case "$d" in */) rmdir "/${d%/}" 2>/dev/null || true ;; esac
  done
  rm -f "$LIST"
  echo "removed what install-netsurf.sh had unpacked; everything else was left alone"
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
set -- "$P"/netsurf64.tar.gz.part*
[ -e "$1" ] || {
  echo "payload missing under $P - install install-netsurf.sh from the App Store first"
  exit 1
}

echo "unpacking NetSurf into / (over 9p - this takes a while) ..."
cat "$P"/netsurf64.tar.gz.part* | tar -xzv -C / > "$LIST"
sync
echo
FRONTEND=$(cat /usr/share/netsurf-d86-frontend 2>/dev/null || echo unknown)
echo "Installed (NetSurf's $FRONTEND frontend, as Arch builds it)."
case "$FRONTEND" in
  framebuffer|sdl)
    echo "This build draws on the machine's display directly - no X11 needed."
    echo "Open the Engine Viewer, then run here:  netsurf https://example.com"
    echo "(If the X11 desktop is running, quit it first - they share the screen.)"
    ;;
  *)
    [ -x /usr/lib/Xorg ] || {
      echo "NOTE: this build needs X11, which is not installed yet -"
      echo "install install-wm64.sh from the App Store and run: sh /install-wm64.sh"
    }
    echo "Run 'startwm' in the Engine Viewer if the desktop is not up, then start"
    echo "NetSurf from the IceWM menu (bottom-left) or type 'netsurf &' in xterm."
    ;;
esac
echo "Networking: run /networking.sh first if the machine is not online yet."
