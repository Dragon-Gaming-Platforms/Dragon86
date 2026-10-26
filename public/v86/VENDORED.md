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
  taken from the copy/v86 Arch demo image set. Despite the filename
  (kept so the loader config doesn't change), this is the Arch
  `vmlinuz`, not a bzImage we built.
- `git` (inside `initrd.gz`, not a separate file) — GNU Git 2.49.1,
  built by Dragon86 from the upstream `git/git` v2.49.1 source with
  `zig cc -target x86-linux-musl`, fully static, linked against zlib
  1.3.1. Configured **without curl/OpenSSL/expat/gettext**; like every
  git, it has no TLS inside the binary itself — its HTTP transports are
  separate programs, and this one ships them (next bullet). Local
  repositories, commits, branches, merges, tags, bundles, `file://`
  remotes all work in the binary itself. GPL-2.0, see `LICENSE.git`.
  Added to the initrd with `tools/initrd-append.py`, which copies the
  existing archive through byte-for-byte and inserts new entries
  before the trailer.
- `git-remote-http.gz` — git's HTTPS transport, built by Dragon86 for
  this guest: `git-remote-http` (the `git-remote-https` name is a
  symlink to it, which is how upstream ships it) from `git/git`
  v2.49.1, linked against libcurl 8.11.1 with mbedTLS 3.6.2 and zlib
  1.3.1, all static, `zig cc -target x86-linux-musl`. 4.3 MB stripped,
  1.9 MB gzipped, written into the guest's `/usr/lib/git-core` at boot
  (see `installGitTransport()` in `src/bridge/v86.ts`) because that is
  the exec path this git was built with. Licences: git GPL-2.0
  (`LICENSE.git`), curl MIT-like (`LICENSE.curl`), mbedTLS Apache-2.0
  (`LICENSE.mbedtls`). `tools/build-git-remote-http.sh` is the whole
  build, from source tarballs, no prebuilt binaries.
- `ca-certificates.crt` — the Mozilla root store as shipped by Python's
  `certifi` (MPL-2.0 for the bundle; the certificates belong to their
  CAs). Installed at the guest's `/etc/ssl/certs/ca-certificates.crt`,
  the path `git-remote-http` was compiled to trust, so a clone verifies
  the server against the same roots a browser would.
- `initrd.gz` — built by Dragon86 from the Arch mkinitcpio initramfs:
  its busybox (GPL-2.0) and the virtio/9p kernel modules, plus a
  userland subset extracted from the same Arch demo rootfs — **GNU
  bash 5.2.32 and GNU coreutils 9.5 with their glibc closure**, so the
  guest shell is Arch's own bash, not a reimplementation. This is a
  subset, not the full ~843 MB Arch installation (that can't be
  vendored into GitHub Pages): no pacman, no systemd, no desktop —
  the kernel, bash, GNU coreutils and git. This archive is also the
  source of the guest's `/`: it is unpacked once into `~/v86`, and the
  guest boots from that copy with `/` served back over 9p. `/init` is
  built from `tools/guest-init/init` (see below for what it does).

## Boot configuration

The emulator is started with ACPI enabled so Linux receives v86's
interrupt/CPU tables instead of falling back to SeaBIOS's incomplete
MP table (which otherwise causes RSDP, MP-table and IOAPIC warnings).
The kernel command line also blacklists `mcheck_init_device`: v86's
CPU has no machine-check hardware for the Arch kernel to initialize.
These warnings did not prevent booting, but the guest now boots
without them; the shared-folder boot was retested after the change.

## The 9p root: mount once

`/init` (`tools/guest-init/init`) mounts the share with `mount -t 9p … host9p
/newroot` and then chroots into it. It reaches that step twice — once to repair
a lost permission bit, once before starting the session — and a second
`mount` of the same tag is refused with `EBUSY`. Each refusal also makes
9pnet_virtio log `no channels available for device host9p`, so the retry loop
used to produce forty of those, give up, and drop into the initramfs recovery
shell. `mount_root` now treats an already-mounted `/newroot` as success
(`mountpoint -q`), keeps mount's own error message instead of discarding it,
and reloads `9pnet_virtio` before retrying a genuine failure. `npm run test:vm`
boots the real kernel, initramfs and 9p server in Node and fails if either the
storm or the recovery shell comes back.

Loopback is brought up as well: nothing else in this guest did, so 127.0.0.1
was unreachable.

## Networking, and what `git clone https://…` needs

The guest gets a NIC from the emulator (virtio-net), DHCP from v86 itself, and
DNS + TCP through the relay URL set in Settings → v86 network (default
`wss://relay.widgetry.org/`). `/networking.sh` brings the card up; there is no
second network stack and no proxy inside the guest.

Two things mislead people here, so both are now handled in the guest itself:

1. **`ping` proves nothing.** v86 answers ICMP on its own virtual link; a ping
   reply arrives even with the relay switched off. `d86-net check` walks the
   chain that actually matters — interface, route, resolv.conf, a real DNS
   lookup, a real TLS connection — and stops at the first broken link.

2. **git's HTTPS transport is a separate program, and it now ships here.** The
   `git` binary has no TLS of its own (no curl, no OpenSSL — see the `git`
   bullet above), so it looks for `git-remote-https` in its exec path. That is
   `/usr/lib/git-core/git-remote-http` plus the alias, installed at boot, with
   the CA bundle it verifies against. `git clone https://github.com/owner/repo`
   is therefore a real clone: real history, real branches, no proxy. Before
   this existed, the same command died with `Unable to find remote helper for
   'https'` (or `repository '…' does not exist`) before a packet was sent.

`public/v86/scripts/` holds three files that the bridge (`src/bridge/v86.ts`,
`installGuestTools`) copies into the guest root at every boot, so they are
ordinary, editable files in Files:

| asset | guest path | what it is |
| --- | --- | --- |
| `networking.sh` | `/networking.sh` | DHCP for the emulated card (unchanged) |
| `d86-clone.sh` | `/usr/bin/d86-clone` | fetch a GitHub branch snapshot with busybox's TLS, unpack it, and make a one-commit repository with the guest's git |
| `d86-net.sh` | `/usr/bin/d86-net` | the honest connectivity check above |
| `guest-helpers.sh` | `/usr/share/d86/helpers.sh` | shell functions, sourced from a marked block appended to `/etc/profile`: `d86-clone`, `d86-net`, and a `git` wrapper that catches only `clone` with an http(s) URL |
| `guest-readme.txt` | `/usr/share/d86/README.guest` | the same explanation, readable from inside the guest |

`d86-clone` is a **snapshot import, not a clone**: it downloads GitHub's own
tarball for one branch (the endpoint behind "Download ZIP"), so you get the
current files and one commit, and `git log` shows no upstream history. It is
kept for repositories where only the files matter; for history, `git clone`
does the real thing now.
The script says so every time it runs rather than pretending the clone was
complete, and `--force` is required before it will pull a repository large
enough to threaten browser storage.

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

## The guest root lives in your files (`~/v86`)

`/` inside the guest **is** `~/v86`. Once per device, Dragon86 unpacks
this initramfs into `~/v86` (`src/bridge/guest-root.ts`: sorted by path,
directories before files, symlinks last, modes preserved) and drops a
marker, `~/v86/.dragon86-root.json` (`{v, at, initrdBytes, files}`).
`~/v86/boot/bzImage` and `~/v86/boot/initrd.gz` are the copies the
emulator actually boots from, so the distro's own kernel and userland are
ordinary files you can inspect in the Files app.

From then on everything the guest reads comes from that folder over 9p,
and everything the guest writes lands in it — edit `~/v86/etc/motd` in
Files and `cat /etc/motd` shows the change immediately, no sync step.
Only `bin`, `sbin` and `lib` are created as symlinks into `usr/` (and only
when the destination is empty), because the archive's root has no `bin`
directory of its own.

`~/v86/shared` is mounted as the guest's `/shared` and is your Files
folder (`createUnionFs` over the OS home), so `/shared` is the same place
you see in Files → Home. CheerpX gets the matching `~/CheerpX/shared`.

## The guest init (`tools/guest-init/init`)

`public/v86/initrd.gz` boots into an initramfs whose `/init` is built from
`tools/guest-init/init`; `tools/build-initrd.sh` bakes it in (it replaces
`/init` in a copy of the archive with `tools/initrd-append.py`). The
initramfs still exists because it is what the kernel is given, and it
holds the modules needed to reach the 9p device; all the *distro* files
are on the share.

`/init` does, in order:

1. mount `proc`, `sys`, `devtmpfs`, `devpts`;
2. size the serial console from the kernel cmdline (`d86cols`/`d86rows` —
   serial has no winsize channel, so the host passes the size in-band);
3. write `/etc/udhcpc.script` and ask for a DHCP lease in the background
   (v86 answers it itself; a missing relay never delays the shell);
4. `modprobe virtio_pci 9pnet_virtio`, wait for `/sys/bus/virtio/devices/virtio0`,
   then `mount -t 9p -o trans=virtio,version=9p2000.L,cache=loose host9p /newroot`;
5. `mkdir` the mount points the distro needs, bind `/proc`, `/sys`, `/dev`
   in and put tmpfs on `/tmp` and `/run` (a 9p root cannot be
   `pivot_root`ed into: `switch_root`'s `MS_MOVE` fails with `ENOSYS` on
   a 9p mount, so a `chroot` is what takes us across);
6. write the launcher `/.dragon86-shell` and `chroot` into it, respawning
   bash on ttyS0 if the session ends.

If the share never arrives (host is still unpacking, or the device has no
root), init falls back to a recovery shell **in the initramfs** that mounts
the share at `/shared` — the battery-included behaviour from before — so
a bad first boot shows a prompt, not a dead console.

Notes that cost real debugging time and are worth keeping:

- baked files need an explicit `chmod 755`, or `/init` dies with
  `Failed to execute /init (error -13)`;
- `Txattrwalk` must answer a *named* attribute with `ENODATA` (not a
  zero-length value). The kernel reads a 0-byte `security.capability` as
  corrupt and aborts every exec with `EINVAL`
  (`Invalid argument reading file caps for …` in `dmesg`). An *empty* name
  is `listxattr` and wants a zero-length value, or `ls -l` prints
  "No data available" for every file;
- the wire order for `Txattrwalk` is `fid, newfid, name` — the walk opens a
  second fid for the value;
- the 9p handler's path check has to treat a `/` root as `/`, not `//`.

## Full Arch Linux: removed

Earlier builds tried to boot the complete copy/v86 Arch image (an
`fs.json` file list plus content-addressed blobs, mirrored to an
`arch-image` branch because the origin refuses non-copy.sh referrers).
That guest never booted reliably and cost ~700 MB of vendored blobs, four
GitHub workflows and a per-device cache; it is all gone. This userland is
the engine instead: smaller, boots in seconds, and — unlike the streamed
image — its files are ordinary files in your filesystem. `networking.sh`
stays at `/networking.sh` in the guest root.

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
