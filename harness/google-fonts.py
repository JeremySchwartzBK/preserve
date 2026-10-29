# Fonts from Squarespace's own font library come from Google Fonts instead (Jeremy, 2026-10-19: copies never reuse
# Squarespace's files). Squarespace's free library is Google Fonts families, all under open licenses, re-hosted on its
# CDN (file.squarespace-cdn.com/.../fonts/libraries/sqsp/...). For each such file the page loaded, this finds the family,
# weight, style and character subset (from the page's @font-face rules, else the file's own name table), downloads the
# same face from Google Fonts, and records it in <siteDir>/fonts-google.json. server.mjs serves those files in place of
# Squarespace's. A face Google doesn't have gets a lookalike from Google Fonts (noted on the copy); the copy never falls
# back to Squarespace's file, and only a face with neither is left out and flagged by the quality check. Each family's license (OFL text with its copyright line, or Apache) is
# kept with it and shipped in the copy by export-static.mjs.
#
# Every other font is sorted by who holds its license (Jeremy, 2026-10-19), and the result is kept as a record for the
# review's Fonts tab and the confirmation at Publish (fonts-google.json "record"):
#   anyone    open fonts: Squarespace's library (above), Google Fonts the page loaded itself. Hosted by us.
#   platform  Adobe fonts from Squarespace's font menu (use.typekit.net, on Squarespace's Adobe account). Their license is
#             Squarespace's, so the copy never ships Adobe's files: the same family from Google Fonts when it is an
#             open font Adobe also serves, else a lookalike from Google Fonts. The designer can bring their own license
#             at review.
#   designer  fonts the site owner uploaded (trials included). Kept as on the site, on the designer's word; the record
#             names them and carries the font's own copyright and license lines (and a trial hint) for the review.
#   other     fonts loaded from any other host (widget services). Kept; recorded so nothing is silent by accident.
# Squarespace's own icon font is not a font decision (own-css.mjs replaces it).
#
# Runs after capture; the raw capture is left untouched. Usage: python3 google-fonts.py <siteDir>
import sys, os, re, json, glob, hashlib, urllib.request, urllib.parse, urllib.error
from fontTools.ttLib import TTFont

LIBRARY = re.compile(r'/fonts/libraries/sqsp/')
ADOBE = re.compile(r'^https?://use\.typekit\.net/af/')
FONT_EXT = re.compile(r'\.(woff2?|ttf|otf|eot)$', re.I)
UPLOAD = re.compile(r'^https?://(static1\.squarespace\.com/static/|images\.squarespace-cdn\.com/content/|file\.squarespace-cdn\.com/content/)')
SQSP_UI = re.compile(r'^https?://assets\.squarespace\.com/universal/fonts/')
TRIAL = re.compile(r'\b(trial|demo|unlicensed|not for (commercial|web) use|non[- ]?commercial|personal use only|test font)\b', re.I)
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
site = sys.argv[1]
OUT = os.path.join(site, 'fonts-google')

def get(url, text=True):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'user-agent': UA}), timeout=30) as r:
        b = r.read()
    return b.decode('utf8') if text else b

def prop(block, name, default=None):
    m = re.search(r'(?:^|[;{\s])' + name + r'\s*:\s*([^;}]+)', block)
    return m.group(1).strip().strip('\'"') if m else default

def ranges(s):
    out = set()
    for part in (s or '').replace('U+', '').replace('u+', '').split(','):
        part = part.strip()
        if not part: continue
        if '?' in part: lo, hi = int(part.replace('?', '0'), 16), int(part.replace('?', 'F'), 16)
        elif '-' in part: lo, hi = (int(x, 16) for x in part.split('-'))
        else: lo = hi = int(part, 16)
        out.update(range(lo, hi + 1))
    return out

