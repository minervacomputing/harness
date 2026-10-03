"""Build the Minerva logo as flat, single-path SVG geometry.

The construction lives in design/logos.html (masks and strokes, easy to read);
this script flattens it with boolean operations so every exported file is one
plain path with no masks, clip paths, strokes or fonts.

Usage (from the repository root):
  uv run --with fonttools --with skia-pathops --with uharfbuzz python design/logo/build.py <Archivo[wdth,wght].ttf>
Writes design/logo/geometry.json. Run design/logo/export.py afterwards.
"""

import json
import pathlib
import sys

import pathops
import uharfbuzz as hb
from fontTools.pens.basePen import BasePen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

HERE = pathlib.Path(__file__).parent
FONT = pathlib.Path(sys.argv[1])

# --- the owl, on a 100-unit square (same numbers as design/logos.html) ---
def circ(cx, cy, r):
    return f"M{cx - r} {cy}A{r} {r} 0 1 0 {cx + r} {cy}A{r} {r} 0 1 0 {cx - r} {cy}Z"

DISC = circ(50, 50, 50)
OWL = "M50 22.6Q42 22.6 35 27.1L18.8 21.2L18.8 25Q19 31 24 34.7C19 40 18.5 52 22.5 59C17.5 64 16.5 72 17.6 77C18.5 83 21 88.5 24 93L30 108H70L76 93C79 88.5 81.5 83 82.4 77C83.5 72 82.5 64 77.5 59C81.5 52 81 40 76 34.7Q81 31 81.2 25L81.2 21.2L65 27.1Q58 22.6 50 22.6Z"
FACIAL = [circ(38, 47, 12), circ(62, 47, 12), "M26 47C26 54 34 58 40 61C45 63.5 48 65.5 50 68.8C52 65.5 55 63.5 60 61C66 58 74 54 74 47Z"]
EYES = [circ(38, 47, 5), circ(62, 47, 5)]
BEAK = "M50 63.8C46.5 59.5 45.5 56.5 45.5 54C45.5 51.3 47.5 49.4 50 49.4C52.5 49.4 54.5 51.3 54.5 54C54.5 56.5 53.5 59.5 50 63.8Z"
RULES = [f"M-20 {y}H120V{y + 2}H-20Z" for y in range(8, 81, 8)]
GAP = 2

# --- the name: Archivo Expanded ExtraBold capitals, cap height 34 on baseline 70 ---
NAME, WDTH, WGHT, TRACK, CAP, BASELINE, NAME_GAP = "MINERVA", 125, 800, 0.03, 34, 70, 26


def svg_path(d):
    path = pathops.Path()
    parse_path(d, path.getPen())
    return pathops.simplify(path)


def union(paths):
    out = pathops.Path()
    for p in paths:
        out = pathops.op(out, p, pathops.PathOp.UNION)
    return out


def minus(a, b):
    return pathops.op(a, b, pathops.PathOp.DIFFERENCE)


def both(a, b):
    return pathops.op(a, b, pathops.PathOp.INTERSECTION)


class _Pen(BasePen):
    """Rounds coordinates while drawing into an SVGPathPen."""

    def __init__(self, out, transform=(1, 0, 0, 1, 0, 0)):
        super().__init__(None)
        self.out = TransformPen(out, transform)

    def _moveTo(self, p): self.out.moveTo(p)
    def _lineTo(self, p): self.out.lineTo(p)
    def _curveToOne(self, a, b, c): self.out.curveTo(a, b, c)
    def _qCurveToOne(self, a, b): self.out.qCurveTo(a, b)
    def _closePath(self): self.out.closePath()


def to_d(path, transform=(1, 0, 0, 1, 0, 0)):
    pen = SVGPathPen(None, ntos=lambda v: f"{round(v, 2):g}")
    path.draw(_Pen(pen, transform))
    return pen.getCommands()


def bounds(path):
    pen = BoundsPen(None)
    path.draw(pen)
    return pen.bounds


def stroked(path, width):
    out = pathops.Path()
    path.draw(out.getPen())
    out.stroke(width, pathops.LineCap.BUTT_CAP, pathops.LineJoin.ROUND_JOIN, 4)
    out.convertConicsToQuads()
    return pathops.simplify(out)


def mark(rules):
    disc = svg_path(DISC)
    owl = svg_path(OWL)
    face = union(svg_path(d) for d in FACIAL)
    body = minus(both(owl, disc), face)
    details = union([*(svg_path(d) for d in EYES), svg_path(BEAK)])
    cut = union([owl, stroked(owl, GAP * 2)])
    if rules:
        cut = union([cut, *(svg_path(d) for d in RULES)])
    ground = minus(disc, cut)
    return union([ground, body, details]), union([body, details])


def name_path():
    font = TTFont(FONT)
    instance = instantiateVariableFont(font, {"wdth": WDTH, "wght": WGHT})
    glyphs = instance.getGlyphSet()
    cap = glyphs[instance.getBestCmap()[ord("H")]]
    cap_pen = BoundsPen(glyphs)
    cap.draw(cap_pen)
    scale = CAP / cap_pen.bounds[3]
    upm = instance["head"].unitsPerEm

    blob = hb.Blob.from_file_path(str(FONT))
    hb_font = hb.Font(hb.Face(blob))
    hb_font.set_variations({"wdth": WDTH, "wght": WGHT})
    buf = hb.Buffer()
    buf.add_str(NAME)
    buf.guess_segment_properties()
    hb.shape(hb_font, buf, {"kern": True})

    out, x = pathops.Path(), 0.0
    order = instance.getGlyphOrder()
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        glyph = pathops.Path()
        glyphs[order[info.codepoint]].draw(TransformPen(glyph.getPen(), (scale, 0, 0, -scale, x * scale, BASELINE)))
        out = pathops.op(out, pathops.simplify(glyph), pathops.PathOp.UNION)
        x += pos.x_advance + TRACK * upm
    return out


def main():
    ruled, owl = mark(rules=True)
    solid, _ = mark(rules=False)
    name = name_path()

    nx0, ny0, nx1, ny1 = bounds(name)
    # The name starts NAME_GAP units after the disc's edge, measured to its ink.
    dx = 100 + NAME_GAP - nx0
    ox0, oy0, ox1, oy1 = bounds(owl)

    geometry = {
        "note": "Generated by design/logo/build.py. Do not edit by hand.",
        "mark": {"viewBox": [0, 0, 100, 100], "ruled": to_d(ruled), "solid": to_d(solid)},
        "owl": {"viewBox": [round(ox0, 2), round(oy0, 2), round(ox1 - ox0, 2), round(oy1 - oy0, 2)], "d": to_d(owl)},
        "name": {
            "viewBox": [0, round(ny0, 2), round(nx1 - nx0, 2), round(ny1 - ny0, 2)],
            "d": to_d(name, (1, 0, 0, 1, -nx0, 0)),
            "inLockup": to_d(name, (1, 0, 0, 1, dx, 0)),
        },
        "lockup": {"viewBox": [0, 0, round(nx1 + dx, 2), 100]},
    }
    (HERE / "geometry.json").write_text(json.dumps(geometry, indent=2) + "\n")
    print("lockup width", round(nx1 + dx, 2), "| name ink", [round(v, 2) for v in (nx0, ny0, nx1, ny1)], "| owl", [round(v, 2) for v in (ox0, oy0, ox1, oy1)])


main()
