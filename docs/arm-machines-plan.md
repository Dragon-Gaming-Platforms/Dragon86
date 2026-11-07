# ARM machines: scouting report and plan

Decision from the project owner: **FreeBSD on ARM64, RISC OS on ARM32.**
This document records what was scouted, what is true, and the honest path
to each — before any code is written.

## First, a correction about v64

v64 does **not** emulate ARM. The "supports both via its API" memory is
about v64 supporting both **32-bit and 64-bit x86** in one engine — that is
why the x86-64 machine can boot the 32-bit Arch distro. v64 is a v86
descendant and is x86-only. Both ARM machines need a new engine.

## ARM64 → FreeBSD: the engine is QEMU Wasm

[`ktock/qemu-wasm`](https://github.com/ktock/qemu-wasm) — QEMU patched to
run in the browser via Emscripten, **including `qemu-system-aarch64`**.
It is the only credible in-browser ARM64 system emulator found.

What was verified (repo + FOSDEM 2025 talk by the author, NTT):

- Real JIT: a TCG backend that compiles hot translation blocks to
  WebAssembly modules (cold code runs in the TCI interpreter). Multi-
  threaded TCG works.
- Demonstrated guests: x86_64, AArch64 and RISC-V 64 Linux, including a
  Raspberry Pi board model, on the public demo page.
- Actively developed (pushed Feb 2026, 400+ stars) and **being upstreamed
  into QEMU proper**: Wasm-host TCI for 32-bit guests landed in QEMU 10.1;
  64-bit TCI and the JIT are in review on qemu-devel.
- License: QEMU's usual GPLv2 — vendorable with license files, same way
  v86/v64 are vendored.
- Build recipe is documented (Emscripten in Docker, `--target-list=
  aarch64-softmmu`, `--enable-virtfs`) — a CI workflow can produce the
  artifacts the same way the arch64/rv64 workflows do today.

Costs that must be stated up front:

- **Needs SharedArrayBuffer**, i.e. COOP/COEP. The repo already has the
  coi service worker, currently disabled behind if-checks — this is the
  feature that would turn it back on, for this engine only.
- **Heavy.** The build configures ~2.3 GB of Wasm memory; phones are out
  of the picture for this machine. Boot will take minutes, not seconds —
  QEMU TCG on Wasm is an order of magnitude slower than native TCG.
- FreeBSD arm64 boots the standard way (edk2 UEFI + virtio disk) on
  QEMU's `virt` machine. A trimmed disk image must be built in CI and
  split into <100 MB parts for Pages, like the guest packs are.
- The ZenFS-as-`/` 9p trick is Linux-specific. QEMU Wasm builds with
  virtfs, and recent FreeBSD has a 9p client, so a shared folder looks
  possible — **to verify during the build, not promised now**. The system
  disk itself will be a disk image either way.

## ARM32 → RISC OS: the engine is Arculator WASM

[`pdjstone/arculator-wasm`](https://github.com/pdjstone/arculator-wasm) —
Sarah Walker's Acorn Archimedes emulator ported to WebAssembly, GPL-2.0,
**actively developed (pushed this week)**. Its front-end project,
[Archimedes Live](https://archi.medes.live), already runs RISC OS in a
browser tab with graphics, sound, mouse and keyboard — this is proven
technology, not a bet. It emulates the machines RISC OS was born on
(A3000/A310/A5000; ARM2/ARM3) and boots Arthur, RISC OS 2 and RISC OS 3.

**The ROM situation, honestly:**

- The emulator code is GPL-2.0 and fine to vendor. It ships **no ROMs** —
  its `roms/` directory is a placeholder saying the user must provide them.
- RISC OS 2/3 and Arthur ROMs are **not open source**. The 2018 Apache-2.0
  relicensing covered RISC OS 5 only; classic ROMs are still sold
  commercially (3QD Developments) and community mirrors live in a
  tolerated grey zone. Dragon86 must **not** vendor them into a public
  GitHub repo and Pages site.
- Therefore the UX is **bring-your-own-ROM**: the machine ships installed
  but asks for a ROM image once (file upload → stored in ZenFS), with a
  plain explanation of where to get one legally (your own machine's dump,
  or a purchased emulation ROM set). Same convention as every console
  emulator; honest and workable.
- The clean-license endgame would be **RISC OS 5 (Apache 2.0)** — but its
  IOMD build needs a RiscPC emulator (RPCEmu), which has no browser port
  today, and QEMU's Raspberry Pi machines lack the USB input RISC OS
  needs. Porting RPCEmu to Wasm is the long-term option if the ROM prompt
  ever becomes a problem.

## Suggested build order

1. **Arculator first** — it is smaller, proven in-browser, needs no
   COOP/COEP, and gives the Engine Viewer a real GUI OS quickly. Work:
   vendor/build the Wasm engine in CI, wire display+input into the Engine
   Viewer, ROM-upload flow, App Store entry ("RISC OS (ARM32)" machine).
2. **QEMU Wasm + FreeBSD second** — bigger lift: CI build of the engine,
   re-enable COI selectively, CI-built FreeBSD disk image in split parts,
   serial console in the Terminal first, framebuffer later.

Neither machine reuses the Linux distro plumbing (`ensureGuestRoot`,
9p root); both integrate as self-contained machines with their own
storage, which the picker and store copy must say plainly.
