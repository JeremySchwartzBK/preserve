# Our own icon font, standing in for Squarespace's UI icon font (squarespace-ui-font: carousel arrows, close buttons,
# social and share icons drawn with ::before content). Every icon here is drawn by us from plain shapes; what we take
# from the original font is only layout: which code points exist, how wide each one is, and the box each icon fills,
# so text and spacing around the icons don't move.
# Usage: python3 icons.py <squarespace-ui-font file> <out.woff2>   -> prints JSON {drawn: [...], blank: [...]}
import sys, json, math
from fontTools.ttLib import TTFont
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.boundsPen import BoundsPen

# Shapes are drawn in a 100x100 box, y pointing down. A shape is (points, hole).
def poly(pts, hole=False): return [(list(pts), hole)]
def rect(x, y, w, h, hole=False): return poly([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], hole)
def circle(cx, cy, r, hole=False, n=48): return poly([(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)], hole)
def ring(cx, cy, r, w): return circle(cx, cy, r) + circle(cx, cy, r - w, True)
def line(a, b, w, hole=False):
    (x1, y1), (x2, y2) = a, b
    dx, dy = x2 - x1, y2 - y1; l = math.hypot(dx, dy) or 1; nx, ny = -dy / l * w / 2, dx / l * w / 2
    ex, ey = dx / l * w / 2, dy / l * w / 2  # square ends
    return poly([(x1 + nx - ex, y1 + ny - ey), (x2 + nx + ex, y2 + ny + ey), (x2 - nx + ex, y2 - ny + ey), (x1 - nx - ex, y1 - ny - ey)], hole)
def path(pts, w, hole=False): return [s for a, b in zip(pts, pts[1:]) for s in line(a, b, w, hole)]
def rot(shapes, deg, cx=50, cy=50):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [([(cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c) for x, y in pts], h) for pts, h in shapes]
def scale(shapes, k, cx=50, cy=50): return [([(cx + (x - cx) * k, cy + (y - cy) * k) for x, y in pts], h) for pts, h in shapes]
def holes(shapes): return [(p, True) for p, _ in shapes]
def heart(k=1.0, hole=False):
    pts = []
    for i in range(64):
        t = 2 * math.pi * i / 64
        x = 16 * math.sin(t) ** 3; y = -(13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t))
        pts.append((50 + x * 2.9 * k, 47 + y * 2.9 * k))
    return poly(pts, hole)

chevron = poly([(100, 15), (45, 50), (100, 85), (70, 100), (0, 50), (70, 0)])                      # pointing left
arrow = poly([(10, 50), (50, 14), (50, 36), (90, 36), (90, 64), (50, 64), (50, 86)])
small_arrow = scale(arrow, 0.5)
thin_chevron = path([(66, 6), (22, 50), (66, 94)], 5)
x_mark = rot(poly([(41, 10), (59, 10), (59, 41), (90, 41), (90, 59), (59, 59), (59, 90), (41, 90), (41, 59), (10, 59), (10, 41), (41, 41)]), 45)  # one outline, so it can also be cut out
info_i = circle(54, 18, 9) + poly([(40, 36), (62, 36), (52, 80), (64, 80), (62, 90), (34, 90), (44, 46), (36, 46)])