def faces(css):
    # [{family, weight, style, range, label, urls}]; label is Google's subset comment ("latin", "[12]").
    out = []
    for m in re.finditer(r'(?:/\*\s*([^*]+?)\s*\*/\s*)?@font-face\s*\{([^}]*)\}', css):
        b = m.group(2)
        out.append({'family': prop(b, 'font-family', ''), 'weight': prop(b, 'font-weight', '400').replace('normal', '400').replace('bold', '700'),
                    'style': 'italic' if 'italic' in prop(b, 'font-style', 'normal') or 'oblique' in prop(b, 'font-style', 'normal') else 'normal',
                    'range': prop(b, 'unicode-range'), 'label': m.group(1), 'urls': re.findall(r'url\(\s*[\'"]?([^\'")]+)', b)})
    return out

def label_of(url):
    # Squarespace names each file after Google's subset: latin.woff2, cyrillic-ext.woff2, dotgothic16-subset12.woff2 ([12]).
    n = url.split('?')[0].rsplit('/', 1)[-1].rsplit('.', 1)[0]
    m = re.search(r'-subset(\d+)$', n)
    return f'[{m.group(1)}]' if m else n

def from_file(path):
    f = TTFont(path)
    name = f['name']
    fam = name.getDebugName(16) or name.getDebugName(1)
    italic = bool(f['OS/2'].fsSelection & 1) or bool(f['head'].macStyle & 2)
    return {'family': fam, 'weight': str(f['OS/2'].usWeightClass), 'style': 'italic' if italic else 'normal', 'range': None, 'label': None}

def key(u):
    return u.split('?')[0].replace('http://', 'https://', 1)

def fvd(u):
    # Adobe's font URLs name the face in fvd: n4 = weight 400 normal, i7 = 700 italic.
    m = re.search(r'[?&]fvd=([ni])(\d)', u)
    return (str(int(m.group(2)) * 100), 'italic' if m.group(1) == 'i' else 'normal') if m else ('400', 'normal')

def name_lines(path):
    # The font's own words about itself: copyright, license and license URL, plus a trial hint from its names.
    try: n = TTFont(path)['name']
    except Exception: return {}
    lines = {k: n.getDebugName(i) for k, i in (('copyright', 0), ('license', 13), ('license_url', 14))}
    names = ' '.join(x for x in (n.getDebugName(i) for i in (0, 1, 3, 4, 13, 16)) if x)
    fam = n.getDebugName(16) or n.getDebugName(1)
    return {**{k: v.strip()[:500] for k, v in lines.items() if v}, **({'font_name': fam.strip()[:100]} if fam else {}), **({'trial_hint': True} if TRIAL.search(names) else {})}

def cmap(path):
    try: return set(TTFont(path).getBestCmap() or {})
    except Exception: return set()

manifest = json.load(open(os.path.join(site, 'manifest.json')))
wanted = {u.split('?')[0]: e for u, e in manifest.items() if u.startswith('http') and LIBRARY.search(u) and e.get('file')}
is_font = lambda u, e: bool(FONT_EXT.search(u.split('?')[0])) or 'font' in (e.get('ct') or '')
fonts_loaded = {u: e for u, e in manifest.items() if u.startswith('http') and e.get('file') and is_font(u, e) and not SQSP_UI.search(u)}
result = {'fonts': {}, 'missing': [], 'licenses': {}, 'record': []}
if not fonts_loaded and not any(ADOBE.search(u) for u in manifest):
    json.dump(result, open(os.path.join(site, 'fonts-google.json'), 'w'), indent=1); print('no fonts'); sys.exit(0)

# Where the page declared each font file: stylesheets, inline styles in the page, and the rendered page. Adobe's faces
# are taken from their @font-face rules even when the page never loaded the file (all of a face's URLs, so none is
# left pointing at Adobe).
declared = {}
adobe_faces = {}  # (family, weight, style) -> {urls}
page_texts = []
texts = [os.path.join(site, 'raw', e['file']) for e in manifest.values() if e.get('file') and re.search(r'css|html', e.get('ct') or '')]
texts += glob.glob(os.path.join(site, 'rendered-*.html')) + [os.path.join(site, 'server.html')]
for p in texts:
    try: css = open(p, encoding='utf8', errors='ignore').read()
    except OSError: continue
    page_texts.append(css)
    if '@font-face' not in css: continue
    for f in faces(css):
        for u in f['urls']:
            if not u.startswith('http'): continue
            declared.setdefault(key(u), f)
            if LIBRARY.search(u): declared.setdefault(u.split('?')[0], f)
            if ADOBE.search(u): adobe_faces.setdefault((f['family'], f['weight'], f['style']), set()).add(u)
