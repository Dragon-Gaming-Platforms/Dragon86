#!/bin/sh
# Build public/rv64/ — the RISC-V 64 engine and its Alpine Linux guest.
#
# What this produces (all vendored output, committed by the build-rv64
# workflow, never written by hand):
#
#   public/rv64/rv64.js          the rv64.js emulator (ESM), release v0.4.43
#   public/rv64/rv64.worker.js   its optional Worker entry point
#   public/rv64/rv64.d.ts        its public types (for reference/tooling)
#   public/rv64/rv64_wasm.wasm   the CPU core + devices (Rust → wasm)
#   public/rv64/Image            the release's riscv64 Linux kernel
#                                ("minimal" flavour: 9p/virtio-mmio/serial
#                                built in, MODULES=n — nothing to load)
#   public/rv64/initrd.gz        Alpine riscv64 userland + bash + Alpine's
#                                own git (real HTTPS) + our /init — doubles
#                                as the App Store distro payload, exactly
#                                like the x86 initrds
#
# Where the pieces come from:
#   - engine + kernel: the justwasm/rv64.js GitHub release, pinned by tag,
#     every file verified against the release's own SHA256SUMS
#   - userland: official Alpine riscv64 packages, cross-extracted with apk
#     inside an x86_64 alpine container (tools/rv64-collect.sh) — no qemu,
#     no riscv64 execution at build time
#
# Run on ubuntu-latest (needs docker, python3, curl). A few minutes.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-/tmp/d86-rv64-build}
OUT="$REPO/public/rv64"

RV64_TAG=${RV64_TAG:-v0.4.43}
REL="https://github.com/justwasm/rv64.js/releases/download/$RV64_TAG"
KERNEL_ASSET=rv64-kernel-riscv64-minimal

mkdir -p "$WORK/rel" "$OUT"
say() { printf '== %s\n' "$*"; }

# ================================================================= engine ==
say "rv64.js $RV64_TAG release assets"
cd "$WORK/rel"
for f in rv64.js rv64.worker.js rv64.d.ts rv64_wasm.wasm SHA256SUMS \
         "$KERNEL_ASSET" KERNELS-SHA256SUMS; do
  [ -f "$f" ] || curl -fsSL -o "$f" "$REL/$f"
done

say "verify checksums (the release's own SHA256SUMS)"
grep -E '^[0-9a-f]{64}  (rv64\.js|rv64\.worker\.js|rv64\.d\.ts|rv64_wasm\.wasm)$' SHA256SUMS | sha256sum -c -
grep -F "  $KERNEL_ASSET" KERNELS-SHA256SUMS | grep -v '\.tgz' | sha256sum -c -

cp rv64.js rv64.worker.js rv64.d.ts rv64_wasm.wasm "$OUT/"
cp "$KERNEL_ASSET" "$OUT/Image"
echo "$RV64_TAG" > "$OUT/ENGINE_TAG"

# ================================================================ userland ==
STAGE="$WORK/stage"
if [ ! -f "$STAGE/.done" ]; then
  say "Alpine riscv64 userland via docker (apk as cross-extractor)"
  rm -rf "$STAGE"; mkdir -p "$STAGE"
  docker run --rm \
    -v "$STAGE:/stage" -v "$REPO/tools:/tools:ro" alpine:3.24 \
    sh /tools/rv64-collect.sh
  sudo chown -R "$(id -u):$(id -g)" "$STAGE" 2>/dev/null || chown -R "$(id -u):$(id -g)" "$STAGE" || true
  [ -f "$STAGE/.done" ]
fi
cp "$STAGE/initrd.gz" "$OUT/initrd.gz"

say "done"
ls -la "$OUT"
du -sh "$OUT"