ICONS = {
    0xe000: chevron, 0xe003: rot(chevron, 180), 0xe006: rot(chevron, 90), 0xe009: rot(chevron, -90),
    0xe001: ring(50, 50, 48, 9) + small_arrow, 0xe004: ring(50, 50, 48, 9) + rot(small_arrow, 180),
    0xe007: ring(50, 50, 48, 9) + rot(small_arrow, 90), 0xe00a: ring(50, 50, 48, 9) + rot(small_arrow, -90),
    0xe002: arrow, 0xe005: rot(arrow, 180), 0xe008: rot(arrow, 90), 0xe00b: rot(arrow, -90),
    0xe00c: ring(50, 50, 48, 12) + path([(50, 22), (50, 52), (70, 64)], 11), 0xe00d: ring(50, 50, 48, 7) + path([(50, 18), (50, 52), (72, 74)], 7),
    0xe00e: poly([(6, 6), (52, 6), (94, 48), (50, 92), (6, 48)]) + circle(24, 24, 8, True),
    0xe00f: rot(poly([(6, 30), (60, 30), (90, 50), (60, 70), (6, 70)]) + circle(64, 50, 6, True), -35),
    0xe010: poly([(8, 2), (92, 2), (92, 72), (40, 72), (24, 98), (24, 72), (8, 72)]), 0xe011: poly([(4, 12), (96, 12), (96, 76), (56, 76), (40, 92), (40, 76), (4, 76)]),
    0xe012: heart(), 0xe013: heart() + heart(0.72, True),
    0xe014: [s for x in (10, 56) for y in (10, 56) for s in rect(x, y, 34, 34) + rect(x + 7, y + 7, 20, 20, True)],
    0xe015: rect(0, 14, 100, 86) + rect(12, 30, 76, 58, True) + rect(18, 0, 14, 22) + rect(68, 0, 14, 22),
    0xe016: scale(rot(rect(4, 34, 52, 32) + rect(14, 42, 32, 16, True) + rect(44, 34, 52, 32) + rect(54, 42, 32, 16, True), -45), 1.3),
    0xe017: circle(50, 50, 48) + holes(scale(info_i, 0.7)),
    0xe018: circle(50, 50, 46) + holes(scale(x_mark, 0.62)), 0xe023: circle(50, 50, 46) + holes(scale(x_mark, 0.62)),
    0xe019: path([(12, 52), (40, 80), (88, 18)], 20), 0xe01a: scale(x_mark, 1.2),
    0xe01b: (poly([(50 + 46 * math.cos(t / 20 * math.pi), 50 + 26 * math.sin(t / 20 * math.pi)) for t in range(40)]) + circle(50, 50, 18, True) + circle(50, 50, 10)),
    0xe01c: rect(14, 2, 72, 96) + rect(24, 12, 52, 76, True) + rect(32, 22, 36, 8) + rect(32, 44, 36, 8) + rect(32, 66, 36, 8),
    0xe01d: ring(50, 50, 48, 8) + poly([(74, 26), (58, 58), (26, 74), (42, 42)]) + circle(50, 50, 6, True),
    0xe01e: path([(4, 14), (50, 30), (96, 14), (96, 80), (50, 96), (4, 80), (4, 14)], 7) + rect(47, 30, 6, 66),
    0xe01f: ring(50, 50, 48, 8) + path([(44, 36), (30, 36), (24, 42), (24, 58), (30, 64), (44, 64)], 10) + path([(74, 36), (60, 36), (54, 42), (54, 58), (60, 64), (74, 64)], 10),
    0xe020: poly([(26, 4), (74, 4), (74, 94), (50, 72), (26, 94)]), 0xe021: info_i,
    0xe022: circle(18, 82, 12) + [s for k in (0, 1) for s in path([(6 + 0, 40 - 36 * k + 0)] + [(6 + (54 + 36 * k) * math.sin(a / 12 * math.pi / 2), 94 - (54 + 36 * k) * math.cos(a / 12 * math.pi / 2)) for a in range(13)], 12)],
    0xe024: rect(40, 6, 20, 88) + rect(6, 40, 88, 20), 0xe025: rect(6, 40, 88, 20),
    0xe026: rect(6, 14, 78, 80) + rect(18, 26, 54, 56, True) + poly([(52, 4), (96, 34), (52, 62), (52, 46), (34, 52), (36, 34), (52, 24)]),
    0xe027: poly([(10, 10), (40, 10), (46, 18), (90, 18), (90, 90), (10, 90)]),
    0xe028: poly([(4, 12), (32, 12), (40, 22), (80, 22), (80, 36), (22, 36), (4, 86)]) + poly([(24, 42), (96, 42), (78, 88), (6, 88)]),
    0xe029: rect(6, 14, 88, 16) + rect(6, 42, 88, 16) + rect(6, 70, 88, 16),
    0xe02a: rect(4, 8, 20, 20) + rect(4, 40, 20, 20) + rect(4, 72, 20, 20) + rect(34, 12, 62, 12) + rect(34, 44, 62, 12) + rect(34, 76, 62, 12),
    0xe02b: circle(24, 50, 15) + circle(76, 22, 15) + circle(76, 78, 15) + line((24, 50), (76, 22), 9) + line((24, 50), (76, 78), 9),
    0xe02c: thin_chevron, 0xe02d: rot(thin_chevron, 180), 0xe02e: line((5, 5), (95, 95), 9) + line((95, 5), (5, 95), 9),
    0xe02f: circle(50, 36, 34) + poly([(20, 54), (80, 54), (50, 100)]) + circle(50, 36, 14, True),
    0xe030: rect(0, 0, 100, 14) + rect(0, 43, 100, 14) + rect(0, 86, 100, 14), 0xe031: rect(0, 0, 100, 100) + rect(25, 25, 50, 50, True),
    0xf000: poly([(2, 2), (98, 98), (2, 98)]),
    0xf065: path([(20, 80), (80, 20)], 12) + poly([(56, 8), (92, 8), (92, 44)]) + poly([(8, 56), (8, 92), (44, 92)]),
    0xf066: path([(8, 92), (40, 60)], 12) + path([(60, 40), (92, 8)], 12) + poly([(26, 54), (46, 54), (46, 74)]) + poly([(54, 26), (54, 46), (74, 46)]),
}

