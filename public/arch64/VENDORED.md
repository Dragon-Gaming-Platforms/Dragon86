# public/arch64 — vendored 64-bit Arch Linux guest

Built by the 'Build arch64 guest' workflow — not written by hand.

- bzImage: Arch Linux `linux` package kernel, version 6.18.60-1-lts,
  taken as-is from the official `archlinux` Docker image via pacman.
- initrd.gz: Arch's x86_64 bash/coreutils/grep/sed/gawk/kmod/
  util-linux + glibc, busybox for the rest, the virtio/9p/serial/
  keyboard modules for 6.18.60-1-lts, and a static 64-bit git
  (git/git v2.49.1, zig cc, x86_64-linux-musl, NO_CURL).
  The non-userland entries (/init, /networking.sh, /etc, device
  nodes) are reused verbatim from public/v86/initrd.gz — they are
  shell scripts and text, not binaries. See tools/make-arch64-initrd.py.
- git-remote-http.gz: git v2.49.1 HTTPS transport, static
  x86_64-linux-musl, libcurl 8.11.1 + mbedTLS 3.6.2 + zlib 1.3.1 —
  the same pinned recipe as tools/build-git-remote-http.sh.
  Licenses: see public/v86/LICENSE.git/.curl/.mbedtls (same sources).
- CA bundle: the guest reuses public/v86/ca-certificates.crt.

Built: 2026-11-06T18:35:12Z by GitHub Actions run 42271460133
Rebuild: run the 'Build arch64 guest' workflow (it overwrites these files).
