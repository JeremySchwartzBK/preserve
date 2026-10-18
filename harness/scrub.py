# Removes what's left of Squarespace from an exported copy, so the files hold no Squarespace addresses at all:
# - unresolved links (fallback font formats, icons we never captured) -> dropped
# - @font-face rules for fonts the page never uses -> dropped (Squarespace ships every theme font)
# - CSS comments, JSON metadata blocks, and attributes that only told Squarespace's scripts where to load things
# - personal contact details (emails, phone numbers, mailing addresses, map coordinates) -> placeholders (pii.py)
# Usage: python3 scrub.py <outRoot>/<site> [original URL]
import sys, os, re, glob
site = sys.argv[1]
orig_url = sys.argv[2] if len(sys.argv) > 2 else ''
SQ = re.compile(r'squarespace|sqspcdn|typekit|/frozen-opt/', re.I)
FACE = re.compile(r'@font-face\s*\{[^}]*\}', re.I)
URL = re.compile(r'url\(\s*([\'"]?)([^\'")]*)\1\s*\)', re.I)
bad = lambda u: bool(SQ.search(u)) or u.startswith('http') or u.startswith('//')

css_files = glob.glob(os.path.join(site, 'a', '*.css'))
htmls = [os.path.join(site, f) for f in ('desktop.html', 'mobile.html')]
read = lambda f: open(f, encoding='utf8', errors='ignore').read()
# Families the page actually refers to (anywhere outside @font-face rules, including CSS variables and inline styles).
usage = ' '.join(FACE.sub(' ', read(f)) for f in css_files + htmls).lower()

def fix_face(m):
    rule = m.group(0)
    fam = re.search(r'font-family\s*:\s*([\'"]?)([^;\'"}]+)\1', rule, re.I)
    if fam and fam.group(2).strip().lower() not in usage: return ''
    src = re.search(r'src\s*:([^;}]*)', rule, re.I)
    if src:
        parts = [p for p in re.split(r',(?![^(]*\))', src.group(1)) if not any(bad(u[1]) for u in URL.findall(p))]
        if not parts: return ''
        rule = rule[:src.start(1)] + ','.join(parts) + rule[src.end(1):]
    return rule

def scrub_css(css):
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
    css = FACE.sub(fix_face, css)
    return URL.sub(lambda m: 'none' if bad(m.group(2)) else m.group(0), css)

before = after = 0
for f in css_files:
    t = read(f); n = scrub_css(t); before += len(SQ.findall(t)); after += len(SQ.findall(n))
    open(f, 'w', encoding='utf8').write(n)
for f in htmls:
    h = read(f); before += len(SQ.findall(h))
    h = re.sub(r'<script[^>]*type="application/(?:ld\+)?json"[^>]*>.*?</script>', '', h, flags=re.S)
    h = re.sub(r'(<style[^>]*>)(.*?)(</style>)', lambda m: m.group(1) + scrub_css(m.group(2)) + m.group(3), h, flags=re.S)
    h = re.sub(r'style="([^"]*)"', lambda m: 'style="' + URL.sub(lambda u: 'none' if bad(u.group(2).replace('&quot;', '')) else u.group(0), m.group(1)) + '"', h)
    # Attributes still naming Squarespace (data-block-css, data-src, links to squarespace.com...): links go nowhere, the rest go.
    h = re.sub(r'\s(href)="[^"]*(?:squarespace|sqspcdn)[^"]*"', r' \1="#"', h, flags=re.I)
    h = re.sub(r'\s(?!class=|id=|href=)([\w:-]+)="[^"]*(?:squarespace\.com|squarespace-cdn|sqspcdn|/frozen-opt/)[^"]*"', '', h, flags=re.I)
    after += len(SQ.findall(h))
    open(f, 'w', encoding='utf8').write(h)
print('squarespace/typekit mentions', before, '->', after)

