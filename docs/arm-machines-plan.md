# ARM machines: scouting report and plan (revision 2)

Revision 2, after the project owner pointed at upstream v64's README — and
was right: **upstream v64 now has ARM64 and arm32 machines.** The first
revision of this document said v64 was x86-only; that was true of the build
this repo vendors, but upstream has moved a long way past it. Constraint
from the owner, also recorded here: **no COOP/COEP (coi) work.** That rules
out QEMU Wasm (it needs SharedArrayBuffer), which revision 1 proposed for
ARM64.

## What upstream v64 actually has (verified in its README and docs)

- **ARM64** (`cpu_type: "arm64"`): Armv8.0-A at EL0/EL1 on a copy of QEMU's
  `virt-9.2` board — GICv3, PL011 serial, PL031 RTC, PSCI, PCIe, and
  virtio-blk/net/rng/console/input/vsock/sound/gpu over MMIO or PCI. A
  separate Wasm core (`v86-arm64.wasm`), same `V86` JavaScript API.
  Verified guests upstream: Android 16 and Alpine aarch64, extensively.
  **Cooperative cores run on one thread — no cross-origin isolation
  needed** (only the optional worker-per-core mode wants it).
- **arm32** (`cpu_type: "arm32"`): AArch32 at PL1 — real 32-bit kernels,
  ARMv7-style — on the same virt board. Its plan document is marked
  complete (2026-10-25), verified against 32-bit Linux and Android's
  32-bit images. The front README does not advertise it yet.
- **Boot protocol, the deciding fact:** both machines boot **a Linux-format
  kernel image directly, with a device tree**. There is no UEFI firmware,
  no pflash, no U-Boot.
- The copy of v64 vendored in `public/v64` predates all of this; adopting
  either ARM machine means refreshing the vendored build from upstream in
  CI (the ARM core is an additional `.wasm`, the x86 core is unchanged).

## What that does to the OS picks

**FreeBSD arm64: blocked, honestly.** FreeBSD's arm64 boot path is UEFI
(`loader.efi` on edk2) or U-Boot — v64 emulates neither, and FreeBSD's
kernel is not a Linux-boot-protocol image that a direct loader can start.
The one browser engine that could boot FreeBSD (QEMU Wasm, with real edk2)
is excluded by the no-coi constraint. FreeBSD stays parked unless upstream
v64 grows firmware loading.

**The non-Linux OS that fits v64's boot model is NetBSD.** The NetBSD
wiki's own QEMU page documents booting NetBSD/evbarm on the `virt` board by
**direct kernel load, no firmware**: `-kernel netbsd-GENERIC64.img -append
root=...` — their arm64 kernel image deliberately carries a Linux-style
boot header for exactly this. It uses the PL011 console and
virtio-blk/net/rng (MMIO), all of which v64's board has; the wiki notes
virtio-rng matters ("Waiting for entropy..."), and v64 has `virtio_rng`.
The same wiki page shows the armv7 GENERIC kernel booting the 32-bit
`virt` machine the same way — a candidate for v64's arm32, with one open
question to verify: v64's board is GICv3-only, and NetBSD/armv7's GICv3
support needs checking (QEMU's 32-bit virt defaults to GICv2).

**That question is now answered, the hard way.** A first reading of the
vendored engine found a `gic_v2` flag and an `arm,cortex-a15-gic` device
tree node and concluded the arm32 machine was GICv2; NetBSD (ARM32)
shipped on that basis (PR #89) — and never booted. The GICv2 pieces
belong to v64's *ranchu* board (the Android emulator's); its arm32
**virt** board is GICv3 like the arm64 one (upstream `docs/arm32.md`
gives the QEMU reference as `virt-9.2,gic-version=3`, and its
kvm-unit-tests list includes `gicv3`). NetBSD 11's armv7 GENERIC kernel
only drives GICv2 (`gic*`/`armgic`, no `gicvthree`), so it boots QEMU's
default 32-bit virt and dies silently on v64's board —
`tools/vm/boot-arm.mjs` reproduces both halves on the real engine. The
ARM32 OS is therefore **Alpine Linux (armv7)**, the guest upstream
verified on this exact machine; NetBSD stays ARM64-only.

**RISC OS: v64's arm32 does not help, and that is a board problem, not a
CPU problem.** RISC OS only runs on hardware it was ported to — Archimedes
(IOC/MEMC/VIDC), RiscPC (IOMD), Raspberry Pi (BCM283x), and a few others.
Nobody has ported it to the generic `virt` board, and it has no virtio
drivers. The browser path for RISC OS remains **Arculator WASM**
(`pdjstone/arculator-wasm`, GPL-2.0, actively developed, proven in a tab at
archi.medes.live with graphics, sound, mouse and keyboard — and no coi
requirement). The ROM facts from revision 1 stand: classic RISC OS 2/3
ROMs are not open source and must not be vendored; the UX is
bring-your-own-ROM (one upload, stored in ZenFS, with plain words on where
to get one legally).

## Revised plan

1. **ARM64 machine = v64 `cpu_type: "arm64"` + NetBSD/evbarm aarch64.**
   Vendor-refresh v64 from upstream in CI; boot `netbsd-GENERIC64.img`
   direct with a virtio disk, serial console in the Terminal first (the
   same shape as the RISC-V 64 + Alpine machine). NetBSD has no virtio-gpu
   driver, so this machine is console-first; X on a framebuffer is not
   promised.
2. **ARM32 machine = RISC OS on Arculator WASM.** Vendor/build the engine
   in CI, wire its display and input into the Engine Viewer, ROM-upload
   flow, App Store entry.
   *As shipped:* Arculator is a **self-contained App Store app**
   ("Archimedes", own window, own canvas, own IndexedDB storage), **not**
   an Engine Viewer machine. The Engine Viewer is wired to v86/v64 buses;
   Arculator is an SDL2/WebGL emscripten program with its own display and
   input handling, and bridging it into the viewer would add complexity
   for no user benefit. Everything else stands: CI-built from a pinned
   commit, no bundled OS ROMs, bring-your-own-ROM upload stored in the
   browser, no coi.
3. **FreeBSD: parked** with the reason written down (no UEFI in v64, no
   coi for QEMU Wasm). Revisit if either fact changes.
4. The arm32-NetBSD variant (32-bit NetBSD on v64 arm32) is a possible
   third machine later, pending the GICv3 question.

Neither machine reuses the Linux distro plumbing (`ensureGuestRoot`, 9p
root); both integrate as self-contained machines with their own storage,
which the picker and store copy must say plainly. The upstream v64 refresh
is the enabling step for machine 1 and should also be checked for x86
regressions before it replaces the vendored build.
