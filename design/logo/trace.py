"""Trace the owl drawing into design/logo/owl.svg.

The owl was drawn by an image model (the source PNG lives in ../branding/source/). This script crops it,
scales it up so the threshold falls between pixels, smooths it slightly and traces the dark shape with
potrace. White parts (the face, the gaps between the wing feathers) become holes. Coordinates are in the
drawing's pixels.

Usage (from the repository root):
  uv run --with potracer --with numpy python design/logo/trace.py ../branding/source/owl.png
Then run design/logo/build.py and design/logo/export.py.
"""

import pathlib
import subprocess
import sys

import numpy as np
import potrace

HERE = pathlib.Path(__file__).parent
SRC = pathlib.Path(sys.argv[1])
SCALE = 4
# Specks smaller than this many source pixels are dropped.
SPECK = 4
# A slight blur before the threshold smooths the drawing's ragged edges (about 0.75 source pixels).
BLUR = 3


def gray(src):
    """The drawing cropped to the owl with a small margin, scaled up, as an array of grey levels."""
    prep = ["magick", str(src), "-colorspace", "gray", "-fuzz", "10%", "-trim", "+repage",
            "-bordercolor", "white", "-border", "4", "-resize", f"{SCALE * 100}%", "-blur", f"0x{BLUR}"]
    w, h = map(int, subprocess.run([*prep, "-format", "%w %h", "info:"], capture_output=True, text=True, check=True).stdout.split())
    raw = subprocess.run([*prep, "-depth", "8", "gray:-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(h, w)


def pt(p):
    return f"{p.x / SCALE:.2f} {p.y / SCALE:.2f}"


def main():
    curves = potrace.Bitmap(gray(SRC)).trace(turdsize=SPECK * SCALE * SCALE, alphamax=1.0, opticurve=True, opttolerance=0.5)
    d = []
    for curve in curves:
        d.append(f"M{pt(curve.start_point)}")
        for s in curve:
            d.append(f"L{pt(s.c)}L{pt(s.end_point)}" if s.is_corner else f"C{pt(s.c1)} {pt(s.c2)} {pt(s.end_point)}")
        d.append("Z")
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg">\n'
           f"<!-- Traced from {SRC.name} by design/logo/trace.py. Do not edit by hand. -->\n"
           f'<path fill-rule="evenodd" d="{"".join(d)}"/>\n</svg>\n')
    (HERE / "owl.svg").write_text(svg)
    print(f"{len(curves)} contours, {len(svg)} bytes")


main()
