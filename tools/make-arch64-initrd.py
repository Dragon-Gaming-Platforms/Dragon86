#!/usr/bin/env python3
"""Assemble public/arch64/initrd.gz (see tools/build-arch64-guest.sh).

The 64-bit initramfs is the 32-bit one with its userland swapped out:

  - every entry of the base archive (public/v86/initrd.gz) that is NOT under
    usr/ is carried over verbatim — /init, /networking.sh, /etc, the device
    nodes, the empty mount-point directories. They are shell scripts, text
    and structure: nothing about them is 32-bit.
  - usr/ comes from the staging tree the archlinux container filled
    (Arch's own x86_64 bash/coreutils/glibc/busybox/modules + static git).
  - two symlinks a 64-bit root needs that a 32-bit one never had:
    /lib64 -> usr/lib and /usr/lib64 -> lib (glibc's ELF interpreter lives
    at /lib64/ld-linux-x86-64.so.2 and its default search path is lib64).

Same newc cpio format the kernel and src/bridge/guest-root.ts both read.
"""

import argparse
import gzip
import os
import sys

C_ISDIR = 0o040000
C_ISREG = 0o100000
C_ISLNK = 0o120000


def parse(data):
    """Yield (name, mode, filesize, body, devmajor, devminor) from newc cpio."""
    i = 0
    while i < len(data):
        if data[i : i + 6] != b"070701":
            break
        hdr = data[i : i + 110]
        f = lambda a, b: int(hdr[a:b], 16)
        mode, filesize, namesize = f(14, 22), f(54, 62), f(94, 102)
        rdevmaj, rdevmin = f(78, 86), f(86, 94)
        name = data[i + 110 : i + 110 + namesize - 1].decode()
        i += 110 + namesize
        i = (i + 3) // 4 * 4
        body = data[i : i + filesize]
        i += filesize
        i = (i + 3) // 4 * 4
        if name == "TRAILER!!!":
            return
        yield name, mode, body, rdevmaj, rdevmin


class Writer:
    def __init__(self):
        self.out = bytearray()
        self.ino = 721
        self.seen = set()

    def entry(self, name, mode, body=b"", rdevmaj=0, rdevmin=0):
        if name in self.seen:
            return
        self.seen.add(name)
        self.ino += 1
        nb = name.encode() + b"\0"
        hdr = (
            b"070701"
            + b"%08X" % self.ino
            + b"%08X" % mode
            + b"%08X" % 0  # uid
            + b"%08X" % 0  # gid
            + b"%08X" % 1  # nlink
            + b"%08X" % 0  # mtime
            + b"%08X" % len(body)
            + b"%08X" % 0  # devmajor
            + b"%08X" % 0  # devminor
            + b"%08X" % rdevmaj
            + b"%08X" % rdevmin
            + b"%08X" % len(nb)
            + b"%08X" % 0  # check
        )
        self.out += hdr + nb
        self.out += b"\0" * (-(len(hdr) + len(nb)) % 4)
        self.out += body
        self.out += b"\0" * (-len(body) % 4)

    def trailer(self):
        self.entry("TRAILER!!!", 0)
        self.out += b"\0" * (-len(self.out) % 512)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--stage", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    base = gzip.open(args.base, "rb").read()
    w = Writer()

    kept = dropped = 0
    for name, mode, body, rmaj, rmin in parse(base):
        if name.startswith("usr/") or name == "usr" or name == "etc/ld.so.cache":
            dropped += 1
            continue
        # (etc/os-release is a symlink into usr/ — the stage supplies the
        # real usr/lib/os-release, see tools/arch64-collect.sh)
        w.entry(name, mode, body, rmaj, rmin)
        kept += 1

    # The 64-bit library path: /lib64 -> usr/lib, /usr/lib64 -> lib.
    w.entry("usr", C_ISDIR | 0o755)
    w.entry("lib64", C_ISLNK | 0o777, b"usr/lib")

    added = 0
    stage = os.path.abspath(args.stage)
    for root, dirs, files in os.walk(stage):
        dirs.sort()
        rel = os.path.relpath(root, stage)
        if rel == ".":
            # top of the stage: only usr/ and etc/ belong in the archive
            dirs[:] = [d for d in dirs if d in ("usr", "etc")]
            continue
        w.entry(rel, C_ISDIR | 0o755)
        for fn in sorted(files):
            p = os.path.join(root, fn)
            name = os.path.join(rel, fn)
            if os.path.islink(p):
                w.entry(name, C_ISLNK | 0o777, os.readlink(p).encode())
            else:
                st = os.stat(p)
                mode = C_ISREG | (st.st_mode & 0o7777)
                if name.startswith("usr/bin/"):
                    mode = C_ISREG | 0o755
                with open(p, "rb") as fh:
                    w.entry(name, mode, fh.read())
            added += 1
    w.entry("usr/lib64", C_ISLNK | 0o777, b"lib")

    w.trailer()
    with open(args.out, "wb") as fh:
        fh.write(gzip.compress(bytes(w.out), 9, mtime=0))
    print(
        f"{args.out}: kept {kept} base entries, dropped {dropped} (32-bit usr/), "
        f"added {added} from the stage; {len(w.out)//1048576} MB -> "
        f"{os.path.getsize(args.out)//1048576} MB gz"
    )


if __name__ == "__main__":
    sys.exit(main())
