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

## Sliders and highlight marks at every width (2026-10-21)

Copies used to look right only at the capture widths (1440 desktop, 390 phone); resizing exposed two things sized once by
Squarespace's script:

- Swiper sliders (Ontario Lacrosse's news slider): `capture.mjs` records each slider's settings into `data-pv-swiper`
  (effect, speed, loop, autoplay delay, auto height). `build.mjs` adds `preserve-slider`, which sizes slides to the
  container on load and resize and drives fade/slide, arrows, dots and autoplay itself.
- Text highlights drawn as shapes (`.TextShape-node`, every `data-shape`): `preserve-shapes` re-measures each
  highlighted phrase's lines and places the shapes again on load, font load and resize. A marker is redrawn; a wave is
  repeated and cut to the line's length; other shapes (underline, scribble, ...) are stretched from their drawn size;
  shapes that ring a phrase (circle, box) cover the whole phrase. Captured pages can hold a second, stale set of
  marks per heading; extras are hidden. (Waves and underlines were added 2026-10-22, found by the size check below.)

Autoplay is paused (`window.__pvStill`) while `own-css.mjs` records states and while `check.mjs` compares, so a moving
slide never counts as a difference.

## Speed fixes and new quality checks (2026-10-22)

Speed (plan: "Slow first screen on two preserves"):
- Below-the-fold video waits: `export-static.mjs` gives every video `preload="none"` and moves its sources to
  `data-pv-src`; `preserve-media` attaches them when the video comes within half a screen (posters show meanwhile).
- First-screen byte budget: each first-screen image is re-encoded to AVIF when that saves 10% or more (WebP fallback),
  and when the first screen is over 600 KB (desktop) or 300 KB (phone) only its three largest images keep high
  priority. The JSON report lists `firstScreenBytes` per layout.
- Dead loaders dropped: owner scripts that inject code or pixels from another host (tag managers, referral widgets,
  ad pixels) are no longer kept (`isOwnerScript`), since a copy blocks what they load.
- Phone/desktop switching uses the layout width (`clientWidth`), and the page clips anything past the right edge, so
  an over-wide element can't zoom a phone out and flip the page between layouts forever. `check.mjs` reports a copy
  that keeps reloading itself.

Checks added to `gate.mjs` (each can be turned off with an environment variable, for tests):
- Load time (`loadtime.mjs`, `PRESERVE_LOAD_CHECK=0` to skip): the copy is served like the live host (brotli, ranges,
  `PRESERVE_HOST_WAIT_MS` per request, default 120) and timed with `measure.mjs`, 3 cold loads per layout. "Ready" is
  when the first screen's images are in, or when the owner's intro animation starts if there is one: the owner's own
  intro doesn't count against us (Jeremy, 2026-10-22) and is reported separately, with a warning when it hides the page
  for over a second. Over 2 s gives the note `slow-first-screen`, never a block. Heavy files loading before the first
  screen is ready are listed as a warning.
- Size check (`resize.mjs`, `PRESERVE_RESIZE_CHECK=0` to skip): at one extra width per layout (1024, 360) the copy is
  compared with the live page at that width (`differs-at-other-widths`, allowing for how much the live page differs
  from itself), and a copy opened at its capture width then resized is compared with one opened at that width
  (`breaks-on-resize`). A fixed-size detector lists elements with written-in sizes that kept them although their
  container changed, and now stick out of it or no longer fill it: a new widget of the "sized once" family shows up
  here before anyone sees it.

Test corpus: `--reuse-capture` builds from the capture already in `--work`, so the 21-site core set can be rebuilt with
new code and compared. Weekly re-timing: `.github/workflows/retime.yml` runs `retime.mjs` every Monday against the
published corpus copies in `corpus.json` and opens an issue when one got slower by 0.3 s or went over 2 s.

## Slow-site and other-width fixes (2026-10-23)

From the 58-site run:
- Timing a first screen that changes on its own: `measure.mjs` compared every frame with the last one, so a slideshow
  that advanced after the page was in counted as still loading (State of Sage, 7.5 s for a screen complete by 2 s).
  A change after the load event with no file arriving in the 0.6 s before it is now treated as motion, and progress is
  measured against the frame just before it.
- Video posters: the poster was the clip's first frame, which is often black (a fade in), so a phone saw a black first
  screen until the video streamed in (Ken Rosenberg, 9.5 s). `video.mjs` now uses the first frame within 8 s that has a
  picture in it.
- Header padding: Squarespace pads the first section and the menu overlay by the header's height in pixels for the
  width it saw. At other widths the header's height changes, so content sat too low or slid under the header (Fireside,
  Luigi's, Frankly). `capture.mjs` records the header's height (`data-pv-h0`) and `preserve-header-pad` redoes the sum at any width
  other than the capture width, leaving out the announcement bar the copy drops, as the live site does.
- Image boxes in the grid layout: Squarespace writes each image box's height in pixels for the width it saw
  (`--image-component-container-height`, baked into our stylesheet as a height). `preserve-image-boxes` works it out
  again at other widths from the grid cell's own height (Luigi's logo, Fireside's title; 27 of the 58 sites have one).
- Own-stylesheet check: both stylesheets are photographed with the header padding as captured, so a header a few
  pixels taller under one of them doesn't move the whole page and read as a big difference (Myrtle Green).
- Scrolling text bars: their spacing, path and height were written for the text size at capture. `preserve-motion`
  now scales them by how much the text itself changed size, and wraps on the full set of phrases, not the first one
  (Borrachito, known limitation #21).
- Size check: video is hidden in both pictures (keeping its space), since the live player can't play in our browser
  and showed "Video is not available" where the copy shows the video.

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
- `loadtime.mjs`, `resize.mjs`, `retime.mjs`: the load-time check, size check and weekly re-timing (above).
- `check.mjs`: on the original and each copy: JS errors, overlays still visible, broken images, elements stuck
  invisible after scrolling (scroll animations that never ran), mobile menu opens, desktop dropdown opens, every
  gallery/carousel/slideshow on the page (see "Gallery check" below), replica notice on link click, outside requests,
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
- The gallery check sees a change in the picture, not which slide is shown: a slide that moves to the wrong picture
  still passes. Swipe-only galleries on phones (no arrow) are only tested for autoplay and blank slides.

## Gallery player (2026-10-28)

Copies have none of Squarespace's scripts, so galleries, carousels and slideshows never moved (known limitation 9;
the gallery check above found emmagrinteriors' reel frozen). Instead of rebuilding each kind of gallery's script,
`recordGalleries()` in `capture.mjs` steps each gallery on the live page through its slides, the way the site does:
Squarespace's own gallery object for 7.0 gallery blocks (waiting while a slide is still moving), the site's own timer
for galleries that play by themselves (so the copy keeps the rhythm, including slide changes made of two or three
quick steps), or its "next" arrow. For each step it writes down what changed on the elements that move: classes,
inline style, short state attributes (`data-active`, `aria-hidden`...) and their order among their siblings. It stops
when the gallery is back on its first slide, repeats itself, stops changing, or after 30 steps (45 s; 90 s when
it has to wait on the site's timer). It skips galleries that add or remove elements as they move (cloned slides), and
Swiper sliders, which have their own player. The record goes in `data-pv-gal` on the gallery, `data-pv-gi` on each
moving element and `data-pv-gal-next` / `-prev` on the arrows; the gallery is put back on its first slide before
the page is saved. `GALLERY_SCRIPT` in `build.mjs` plays the steps back on the arrows and on the recorded timer
(paused under `__pvStill` and for visitors who ask for less motion), with the copy's own class names, positions
scaled to the gallery's width, and a short transition where Squarespace animated in script.

## Gallery check (2026-10-28)

`probeGalleries()` in `check.mjs` runs on the live page (in `gate.mjs`'s second look) and on the copy, in a page of its
own without `__pvStill`, so slideshows play as a visitor sees them. It finds up to six galleries, carousels and
slideshows (one per block, holding more than one picture) and for each: watches it for up to 6 s (a change means it
plays by itself), clicks its "next" arrow right after (so an autoplay step can't pass for the click), and counts
pictures in its visible part that never draw. `gate.mjs` holds each copy gallery to the live one in the same block:
`gallery-does-not-advance` (arrow moves it live, not in the copy), `gallery-does-not-autoplay` (plays by itself live,
still in the copy), `gallery-blank-slide` (more undrawn slide pictures than live). Each marks its gallery as a pin.

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

Every other font is sorted by who holds its license (Jeremy 2026-10-19; built 2026-10-26), in the same
`google-fonts.py` pass, which `server.mjs` now runs for any page that loaded a font:
- **Platform:** Adobe fonts from Squarespace's font menu (`use.typekit.net/af/...`, on Squarespace's Adobe account). The
  license is Squarespace's, so Adobe's files are never served. An open family Adobe also serves (Bebas Neue) comes from
  Google Fonts under its own name, if it is in Google's open catalog (github.com/google/fonts; Google also answers for
  some fonts outside it, e.g. Proxima Nova, which are not ours to use). Anything else gets a lookalike: a short curated
  list for the ones seen most (Proxima Nova -> Montserrat, Freight Sans -> Lato, Acumin -> Inter, Omnes -> Nunito, ...;
  a starting point until the side-by-side lookalike review is done), else the lookalike of its kind. The @font-face
  family name stays, so the page's styles are untouched; only the file changes. The quality check adds a note naming
  the swaps a visitor would see.
- **Designer:** fonts the site owner uploaded (`static1.squarespace.com/static/...` and the CDN's `content/`), trials
  included. Kept as captured, on the designer's word.
- **Anyone:** Squarespace's library (above) and Google Fonts the page linked itself.
- **Other:** fonts from any other host (widget services). Kept.

`fonts-google.json` keeps the result as `record`: one row per face with holder, source, what was done (`from-google`,
`open-equivalent`, `lookalike`, `kept`, `left-out`), the font served in its place, and for kept fonts the font's own
copyright and license lines plus a `trial_hint`. The quality check marks each row with the layouts that actually draw
with it (`check.mjs` `fontsUsed`: faces the browser loaded after scrolling through) and returns it as `info.fonts`, which
the runner stores with the job's verdict. That is the data for the review's Fonts tab and the confirmation at Publish
(plan: "Sign-up and first preserve"). A capture sorted before the record existed is sorted again on the next build.

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
- writes formulas and animations in our own form (`own-forms.mjs`, Jeremy 2026-10-20; `PRESERVE_OWN_FORMS=0` turns
  just this part off, which is its rollback): every `calc`/`min`/`max`/`clamp` value is worked out and written as a
  straight line in the units it depends on (`calc(100vw - 2.6em)`, `min(2.16vw + 1rem, …)`), plain values where it comes
  out constant, and leftovers from unset variables dropped. Each `@keyframes` in use is played on two test boxes,
  measured at every keyframe and between them, and rewritten from the measurements (move by px or % of the box, turn,
  scale, fade); ours is played back and must land on the same values all along, otherwise the original stays (renamed)
  and the report lists it under `motions.kept`;
- photographs the page before and after (motion off, every picture loaded and decoded, one pixel per CSS pixel; a
  second look when they differ) and reports how much differs, at rest, with the phone menu open, and at other widths
  the layout serves (desktop 1024, 1280, 1920; phone 360, 430).
Typical result: 2.3-2.8 MB of Squarespace CSS becomes 45-110 KB of ours; about 15-70 s per layout. Debug pictures:
`OC_DEBUG=<dir> node own-css.mjs <stage>`. With the switch on, the quality check also fails `squarespace-styles-left`
(any of those names, a stylesheet file or link left) and `own-stylesheet-mismatch` (more than 1% of the page, the open menu
or the page at another width differs, page height changed, a state change not reproduced, or an icon not redrawn). The report is kept as
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
