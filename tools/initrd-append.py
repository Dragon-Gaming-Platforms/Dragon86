#!/usr/bin/env python3
"""Append files to an existing gzipped cpio (newc) initramfs.

Used to add the guest's GNU userland bits (git) to the vendored Arch
initrd without rebuilding the whole tree. The original archive is copied
through byte-for-byte; the new entries are inserted just before the
TRAILER so every existing inode/hardlink/symlink stays exactly as it was.

    tools/initrd-append.py public/v86/initrd.gz <staging-dir> public/v86/initrd.gz

Paths inside <staging-dir> are preserved (e.g. usr/bin/git -> /usr/bin/git).
An existing path in the archive is an error: this tool only adds.
"""
import gzip
import os
import stat
import sys

NEWC = b"070701"


def align4(n):
    return (n + 3) & ~3


def walk(data):
    """Parse entries -> list of (name, mode, data_slice), plus trailer offset/max inode."""
    i = 0
    max_ino = 0
    while True:
        hdr = data[i:i + 110]
        if hdr[:6] != NEWC:
            raise SystemExit(f"not a newc archive at offset {i}")
        f = lambda o: int(hdr[o:o + 8], 16)
        ino, mode, nlink, size, namesize = f(6), f(14), f(38), f(54), f(94)
        name = data[i + 110:i + 110 + namesize - 1].decode()
        body = align4(110 + namesize)
        if name == "TRAILER!!!":
            return i, max_ino
        max_ino = max(max_ino, ino)
        i = i + body + size
        i = align4(i)


def entry(name, mode, ino, data=b""):
    namesize = len(name) + 1
    hdr = NEWC + b"".join(
        b"%08X" % v for v in (
            ino, mode, 0, 0, 1 if stat.S_ISDIR(mode) else 1, 0, len(data), 0, 0, 0, 0, namesize, 0,
        )
    )
    # Layout check: ino, mode, uid, gid, nlink, mtime, filesize, devmaj, devmin, rdevmaj, rdevmin, namesize, check
    out = hdr + name.encode() + b"\0"
    out += b"\0" * (align4(len(out)) - len(out))
    out += data
    out += b"\0" * (align4(len(out)) - len(out))
    return out


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    src, root, dst = sys.argv[1:]
    data = gzip.open(src, "rb").read()
    trailer_off, max_ino = walk(data)
    existing = set()
    i = 0
    while i < trailer_off:
        hdr = data[i:i + 110]
        namesize = int(hdr[94:102], 16)
        size = int(hdr[54:62], 16)
        existing.add(data[i + 110:i + 110 + namesize - 1].decode())
        i = align4(i + align4(110 + namesize) + size)

    todo = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        if rel != ".":
            todo.append(("dir", rel))
        for fn in sorted(filenames):
            todo.append(("file", os.path.join(rel, fn) if rel != "." else fn))

    added = []
    ino = max_ino + 1
    out = []
    for kind, rel in todo:
        path = os.path.join(root, rel)
        st = os.lstat(path)
        if rel in existing:
            if kind == "dir":
                continue
            raise SystemExit(f"already present in archive: /{rel}")
        if kind == "dir":
            mode, body = stat.S_IFDIR | 0o755, b""
        elif os.path.islink(path):
            mode, body = stat.S_IFLNK | 0o777, os.readlink(path).encode()
        else:
            mode = stat.S_IFREG | (st.st_mode & 0o7777)
            with open(path, "rb") as fh:
                body = fh.read()
        out.append(entry(rel, mode, ino, body))
        added.append((rel, len(body)))
        ino += 1

    trailer = entry("TRAILER!!!", 0, 0)
    archive = data[:trailer_off] + b"".join(out) + trailer
    archive += b"\0" * (align4(len(archive)) - len(archive))
    with gzip.GzipFile(dst, "wb", compresslevel=9, mtime=0) as fh:
        fh.write(archive)

    for rel, n in added:
        print(f"  + /{rel} ({n} bytes)")
    print(f"{src} + {len(added)} entries -> {dst} "
          f"({os.path.getsize(src)} -> {os.path.getsize(dst)} bytes)")


if __name__ == "__main__":
    main()
