# Preserve capture prototype: harness

Research scripts that (1) time how fast a page's first screen looks finished, (2) capture a live Squarespace page,
(3) build four copy variants, (4) check what breaks, and (5) write a results table. Not product code.

Tested end to end on `mock-site/` (a small Squarespace-like page). Not yet run on the real sites: the first
environment had no outbound network access.

## Run it

### Domains the run needs

Needed (without these the run is invalid):

| domain | why |
|---|---|
| `www.minaab.com`, `www.breathpod.com`, `www.designforward.live`, `www.xanadu.nyc` | the test sites |
| `*.squarespace.com` (covers `hello-world-kosa.squarespace.com`, `assets.squarespace.com`, `static1.squarespace.com`) | the 5th site, plus every Squarespace site's CSS, scripts, and template files |
| `*.squarespace-cdn.com` (`images.squarespace-cdn.com`, `video.squarespace-cdn.com`) | all site images and background video |
| `*.sqspcdn.com` (`definitions.sqspcdn.com`) | Squarespace block definitions some templates load |
| `use.typekit.net`, `p.typekit.net` | Adobe fonts, used by most Squarespace templates |
| `fonts.googleapis.com`, `fonts.gstatic.com` | Google fonts, used by some templates |

Site-dependent (run `check-access.mjs`; add whatever it lists that a site uses visually, e.g.
`player.vimeo.com`, `i.vimeocdn.com`, `www.youtube.com`, `i.ytimg.com`, `cdn.shopify.com`, embed widgets).

Not needed: analytics, ad pixels, chat widgets, consent tools. Copies drop them anyway.

### What a narrow allowlist distorts

- **Squarespace CDN hosts missing:** the capture gets no CSS, scripts, or images. Originals render unstyled and
  copies are empty shells. Every number is meaningless. `check-access.mjs` will show `assets.squarespace.com`,
  `static1.squarespace.com`, or `images.squarespace-cdn.com` as failed.
- **Font hosts missing:** both the original and the copies fall back to system fonts. Timings look slightly
  better than reality and the copies don't keep the real typography, so pixel diffs say nothing about fonts.
- **Video/embed hosts missing:** hero videos and embeds show as blank in both the baseline and the copies.
- **Analytics/pixels/chat missing:** only the *original* baseline is affected. It loads a bit faster than for real
  visitors, so the speed-up we report for copies is understated (conservative). Copies are unaffected.

```bash
cp -r /mnt/project-files/prototype/harness ~/proto && cd ~/proto
npm ci                      # playwright 1.56 uses the preinstalled Chromium in /opt/pw-browsers
node check-access.mjs       # preflight: lists every host each site tried to reach that was blocked
# quick sanity check on one site, one run each:
node run-all.mjs --sites kosa --runs 1 --work ~/work
# the real run (5 sites x original + 4 copies x mobile/desktop x 3 cold loads; roughly 40-60 min):
node run-all.mjs --runs 3 --work ~/work
node summarize.mjs [outDir] # writes <outDir>/results.md and results.csv (default /mnt/project-files/prototype)
node compare.mjs ~/work <outDir>   # side-by-side full-page strips per site in <outDir>/compare/
```

Site keys: `minaab`, `breathpod`, `kosa`, `designforward`, `xanadu` (`--sites a,b`). `--variants frozen,opt-server`
limits copies. `--recapture` forces a new capture. `--url <url>` runs any single page as site `test`.
Mock: `python3 -m http.server 8099 -d mock-site` then `node run-all.mjs --url http://localhost:8099/ --runs 1 --out ./testout --work ./testwork`.

Behind the cloud agent proxy, Chromium is launched with `HTTPS_PROXY` and a loopback bypass (see `lib.mjs`).

## Changes after the first real run (2026-10-06)

- Profiles: added `mobile-4g` (same phone, 9 Mbps, 85ms; timing only). `--profiles` picks which run.
- Timing: recording continues 3s after the page settles; pixels still changing then (tickers, clocks, slideshows)
  are left out of "first screen ready" (`moving` column). Marketing overlays are hidden on originals too, so a
  popup that appears at 5s doesn't count as the page finishing. Browser cache is no longer disabled (each load uses
  a fresh browser), so preloads aren't downloaded twice; the copy server sends cacheable headers.
