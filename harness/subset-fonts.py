# Shrinks large web fonts in an exported copy to the characters the copy uses (plus ASCII and common punctuation).
# A copy is frozen, so its text never changes; kosa's 213 KB display font drops to a fraction of that.
# Usage: python3 subset-fonts.py <outRoot>/<site>
import sys, os, re, html, glob, subprocess
site = sys.argv[1]
text = set()
for f in ('desktop.html', 'mobile.html'):
    h = open(os.path.join(site, f), encoding='utf8').read()
    h = re.sub(r'<(script|style)[^>]*>.*?</\1>', ' ', h, flags=re.S)
    body = html.unescape(re.sub(r'<[^>]+>', ' ', h))
    attrs = ' '.join(html.unescape(v) for v in re.findall(r'(?:alt|placeholder|value|aria-label|title)="([^"]*)"', h))
    text.update(body + attrs)
# CSS generated content, e.g. content: "→"
for css in glob.glob(os.path.join(site, 'a', '*.css')) + [os.path.join(site, 'desktop.html'), os.path.join(site, 'mobile.html')]:
    for m in re.findall(r'content:\s*"([^"]*)"', open(css, encoding='utf8', errors='ignore').read()):
        text.update(re.sub(r'\\([0-9a-fA-F]{1,6})\s?', lambda e: chr(int(e.group(1), 16)), m).replace('\\', ''))
text.update(chr(c) for c in range(0x20, 0x7f))
text.update('‘’“”–—…•·©®™°€£×→←↑↓ ')
text.update(''.join(text).upper() + ''.join(text).lower())
tf = os.path.join(site, '.subset-text.txt'); open(tf, 'w', encoding='utf8').write(''.join(sorted(text)))
saved = 0
for f in glob.glob(os.path.join(site, 'a', '*')):
    ext = f.rsplit('.', 1)[-1]
    if ext not in ('woff2', 'woff', 'ttf', 'otf') or os.path.getsize(f) < 30000: continue
    out = f + '.sub'
    r = subprocess.run([sys.executable, '-m', 'fontTools.subset', f, f'--text-file={tf}', '--layout-features=*', '--flavor=' + ('woff2' if ext in ('woff2', 'ttf', 'otf') else 'woff'), '--no-hinting', '--desubroutinize', f'--output-file={out}'], capture_output=True, text=True)
    if r.returncode == 0 and os.path.exists(out) and os.path.getsize(out) < os.path.getsize(f):
        saved += os.path.getsize(f) - os.path.getsize(out); print(os.path.basename(f), os.path.getsize(f) // 1024, '->', os.path.getsize(out) // 1024, 'KB'); os.replace(out, f)
    elif os.path.exists(out): os.remove(out)
os.remove(tf)
print('saved', saved // 1024, 'KB')
