#!/usr/bin/env python3
"""Drop empty directories from a gzipped newc-cpio initramfs.

Why: the initrd doubles as the distro image — guest-root.ts unpacks it into
the OS filesystem's `/` — and every empty directory it carries becomes a
permanent piece of clutter in the Files app (/shared, /proc, /sys,
/usr/local/… holding nothing, forever). None of them are needed:

  - in the initramfs, /init makes its own mount points the moment before
    it mounts them (tools/guest-init/init)
  - in the OS filesystem, guest-root.ts ensures the directories a 9p root
    actually needs (proc, sys, dev, tmp, run, root, home, mnt) after every
    unpack

"Empty" is recursive: a directory whose only contents are other empty
directories is empty too. The archive root itself is not an entry in a
cpio and is never touched. Everything kept is copied byte-for-byte —
header, name, body — so this is a pure deletion, not a re-encoding; only
the gzip wrapper is rewritten (mtime=0, so identical input gives
identical output).

  python3 tools/clean-initrd.py <in.gz> <out.gz>   (may be the same file)
"""

import gzip
import sys

# newc header: magic + 11 fields (ino…rdevminor) + namesize + check = 110 B.
TRAILER = b"070701" + b"0" * 88 + b"0000000B" + b"00000000" + b"TRAILER!!!\0"


def chunks(data):
    """Yield (name, mode, raw_bytes) for every entry, raw bytes verbatim."""
    i = 0
    while i + 110 <= len(data):
        if data[i : i + 6] not in (b"070701", b"070702"):
            break
        hdr = data[i : i + 110]
        f = lambda a, b: int(hdr[a:b], 16)
        mode, filesize, namesize = f(14, 22), f(54, 62), f(94, 102)
        name = data[i + 110 : i + 110 + namesize - 1].decode()
        body_at = (i + 110 + namesize + 3) // 4 * 4
        end = (body_at + filesize + 3) // 4 * 4
        if name == "TRAILER!!!":
            return
        yield name, mode, data[i:end]
        i = end


def main():
    src, dst = sys.argv[1], sys.argv[2]
    data = gzip.open(src, "rb").read()
    entries = list(chunks(data))
    names = {n for n, _, _ in entries}
    dirs = [n for n, m, _ in entries if (m & 0o170000) == 0o040000]

    dropped = set()
    changed = True
    while changed:
        changed = False
        for d in dirs:
            if d in dropped:
                continue
            prefix = d + "/"
            if not any(n.startswith(prefix) and n not in dropped for n in names):
                dropped.add(d)
                changed = True

    out = bytearray()
    for name, _, raw in entries:
        if name in dropped:
            continue
        out += raw
    out += TRAILER
    out += b"\0" * (-len(out) % 4)

    with open(dst, "wb") as f:
        f.write(gzip.compress(bytes(out), 9, mtime=0))
    kept = len(entries) - len(dropped)
    print(f"{dst}: kept {kept} entries, dropped {len(dropped)} empty dir(s)"
          + (": " + ", ".join(sorted(dropped)) if dropped else ""))


if __name__ == "__main__":
    main()
