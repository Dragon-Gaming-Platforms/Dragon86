#!/bin/bash
# Runs INSIDE the archlinux:latest container, after tools/arch64-collect.sh
# (which sources it when GFX_BUNDLES=1 — same container run, so the kernel
# modules here are for exactly the kernel the arch64 initrd ships).
#
# Collects two guest packs out of Arch's own packages:
#
#   /stage/x11      X11 + IceWM: Xorg on the bochs DRM framebuffer,
#                   evdev keyboard/mouse, xterm, IceWM, fonts, and the
#                   bochs/evdev kernel modules for /stage/kver
#   /stage/netsurf  NetSurf (Arch's gtk3 build) + its library closure and
#                   the GTK data files it needs (pixbuf loaders, schemas,
#                   mime cache, a trimmed icon theme)
#
# Everything is Arch's binary as shipped — nothing is rebuilt. The payloads
# install into the guest via tools/guest-pack/install-*.sh.
set -eux

KVER=$(cat /stage/kver)
X=/stage/x11
N=/stage/netsurf
rm -rf "$X" "$N"
mkdir -p "$X/usr/bin" "$X/usr/lib" "$N/usr/bin" "$N/usr/lib"

pacman -S --noconfirm --needed \
  xorg-server xorg-xinit xorg-xkbcomp xf86-video-fbdev xf86-input-evdev \
  xorg-fonts-misc xkeyboard-config xterm icewm ttf-dejavu fontconfig \
  netsurf gsettings-desktop-schemas shared-mime-info adwaita-icon-theme >/dev/null

# ---- shared-library closure: copy every library a binary (or module) pulls
# ---- in, into <dest>/usr/lib. ldd covers dlopen'd X drivers too because we
# ---- run it on the .so files themselves.
closure() { # dest file...
  local dest=$1; shift
  set +x
  for f in "$@"; do
    [ -e "$f" ] || continue
    ldd "$f" 2>/dev/null | while read -r line; do
      lib=$(echo "$line" | sed -n 's/.*=> \(\/[^ ]*\) .*/\1/p')
      [ -z "$lib" ] && lib=$(echo "$line" | sed -n 's/^\s*\(\/[^ ]*ld-linux[^ ]*\) .*/\1/p')
      [ -n "$lib" ] || continue
      name=$(basename "$lib")
      [ -e "$dest/usr/lib/$name" ] || cp -L "$lib" "$dest/usr/lib/$name"
    done
  done
  set -x
}

# ======================================================= X11 + IceWM pack ==
for b in xinit xterm icewm icewm-session icewmbg icesh xkbcomp; do
  [ -e "/usr/bin/$b" ] && cp -L "/usr/bin/$b" "$X/usr/bin/$b"
done
cp -L /usr/lib/Xorg "$X/usr/lib/Xorg"
cp -a /usr/lib/xorg "$X/usr/lib/xorg"

