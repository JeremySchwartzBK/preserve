# Replaces personal contact details in a copy with obvious placeholders, so hosting a copy never republishes someone's
# email address, phone number or mailing address. Layout is kept: a placeholder takes the place of the original text.
#   jeremy@mycompany.com           -> name@yourcompany.com (Jeremy, 2026-10-15: never keep the original domain)
#   (718) 555-1234 / tel: links    -> (555) 555-0100, same punctuation
#   262 Starr St, Brooklyn NY 11237 -> 123 Main Street, Anytown NY 12345 (street and city lines are swapped separately,
#                                     so addresses split over several lines keep their shape)
#   UK, Canada, Australia, Europe   -> 123 Main Street + a placeholder postcode in the local shape (AB1 2CD, A1A 1A1,
#                                     Anytown NSW 1234, 12345 Anytown). A bare town or country name is left alone.
# Postcodes it can see but can't place (anything left after the rewrite) are reported, not guessed at.
# Usage: python3 pii.py <file.html> [original URL]   (prints what it would change; scrub.py applies it)
import re, sys, html as H
from urllib.parse import urlparse

EMAIL = re.compile(r'(?<![\w.+-])([A-Za-z0-9._%+-]+)(@|\s*[\[(]\s*at\s*[\])]\s*)([A-Za-z0-9-]+(?:(?:\.|\s*[\[(]\s*dot\s*[\])]\s*)[A-Za-z0-9-]+)*(?:\.|\s*[\[(]\s*dot\s*[\])]\s*)([A-Za-z]{2,24}))\b', re.I)
IMG_EXT = re.compile(r'^(png|jpe?g|gif|webp|svg|avif|js|css|woff2?|ttf|otf)$', re.I)
PHONE = re.compile(r'(?<![\w/#.=-])(\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?([\s.\- ]{0,2})([2-9]\d{2})([\s.\- ])(\d{4})(?![\w-])')
INTL_PHONE = re.compile(r'(?<![\w/#.=-])\+(?!1\b)(\d{1,3})((?:[\s.\- ]?\(?\d{1,5}\)?){2,6})(?![\w-])')
SUFFIX = r'(?:St|Street|Ave|Av|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Pl|Place|Ct|Court|Ter|Terrace|Cir|Circle|Pkwy|Parkway|Hwy|Highway|Sq|Square|Plaza|Broadway|Bowery|Row|Trail|Pike|Alley|Loop|Yard|Mews|Close|Gardens|Crescent|Grove|Walk|Rise|Wharf|Quay|Parade|Gate)'
STREET = re.compile(r'\b\d{1,6}[A-Za-z]?(?:-\d{1,5})?\s+(?:[NSEW]\.?\s+|North\s+|South\s+|East\s+|West\s+)?(?:(?:[A-Z0-9][\w\'.-]*\s+){1,4}' + SUFFIX + r'|Broadway|Bowery)\b\.?(?:\s*(?:,\s*)?(?:#|Apt\.?|Suite|Ste\.?|Unit|Fl\.?|Floor|Rm\.?|Room)\s*[\w-]+)?(?:\s+(?:N|S|E|W|NE|NW|SE|SW)\b\.?)?')
STATES = {'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA','Colorado':'CO','Connecticut':'CT','Delaware':'DE','Florida':'FL','Georgia':'GA','Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS','Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD','Massachusetts':'MA','Michigan':'MI','Minnesota':'MN','Mississippi':'MS','Missouri':'MO','Montana':'MT','Nebraska':'NE','Nevada':'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK','Oregon':'OR','Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD','Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT','Virginia':'VA','Washington':'WA','West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY','District of Columbia':'DC'}
ABBR = '|'.join(sorted(set(STATES.values())))
FULL = '|'.join(sorted(STATES, key=len, reverse=True))
# "Brooklyn, NY 11237", "Brooklyn NY 11237", "Los Angeles, California 90012", "New York, NY, 10001"
CITY = re.compile(r'\b((?:[A-Za-z][\w\'.-]*\s){0,3}[A-Za-z][\w\'.-]*)(,?\s+)(' + FULL + r'|' + ABBR + r')\b(,?\s*)(\d{5})(?:-\d{4})?\b')
UK_POST = re.compile(r'\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b')
CA_POST = re.compile(r'\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b')
AU_CITY = re.compile(r'\b((?:[A-Z][\w\'-]*\s){0,2}[A-Z][\w\'-]*)(,?\s+)(NSW|VIC|QLD|SA|WA|TAS|ACT|NT)(,?\s+)(\d{4})\b')
# European streets: "Körnerstr. 19", "Prinsengracht 263", "12 rue de Rivoli", "Via Roma 5"
EU_STREET = re.compile(r'\b[\wÀ-ſ-]+(?:str\.|stra(?:ss|ß)e|weg|gasse|platz|allee|damm|laan|straat|gracht|kade|gade|vej|gatan|vägen)\s*\d+[a-z]?\b'
                       r'|\b\d{1,4}[a-z]?,?\s+(?:rue|avenue|av\.|boulevard|bd|place|chemin|allée|quai|impasse)\s+(?:de\s+la\s+|des\s+|du\s+|de\s+l\'|de\s+|d\')?[\wÀ-ſ\'-]+(?:\s+[\wÀ-ſ\'-]+){0,3}'
                       r'|\b(?:via|viale|piazza|corso|calle|avenida|plaza|paseo|rua|carrer)\s+(?:[\wÀ-ſ\'-]+\s+){1,4}\d{1,4}\b', re.I)
