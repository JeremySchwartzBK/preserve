# Builds lookalike-pool.json: the open Google Fonts families google-fonts.py may pick as a lookalike, with each one's
# per-letter widths, x-height and cap height at weight 400 (per em). google-fonts.py measures the font being replaced
# the same way and picks the family whose letters run closest in width and height, so a condensed face gets a condensed
# lookalike, a wide one a wide one, a serif a serif. Re-run after editing POOL: python3 lookalike-pool.py
import io, json, re, urllib.request
from fontTools.ttLib import TTFont
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
CHARS = ' abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
POOL = {
 'sans': ['Inter', 'Work Sans', 'DM Sans', 'Manrope', 'Archivo', 'Barlow', 'Barlow Semi Condensed', 'Barlow Condensed',
          'Roboto Condensed', 'Archivo Narrow', 'Oswald', 'Antonio', 'Saira Condensed', 'Saira Extra Condensed',
          'Big Shoulders Display', 'Encode Sans Condensed', 'Encode Sans Semi Expanded', 'Encode Sans Expanded',
          'Space Grotesk', 'Poppins', 'Jost', 'Montserrat', 'Lexend', 'Syne', 'Familjen Grotesk', 'Instrument Sans',
          'Figtree', 'Red Hat Display', 'Outfit', 'Sora', 'Lato', 'Nunito Sans', 'Josefin Sans', 'Karla', 'Public Sans',
          'IBM Plex Sans', 'Mulish', 'Raleway', 'Albert Sans', 'Schibsted Grotesk', 'Hanken Grotesk', 'Rubik'],
 'serif': ['Source Serif 4', 'EB Garamond', 'Cormorant Garamond', 'Cormorant', 'Libre Caslon Text', 'Playfair Display',
           'Lora', 'Crimson Pro', 'Libre Bodoni', 'Fraunces', 'Newsreader', 'Spectral', 'Gelasio', 'Bodoni Moda',
           'Instrument Serif', 'DM Serif Display', 'Libre Baskerville', 'PT Serif', 'Cardo', 'Bitter', 'Noto Serif Display',
           'Petrona', 'Literata', 'Merriweather', 'Young Serif', 'Gloock', 'IBM Plex Serif', 'Prata', 'Marcellus'],
}

def measure(f):
    # Heights from the drawn x and H (fonts' own OS/2 heights are often missing or wrong).
    from fontTools.pens.boundsPen import BoundsPen
    cm, hm, upem, gs = f.getBestCmap(), f['hmtx'], f['head'].unitsPerEm, f.getGlyphSet()
    adv = {c: round(hm[cm[ord(c)]][0] / upem, 4) for c in CHARS if ord(c) in cm}
    def top(c):
        if ord(c) not in cm: return 0
        p = BoundsPen(gs); gs[cm[ord(c)]].draw(p)
        return round(p.bounds[3] / upem, 4) if p.bounds else 0
    return {'adv': adv, 'xh': top('x'), 'ch': top('H')}

def weights(fam):
    # The upright weights Google has for the family, so a site using Light and Bold gets a family that has both.
    from concurrent.futures import ThreadPoolExecutor
    def has(w):
        try: urllib.request.urlopen(urllib.request.Request(f'https://fonts.googleapis.com/css2?family={fam.replace(" ", "+")}:wght@{w}', headers={'user-agent': UA}), timeout=30).close(); return w
        except Exception: return None
    with ThreadPoolExecutor(9) as ex: return [w for w in ex.map(has, range(100, 1000, 100)) if w]

if __name__ == '__main__':
    out = {}
    for kind, fams in POOL.items():
        for fam in fams:
            css = urllib.request.urlopen(urllib.request.Request('https://fonts.googleapis.com/css2?family=' + fam.replace(' ', '+') + ':wght@400', headers={'user-agent': UA}), timeout=30).read().decode()
            u = [re.search(r'url\((\S+?)\)', b).group(1) for l, b in re.findall(r'/\* (\S+) \*/\s*@font-face\s*{([^}]*)}', css) if l == 'latin'][0]
            out[fam] = {'kind': kind, **measure(TTFont(io.BytesIO(urllib.request.urlopen(u, timeout=30).read()))), 'weights': weights(fam)}
            print(fam, out[fam]['xh'], out[fam]['ch'])
    json.dump(out, open('lookalike-pool.json', 'w'), separators=(',', ':'))