for u in manifest:
    if ADOBE.search(u) and u.startswith('http') and not any(u in v for v in adobe_faces.values()):
        # A loaded Adobe file no rule names (a script added it): its face comes from the URL alone.
        w, st = fvd(u); adobe_faces.setdefault((None, w, st), set()).add(u)

need = {}  # family -> {url: face}
for u, e in wanted.items():
    raw = os.path.join(site, 'raw', e['file'])
    f = declared.get(u)
    if f: f = {**f, 'label': label_of(u)}
    else:
        try: f = {**from_file(raw), 'label': label_of(u)}
        except Exception as ex:
            result['missing'].append({'url': u, 'family': None, 'reason': f'unreadable font file: {ex}'}); continue
    f['cmap'] = cmap(raw)
    need.setdefault(f['family'], {})[u] = f

def google_css(family, tuples):
    spec = []
    for ital, w in sorted(tuples):
        spec.append(f'{ital},{w.replace(" ", "..")}')
    q = urllib.parse.urlencode({'family': f'{family}:ital,wght@' + ';'.join(spec), 'display': 'swap'})
    return get('https://fonts.googleapis.com/css2?' + q)

# A face Google doesn't have gets a lookalike from Google Fonts in its place (Jeremy, 2026-10-19), never Squarespace's
# file: an open-license family of the same kind, at the nearest weight it has. A stand-in until the curated lookalike
# list in fonts/font-flow-scenarios.md exists. family: (weights, has italic)
LOOKALIKES = {'sans': ('Inter', (100, 900), True), 'serif': ('Source Serif 4', (200, 900), True),
              'mono': ('Roboto Mono', (100, 700), True), 'script': ('Dancing Script', (400, 700), False),
              'pixel': ('Pixelify Sans', (400, 700), False)}

def kind_of(path, family):
    # What kind of face it is, from the most telling clue we have: its name, then how the site's styles list it (the
    # generic family after it, e.g. "'EB Garamond', serif"), then the font's own classification (often left blank).
    name = family.lower()
    if re.search(r'pixel|bitmap|8-?bit', name): return 'pixel'
    if re.search(r'mono|code|typewriter', name): return 'mono'
    if re.search(r'script|hand|brush|signature|callig', name): return 'script'
    if re.search(r'sans|grotesk|grotesque|gothic', name): return 'sans'
    if re.search(r'serif|garamond|goudy|didot|bodoni|baskerville|caslon|times|georgia|antiqua|roman', name): return 'serif'
    votes = {}
    for t in page_texts:
        for m in re.finditer(r'font-family\s*:\s*([^;}{]*)', t):
            stack = m.group(1).lower()
            if name not in stack: continue
            g = re.search(r'\b(sans-serif|serif|monospace|cursive)\b', stack[stack.index(name):])
            if g: votes[g.group(1)] = votes.get(g.group(1), 0) + 1
    if votes: return {'sans-serif': 'sans', 'serif': 'serif', 'monospace': 'mono', 'cursive': 'script'}[max(votes, key=votes.get)]
    try:
        f = TTFont(path)  # path None (a face we only know by name): no file to look at
        p = f['OS/2'].panose
        if f['post'].isFixedPitch or p.bProportion == 9: return 'mono'
        if p.bFamilyType == 3: return 'script'
        if p.bFamilyType == 2 and 2 <= p.bSerifStyle <= 10: return 'serif'
    except Exception: pass
    return 'sans'

