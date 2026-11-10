# Alpine Linux (ARM32) — vendored guest

Built by .github/workflows/build-alpine32.yml from the official
Alpine Linux release (no hand-built binaries):

- alpine-netboot-3.24.4-armv7.tar.gz — vmlinuz-lts (the kernel, a zImage; armv7's netboot
  release ships lts + rpi, and lts is the multiplatform build that
  drives the virt board), initramfs-lts (shipped as initrd.img with
  ONE addition: the ext4 module closure from modloop-lts, because
  the official netboot initramfs cannot mount an ext4 root — the
  boot test on the real engine proved it), modloop-lts (the
  kernel's modules, copied into the disk's /lib/modules)
- alpine-minirootfs-3.24.4-armv7.tar.gz — the userland, unpacked onto a 512 MiB ext4 image

Both artifacts are SHA512-verified against latest-releases.yaml.
Local changes: a serial-console inittab (getty on ttyAMA0), root
login without a password, hostname, motd, fstab. Boot-tested on
the REAL vendored engine (public/v64, cpu_type "arm32") by
tools/vm/boot-arm.mjs before this commit.

Alpine Linux is (c) its contributors, MIT-style licenses per
package; see https://alpinelinux.org.