# A copy is a preview, never a stand-in for the real site: keep it out of search engines and drop everything that points
# search engines or social cards at it as the original. The robots tag lives in the page itself so it still applies when
# the files are self-hosted somewhere without our response headers.
ROBOTS = 'noindex, nofollow, noarchive, nosnippet, noimageindex'
def unlist(h):
    h = re.sub(r'<link\b[^>]*\brel="(?:canonical|alternate|shortlink|image_src|amphtml|manifest|me|search)"[^>]*>', '', h, flags=re.I)
    # Verification tags would let the original's owner claim our host in Search Console and similar tools.
    h = re.sub(r'<meta\b[^>]*\b(?:name|property)="(?:robots|googlebot|bingbot|description|keywords|author|generator|[\w.-]*verif[\w.-]*|p:domain_verify|msvalidate\.01|og:[^"]*|twitter:[^"]*|fb:[^"]*|article:[^"]*)"[^>]*>', '', h, flags=re.I)
    h = re.sub(r'<meta\b[^>]*\bitemprop="[^"]*"[^>]*>', '', h, flags=re.I)
    h = re.sub(r'<script[^>]*type="application/(?:ld\+)?json"[^>]*>.*?</script>', '', h, flags=re.S)
    h = re.sub(r'(<head\b[^>]*>)', r'\1<meta name="robots" content="' + ROBOTS + '">', h, count=1, flags=re.I)
    # The tab names it as a preview, so a shared link can't be mistaken for the site itself.
    h = re.sub(r'<title>(.*?)</title>', lambda m: '<title>' + (m.group(1).strip() + ' · ' if m.group(1).strip() else '') + 'Preview copy</title>', h, count=1, flags=re.S | re.I)
    return h
for f in htmls:
    h = read(f)
    if 'name="robots" content="' + ROBOTS in h: continue  # already done (scrub.py rerun)
    open(f, 'w', encoding='utf8').write(unlist(h))

# Very large inline SVGs (designforward has a 1.6 MB traced logo) make the page itself slow to arrive. When one is
# self-contained (no currentColor, CSS variables or classes the page styles), move it to its own cached file shown
# with <img>, with coordinates rounded to 2 decimals (invisible at any screen size).
import hashlib, subprocess
def svg_out(m):
    s = m.group(0)
    if len(s) < 50000 or re.search(r'currentColor|var\(|class=|<style|<script|<use|<foreignObject', s): return s
    s2 = re.sub(r'(\d+\.\d{2})\d+', r'\1', s)
    if 'xmlns=' not in s2[:300]: s2 = s2.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"', 1)
    name = hashlib.sha1(s2.encode()).hexdigest()[:12] + '.svg'
    open(os.path.join(site, 'a', name), 'w', encoding='utf8').write(s2)
    # Still huge (traced artwork with thousands of points): a 2800 px wide image looks the same and is a tiny fraction.
    if len(s2) > 200000:
        web = name.replace('.svg', '.webp')
        r = subprocess.run(['node', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'raster-svg.mjs'), os.path.join(site, 'a', name), os.path.join(site, 'a', web), '2800'], capture_output=True, text=True)
        if r.returncode == 0: os.remove(os.path.join(site, 'a', name)); name = web
    attrs = re.match(r'<svg([^>]*)>', s).group(1)
    w = re.search(r'\swidth="([^"]+)"', attrs); st = re.search(r'\sstyle="([^"]*)"', attrs)
    style = 'display:block;' + ('width:' + w.group(1) + ';' if w and w.group(1).endswith('%') else '') + 'height:auto;max-width:100%;' + (st.group(1) if st else '')
    vb = re.search(r'viewBox="[\d.\s-]*?\s([\d.]+)\s+([\d.]+)"', attrs)
    ratio = f'aspect-ratio:{vb.group(1)}/{vb.group(2)};' if vb else ''
    print('  svg', len(s) // 1024, 'KB ->', name, len(s2) // 1024, 'KB')
    return f'<img src="a/{name}" alt="" decoding="async" style="{style}{ratio}">'
for f in htmls:
    h = read(f); h2 = re.sub(r'<svg\b.*?</svg>', svg_out, h, flags=re.S)
    if h2 != h: open(f, 'w', encoding='utf8').write(h2)

# Personal contact details: emails -> name@yourcompany.com, phones -> (555) 555-0100, addresses -> 123 Main Street +
# a placeholder town/postcode in the local shape, map coordinates -> 0. Addresses it can't rewrite are listed as UNHANDLED so the quality check can
# hold the copy back instead of publishing them.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pii
dom = pii.site_domain(orig_url, os.path.basename(site.rstrip('/')))
PLACEHOLDER = re.compile(r'^(name@yourcompany\.com|\(?555|\+1[\s.-]?\(?555|123 Main Street|Anytown|AB1 2CD|A1A 1A1|1234 AB Anytown|12345 Anytown|\+\d+[0\s.()-]+$)')
counts, unhandled = {}, set()
for f in htmls:
    h = read(f); h2, found = pii.strip(h, dom)
    for kind, val in found:
        if PLACEHOLDER.match(val.strip()): continue
        counts[kind] = counts.get(kind, 0) + 1
        if kind == 'unhandled-address': unhandled.add(val.strip())
    if h2 != h: open(f, 'w', encoding='utf8').write(h2)
print('personal details replaced', counts or 'none')
for u in sorted(unhandled): print('  UNHANDLED address (not rewritten):', u)