def load(family, tuples):
    try: return faces(google_css(family, tuples))
    except urllib.error.HTTPError:
        # One weight or style Google doesn't have makes the whole request fail; ask for each on its own.
        out = []
        for t in tuples:
            try: out += faces(google_css(family, {t}))
            except urllib.error.HTTPError: pass
        return out

def take(family, gfaces, f, weight, style):
    same = [g for g in gfaces if g['style'] == style and g['weight'] == weight]
    # Variable families: Google may answer a single weight with a face covering a range.
    if not same: same = [g for g in gfaces if g['style'] == style and ' ' in g['weight'] and float(g['weight'].split()[0]) <= float(weight.split()[0]) <= float(g['weight'].split()[-1])]
    if not same: return None
    pick = next((g for g in same if f['label'] and g['label'] == f['label']), None)
    if not pick and f['range']: pick = next((g for g in same if ranges(g['range']) == ranges(f['range'])), None)
    if not pick: pick = max(same, key=lambda g: len(ranges(g['range']) & f['cmap']) if g['range'] else len(f['cmap']))
    src = next(x for x in pick['urls'] if x.startswith('https://fonts.gstatic.com/'))
    body = get(src, text=False)
    # Most files end in .woff2; some faces come back as /l/font?kit=... URLs, so the type is read from the file itself.
    ext = {b'wOF2': 'woff2', b'wOFF': 'woff', b'OTTO': 'otf'}.get(body[:4], 'ttf')
    name = hashlib.sha1(body).hexdigest()[:12] + '.' + ext
    open(os.path.join(OUT, name), 'wb').write(body)
    return {'family': family, 'weight': weight, 'style': style, 'subset': pick['label'], 'file': name, 'ct': 'font/' + name.rsplit('.', 1)[-1], 'source': src,
            'lacks': len(f['cmap'] - cmap(os.path.join(OUT, name)))}  # characters Squarespace's file had and Google's doesn't

def lookalike(u, f, path=None):
    kind = kind_of(os.path.join(site, 'raw', wanted[u]['file']) if u else path, f['family'])
    fam, (lo, hi), italic = LOOKALIKES[kind]
    w = str(min(hi, max(lo, round(float(f['weight'].split()[0]) / 100) * 100)))
    style = f['style'] if italic else 'normal'
    rec = take(fam, load(fam, {(1 if style == 'italic' else 0, w)}), f, w, style)
    if rec: rec.update(lookalike_for=f['family'], kind=kind)
    return rec

os.makedirs(OUT, exist_ok=True)
for family, urls in need.items():
    try:
        gfaces = load(family, {(1 if f['style'] == 'italic' else 0, f['weight']) for f in urls.values()})
        for u, f in urls.items():
            rec = take(family, gfaces, f, f['weight'], f['style']) or lookalike(u, f)
            if rec: result['fonts'][u] = rec
            else: result['missing'].append({'url': u, 'family': family, 'weight': f['weight'], 'style': f['style'], 'reason': 'no Google Fonts face or lookalike'})
    except Exception as ex:
        for u in urls:
            if u not in result['fonts']: result['missing'].append({'url': u, 'family': family, 'reason': f'Google Fonts unreachable: {ex}'})

for family, urls in need.items():
    for u, f in urls.items():
        r = result['fonts'].get(u)
        result['record'].append({'family': family, 'weight': f['weight'], 'style': f['style'], 'holder': 'anyone', 'source': 'squarespace-library',
                                 'action': ('lookalike' if r.get('lookalike_for') else 'from-google') if r else 'left-out', **({'served_as': r['family']} if r else {})})

