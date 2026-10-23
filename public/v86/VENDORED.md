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
- `bzImage` — Arch Linux 32 kernel `vmlinuz-linux` 6.12.4-arch1-1.0
  (GPL-2.0; source via the Arch Linux 32 kernel package / kernel.org),
  taken from the copy/v86 Arch demo image set (fs.json + sha256 flat
  store). Despite the filename (kept so the loader config doesn't
  change), this is the Arch `vmlinuz`, not a bzImage we built.
- `git` (inside `initrd.gz`, not a separate file) — GNU Git 2.49.1,
  built by Dragon86 from the upstream `git/git` v2.49.1 source with
  `zig cc -target x86-linux-musl`, fully static, linked against zlib
  1.3.1. Configured without curl/OpenSSL/expat/gettext (no network in
  the guest, so `git clone https://…` is not available; local
  repositories, commits, branches, merges, tags, bundles and
  `file://`-style remotes all work). GPL-2.0, see `LICENSE.git`.
  Added to the initrd with `tools/initrd-append.py`, which copies the
  existing archive through byte-for-byte and inserts new entries
  before the trailer.
- `initrd.gz` — built by Dragon86 from the Arch mkinitcpio initramfs:
  its busybox (GPL-2.0) and the virtio/9p kernel modules, plus a
  userland subset extracted from the same Arch demo rootfs — **GNU
  bash 5.2.32 and GNU coreutils 9.5 with their glibc closure**, so the
  guest shell is Arch's own bash, not a reimplementation. This is a
  subset, not the full ~843 MB Arch installation (that can't be
  vendored into GitHub Pages): no pacman, no systemd, no desktop —
  the kernel, bash, GNU coreutils and git. Our `/init` loads the
  virtio PCI + 9p modules, mounts the host share at `/shared` in the
  background (the virtio probe finishes after init under emulation),
  sizes the serial line from the kernel cmdline (`d86cols`/`d86rows`
  — serial has no winsize channel), and spawns bash on ttyS0.

## Boot configuration

The emulator is started with ACPI enabled so Linux receives v86's
interrupt/CPU tables instead of falling back to SeaBIOS's incomplete
MP table (which otherwise causes RSDP, MP-table and IOAPIC warnings).
The kernel command line also blacklists `mcheck_init_device`: v86's
CPU has no machine-check hardware for the Arch kernel to initialize.
These warnings did not prevent booting, but the guest now boots
without them; the shared-folder boot was retested after the change.

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

## Full Arch Linux (the copy/v86 image)

The mini guest above is the default. Settings → v86 guest can switch to
**Full Arch Linux 32**, which boots copy.sh's complete Arch root
filesystem instead of our subset.

That image is not a disk file. Upstream serves a whole root filesystem
over 9p from a flat HTTP store — `fs.json` (the tree) plus
`arch/<sha256-prefix>.bin` blobs, fetched lazily as the guest touches files.
Dragon86 points v86 at that store (`filesystem: { baseurl, basefs }` +
`bzimage_initrd_from_filesystem`, so the kernel and initrd come from
inside the image) and changes only the console: upstream's openrc init
greets tty1, but Dragon86's Terminal is a serial line, so the command
line asks for `console=ttyS0 init=/bin/bash`. Because no boot scripts
run, the Terminal's **Prepare Shell** button types the equivalent of a
login (mount devtmpfs/proc/sys/devpts, set PATH) when the user asks for
it. Nothing is injected automatically.

Consequences, by design:

- The image is streamed from the origin, not vendored, so Dragon86 stays
  far under GitHub Pages' 1 GB limit.
- The origin must allow cross-origin reads. `i.copy.sh` must, since
  copy.sh itself is a different origin and fetches the same URLs; the
  Settings **Test** button and the Terminal's **Check Image** button
  report the exact HTTP/CORS result from the user's browser. If it is
  blocked, `tools/arch-image/` mirrors the store into a Pages repo of
  our own (Pages always sends `Access-Control-Allow-Origin: *`) and the
  same setting points at it.
