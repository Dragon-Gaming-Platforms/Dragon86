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

## Where the files go

Two files, **two different folders** — and no, they are not both at the
root:

| file in this folder | goes in the image repo at | why |
|---|---|---|
| `mirror.py`       | `mirror.py` (repo root)              | the workflow calls it as `python3 mirror.py site`, relative to the checkout root |
| `mirror.yml`      | `.github/workflows/mirror.yml`       | GitHub only runs workflows from that exact path |
| `README.md` (this) | optional, repo root as `README.md`  | documentation only |

Everything else is **created by the script**, not by you: `site/fs.json`
and `site/arch/*.bin` are generated during the run, inside the Actions
runner, and never committed. The repo itself stays two files and a few
KB.

Typing the hidden `.github/` path on github.com: *Add file → Create new
file*, then type `.github/workflows/mirror.yml` as the filename — the
slashes create the folders.

## Steps

1. Create an empty public repo, e.g.
   `Dragon-Gaming-Platforms/Dragon86-arch-image`. Let it initialise with a
   `main` branch (a README commit is enough) — Actions will not run in a
   repo with no commits.

2. Add the two files at the paths in the table above. You can drag-and-drop
   `mirror.py` into the repo root in the browser, or use git:

       git clone https://github.com/Dragon-Gaming-Platforms/Dragon86-arch-image
       cd Dragon86-arch-image
       cp <dragon86>/tools/arch-image/mirror.py .
       mkdir -p .github/workflows
       cp <dragon86>/tools/arch-image/mirror.yml .github/workflows/
       git add -A && git commit -m "Mirror the copy/v86 Arch image" && git push

3. Settings → Pages → **Source: GitHub Actions**.

4. Actions → *Mirror Arch image* → **Run workflow** (leave the source as
   `https://i.copy.sh/`). It downloads `fs.json` and every blob, checks the
   total against GitHub's 1 GB Pages cap, and deploys.

5. The image lands at:

       https://dragon-gaming-platforms.github.io/Dragon86-arch-image/fs.json
       https://dragon-gaming-platforms.github.io/Dragon86-arch-image/arch/

   Tell Dragon86 that URL and the v86 engine can boot
   `root=host9p` against it.

If step 4 fails on the first download with a 403/404 from
`i.copy.sh`, run it again with the `source` input set to
`https://copy.sh/v86/` (alternate mirror of the same store) — that is
the one thing about this pipeline I could not test from the build
sandbox, which has no route to copy.sh.

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
