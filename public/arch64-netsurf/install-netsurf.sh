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

# gdk-pixbuf decodes images through glycin's loader processes, which default
# to a bwrap sandbox this minimal guest can't provide (gtk aborts drawing its
# first icon otherwise). Replace Arch's thin wrapper with one that runs the
# loaders unsandboxed - proven necessary and sufficient in the harness.
if [ -x /usr/bin/netsurf-gtk3 ]; then
  cat > /usr/bin/netsurf <<'WRAP'
#!/bin/sh
# Dragon86 wrapper around netsurf-gtk3 (replaces Arch's LANG-only wrapper)
export GLYCIN_DISABLE_SANDBOX=i-know-the-risks
export GLYCIN_SANDBOX_MECHANISM=not-sandboxed
export HOME="${HOME:-/root}"
# From the serial console there is no DISPLAY — the desktop startwm runs
# is on :0 (the Engine Viewer screen), so default to it instead of letting
# GTK die with "cannot open display:".
export DISPLAY="${DISPLAY:-:0}"
D=${DISPLAY#:}; D=${D%%.*}
[ -S "/tmp/.X11-unix/X$D" ] || {
  echo "netsurf: no X server on display $DISPLAY." >&2
  echo "Run 'startwm' first (type it in the Engine Viewer - the machine's own screen)," >&2
  echo "then run netsurf again; the window appears on that screen." >&2
  exit 1
}
LANG_PREFIX=${LANG%%[._]*}; LANG_PREFIX=${LANG_PREFIX:-en}
[ -d "/usr/share/netsurf/$LANG_PREFIX" ] || export LANG=en_US.UTF-8
exec /usr/bin/netsurf-gtk3 "$@"
WRAP
  chmod 755 /usr/bin/netsurf
fi

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
    echo "Run 'startwm' in the Engine Viewer if the desktop is not up. Then start"
    echo "NetSurf any of these ways (the window appears on the Engine Viewer screen):"
    echo "  - right here in this serial console:   netsurf https://example.com &"
    echo "  - from the xterm on the desktop:       netsurf &"
    echo "  - from the IceWM menu (bottom-left)"
    ;;
esac
echo "Networking: run /networking.sh first if the machine is not online yet."
