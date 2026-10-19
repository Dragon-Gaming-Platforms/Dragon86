# Vendored: v86 compatibility engine

The Terminal's third engine option ("v86 (compatibility)") for browsers
that can't do cross-origin isolation (Android WebView, locked-down
browsers…). v86 needs no SharedArrayBuffer and no service worker.

Contents and provenance:

- `libv86.js`, `v86.wasm`, `v86-fallback.wasm` — npm package `v86@0.5.472`
  (upstream copy/v86, latest release line). BSD-2-Clause, see
  `LICENSE.v86`.
- `bios/seabios.bin`, `bios/vgabios.bin` — from copy/v86 `bios/`.
  SeaBIOS is LGPLv3, see `LICENSE.seabios`.
- `bzImage` — Alpine Linux 6.12.94 `vmlinuz-virt` (GPL-2.0; source via
  Alpine's kernel package / kernel.org), extracted from the upstream
  v86 Alpine image set (fs.json + sha256 flat store).
- `initrd.gz` — built by Dragon86 from Alpine's initramfs: busybox
  (GPL-2.0; source via Alpine aports) for the core utilities, the
  virtio-9p kernel modules, and **GNU bash 5.3 as the login shell** —
  cross-compiled from the GNU bash mirror with
  `zig cc -target x86-linux-musl -static`. Our `/init` loads the 9p
  modules, mounts the host share at `/shared`, sizes the serial line
  from the kernel cmdline (`d86cols`/`d86rows` — serial has no winsize
  channel), and spawns bash on ttyS0.

## The filesystem: a real 9p server, not a sync

The guest's `/shared` **is** the Dragon86 filesystem (`/home/user`),
live in both directions. `src/bridge/p9.ts` implements a 9p2000.L
server backed directly by ZenFS and plugs into stock v86 via
`filesystem.handle9p`; the guest kernel mounts it like any 9p share.
Creates, edits, deletes and renames on either side are just filesystem
operations on the other — nothing is copied at boot, nothing is typed
into the guest shell to arrange it. (AnuraOS does the same shape with a
forked v86 whose 9p layer calls their host fs; this is the equivalent
on unmodified upstream v86.)

Verified before shipping: booted under Node with these exact files —
bash prompt on serial, `/shared` listing/reading OS files, guest
`echo`/`mkdir`/`mv`/`rm` all visible in the OS filesystem, and a
save-state → restore round trip after which the share kept working.

## Save state

Terminal → **Save State** snapshots the machine (`save_state`),
gzip-compresses the result and stores it in IndexedDB (database
`dragon86-v86state`; localStorage's ~5 MB cap is far too small for a
machine snapshot). The next v86 start passes it as `initial_state` and
resumes; the 9p server treats fids it doesn't know as the share root,
so the restored guest's mount heals itself on first use.

## Why not a full Arch Linux guest?

Arch dropped 32-bit; the surviving archlinux32 build path is a ~2 GB
disk image produced by booting the installer ISO under QEMU/Packer —
no prebuilt image is fetchable from this build environment, and a 2 GB
guest is wrong for GitHub Pages + phones. The interactive parts that
motivated the swap are covered: the shell is genuine GNU bash and the
file system is the OS's own. If a fetchable archlinux32 image ever
becomes available, it can drop in as an `hda` image beside this setup.