# Adobe fonts from Squarespace's font menu. Curated stand-ins for the ones we see most, a starting point until the
# side-by-side review of the lookalike table (fonts/font-licensing.md) is done; any other gets a lookalike of its kind.
ADOBE_LOOKALIKES = {
    'proxima-nova': 'Montserrat', 'freight-sans-pro': 'Lato', 'acumin-pro': 'Inter', 'acumin-variable': 'Inter',
    'futura-pt': 'Jost', 'omnes-pro': 'Nunito', 'neue-haas-grotesk-display': 'Inter', 'neue-haas-grotesk-text': 'Inter',
    'aktiv-grotesk': 'Inter', 'adobe-garamond-pro': 'EB Garamond', 'minion-pro': 'Crimson Pro', 'din-2014': 'Barlow',
    'source-sans-pro': 'Source Sans 3', 'source-serif-pro': 'Source Serif 4', 'source-code-pro': 'Source Code Pro',
    'baskerville-display-pt': 'Libre Baskerville', 'brandon-grotesque': 'Josefin Sans', 'europa': 'Nunito Sans',
}
title = lambda slug: ' '.join(w if w.isdigit() else w.capitalize() for w in re.split(r'[-_ ]+', slug or '') if w)

def stand_in(gfam, weight, style, f):
    # The face at the asked weight, else the nearest weight Google has, upright if it has no italic.
    w0 = int(float(weight.split()[0]))
    tries = [(w, st) for st in dict.fromkeys([style, 'normal']) for w in sorted(range(100, 1000, 100), key=lambda w: (abs(w - w0), w))]
    for w, st in tries[:4] + tries[9:13]:
        rec = take(gfam, load(gfam, {(1 if st == 'italic' else 0, str(w))}), f, str(w), st)
        if rec: return rec
    return None

_open = {}
def open_family(family):
    # In Google's open catalog (its license is in github.com/google/fonts). Google Fonts also answers for some families
    # outside it (Proxima Nova comes back, served for Google's own use), so an answer alone doesn't make a font open.
    if family not in _open:
        slug = re.sub(r'[^a-z0-9]', '', family.lower())
        _open[family] = False
        for d in ('ofl', 'apache', 'ufl'):
            try: urllib.request.urlopen(urllib.request.Request(f'https://raw.githubusercontent.com/google/fonts/main/{d}/{slug}/METADATA.pb', headers={'user-agent': UA}), timeout=30).close(); _open[family] = True; break
            except Exception: pass
    return _open[family]

by_family = {}
for (family, weight, style), urls in adobe_faces.items():
    by_family.setdefault(family, []).append((weight, style, urls))
for family, faces_ in by_family.items():
    if family is None: family = 'unnamed Adobe font'
    for weight, style, urls in faces_:
        loaded = next((manifest[u] for u in urls if u in manifest and manifest[u].get('file')), None)
        path = os.path.join(site, 'raw', loaded['file']) if loaded else None
        f = {'family': family, 'weight': weight, 'style': style, 'range': None, 'label': 'latin', 'cmap': set()}
        rec, action = None, None
        try:
            gname = title(family)
            rec = take(gname, load(gname, {(1 if style == 'italic' else 0, weight)}), f, weight, style) if open_family(gname) else None
            if rec: action = 'open-equivalent'  # an open font Adobe also serves (Bebas Neue): the same family from Google
            elif ADOBE_LOOKALIKES.get(family):
                rec = stand_in(ADOBE_LOOKALIKES[family], weight, style, f); action = 'lookalike'
            if not rec:
                rec = lookalike(None, f, path); action = 'lookalike'
        except Exception as ex:
            rec = None; print('ADOBE', family, weight, style, ex)
        if rec:
            rec.update(adobe=True, **({'lookalike_for': family} if action == 'lookalike' else {}))
            for u in urls: result['fonts'][key(u)] = rec
        else:
            # Never Adobe's file: the face is left out and its text shows in the next font the site's styles list.
            result['missing'].append({'url': sorted(urls)[0], 'family': family, 'weight': weight, 'style': style, 'reason': 'Adobe font licensed to Squarespace; no lookalike'})
        result['record'].append({'family': family, 'weight': weight, 'style': style, 'holder': 'platform', 'source': 'adobe-via-squarespace',
                                 'action': action if rec else 'left-out', **({'served_as': rec['family']} if rec else {})})

