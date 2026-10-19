# Fonts from Squarespace's own font library come from Google Fonts instead (Jeremy, 2026-10-19: copies never reuse
# Squarespace's files). Squarespace's free library is Google Fonts families, all under open licenses, re-hosted on its
# CDN (file.squarespace-cdn.com/.../fonts/libraries/sqsp/...). For each such file the page loaded, this finds the family,
# weight, style and character subset (from the page's @font-face rules, else the file's own name table), downloads the
# same face from Google Fonts, and records it in <siteDir>/fonts-google.json. server.mjs serves those files in place of
# Squarespace's, and serves nothing for a face Google doesn't have, so the copy never falls back to Squarespace's file;
# the quality check flags the missing family. Each family's license (OFL text with its copyright line, or Apache) is
# kept with it and shipped in the copy by export-static.mjs.
#
# Runs after capture; the raw capture is left untouched. Usage: python3 google-fonts.py <siteDir>
import sys, os, re, json, glob, hashlib, urllib.request, urllib.parse, urllib.error
from fontTools.ttLib import TTFont

LIBRARY = re.compile(r'/fonts/libraries/sqsp/')
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

def cmap(path):
    try: return set(TTFont(path).getBestCmap() or {})
    except Exception: return set()

manifest = json.load(open(os.path.join(site, 'manifest.json')))
wanted = {u.split('?')[0]: e for u, e in manifest.items() if u.startswith('http') and LIBRARY.search(u) and e.get('file')}
result = {'fonts': {}, 'missing': [], 'licenses': {}}
if not wanted:
    json.dump(result, open(os.path.join(site, 'fonts-google.json'), 'w'), indent=1); print('no library fonts'); sys.exit(0)

# Where the page declared each library file: stylesheets, inline styles in the page, and the rendered page.
declared = {}
texts = [os.path.join(site, 'raw', e['file']) for e in manifest.values() if e.get('file') and re.search(r'css|html', e.get('ct') or '')]
texts += glob.glob(os.path.join(site, 'rendered-*.html')) + [os.path.join(site, 'server.html')]
for p in texts:
    try: css = open(p, encoding='utf8', errors='ignore').read()
    except OSError: continue
    if 'libraries/sqsp' not in css: continue
    for f in faces(css):
        for u in f['urls']:
            if LIBRARY.search(u): declared.setdefault(u.split('?')[0], f)

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

os.makedirs(OUT, exist_ok=True)
for family, urls in need.items():
    tuples = {(1 if f['style'] == 'italic' else 0, f['weight']) for f in urls.values()}
    gfaces = []
    try: gfaces = faces(google_css(family, tuples))
    except urllib.error.HTTPError:
        # One weight or style Google doesn't have makes the whole request fail; ask for each on its own.
        for t in tuples:
            try: gfaces += faces(google_css(family, {t}))
            except urllib.error.HTTPError: pass
    except Exception as ex:
        for u in urls: result['missing'].append({'url': u, 'family': family, 'reason': f'Google Fonts unreachable: {ex}'})
        continue
    for u, f in urls.items():
        same = [g for g in gfaces if g['style'] == f['style'] and g['weight'] == f['weight']]
        # Variable families: Google may answer a single weight with a face covering a range.
        if not same: same = [g for g in gfaces if g['style'] == f['style'] and ' ' in g['weight'] and float(g['weight'].split()[0]) <= float(f['weight'].split()[0]) <= float(g['weight'].split()[-1])]
        if not same:
            result['missing'].append({'url': u, 'family': family, 'weight': f['weight'], 'style': f['style'], 'reason': 'not on Google Fonts'}); continue
        pick = next((g for g in same if f['label'] and g['label'] == f['label']), None)
        if not pick and f['range']: pick = next((g for g in same if ranges(g['range']) == ranges(f['range'])), None)
        if not pick: pick = max(same, key=lambda g: len(ranges(g['range']) & f['cmap']) if g['range'] else len(f['cmap']))
        src = next(x for x in pick['urls'] if x.startswith('https://fonts.gstatic.com/'))
        body = get(src, text=False)
        name = hashlib.sha1(body).hexdigest()[:12] + '.' + src.rsplit('.', 1)[-1]
        open(os.path.join(OUT, name), 'wb').write(body)
        result['fonts'][u] = {'family': family, 'weight': f['weight'], 'style': f['style'], 'subset': pick['label'], 'file': name, 'ct': 'font/' + name.rsplit('.', 1)[-1], 'source': src,
                              'lacks': len(f['cmap'] - cmap(os.path.join(OUT, name)))}  # characters Squarespace's file had and Google's doesn't
    if any(v['family'] == family for v in result['fonts'].values()):
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
print(f"{len(result['fonts'])} library fonts from Google Fonts ({', '.join(sorted(result['licenses']))}); {len(result['missing'])} missing")
for m in result['missing']: print('MISSING', m.get('family'), m.get('weight', ''), m.get('style', ''), m['reason'])
