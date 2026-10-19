# Vendored: v86 compatibility engine

The Terminal's third engine option ("v86 (compatibility)") for browsers
that can't do cross-origin isolation (Android WebView, locked-down
browsers…). v86 needs no SharedArrayBuffer and no service worker.

Contents and provenance (all downloaded/built 2026-10-19):

- `libv86.js`, `v86.wasm`, `v86-fallback.wasm` — npm package `v86@0.5.472`
  (upstream copy/v86, latest release line). BSD-2-Clause, see
  `LICENSE.v86`.
- `bios/seabios.bin`, `bios/vgabios.bin` — from copy/v86 `bios/`.
  SeaBIOS is LGPLv3, see `LICENSE.seabios`.
- `bzImage` — Alpine Linux 6.12.94 `vmlinuz-virt` (GPL-2.0; source via
  Alpine's linux kernel package / kernel.org), extracted from the
  upstream v86 Alpine image set (fs.json + sha256 flat store).
- `initrd.gz` — built by Dragon86 from Alpine's initramfs (busybox,
  GPL-2.0; source via Alpine aports): stock modules kept, apk/crypto
  leftovers trimmed, and `/init` replaced with our own — it loads the
  virtio-9p modules, mounts the host share at `/shared`, and runs a
  login shell on the serial console.

## The VFS wiring

Dragon86's virtual filesystem (`/home/user` in the OS) *is* the guest's
`/shared`: the OS pushes its files into v86's 9p filesystem at boot
(`create_file`), the guest mounts it read-write, and guest writes flow
back into the OS filesystem on v86's `9p-write-end` events
(`src/bridge/v86.ts`). No disk image, no CheerpX-Bridge involved.

Verified before vendoring: booted under Node with this exact
bzImage/initrd — shell on serial, `/shared` mounted, host→guest and
guest→host file round-trips both passed.

Not synced (known limits): guest-side deletions/renames, and OS-side
edits made *while* the engine is running (they land on next boot or
Reconnect).
