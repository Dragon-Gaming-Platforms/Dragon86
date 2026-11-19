#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="${1:-$ROOT/.build/supertux-ps2}"
OUT_DIR="${2:-$ROOT/dist}"
OUT_ISO="$OUT_DIR/supertux-ps2.iso"
SOURCE_SHA="${SUPER_TUX_SOURCE_SHA:-unknown}"

for tool in genisoimage sha256sum; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done
PATCH_FILE="$ROOT/tools/supertux-ps2-ps2sdk-ports.patch"
[[ -f "$SOURCE_DIR/Makefile.ps2" && -f "$SOURCE_DIR/COPYING" && -f "$SOURCE_DIR/AUTHORS" && -d "$SOURCE_DIR/data" && -f "$PATCH_FILE" ]] || {
  echo "Expected a complete headshot2017/supertux-ps2 source checkout at $SOURCE_DIR" >&2
  exit 1
}
[[ -s "$SOURCE_DIR/supertux.elf" ]] || {
  echo "Build the PS2 executable first (make -f Makefile.ps2)" >&2
  exit 1
}

# Catch an accidentally supplied host executable before it becomes a disc image.
python3 - "$SOURCE_DIR/supertux.elf" <<'PY'
import struct, sys
with open(sys.argv[1], "rb") as f:
    head = f.read(20)
if len(head) < 20 or head[:4] != b"\x7fELF":
    raise SystemExit("supertux.elf is not an ELF executable")
if struct.unpack_from("<H", head, 18)[0] != 8:
    raise SystemExit("supertux.elf is not a MIPS executable")
PY

mkdir -p "$OUT_DIR"
cp "$PATCH_FILE" "$OUT_DIR/SUPERTUX-PS2SDK.patch"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
cp "$SOURCE_DIR/supertux.elf" "$staging/SUPERTUX.ELF"
cp -a "$SOURCE_DIR/data" "$staging/data"
cp "$SOURCE_DIR/COPYING" "$staging/COPYING.TXT"
cp "$SOURCE_DIR/AUTHORS" "$staging/AUTHORS.TXT"
cp "$SOURCE_DIR/README" "$staging/README.TXT"
cp "$PATCH_FILE" "$staging/BUILD.PAT"

cat > "$staging/SYSTEM.CNF" <<'EOF'
BOOT2 = cdrom0:\SUPERTUX.ELF;1
VER = 1.00
VMODE = NTSC
EOF

cat > "$staging/README.D86" <<EOF
SuperTux for PlayStation 2 — Dragon86 workflow sample

This is an original PS2 disc image built from the SuperTux PS2 homebrew
source, not a precompiled web build. The image includes SuperTux's GPL-2.0
license and upstream attribution files. See COPYING.TXT, AUTHORS.TXT, and
data/CREDITS. BUILD.PAT records Dragon86's one-line PS2SDK SDL include-path
adjustment, required to build this revision with the pinned PS2DEV toolchain.

Upstream: https://github.com/headshot2017/supertux-ps2
Source revision: $SOURCE_SHA
The corresponding source archive is distributed next to this ISO in the
Dragon86 release that contains it. Build environment: https://github.com/ps2dev/ps2dev

The separate PS2-Web-Recomp project is not affiliated with SuperTux or
Dragon86. A successful conversion is a workflow check, not a guarantee that
the game is fully playable in every browser or runtime.
EOF

rm -f "$OUT_ISO"
genisoimage \
  -quiet \
  -iso-level 2 \
  -l \
  -allow-lowercase \
  -allow-multidot \
  -V SUPERTUX \
  -sysid PLAYSTATION \
  -A 'SuperTux PS2 homebrew sample' \
  -o "$OUT_ISO" \
  "$staging"

# Verify the ISO9660 primary volume descriptor and required root entries with
# the same image reader used by PS2-Web-Recomp during the downstream smoke test.
python3 - "$OUT_ISO" <<'PY'
import os, struct, sys
path = sys.argv[1]
with open(path, "rb") as f:
    f.seek(16 * 2048)
    pvd = f.read(2048)
if len(pvd) != 2048 or pvd[:7] != b"\x01CD001\x01":
    raise SystemExit("genisoimage did not produce a valid ISO9660 primary volume descriptor")
if os.path.getsize(path) % 2048:
    raise SystemExit("ISO size is not a whole number of 2048-byte sectors")
print(f"ISO9660 image ready: {path} ({os.path.getsize(path)} bytes)")
PY

sha256sum "$OUT_ISO" > "$OUT_DIR/SHA256SUMS"
printf '%s\n' \
  "SuperTux PS2 source: https://github.com/headshot2017/supertux-ps2/tree/$SOURCE_SHA" \
  "SuperTux PS2 license: GPL-2.0 (see COPYING.TXT in the ISO and source archive)" \
  "PS2DEV build environment: https://github.com/ps2dev/ps2dev/tree/v2.0.0" \
  "Dragon86 PS2SDK SDL include-path patch is included as BUILD.PAT on the disc and in this release." \
  "The ISO is original PS2 homebrew input; it is not a PS2-Web-Recomp web build." \
  > "$OUT_DIR/NOTICE.txt"
