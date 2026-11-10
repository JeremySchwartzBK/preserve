# Style measures of a face, read from its drawn letters, so a lookalike can match how a font looks and not only how
# wide it runs (myrtle-green, 2026-11-10: lookalikes fit the width but looked nothing alike). Shared by
# lookalike-pool.py (the pool's own measures, kept in lookalike-pool.json) and google-fonts.py (the font replaced).
#   serif:    how much wider the foot of an I (or l) is than its middle; about 1 for a sans, 1.5 and up with serifs
#   contrast: thinnest over thickest stroke of an o (or O); 1 for even strokes, near 0.2 for a Didone like Bodoni
#   stem:     the o's thick stroke over the H height; how heavy the face looks, whatever its weight is called
# Any measure the face can't give (a subset without those letters) is None, and simply isn't compared.
import io

SIZE = 400

def _render(font, ch):
    from PIL import Image, ImageDraw, ImageFont
    cm = font.getBestCmap()
    if ord(ch) not in cm: return None
    buf = io.BytesIO()
    f = font
    if getattr(f, 'flavor', None):
        from fontTools.ttLib import TTFont
        buf0 = io.BytesIO(); f.save(buf0); buf0.seek(0); f = TTFont(buf0); f.flavor = None
    f.save(buf); buf.seek(0)
    pf = ImageFont.truetype(buf, SIZE)
    l, t, r, b = pf.getbbox(ch)
    if r <= l or b <= t: return None
    im = Image.new('L', (r - l + 20, b - t + 20), 0)
    ImageDraw.Draw(im).text((10 - l, 10 - t), ch, font=pf, fill=255)
    return im

def _ink_rows(im):
    w, h = im.size; px = im.load()
    return [[x for x in range(w) if px[x, y] > 127] for y in range(h)]

def style_of(font):
    out = {'serif': None, 'contrast': None, 'stem': None}
    try:
        from copy import deepcopy
        font = deepcopy(font)
        for ch in 'Il':
            im = _render(font, ch)
            if not im: continue
            rows = [r for r in _ink_rows(im) if r]
            if len(rows) < 20: continue
            span = lambda r: r[-1] - r[0] + 1
            mid = span(rows[len(rows) // 2])
            foot = max(span(r) for r in rows[-max(2, len(rows) // 25):])
            if mid: out['serif'] = round(foot / mid, 3); break
        ch_h = None
        h = _render(font, 'H')
        if h: ch_h = sum(1 for r in _ink_rows(h) if r)
        for ch in 'oO':
            im = _render(font, ch)
            if not im: continue
            w, hgt = im.size; px = im.load()
            # Thick: the left stroke where the o is widest (its middle row); thin: the top stroke at its middle column.
            rows = [y for y in range(hgt) if any(px[x, y] > 127 for x in range(w))]
            cols = [x for x in range(w) if any(px[x, y] > 127 for y in range(hgt))]
            if not rows or not cols: continue
            y = (rows[0] + rows[-1]) // 2; x = (cols[0] + cols[-1]) // 2
            def run_x(y):
                xs = [x for x in range(w) if px[x, y] > 127]
                if not xs: return 0
                n = 0
                for xx in range(xs[0], w):
                    if px[xx, y] > 127: n += 1
                    else: break
                return n
            def run_y(x):
                ys = [y for y in range(hgt) if px[x, y] > 127]
                if not ys: return 0
                n = 0
                for yy in range(ys[0], hgt):
                    if px[x, yy] > 127: n += 1
                    else: break
                return n
            thick = max(run_x(yy) for yy in range(max(0, y - 3), min(hgt, y + 4)))
            thin = min(run_y(xx) or 9999 for xx in range(max(0, x - 3), min(w, x + 4)))
            if thick and thin < 9999:
                out['contrast'] = round(min(thin, thick) / max(thin, thick), 3)
                if ch_h: out['stem'] = round(thick / ch_h, 3)
                break
    except Exception:
        pass
    return out

def style_distance(a, b):
    # How different two faces look, from the measures both have (0 when nothing can be compared).
    import math
    d = 0.0
    if a.get('serif') and b.get('serif'): d += 1.2 * abs(math.log(a['serif'] / b['serif']))
    if a.get('contrast') and b.get('contrast'): d += 1.0 * abs(math.log(a['contrast'] / b['contrast']))
    if a.get('stem') and b.get('stem'): d += 0.8 * abs(math.log(a['stem'] / b['stem']))
    return d
