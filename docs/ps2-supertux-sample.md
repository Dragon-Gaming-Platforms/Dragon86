# SuperTux PS2 sample image

Dragon86's sample is built from the PS2 port maintained at
[`headshot2017/supertux-ps2`](https://github.com/headshot2017/supertux-ps2), pinned
at commit `5c6ddb17d0d893f7bc85409c0750f374e5bf137e`. The repository identifies
the project as GPL-2.0 and includes the GPL text, author credits, and game-data
credits. The ISO packaging step uses only that checkout, adds a PS2 `SYSTEM.CNF`, and
applies the small `tools/supertux-ps2-ps2sdk-ports.patch` to add the PS2SDK SDL
header include directory and explicit LZMA/gsKit/DMAKit link dependencies
required by the pinned toolchain. It does not use a
retail game or BIOS. The patch is included on disc and in the source archive
when a release is authorized.

The build workflow is `.github/workflows/build-supertux-ps2-iso.yml`. It runs
when that workflow (or its ISO packaging helper) is pushed, builds the PS2 ELF
with the versioned PS2DEV toolchain, packages an ISO9660 CD image, and passes
the image through the pinned PS2-Web-Recomp `port.sh` flow. The build and conversion check run on pushes, but ISO/source artifacts are not
uploaded as CI artifacts. Release publication is additionally gated on the
repository variable `SUPERTUX_ASSET_REDISTRIBUTION_APPROVED` being set to
`true` after rights for every bundled asset are documented. The GPL-2.0 source
license alone does not establish those rights. Generated recompiler output is
never published. Until that review is complete, the sample ISO download is
withheld.

The recompiler check tests whether the image can be consumed and built by that
workflow. It does not claim the game is fully playable or tested on physical
PS2 hardware. The upstream code and assets remain under their respective upstream licenses;
see `COPYING.TXT`, `AUTHORS.TXT`, and `data/CREDITS` in the source checkout.
These notices are provenance, not independent proof that every asset may be
redistributed in a compiled ISO.