closure "$X" "$X"/usr/bin/* "$X/usr/lib/Xorg" \
  $(find "$X/usr/lib/xorg" -name '*.so')

# data the server and clients read at runtime
mkdir -p "$X/usr/share/X11" "$X/usr/share/fonts" "$X/var/lib/xkb" "$X/etc/X11"
cp -a /usr/share/X11/xkb "$X/usr/share/X11/xkb"
cp -a /usr/share/fonts/misc "$X/usr/share/fonts/misc"
mkdir -p "$X/usr/share/fonts/TTF"
cp -L /usr/share/fonts/TTF/DejaVuSans.ttf /usr/share/fonts/TTF/DejaVuSans-Bold.ttf \
      /usr/share/fonts/TTF/DejaVuSansMono.ttf "$X/usr/share/fonts/TTF/"
cp -a /etc/fonts "$X/etc/fonts"
cp -a /usr/share/fontconfig "$X/usr/share/fontconfig"
cp -a /usr/share/icewm "$X/usr/share/icewm"
install -D /usr/share/terminfo/x/xterm "$X/usr/share/terminfo/x/xterm"
install -D /usr/share/terminfo/x/xterm-256color "$X/usr/share/terminfo/x/xterm-256color" 2>/dev/null || true

# the IceWM start menu: the two things this machine actually has
cat > "$X/usr/share/icewm/menu" <<'EOF'
prog xterm utilities-terminal xterm
prog NetSurf web-browser netsurf
EOF

# ---- Xorg config: no udev in this guest, so every device is written down.
# ---- The display is the bochs DRM framebuffer; input is whatever the
# ---- kernel put on /dev/input/event0-3 (atkbd and psmouse — the order can
# ---- vary, evdev sorts out which is which by capabilities).
cat > "$X/etc/X11/xorg-d86.conf" <<'EOF'
Section "ServerFlags"
    Option "AutoAddDevices" "off"
    Option "AutoAddGPU" "off"
EndSection
Section "Files"
    FontPath "/usr/share/fonts/misc"
EndSection
Section "Device"
    Identifier "fb"
    Driver "fbdev"
    Option "fbdev" "/dev/fb0"
EndSection
Section "Screen"
    Identifier "screen"
    Device "fb"
EndSection
Section "InputDevice"
    Identifier "ev0"
    Driver "evdev"
    Option "Device" "/dev/input/event0"
EndSection
Section "InputDevice"
    Identifier "ev1"
    Driver "evdev"
    Option "Device" "/dev/input/event1"
EndSection
Section "InputDevice"
    Identifier "ev2"
    Driver "evdev"
    Option "Device" "/dev/input/event2"
EndSection
Section "InputDevice"
    Identifier "ev3"
    Driver "evdev"
    Option "Device" "/dev/input/event3"
EndSection
Section "ServerLayout"
    Identifier "d86"
    Screen "screen"
    InputDevice "ev0"
    InputDevice "ev1"
    InputDevice "ev2"
    InputDevice "ev3"
EndSection
EOF

cat > "$X/etc/X11/xinitrc-d86" <<'EOF'
#!/bin/sh
# What startwm's X session runs: a terminal, then the window manager.
xterm -geometry 80x24+16+16 &
exec icewm
EOF
chmod 755 "$X/etc/X11/xinitrc-d86"

cat > "$X/usr/bin/startwm" <<'EOF'
#!/bin/sh
# Start the X11 desktop on the machine's display (open the Engine Viewer to
# see and use it). Loads the display/input modules first, then runs X with
# IceWM via /etc/X11/xinitrc-d86. The serial console stays usable.
set -e
modprobe bochs 2>/dev/null || modprobe bochs_drm 2>/dev/null || true
modprobe evdev 2>/dev/null || true
modprobe psmouse 2>/dev/null || true
n=0
while [ ! -e /dev/fb0 ] && [ "$n" -lt 25 ]; do sleep 0.2; n=$((n + 1)); done
[ -e /dev/fb0 ] || {
  echo "no /dev/fb0: the bochs DRM driver did not bind to the display."
  echo "Check 'dmesg | tail' - and that this is the x86-64 machine with the"
  echo "kernel the pack was built for (see /opt/dragon86/xgfx64.kver)."
  exit 1
}
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
exec xinit /etc/X11/xinitrc-d86 -- /usr/lib/Xorg :0 vt2 \
  -config /etc/X11/xorg-d86.conf -logfile /tmp/Xorg.d86.log "$@"
EOF
chmod 755 "$X/usr/bin/startwm"

# ---- kernel modules: the bochs DRM display and the evdev input layer (plus
# ---- dependencies), decompressed so the guest's kmod never sees .ko.zst.
copymods() { # dest module...
  local dest=$1; shift
  for m in "$@"; do
    modprobe --show-depends --set-version "$KVER" "$m" 2>/dev/null | while read -r kind path rest; do
      [ "$kind" = insmod ] || continue
      rel=${path#/usr/lib/modules/}; rel=${rel#/lib/modules/}
      d="$dest/usr/lib/modules/${rel%.zst}"
      [ -e "$d" ] && continue
      mkdir -p "$(dirname "$d")"
      case "$path" in
        *.zst) unzstd -q -o "$d" "$path" ;;
        *) cp "$path" "$d" ;;
      esac
    done || echo "note: module $m not found for $KVER (may be built-in)"
  done
}
copymods "$X" bochs bochs_drm evdev psmouse

du -sh "$X"

# ============================================================ NetSurf pack ==
# Which frontend Arch built NetSurf with is read off the binary itself, not
# assumed (the first run of this script assumed gtk3 and was wrong — the
# package links no gdk-pixbuf at all).
NS_BIN=$(pacman -Ql netsurf | awk '$2 ~ /\/usr\/bin\/./ {print $2}' | head -1)
[ -n "$NS_BIN" ]
ldd "$NS_BIN"
NS_LIBS=$(ldd "$NS_BIN" | awk '{print $1}')
FRONTEND=unknown
case "$NS_LIBS" in
  *libgtk-3*) FRONTEND=gtk3 ;;
  *libgtk-x11-2*) FRONTEND=gtk2 ;;
  *libSDL*) FRONTEND=sdl ;;
  *libnsfb*) FRONTEND=framebuffer ;;
  *libX11*) FRONTEND=x11 ;;
esac
echo "netsurf frontend: $FRONTEND"
[ "$FRONTEND" != unknown ] || { echo "cannot tell what Arch's netsurf draws with - look at the ldd above"; exit 1; }

cp -L "$NS_BIN" "$N/usr/bin/netsurf"
[ -d /usr/share/netsurf ] && cp -a /usr/share/netsurf "$N/usr/share/netsurf"
# toolkit runtime data, only what this frontend actually has installed
[ -d /usr/lib/gdk-pixbuf-2.0 ] && cp -a /usr/lib/gdk-pixbuf-2.0 "$N/usr/lib/gdk-pixbuf-2.0"
[ -d /usr/lib/gtk-3.0 ] && cp -a /usr/lib/gtk-3.0 "$N/usr/lib/gtk-3.0"
[ -d /usr/lib/gtk-2.0 ] && cp -a /usr/lib/gtk-2.0 "$N/usr/lib/gtk-2.0"

closure "$N" "$N/usr/bin/netsurf" \
  $(find "$N/usr/lib/gdk-pixbuf-2.0" "$N/usr/lib/gtk-3.0" "$N/usr/lib/gtk-2.0" -name '*.so' 2>/dev/null)

if [ -d /usr/share/glib-2.0/schemas ] && { [ "$FRONTEND" = gtk3 ] || [ "$FRONTEND" = gtk2 ]; }; then
  # compiled GSettings schemas — gtk aborts the process on a missing schema
  glib-compile-schemas /usr/share/glib-2.0/schemas
  install -D /usr/share/glib-2.0/schemas/gschemas.compiled \
    "$N/usr/share/glib-2.0/schemas/gschemas.compiled"
fi
[ -f /usr/share/mime/mime.cache ] && install -D /usr/share/mime/mime.cache "$N/usr/share/mime/mime.cache"
if [ "$FRONTEND" = gtk3 ] || [ "$FRONTEND" = gtk2 ]; then
  # icon theme, trimmed to what a browser window actually shows
  mkdir -p "$N/usr/share/icons/Adwaita" "$N/usr/share/icons/hicolor"
  cp /usr/share/icons/hicolor/index.theme "$N/usr/share/icons/hicolor/" 2>/dev/null || true
  cp /usr/share/icons/Adwaita/index.theme "$N/usr/share/icons/Adwaita/" 2>/dev/null || true
  for d in cursors 16x16 24x24 32x32 48x48 scalable symbolic; do
    [ -d "/usr/share/icons/Adwaita/$d" ] && cp -a "/usr/share/icons/Adwaita/$d" "$N/usr/share/icons/Adwaita/$d"
  done
fi
# the install script reads this to print the right launch instructions
install -D /dev/null "$N/usr/share/netsurf-d86-frontend"
echo "$FRONTEND" > "$N/usr/share/netsurf-d86-frontend"

du -sh "$N"
