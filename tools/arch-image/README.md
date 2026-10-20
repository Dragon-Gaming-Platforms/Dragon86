# Hosting the full Arch Linux image for Dragon86

Dragon86's **v86 (compatibility)** engine normally boots a small
hand-built root filesystem: Arch's kernel, bash, GNU coreutils and now
git. That keeps the download small, but it is not an Arch *installation*
— no pacman, no systemd, no package database.

This directory holds everything needed to serve the **real** copy/v86
Arch image from its own GitHub Pages repo, on the same
`dragon-gaming-platforms.github.io` domain, so Dragon86's 1 GB site is
untouched.

## Why it is not just "download arch.img"

copy/v86's Arch demo has no disk image at all. It boots with

    root=host9p rootfstype=9p

and v86 serves the entire root filesystem over 9p from a flat HTTP
store:

- `fs.json` — the whole directory tree: `[name, size, mtime, mode, uid,
  gid, children-or-blob]`
- `arch/<hash>.bin[.zst]` — one file per unique blob, named after the
  first 10 hex digits of its sha256

v86 fetches blobs lazily as the guest touches them, so the browser never
downloads the full tree — only what it runs.

So "hosting the image" means publishing those two things.

## Steps

1. Create an empty public repo, e.g.
   `Dragon-Gaming-Platforms/Dragon86-arch-image`.

2. Copy these two files into it:

   - `mirror.py` (this folder) → `mirror.py`
   - `mirror.yml` (this folder) → `.github/workflows/mirror.yml`

3. Settings → Pages → **Source: GitHub Actions**.

4. Actions → *Mirror Arch image* → **Run workflow**. It downloads
   `fs.json` and every blob (a few hundred MB), checks the total against
   GitHub's 1 GB Pages cap, and deploys.

5. The image lands at:

       https://dragon-gaming-platforms.github.io/Dragon86-arch-image/fs.json
       https://dragon-gaming-platforms.github.io/Dragon86-arch-image/arch/

   Tell Dragon86 that URL and the v86 engine can boot
   `root=host9p` against it.

## Running it locally instead

    pip install nothing-needed
    python3 mirror.py site          # resumable: SKIP_EXISTING=1 python3 mirror.py site
    # then publish site/ however you like

## Caveats

- **Size.** Unknown until the first run; upstream lists Arch as
  "15+ MB" on its start page, but a real rootfs is far larger. The
  script stops at 950 MB rather than let a Pages deploy fail silently.
- **Speed.** A 9p root over HTTP is slower than our initramfs: every
  new binary touches the network once. Expect a boot measured in
  minutes on a phone.
- **Memory.** The upstream demo runs this with 512 MB of guest RAM;
  ours runs at 128 MB. That likely needs raising for a full rootfs.
- **`/shared`.** v86 has a single 9p device, so a `root=host9p` boot
  cannot simultaneously serve Dragon86's live Files folder. Making both
  work means teaching `src/bridge/p9.ts` to merge the two trees — the
  next step once the image exists.
