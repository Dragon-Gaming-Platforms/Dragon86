# public/rv64 — vendored RISC-V 64 engine + Alpine guest

Built by the 'Build rv64 guest' workflow — not written by hand.

- rv64.js / rv64.worker.js / rv64.d.ts / rv64_wasm.wasm: the
  justwasm/rv64.js emulator, release v0.4.43, taken as-is from
  that release and verified against its SHA256SUMS. MIT licensed
  (see LICENSE here).
- Image: the same release's riscv64 Linux kernel ('minimal'
  flavour). 9p, virtio-mmio and the 8250 serial console are
  built in; MODULES=n, so the guest ships no modules. GPL-2.0.
- initrd.gz: official Alpine Linux riscv64 (minirootfs + apk
  packages bash, git, ca-certificates, openssl — Alpine's own
  riscv64 binaries, cross-extracted, nothing rebuilt) plus
  Dragon86's /init and /etc overlay. Also the App Store distro
  payload. Alpine packages: MIT/GPL and others, see each
  package; assembly: tools/rv64-collect.sh.

Built: 2026-11-06T03:52:15Z by GitHub Actions run 42159079914
Rebuild: run the 'Build rv64 guest' workflow (it overwrites these files).