- `/shared` is unavailable in this mode: v86 has one 9p device and the
  root filesystem occupies it.
- Save State is unavailable in this mode: the root filesystem lives in
  v86's HTTP-backed 9p store, which `save_state()` does not contain, so
  a restored machine would come back with an empty root. Snapshots
  record which guest they belong to and are ignored across guests.
- Memory rises to 512 MB (320 MB on touch devices), matching upstream's
  demo, because a real distro userland needs it.

Verified locally before shipping: a store built from a real root tree
(fs.json + 160 blobs) was booted through v86's `filesystem: { baseurl,
basefs }` path; the guest mounted the streamed root over 9p and listed
its contents from the shell.

## The Arch root in ZenFS

`/` inside the full Arch guest is `~/v86` on the OS side, served by our
own 9p server (`src/bridge/p9.ts`) out of a union filesystem
(`src/bridge/union-fs.ts`):

    copy.sh's read-only image  (fs.json + blobs, fetched lazily)
              ↓ read
    ~/v86/…                    ZenFS: writable, persistent, in Files
              ↓
    guest /                    served over 9p

Reads that ZenFS cannot satisfy come from the image. The first **write**
to an image file copies it up into ZenFS first, so edits persist in
IndexedDB and show up in the Files app, while untouched files cost
nothing. Guest deletions of image files are recorded as whiteouts in
`~/v86/.dragon86-whiteouts.json` so they do not reappear.

On boot the image's directory tree (directories and symlinks only) is
created in `~/v86` in the background, so the whole Arch layout is
browsable in Files immediately; contents materialise on first use. The
marker `~/v86/.dragon86-image.json` records which image base the tree
came from, so it is not walked twice.

The guest's `/shared` is a submount of the same union: `~/v86/shared`
on top of your Files folder (`zenfsBase(HOME)`), so existing files stay
visible in the guest and anything the guest writes there persists in
`~/v86/shared`. The mini guest uses exactly the same `/shared` layout.

CheerpX gets the matching folder, `~/CheerpX/shared`; pointing the fs1
bridge at it is the last step for that engine (the hoster side still has
to mount it).

Verified with a real guest on a local copy of the store: image files
read through the union, an OS-side edit read back inside the guest, a
guest write persisted into ZenFS, a guest write to an *image* file
copying it up intact, and `/shared` showing the OS files. The full
`root=host9p` boot uses the same server with `/` instead of `/shared`
as the mount point.

## Networking (emulator side)

v86 emulates the NIC and everything behind it; the guest never invents a
network for itself. Dragon86 passes `net_device: { type: "virtio",
relay_url }` (Settings → **v86 network**), so:

- v86's virtio-net card appears as `eth0` in the guest,
- the backend answers DHCP itself for its local link
  (`192.168.86.100`, router/DNS `192.168.86.1`),
- traffic beyond that link goes through the relay.

The backend is chosen by the URL's scheme: `wss://`/`ws://` = wsproxy
(copy.sh's own public relay is the default), `wisp://`/`wisps://` = a
wisp server, `fetch` = the in-page stack (no server, CORS-limited).
Settings → Test opens the socket the emulator will open and reports the
outcome, because a dead relay looks exactly like a broken guest: the
interface comes up, the lease never arrives.

`public/v86/scripts/networking.sh` (shipped in the initramfs at
`/networking.sh` and copied into the OS filesystem at
`~/v86/networking.sh`, so it is editable in Files) does what the
same script does in copy.sh's images — loads the driver and asks for a
lease — plus a static fallback and a `status` mode. The guest init also
tries to bring the card up in the background at boot, so a working relay
means the shell already has a network.

Verified with a real guest and a local wisp proxy: the guest loaded
virtio_net, got `192.168.86.100` by DHCP from the emulated router, wrote
`/etc/resolv.conf`, and fetched a page over HTTP through the emulated
NIC. Without a relay the same guest loads the driver, shows `eth0`, and
times out on DHCP — which is why the probe exists.

## The image file list (`fs.json`) is vendored

The full Arch guest's root filesystem is described by one document,
`fs.json`: for every path, a `[name, size, mtime, mode, uid, gid, last]`
entry where `last` is either a child list or the name of a content blob
(`<sha256-prefix>.bin[.zst]`, 8 hex digits in the current image). It is the 9p file list, not file contents.

**It is a file in this repository** — 5.8 MB, 98,006 paths (9,789
directories, 5,723 symlinks, 82,489 files, 70,661 distinct contents) for the
current Arch set — — `public/v86/fs.json` — and is served
from our own origin. That is not a tidiness choice: the upstream store
answers **403 to Safari**, so a browser-side fetch of the list can simply
fail. Same-origin has no such opinion.

Two workflows keep it current:

- `.github/workflows/vendor-fs-json.yml` — on every push to main, fetches
  `fs.json` (https, then http), validates it (JSON, a real `fsroot` with
  file entries, sane size), and commits it if it changed. Bot pushes use
  `GITHUB_TOKEN`, so they do not re-trigger workflows: one fetch per real
  push, no loop.
- `.github/workflows/deploy.yml` — before building, uses the committed copy
  if there is one, otherwise fetches it. Best-effort either way.

At runtime the app resolves it in this order, and logs which one it used
(`[D86:image] using the shipped image list`):

1. **shipped** — `public/v86/fs.json`, same origin.
2. **vendored on this device** — the same document kept in ZenFS at
   `~/v86/.dragon86-image-fs.json`. Settings → **v86 image** → *Vendor to
   this device* fetches it once in your browser and keeps it there; useful
   when a build has no copy, or you point Settings at another image base.
3. **live** — `fs.json` from the configured image base (or its mirror, see
   below). If this worked, it is saved, so it happens at most once.

Only **file contents** are streamed from the image store
(`<base>arch/<blob>`), lazily, the first time the guest or Files touches a
file.

### Safari: the 403, the mirror, and zstd

What the origin actually does (measured, see `docs/fs-probe.md` and
`docs/fs-vendor.log`): it is not down and it does not hate any browser. It
**requires a `Referer` header** and refuses the connection without one — and
when it does answer, it is generous: 200, `application/json`,
`Access-Control-Allow-Origin: *`. Browsers normally send a referrer
cross-origin, so this mostly works; when a policy, a tracking protection or a
stripped header removes it, every image request dies with an opaque failure,
which is what Safari was showing. The loader now passes
`referrerPolicy: "origin"` on every cross-origin request, so the header is
not optional any more.

Three separate things had to be true before Full Arch could work in every
browser, and only two of them are ours to fix:

1. **The list** — fixed above, by serving our own copy.
2. **zstd blobs** — Chromium has had `DecompressionStream("zstd")` since
   123; other engines may not, and a guest cannot boot with half its files
   unreadable. `fzstd` (MIT, bundled, ~10 KB) is now the fallback decoder,
   used automatically when the platform API is missing or refuses. Nothing
   to do at runtime; Settings reports which one your browser uses. (The
   current Arch set has no `.zst` blobs at all — all 70,661 are plain
   `.bin` — so today this is insurance against the next image.)
3. **The blobs themselves** — still fetched from upstream, which refuses a
   request with no referrer. Ours to *work around*, not to fix: Settings →
   **v86 image** → **Image mirror** takes a second store with the same file
   names and bytes, and any blob the primary refuses (403 or network error)
   is retried there. `.github/workflows/mirror-arch-image.yml` builds such a
   mirror into a Pages repo of its own on demand — see
   `tools/arch-image/README.md` — because Pages answers everyone and sends
   `Access-Control-Allow-Origin: *`.

With a mirror configured, nothing about the guest changes: same image,
same bytes, just a host that will talk to every browser.