NL_CITY = re.compile(r'\b\d{4}\s?[A-Z]{2}\s+[A-ZÀ-Þ][\wÀ-ſ-]+\b')
EU_CITY = re.compile(r'\b(\d{4,5})\s+([A-ZÀ-Þ][\wÀ-ſ-]+)\b')
# Left over after the rewrite: postcodes in a shape we don't place; reported so the quality check can hold the copy.
FOREIGN = re.compile(r'\b(?:[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}|[A-Z]\d[A-Z]\s\d[A-Z]\d)\b'
                     r'|\b[\wÀ-ſ-]+(?:str\.|stra(?:ss|ß)e|weg|gasse|platz|laan|straat|gade|vej|rue|via|calle|avenida)\s*\d+[a-z]?\b'
                     r'|\b(?:rue|via|calle|avenida|avenue|boulevard)\s[\wÀ-ſ\' -]{2,40},?\s*\d{4,5}\b', re.I)
# Map blocks carry the exact spot as coordinates; zero them so the copy can't place the business on a map.
COORD = re.compile(r'(&quot;|")(mapLat|mapLng|markerLat|markerLng|lat|lng|latitude|longitude)\1\s*:\s*(?:\1)?-?\d+\.\d+(?:\1)?')

EMAIL_TO = 'name@yourcompany.com'

def site_domain(url, site=''):
    host = (urlparse(url).hostname or '') if url else ''
    host = re.sub(r'^www\.', '', host)
    if not host or re.search(r'squarespace\.com$', host):  # never put a Squarespace address in a copy
        label = (host.split('.')[0] if host else site) or 'example'
        return re.sub(r'^hello-world-', '', label) + '.com'
    return host

