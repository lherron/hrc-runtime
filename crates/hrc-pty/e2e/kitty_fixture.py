#!/usr/bin/env python3
"""A pty child that leaves two Kitty images on screen, then waits (E2).

Image 7 is placed at a cell (a=p with the cursor there). Image 8 gets a
virtual placement (a=p,U=1) shown through U+10EEEE placeholder cells whose
foreground colour carries the image id and whose diacritics carry row/column.
"""
import base64
import sys
import time

# Kitty's rowcolumn-diacritics table, first entries (index = row or column).
DIACRITICS = [0x0305, 0x030D, 0x030E, 0x0310, 0x0312, 0x033D, 0x033E, 0x033F,
              0x0346, 0x034A, 0x034B, 0x034C]


def rgba(width, height, colour):
    """A gradient over one base colour, so a screenshot shows it plainly."""
    out = bytearray()
    for y in range(height):
        for x in range(width):
            k = (x + y) / (width + height)
            out += bytes([int(colour[0] * (0.4 + 0.6 * k)), int(colour[1] * (0.4 + 0.6 * k)),
                          int(colour[2] * (0.4 + 0.6 * k)), 255])
    return bytes(out)


def transmit(image_id, width, height, pixels):
    data = base64.b64encode(pixels)
    chunks = [data[i:i + 4096] for i in range(0, len(data), 4096)]
    out = b""
    for n, chunk in enumerate(chunks):
        more = 1 if n + 1 < len(chunks) else 0
        keys = f"a=t,f=32,s={width},v={height},i={image_id},q=2,m={more}" if n == 0 else f"m={more},q=2"
        out += b"\x1b_G" + keys.encode() + b";" + chunk + b"\x1b\\"
    return out


def main():
    w = sys.stdout.buffer
    w.write(b"\x1b[2J\x1b[H")
    w.write(b"kitty fixture: image 7 positioned at row 3 col 5; image 8 virtual (U=1) at row 10 col 5\r\n")
    w.write(transmit(7, 64, 32, rgba(64, 32, (255, 120, 0))))
    w.write(b"\x1b[3;5H\x1b_Ga=p,i=7,p=1,c=8,r=4,C=1,q=2\x1b\\")
    w.write(transmit(8, 48, 24, rgba(48, 24, (0, 160, 255))))
    w.write(b"\x1b_Ga=p,U=1,i=8,p=2,c=6,r=3,q=2\x1b\\")
    for row in range(3):
        w.write(f"\x1b[{10 + row};5H\x1b[38;5;8m".encode())
        cells = "".join(chr(0x10EEEE) + chr(DIACRITICS[row]) + chr(DIACRITICS[col]) for col in range(6))
        w.write(cells.encode("utf-8") + b"\x1b[39m")
    w.write(b"\x1b[16;1Hfixture ready\r\n")
    w.flush()
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