- Copies: animated GIFs become animated WebP in optimized variants; reCAPTCHA/tracking iframes are removed; the
  server tolerates sites whose own CSS glues two URLs together (xanadu's fonts).
- `debug-res.mjs <siteDir> <variant> <profile>` lists what a copy loads, biggest first.

## Video (2026-10-07)

- `video.mjs`: Squarespace video blocks and section background videos. Squarespace streams them as encrypted HLS and
  only starts its player when the browser plays H.264 (the preinstalled Chromium doesn't), so the capture reads each
  video's `alexandriaUrl` from the page, converts the stream with ffmpeg (first 60 s, no audio) and saves
  `preserve-1280.{mp4,webm,jpg}` and `preserve-640.{...}` in the manifest under the video's own CDN path.
  `capture.mjs` calls it; `node addvideos.mjs <siteDir>` adds videos to an older capture.
- `build.mjs` (scripts-free variants): points each `<video>` at those files (WebM then MP4, poster = first frame),
  `preload=none`, and a small script starts them after page load while on screen.
- `export.mjs`: packs the MP4 into single-file copies.
- Known limitations live in `/mnt/project-files/known-limitations.md`.

## What each file does

- `lib.mjs`: device/network profiles. Mobile: 390x844 @3x, Slow 4G (150ms RTT, 1.6 Mbps down), 4x CPU slowdown.
  Desktop: 1440x900, WebPageTest Cable (28ms, 5 Mbps). Overlay selectors (announcement bar, promo popup, cookie banner).
- `measure.mjs`: one cold browser per load, cache off, throttled via DevTools protocol. Records a screen video
  (screencast) and reports **vc95** (time the first screen is, and stays, 95% of the way to its final look), vc99,
  LCP, FCP, KB, requests. Median of N runs. Note: Chrome's throttling delays the response body, not headers, so TTFB
  is not meaningful; use the paint metrics.
- `capture.mjs`: loads the page at desktop and mobile widths, saves every response body, the server HTML, and the
  rendered DOM after scrolling through (lazy content loaded, scroll animations triggered, CSSOM rules serialized).
  Also downloads `?format=2500w` of every Squarespace CDN image so copies can make their own sizes. Saves reference
  screenshots with overlays hidden (`ref-*.png`) and as a visitor sees it (`orig-asis-*.png`).
- `server.mjs`: serves one capture and its copies from a single local origin. `/<variant>/x/<host>/<path>` is a
  captured asset with URLs rewritten to stay local; optimized variants get on-the-fly AVIF/WebP resizing for
  Squarespace image URLs (`?format=750w` etc, emulating an image CDN) and `font-display: swap`. Misses are logged.
- `build.mjs`: the four variants:
  - `frozen`: rendered DOM, every site script removed, assets as captured.
  - `frozen-opt`: frozen + first-screen optimizations (below). The speed ceiling with no site JavaScript.
  - `opt-rendered`: rendered DOM + only Squarespace look-and-feel scripts + optimizations. Tests whether
    Squarespace scripts survive running on an already-rendered page.
  - `opt-server`: original pre-JavaScript HTML + Squarespace look-and-feel scripts + optimizations. Lets Squarespace
    render as it normally would, from local files.
  All variants strip overlays (DOM removal + CSS hide + context flags), drop preconnects, and add a small "this is a
  preview copy" notice for links, forms, and add-to-cart. Script keep/drop rules are `DROP_SRC`/`DROP_INLINE`;
  each variant's decisions are saved as `screenshots/<site>/scripts-<variant>.json`.
- `atf.mjs`: first-screen pass for optimized variants: inline only the CSS rules that match first-screen (or hidden)
  elements, load full stylesheets without blocking, preload up to 4 fonts, give the hero image eager loading,
  `fetchpriority=high` and a preload.
- `check.mjs`: on the original and each copy: JS errors, overlays still visible, broken images, elements stuck
  invisible after scrolling (scroll animations that never ran), mobile menu opens, desktop dropdown opens, gallery
  "next" changes the gallery (autoplaying ones report `unknown`), replica notice on link click, outside requests,
  and pixel difference vs the original (first screen and full page).
- `run-all.mjs`: capture -> build -> measure -> check for each site; writes `result-<site>.json` and screenshots
  into `/mnt/project-files/prototype/`.
- `summarize.mjs`: `results.md` (tables per site/profile, plus notes on errors and missing files) and `results.csv`.

## Known limits

- Copies are served over local HTTP/1.1 with brotli; a real CDN with HTTP/2 or 3 would be a bit faster under latency.
- Originals include real server time over the container's network path; copies don't. Both get the same throttling.
- Critical CSS is a selector-match heuristic, not a full coverage tool; rules for JS-added first-screen elements can be
  missed, which shows up as a first-screen pixel diff.
- Font subsetting is not done yet (fonttools is installable if wanted).
- The gallery check screenshots the nearest gallery/carousel/slideshow ancestor of the "next" button; if there is
  none it compares the whole page, which can give a false "pass" (seen on the mock site's frozen copy).

## One-step copy job and quality check (2026-10-15)

`make-copy.mjs` turns a URL into a finished copy with no hand steps, then decides whether it may ship:

```bash
node make-copy.mjs https://www.example.com/ --id example --work ~/work --out ~/ready [--publish <pagesProject>]
```

Steps: check the URL is a reachable Squarespace page -> `capbuild.mjs` -> `export-static.mjs` -> `subset-fonts.py` ->
`scrub.py` -> `gate.mjs` -> (on pass) copy to `--out`, optionally `publish.mjs`. Progress and the outcome are written to
`<work>/<id>/job.json`: state `working`, `ready`, `needs-review` (the check found problems; the user still reviews
the copy, sees the findings and may keep it, per Jeremy 2026-10-15) or `failed` (couldn't copy at all: not
Squarespace, unreachable, job error). Every check failure appends a line to `<work>/gaps.jsonl`. Exit code 0 ready,
2 needs-review, 1 failed. About 2-4 minutes per site.

The job is shaped around pages (2026-10-18): each page gets a page task (capture, build, export) and the copy then gets
one finishing pass (`link-pages.mjs` when there is more than one page, fonts and scrub over every page's HTML, a quality
check per page, the worst page decides the verdict). A copy is still one page, so the steps run exactly as before.
`link-pages.mjs` turns links to other captured pages into relative copy links marked `data-pv-internal`, which the
replica note lets through; `node test-link-pages.mjs` checks it.

Fonts from Squarespace's own font library (Jeremy 2026-10-19): copies never reuse Squarespace's files. That library is
Google Fonts families re-hosted under `file.squarespace-cdn.com/.../fonts/libraries/sqsp/`. `google-fonts.py <siteDir>`
reads each such file's family, weight, style and subset from the page's @font-face rules (else the file's name table),
downloads the same face from Google Fonts into `<siteDir>/fonts-google/` and lists it in `fonts-google.json`.
`server.mjs` runs it on first start if needed and serves those files in place of Squarespace's. A face Google
doesn't have gets a lookalike from Google Fonts instead (Jeremy 2026-10-19: Inter, Source Serif 4, Roboto Mono or Dancing
Script by the kind of face, at the nearest weight; a stand-in until the curated lookalike list exists), and the copy
carries a note saying so. Only a face with neither (Google unreachable) is left out, and the quality check fails it as
`font-not-on-google-fonts`. `export-static.mjs` ships
each family's license (OFL text with its copyright line) as `a/fonts-license-<hash>.txt`, linked from each page's
`<link rel="license">`. The raw capture is left as captured.

Our own stylesheet (Jeremy 2026-10-19, "a copy is a more robust screenshot"): the job runs
`own-css.mjs <stage>` after export. On by default for new copies since Jeremy's go-ahead (2026-10-19); `--no-own-css`
or `PRESERVE_OWN_CSS=0` (the runner passes its environment through) turns it off, which is the rollback. Copies made
either way stay as they are. For each layout it:
- loads the exported page, runs `own-css-engine.js` inside it (the cascade worked out in one pass over every rule:
  conditions, layers, specificity, nesting, shorthands; every `var()` replaced by its value on that element) and
  records the winning declarations of every element at rest;
- records what changes at each width range the page's breakpoints make within the layout (desktop 768-2560, phone
  320-767), with reduced motion, and in each state our scripts drive (entrance animations, phone menu and its
  folders, accordions, nav dropdowns, the shrinking header) and on hover, written as rules on the elements that change;
- writes it as one `<style id="pv-css">` (elements styled alike share a `z…` class; keyframes still in use renamed
  `k…`), removes every Squarespace stylesheet, `<style>` and `preserve-critical`, renames `sqs-`/`sqsp-`/`sqsrte-`/
  `tweak-` classes and `data-sqs-` attributes in the page and its scripts, drops the attributes only Squarespace's
  scripts read, and deletes the stylesheet and font files nothing uses any more;
- swaps Squarespace's UI icon font (carousel arrows, close, share) for `icons.py`'s `pv-icons`: our own drawing of each
  icon, at the same code points, widths and boxes so nothing moves;
- photographs the page before and after (motion off, every picture loaded and decoded, one pixel per CSS pixel; a
  second look when they differ) and reports how much differs, at rest and with the phone menu open.
Typical result: 2.3-2.8 MB of Squarespace CSS becomes 45-110 KB of ours; about 15-70 s per layout. Debug pictures:
`OC_DEBUG=<dir> node own-css.mjs <stage>`. With the switch on, the quality check also fails `squarespace-styles-left`
(any of those names, a stylesheet file or link left) and `own-stylesheet-mismatch` (more than 1% of the page or the open
menu differs, page height changed, a state change not reproduced, or an icon not redrawn). The report is kept as
`<work>/<id>/own-css-report.json`.

`gate.mjs` (quality check): pass / ship-with-note / fail, following the rules at the top of known-limitations.md.
Fails on: Squarespace or Google addresses left in the files, unhandled addresses (#17), outside requests, broken
images, blocks that never appear, overlays left, phone menu or dropdown not opening, links that navigate instead of
showing the preview notice, galleries that don't advance (#9), and pixel or length differences from the live page.
Pixel limits (12% first screen, 15% full page) are raised by however much the live page differs from itself between
two visits, so slideshows and clocks aren't failed for moving. Notes for detected limitations #1, #3, #5, #10.
Re-run on an existing job: `node gate.mjs <work>/<id> <work>/_stage/<id> <url>`.

`publish.mjs <readyRoot> <pagesProject>`: writes the hosting extras, deploys with wrangler, deletes older deployments.
Interim single-project hosting; the account review's R2 + Worker layout would replace only this file.