def make(domain):
    found = []
    def email(m):
        if IMG_EXT.match(m.group(4)) or re.match(r'^\d+x$', m.group(3).split('.')[0]): return m.group(0)
        found.append(('email', m.group(0)))
        return EMAIL_TO
    def phone(m):
        found.append(('phone', m.group(0)))
        # Keep the original punctuation; swap the digits for the reserved fictional 555-0100 number.
        new = iter(['555', '555', '0100'])
        lead = len(m.group(1) or '')
        return m.group(0)[:lead] + re.sub(r'\d+', lambda d: next(new), m.group(0)[lead:])
    def intl(m):
        digits = re.sub(r'\D', '', m.group(2))
        if len(digits) < 7: return m.group(0)
        found.append(('phone', m.group(0)))
        return '+' + m.group(1) + re.sub(r'\d', '0', m.group(2))
    def street(m):
        found.append(('address', m.group(0)))
        return '123 Main Street'
    def city(m):
        found.append(('address', m.group(0)))
        st = 'New York' if m.group(3) in STATES else 'NY'
        return 'Anytown' + m.group(2) + st + m.group(4) + '12345'
    def text(t):
        t = EMAIL.sub(email, t)
        t = PHONE.sub(phone, t); t = INTL_PHONE.sub(intl, t)
        t = STREET.sub(street, t); t = CITY.sub(city, t)
        def sub(rx, to, t):
            def f(m): found.append(('address', m.group(0))); return to(m) if callable(to) else to
            return rx.sub(f, t)
        t = sub(UK_POST, 'AB1 2CD', t); t = sub(CA_POST, 'A1A 1A1', t)
        t = sub(AU_CITY, lambda m: 'Anytown' + m.group(2) + m.group(3) + m.group(4) + '1234', t)
        had_eu = bool(EU_STREET.search(t))
        t = sub(EU_STREET, '123 Main Street', t)
        # A European postcode + town: rewritten next to a street, or when it is a whole line on its own.
        if (had_eu or NL_CITY.fullmatch(t.strip())) and NL_CITY.search(t): t = sub(NL_CITY, '1234 AB Anytown', t)
        # On its own line only a 5-digit postcode counts (4 digits alone looks like a year: "2024 Squad").
        elif had_eu or re.fullmatch(r'\d{5}\s+[A-ZÀ-Þ][\wÀ-ſ-]+', t.strip()): t = sub(EU_CITY, '12345 Anytown', t)
        for f in FOREIGN.findall(t):
            if f not in ('AB1 2CD', 'A1A 1A1'): found.append(('unhandled-address', f))
        return t
    return text, email, found

def strip(h, domain):
    text, email, found = make(domain)
    out, pos = [], 0
    # Walk tags and text. Text outside <script>/<style> gets every rule; attributes that people read (alt, title,
    # aria-label, placeholder, value, content) get every rule too; links get email and phone rules.
    for m in re.finditer(r'<(script|style)\b[^>]*>.*?</\1\s*>|<!--.*?-->|<[^>]+>', h, flags=re.S | re.I):
        out.append(text(h[pos:m.start()])); tag = m.group(0); pos = m.end()
        if m.group(1):
            # Kept owner scripts and JSON can carry addresses too; only emails are safe to rewrite inside code.
            tag = EMAIL.sub(email, tag)
        elif not tag.startswith('<!--'):
            if COORD.search(tag): found.append(('map', 'coordinates')); tag = COORD.sub(lambda c: c.group(1) + c.group(2) + c.group(1) + ':0', tag)
            def attr(a):
                v = H.unescape(a.group(2)); v2 = text(v)
                return a.group(0) if v2 == v else a.group(1) + H.escape(v2, quote=True) + a.group(3)
            tag = re.sub(r'(\s(?:alt|title|aria-label|placeholder|value|content|data-[\w-]+)=")([^"]*)(")', attr, tag)
            tag = re.sub(r'href="mailto:[^"]*"', 'href="mailto:' + EMAIL_TO + '"', tag, flags=re.I)
            tag = re.sub(r'href="tel:[^"]*"', 'href="tel:+15555550100"', tag, flags=re.I)
            tag = re.sub(r'href="sms:[^"]*"', 'href="sms:+15555550100"', tag, flags=re.I)
        out.append(tag)
    out.append(text(h[pos:]))
    return ''.join(out), found

if __name__ == '__main__':
    f = sys.argv[1]; d = site_domain(sys.argv[2] if len(sys.argv) > 2 else '', f.split('/')[-2] if '/' in f else '')
    _, found = strip(open(f, encoding='utf8', errors='ignore').read(), d)
    for k, v in sorted(set(found)): print(k, '|', v.strip()[:100])
