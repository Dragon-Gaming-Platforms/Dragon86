# SuperTux PS2 sample image

Dragon86's sample is built from the PS2 port maintained at
[`headshot2017/supertux-ps2`](https://github.com/headshot2017/supertux-ps2), pinned
at commit `5c6ddb17d0d893f7bc85409c0750f374e5bf137e`. The repository identifies
the project as GPL-2.0 and includes the GPL text, author credits, and game-data
credits. The ISO packaging step uses only that checkout, adds a PS2 `SYSTEM.CNF`, and
applies the small `tools/supertux-ps2-ps2sdk-ports.patch` to add the PS2SDK SDL
header include directory and explicit LZMA/gsKit/DMAKit link dependencies
required by the pinned toolchain. It does not use a
retail game, BIOS, or externally sourced game assets. The patch is included
both on disc and beside the source archive in the release.

The build workflow is `.github/workflows/build-supertux-ps2-iso.yml`. It runs
when that workflow (or its ISO packaging helper) is pushed, builds the PS2 ELF
with the versioned PS2DEV toolchain, packages an ISO9660 CD image, and passes
the image through the pinned PS2-Web-Recomp `port.sh` flow. Release publication
is limited to successful runs on `main`. The release carries the original ISO,
SHA-256, notices, and a source archive of the exact SuperTux PS2 revision.
Generated recompiler output is never published.

The recompiler check tests whether the image can be consumed and built by that
workflow. It does not claim the game is fully playable or tested on physical
PS2 hardware. The upstream code and assets remain under their upstream license;
see `COPYING.TXT`, `AUTHORS.TXT`, and `data/CREDITS` on the disc and the
corresponding source archive in the release.
