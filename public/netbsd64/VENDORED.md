# public/netbsd64 — vendored NetBSD 11.0 (ARM64) guest

Built by the 'Build netbsd64 guest' workflow — not written by hand.

- kernel.img.gz: the official netbsd-GENERIC64.img kernel from
  cdn.netbsd.org (NetBSD 11.0, evbarm-aarch64), SHA512-verified.
  It carries a Linux-style boot header, so the v64 ARM64 virt
  machine boots it directly — no UEFI involved.
- root.img.gz.NN: a 1280 MiB GPT disk (one FFS partition,
  label d86root) holding the official live image's system minus
  the X11 sets, man/doc/httpd pages and /usr/include, assembled
  and boot-tested under qemu-system-aarch64 by this workflow.
  Boot-test: direct kernel boot, root=NAME=d86root, to a root
  login on the serial console.
- Licensing: NetBSD's BSD licenses; see /usr/share/legal in the
  image and https://www.netbsd.org/about/redistribution.html

Built: 2026-11-10T05:57:12Z by GitHub Actions run 42763721166
Rebuild: run the 'Build netbsd64 guest' workflow (it overwrites these files).