# Everything else the page loaded: the owner's uploads (kept on the designer's word), Google Fonts the page linked
# itself (open), and fonts from other hosts. Served as captured; recorded with what the font says about itself.
for u, e in fonts_loaded.items():
    if LIBRARY.search(u) or ADOBE.search(u): continue
    path = os.path.join(site, 'raw', e['file'])
    f = declared.get(key(u))
    if f: fam, weight, style = f['family'], f['weight'], f['style']
    else:
        try: d = from_file(path); fam, weight, style = d['family'], d['weight'], d['style']
        except Exception: fam, weight, style = u.split('?')[0].rsplit('/', 1)[-1], '400', 'normal'
    host = re.sub(r'^https?://', '', u).split('/')[0]
    holder, source = ('designer', 'upload') if UPLOAD.search(u) else ('anyone', 'google') if host == 'fonts.gstatic.com' else ('other', host)
    # A lookalike for fonts kept on the designer's word, fetched now and shipped unused, so choosing "I don't have
    # rights to this one" at review swaps it in without rebuilding the Preserve (the viewer adds the swap).
    alt = None
    if holder != 'anyone':
        try:
            rec = lookalike(None, {'family': fam, 'weight': str(weight).replace('normal', '400').replace('bold', '700'), 'style': style, 'range': None, 'label': 'latin', 'cmap': set()}, path)
            if rec: alt = {'family': rec['family'], 'file': rec['file'], 'weight': rec['weight'], 'style': rec['style']}
        except Exception as ex: print('ALT', fam, weight, style, ex)
    result['record'].append({'family': fam, 'weight': weight, 'style': style, 'holder': holder, 'source': source, 'action': 'kept',
                             **(name_lines(path) if holder != 'anyone' else {}), **({'alt': alt} if alt else {})})

# One row per face: the same face can arrive as several files (subsets, formats).
seen, rows = set(), []
for r in result['record']:
    k = (r['holder'], r['family'], r['weight'], r['style'])
    if k not in seen: seen.add(k); rows.append(r)
result['record'] = rows

# Each family the copy uses ships with its license.
for family in sorted({v['family'] for v in result['fonts'].values()} | {r['alt']['family'] for r in result['record'] if r.get('alt')}):
    result['licenses'][family] = None
    slug = re.sub(r'[^a-z0-9]', '', family.lower())
    for d, f in (('ofl', 'OFL.txt'), ('apache', 'LICENSE.txt'), ('ufl', 'UFL.txt')):
        try: result['licenses'][family] = {'kind': d, 'text': get(f'https://raw.githubusercontent.com/google/fonts/main/{d}/{slug}/{f}').replace('\r\n', '\n')}; break
        except Exception: pass
    if not result['licenses'][family]:
        # The license text normally comes from Google's font repository; failing that, the font's own copyright and
        # license lines, which name the license and where to read it.
        any_file = next(v['file'] for v in result['fonts'].values() if v['family'] == family)
        n = TTFont(os.path.join(OUT, any_file))['name']
        result['licenses'][family] = {'kind': 'name-table', 'text': '\n'.join(x for x in (n.getDebugName(0), n.getDebugName(13), n.getDebugName(14)) if x)}

json.dump(result, open(os.path.join(site, 'fonts-google.json'), 'w'), indent=1)
for r in result['record']: print('FONT', r['holder'], r['family'], r['weight'], r['style'], r['action'], r.get('served_as', ''), 'TRIAL?' if r.get('trial_hint') else '')
print(f"{len(result['fonts'])} font files from Google Fonts ({', '.join(sorted(result['licenses']))}); {len(result['missing'])} missing")
for v in {(v['lookalike_for'], v['family']) for v in result['fonts'].values() if v.get('lookalike_for')}: print('LOOKALIKE', v[0], '->', v[1])
for m in result['missing']: print('MISSING', m.get('family'), m.get('weight', ''), m.get('style', ''), m['reason'])
