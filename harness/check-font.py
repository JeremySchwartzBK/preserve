# Checks a font file someone uploaded for their Preserve and makes the web file the Preserve uses.
# It must be a font file, and the font named in it must be the one it replaces (by the family name in its name table,
# compared without spaces or case, on the longest word of the expected name, as "Malamocco" in "Malamocco Bold").
# Prints JSON: {"ok": true, "out": <woff2 path>, "family": ...} or {"ok": false, "problem": <words for the person>}.
# Usage: python3 check-font.py <file> <expected font name> <out.woff2>
import sys, re, json
from fontTools.ttLib import TTFont

path, expected, out = sys.argv[1:4]
squash = lambda s: re.sub(r'[^a-z0-9]', '', (s or '').lower())

def done(**r):
    print(json.dumps(r)); sys.exit(0)

try:
    f = TTFont(path)
except Exception:
    done(ok=False, problem='That isn’t a font file. Upload a .woff2, .woff, .otf or .ttf file.')
names = {squash(r.toUnicode()) for r in f['name'].names if r.nameID in (1, 4, 6, 16) and r.toUnicode().strip()} if 'name' in f else set()
word = squash(max(re.split(r'[\s_-]+', expected), key=len))
if word and not any(word in n for n in names):
    done(ok=False, problem=f'That file looks like a different font, so we kept what’s there. Upload a file of {expected}.')
family = next((r.toUnicode() for r in f['name'].names if r.nameID == 1), '')
f.flavor = 'woff2'
f.save(out)
done(ok=True, out=out, family=family)
