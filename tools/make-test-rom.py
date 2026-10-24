#!/usr/bin/env python3
"""Generate the NES test ROM that ships with the filesystem-app demo.

Why generate one instead of using a ROM from the internet: a ROM is someone's
copyrighted work, and this app is about files you own. This ROM is written
here, byte by byte, and does three things a smoke test needs:

  - sets a palette,
  - draws two lines of text from a hand-built 8x8 font (so a blank screen
    means the emulator is not rendering),
  - cycles the background colour every frame (so a frozen screen means the
    CPU/PPU are not ticking).

Mapper 0, 16 KiB PRG, 8 KiB CHR — the smallest legal NES cartridge layout.

    tools/make-test-rom.py public/system-apps/nes/test.nes
"""

import sys

# ---------------------------------------------------------------- font
# 5x7 glyphs, one string per row, '#' = ink. Only the characters the ROM
# prints, to keep it small and unambiguous.
FONT = {
    " ": ["     "] * 7,
    "A": [" ### ", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
    "D": ["#### ", "#   #", "#   #", "#   #", "#   #", "#   #", "#### "],
    "E": ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#####"],
    "F": ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#    "],
    "G": [" ####", "#    ", "#    ", "#  ##", "#   #", "#   #", " ####"],
    "I": ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "#####"],
    "K": ["#   #", "#  # ", "# #  ", "##   ", "# #  ", "#  # ", "#   #"],
    "L": ["#    ", "#    ", "#    ", "#    ", "#    ", "#    ", "#####"],
    "M": ["#   #", "## ##", "# # #", "#   #", "#   #", "#   #", "#   #"],
    "N": ["#   #", "##  #", "# # #", "#  ##", "#   #", "#   #", "#   #"],
    "O": [" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
    "R": ["#### ", "#   #", "#   #", "#### ", "# #  ", "#  # ", "#   #"],
    "S": [" ####", "#    ", "#    ", " ### ", "    #", "    #", "#### "],
    "T": ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "],
    "U": ["#   #", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
    "V": ["#   #", "#   #", "#   #", "#   #", "#   #", " # # ", "  #  "],
    "Y": ["#   #", "#   #", " # # ", "  #  ", "  #  ", "  #  ", "  #  "],
    "2": [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
    "6": [" ### ", "#    ", "#    ", "#### ", "#   #", "#   #", " ### "],
    "8": [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
}

LINES = [
    (11, "DRAGON86"),
    (14, "NES TEST"),
    (17, "RUNNING FROM YOUR FILES"),
]

# palette: universal background, then three background colours that cycle
PALETTE = [0x0F, 0x01, 0x11, 0x21] + [0x0F] * 12 + [0x0F] * 16


# ---------------------------------------------------------------- 6502
class Asm:
    """A hand-rolled two-pass assembler: just the opcodes this ROM uses."""

    def __init__(self):
        self.code = bytearray()
        self.labels = {}
        self.fixups = []  # (offset, label, kind)

    def at(self, label):
        self.labels[label] = len(self.code)

    def emit(self, *bs):
        self.code.extend(bs)

    # immediate / implied
    def lda_i(self, v): self.emit(0xA9, v & 0xFF)
    def ldx_i(self, v): self.emit(0xA2, v & 0xFF)
    def cpx_i(self, v): self.emit(0xE0, v & 0xFF)
    def sei(self): self.emit(0x78)
    def cld(self): self.emit(0xD8)
    def txs(self): self.emit(0x9A)
    def inx(self): self.emit(0xE8)
    def inc_zp(self, z): self.emit(0xE6, z)
    def sta_zp(self, z): self.emit(0x85, z)
    def lda_zp(self, z): self.emit(0xA5, z)
    def and_i(self, v): self.emit(0x29, v & 0xFF)
    def clc(self): self.emit(0x18)
    def adc_i(self, v): self.emit(0x69, v & 0xFF)
    def bit_abs(self, a): self.emit(0x2C, a & 0xFF, a >> 8)
    def sta_abs(self, a): self.emit(0x8D, a & 0xFF, a >> 8)
    def lda_abs_x(self, a): self.emit(0xBD, a & 0xFF, a >> 8)
    def sta_abs_x(self, a): self.emit(0x9D, a & 0xFF, a >> 8)
    def jmp(self, label):
        self.emit(0x4C, 0, 0)
        self.fixups.append((len(self.code) - 2, label, "abs"))
    def bne(self, label):
        self.emit(0xD0, 0)
        self.fixups.append((len(self.code) - 1, label, "rel"))
    def bpl(self, label):
        self.emit(0x10, 0)
        self.fixups.append((len(self.code) - 1, label, "rel"))

    def link(self, base):
        for off, label, kind in self.fixups:
            target = base + self.labels[label]
            if kind == "abs":
                self.code[off] = target & 0xFF
                self.code[off + 1] = (target >> 8) & 0xFF
            else:
                delta = target - (base + off + 1)
                assert -128 <= delta <= 127, f"branch to {label} out of range"
                self.code[off] = delta & 0xFF


def build():
    a = Asm()

    a.sei()
    a.cld()
    a.ldx_i(0xFF)
    a.txs()

    # wait for the PPU to finish powering up
    a.bit_abs(0x2002)
    a.at("wait0")
    a.bit_abs(0x2002)
    a.bpl("wait0")

    # rendering off while we touch VRAM
    a.lda_i(0x00)
    a.sta_abs(0x2000)
    a.sta_abs(0x2001)

    # palette: $3F00
    a.lda_i(0x3F)
    a.sta_abs(0x2006)
    a.lda_i(0x00)
    a.sta_abs(0x2006)
    a.ldx_i(0x00)
    a.at("pal")
    pal_read_at = len(a.code)
    a.emit(0xBD, 0x00, 0x00)  # LDA palette,X — address patched once layout is known
    a.sta_abs(0x2007)
    a.inx()
    a.cpx_i(len(PALETTE))
    a.bne("pal")

    # text, one row at a time straight into the nametable
    chars = [" "] + sorted(k for k in FONT if k != " ")
    index = {c: i for i, c in enumerate(chars)}
    for row, text in LINES:
        addr = 0x2000 + row * 32 + 12
        a.lda_i(addr >> 8)
        a.sta_abs(0x2006)
        a.lda_i(addr & 0xFF)
        a.sta_abs(0x2006)
        for ch in text:
            a.lda_i(index[ch])
            a.sta_abs(0x2007)

    # background on, no sprites, no clipping
    a.lda_i(0x0A)
    a.sta_abs(0x2001)
    a.lda_i(0x00)
    a.sta_abs(0x2000)

    # per-frame: wait for vblank, then cycle the three background colours
    a.at("loop")
    a.at("wait1")
    a.bit_abs(0x2002)
    a.bpl("wait1")
    a.inc_zp(0x00)
    a.lda_zp(0x00)
    a.and_i(0x0F)
    a.sta_zp(0x01)
    a.lda_i(0x3F)
    a.sta_abs(0x2006)
    a.lda_i(0x01)
    a.sta_abs(0x2006)
    a.lda_zp(0x01)
    a.sta_abs(0x2007)
    a.sta_abs(0x2007)
    a.sta_abs(0x2007)
    a.jmp("loop")

    base = 0xC000
    # resolve label references now that the code layout is final
    a.link(base)
    # the palette table lives on the second page of the PRG bank
    code_end = len(a.code)
    pal_addr = base + 0x200
    blob = bytes(a.code)
    blob = (
        blob[:pal_read_at]
        + bytes([0xBD, pal_addr & 0xFF, pal_addr >> 8])
        + blob[pal_read_at + 3 :]
    )

    assert code_end < 0x200, "code overflows its two-page budget"
    prg = bytearray(b"\xff" * 0x4000)
    prg[0:len(blob)] = blob
    prg[0x200 : 0x200 + len(PALETTE)] = bytes(PALETTE)

    # vectors (the 16 KiB bank is mirrored at $C000 and $8000, so one copy
    # of the vector table at the top of the bank is enough)
    prg[0x3FFA:0x3FFC] = bytes([0x00, 0xC0])  # NMI
    prg[0x3FFC:0x3FFE] = bytes([0x00, 0xC0])  # RESET
    prg[0x3FFE:0x4000] = bytes([0x00, 0xC0])  # IRQ

    # CHR: tile 0 blank, then one tile per glyph
    chr_rom = bytearray(0x2000)
    for i, ch in enumerate(chars):
        if ch == " ":
            continue
        rows = FONT[ch]
        for y in range(8):
            bits = 0
            if y < 7:
                for x, px in enumerate(rows[y]):
                    if px == "#":
                        bits |= 0x80 >> x
            chr_rom[i * 16 + y] = bits
            chr_rom[i * 16 + 8 + y] = 0  # no colour detail

    header = b"NES\x1a" + bytes([1, 1, 0, 0]) + bytes(8)
    return header + bytes(prg) + bytes(chr_rom)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "test.nes"
    rom = build()
    with open(out, "wb") as fh:
        fh.write(rom)
    print(f"wrote {out}: {len(rom)} bytes (16 KiB PRG + 8 KiB CHR)")


if __name__ == "__main__":
    main()
