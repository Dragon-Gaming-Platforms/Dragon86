#!/usr/bin/env python3
"""Pack a rootfs tree into a newc-cpio initramfs (public/rv64/initrd.gz).

Unlike make-arch64-initrd.py (which splices a new userland into an existing
archive), this one simply walks the Alpine tree tools/rv64-collect.sh
assembled and writes every entry: directories, files (modes kept), symlinks
and device nodes. Guaranteed device nodes for the consoles are added even if
the tree lacks them — PID 1 needs /dev/console and /dev/ttyS0 before
devtmpfs is mounted.

Same newc format the kernel and src/bridge/guest-root.ts both read.
"""

import gzip
import os
import stat
import sys

C_ISDIR = 0o040000
C_ISREG = 0o100000
C_ISLNK = 0o120000
C_ISCHR = 0o020000


class Writer:
    def __init__(self):
        self.out = bytearray()
        self.ino = 721
        self.seen = set()

    def entry(self, name, mode, body=b"", rdevmaj=0, rdevmin=0):
        if name in self.seen or not name:
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
        name = b"TRAILER!!!\0"
        hdr = b"070701" + b"%08X" % 0 * 12 + b"%08X" % len(name) + b"%08X" % 0
        self.out += hdr + name
        self.out += b"\0" * (-(len(hdr) + len(name)) % 4)


def main():
    root, out_path = sys.argv[1], sys.argv[2]
    root = root.rstrip("/")
    w = Writer()

    entries = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for n in sorted(dirnames) + sorted(filenames):
            entries.append(os.path.join(dirpath, n))
    # os.walk skips symlinked dirs in filenames? No: symlinks to dirs land in
    # dirnames and are not descended when followlinks=False, but they also
    # need an entry; handle every path by lstat below.

    names = sorted(os.path.relpath(p, root) for p in entries)
    for rel in names:
        full = os.path.join(root, rel)
        st = os.lstat(full)
        perm = stat.S_IMODE(st.st_mode)
        if stat.S_ISDIR(st.st_mode):
            w.entry(rel, C_ISDIR | perm)
        elif stat.S_ISLNK(st.st_mode):
            w.entry(rel, C_ISLNK | 0o777, os.readlink(full).encode())
        elif stat.S_ISREG(st.st_mode):
            with open(full, "rb") as f:
                w.entry(rel, C_ISREG | perm, f.read())
        elif stat.S_ISCHR(st.st_mode) or stat.S_ISBLK(st.st_mode):
            kind = C_ISCHR if stat.S_ISCHR(st.st_mode) else 0o060000
            w.entry(rel, kind | perm, b"",
                    os.major(st.st_rdev), os.minor(st.st_rdev))
        # sockets/fifos in a rootfs tarball: nothing in the guest needs them

    # consoles PID 1 depends on, whether or not the tree carried them
    w.entry("dev", C_ISDIR | 0o755)
    for name, maj, minor in (
        ("dev/console", 5, 1),
        ("dev/null", 1, 3),
        ("dev/zero", 1, 5),
        ("dev/tty", 5, 0),
        ("dev/ttyS0", 4, 64),
        ("dev/ptmx", 5, 2),
    ):
        w.entry(name, C_ISCHR | 0o666, b"", maj, minor)

    w.trailer()
    with open(out_path, "wb") as f:
        # mtime=0: a rebuild from identical packages is byte-identical, so
        # the workflow's "nothing to commit" check means what it says (and
        # users' roots are not re-unpacked over a gzip timestamp).
        f.write(gzip.compress(bytes(w.out), 9, mtime=0))
    print(f"{out_path}: {len(w.seen)} entries, "
          f"{os.path.getsize(out_path)} bytes gzipped")


if __name__ == "__main__":
    main()