def area(pts): return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1])) / 2

def main(src, out):
    f = TTFont(src)
    cmap = f.getBestCmap(); gs = f.getGlyphSet(); upm = f['head'].unitsPerEm
    order = ['.notdef'] + [f'u{c:04X}' for c in sorted(cmap)]
    glyphs, metrics, drawn, blank = {}, {}, [], []
    glyphs['.notdef'] = TTGlyphPen(None).glyph(); metrics['.notdef'] = (upm // 2, 0)
    for c in sorted(cmap):
        g = gs[cmap[c]]; bp = BoundsPen(gs); g.draw(bp)
        name = f'u{c:04X}'; pen = TTGlyphPen(None)
        if bp.bounds and c in ICONS:
            x0, y0, x1, y1 = bp.bounds
            for pts, hole in ICONS[c]:
                # Into the original icon's box (font units, y up). Outer shapes clockwise, holes the other way.
                q = [(x0 + x / 100 * (x1 - x0), y1 - y / 100 * (y1 - y0)) for x, y in pts]
                if (area(q) > 0) != hole: q = q[::-1]
                pen.moveTo(q[0]); [pen.lineTo(p) for p in q[1:]]; pen.closePath()
            drawn.append(hex(c))
        elif bp.bounds: blank.append(hex(c))
        gl = pen.glyph(); glyphs[name] = gl
        gl.recalcBounds(None)
        metrics[name] = (g.width, getattr(gl, 'xMin', 0) or 0)
    fb = FontBuilder(upm, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({c: f'u{c:04X}' for c in cmap})
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    hh = f['hhea']; fb.setupHorizontalHeader(ascent=hh.ascent, descent=hh.descent)
    fb.setupNameTable({'familyName': 'pv-icons', 'styleName': 'Regular'})
    os2 = f['OS/2'] if 'OS/2' in f else None
    fb.setupOS2(sTypoAscender=hh.ascent, sTypoDescender=hh.descent, usWinAscent=max(0, hh.ascent), usWinDescent=max(0, -hh.descent))
    fb.setupPost()
    fb.font.flavor = 'woff2'
    fb.save(out)
    print(json.dumps({'drawn': drawn, 'blank': blank}))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
