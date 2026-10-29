# Preserve app

Live: https://preserve-app.pages.dev (Cloudflare Pages project `preserve-app`). Add `?demo` for the in-browser demo
(simulated sign-in and copies, nothing saved to the server). Test branch: https://test.preserve-app.pages.dev.

Screens: sign-in, dashboard (copy link, embed code, archived list), new copy (progress steps, plan limit, notification
bell), review (phone/desktop preview of the real copy, "point out a problem" pins on Squarespace blocks, one retry with
notes, publish, discard), live copy (share, rename with old links redirecting, archive/restore, delete, report), plan.

## How it fits together (2026-10-16)
- `config.js`: Supabase project `uzgprpbhhrctklzumikn` + publishable key (public by design). `GOOGLE = false` until the
  Google provider is set up in Supabase.
- `store.js` picks `store-supabase.js` (real) or `store-local.js` (demo). Same API, so screens don't change.
- Reads go to tables (row-level rules); every change goes through database functions in
  `platform/schema-actions.sql` (request_copy, approve_copy, retry_copy, rename_copy, set_copy_status, delete_copy),
  which enforce plan limits and the single retry. Signing up creates the person's studio (trigger).
- `platform/runner.mjs` takes queued jobs, runs `harness/make-copy.mjs`, uploads the version to R2, records findings in
  plain language, notifies, and keeps the KV lookup in step (review / live / paused / deleted, names and redirects).
  It currently runs inside a Claude cloud session, so copies only get made while that session is up. A permanent
  server for it is still to do.
- Review frame: `preserve-view.pages.dev/c/<id>/<layout>?review=1`. A copy in review is served only with `?review`.
- Sign-in is by email link (PKCE: open the link in the same browser). Supabase's built-in mail sends a few emails an
  hour and only to the Supabase team's addresses until a mail service (SMTP) is connected.
- Test account `claude-test@example.com` (studio `claude-test`) exists for automated checks.

Not done: Google sign-in, Stripe (plan buttons say so), mail service, signed review links, permanent runner host,
refinements actually using the notes (they're passed to the job and logged; the capture doesn't act on them yet).

Deploy: `wrangler pages deploy <this folder> --project-name preserve-app --branch main`.

## Review feedback round 1 (Jeremy, 2026-10-16)
- Desktop preview renders at a real 1440px width, scaled to fit; phone at 390px.
- The preview frame is built once per copy and layout; saving notes/tour/credits only redraws the side panel.
- Pin mode puts a clear layer over the page (bridge in worker/src/index.js), so taps never press buttons or follow
  links; the block under the pointer is outlined. Spots outside blocks fall back to header, footer or page.
- Copy page tabs: in review "1. Check the copy · 2. Tour · 3. Credits"; live "Share · Tour · Credits · Report · Manage".
  Publishing lands on Tour with a note that Tour and Credits are optional.
- Tour stops = copy_pin kind tour (meta.title); credits = kind credit (body name, meta.role/url). The runner writes
  them to KV tour:<id>; the Worker adds them plus /_p/tour.js (R2 platform/tour.js, visitor-only build of the demo
  tour script, source platform/tour/tour.js) to visitor pages.
- Link name is edited inline in the link; Enter or leaving the field saves; old names redirect.
- Report a problem = point and describe (copy_pin kind issue, meta.report=true), logged for triage.
- UX wording pass deferred by Jeremy.

## Refinements and plan limits (decided by Jeremy 2026-10-16, thread "Copy limits per plan")
- "Refinement", not "retry". Up to 20 rounds per copy on every plan; each needs at least one new issue pin since the
  last round; each builds on the latest version plus all pins so far; refinements don't count toward plan limits.
  After 20 rounds: "best we can do for now" message and copy.flagged_at is set. DB: refine_copy() (retry_copy dropped),
  copy_job.attempt 1-21.
- No refreshes: a later version of a site is a new copy.
- Live-copy limit with archive: over the limit after a downgrade or lapse, copies are archived (links show "preview
  paused"), never deleted; the most recently published stay live. DB: enforce_copy_limit(studio), for the Stripe
  webhook. Tier numbers and a monthly new-copy cap are still placeholders.

## Account decisions (Jeremy, 2026-10-16, old "Account, billing and copy management review" thread)
- Link format view.<brand>.com/<studio>/<copy> approved; brand/domain not chosen yet (preserve-view.pages.dev meanwhile).
- Lapsed subscription = same archive state as over-limit copies (enforce_copy_limit with the free allowance, from the
  Stripe webhook). "Preview paused" page wording and the archive UX are to be reviewed with Jeremy later.
- Teams: an account (studio) holds several users. The data model already supports it (studio_member, role
  owner|member; RLS is per membership). Not built yet: inviting people, switching between studios in the app.
- Sign-in: email link now, Google later.

## Quality-check findings as pins (2026-10-16, Jeremy's idea)
- The quality check (harness `check.mjs` / `gate.mjs`) now records where each problem was seen: block id plus position, per layout (same anchors as the review pins). Picture differences are placed on the 100-px bands with the most change (up to 3 per page, 1 for the first screen); a point outside every block goes on the page itself (`el:body`).
- The runner adds them as `copy_pin` rows of kind `finding` on the version under review (earlier versions' findings are closed). Findings it can't place stay a plain list ("Also noticed").
- On the copy page they show as lettered purple dots (grey once answered) with three answers: Looks fine / Needs fixing / Not a problem (`meta.verdict`). "Needs fixing" counts as a new note for a refinement and goes into the job's notes. Unanswered findings never block publishing.
- Database: `platform/schema-findings.sql` (loaded). People can only mark findings, not add or remove them (trigger). For triage, `finding_triage` view (service only) lists every marked finding; `not-a-problem` rows are false alarms to tune the check.
- Also fixed on the way: the phone video mask in the picture comparison was misplaced (phone screenshots are 3x), so phone comparisons around video are now fairer.
- 2026-10-17 (Jeremy's review): findings list shows only the layout on screen, lettered top to bottom (`meta.pageY`, set by the check; older pins backfilled); the block-text snippet is gone; "Known limits" is no longer shown to users (not actionable, only worrying); "Bigger preview" is now "Hide panel".

## Review flow feedback (Jeremy, 2026-10-26, pins on the flow markup page)
- Say "Preserve", never "copy", in anything people read ("copy" reads as page text). Code names stay `copy`.
- Review steps: 1. Look and Feel, 2. Tour, 3. Credits, then Accept Preserve. "+ Issue" drops a pin. Suspected
  issues from our check are answered Ignore issue / Fix issue / Not an issue. Refine Preserve appears once anything
  is marked to fix (a pin of their own, or Fix issue). Accept asks for confirmation ("cannot be refined"; Review
  Preserve goes back to step 1), then goes live if the plan has a free live spot, otherwise starts Archived.
- Tour and credits stay editable after accepting. Tour stops can be moved; a stop whose block is gone after a
  refinement is flagged to move (the review bridge reports pins it couldn't place).
- Dashboard: "Your Preserves", newest first, 20 a page, search on site name and address, filter All / Live / Ready
  to review / Pending / Archived. Cards show the capture date and Copy link, Copy embed code, a Live/Archived switch,
  Review and Delete. Deleting asks first and says it's permanent.
- User-testing questions are collected in /mnt/project-files/product/user-testing-questions.md.
- Round 2 (2026-10-27): house style is numbers under 10 spelled out in sentences (digits in labels and counters) and
  status names capitalized in sentences (Live, Archived, Archiving). Live Preserves lose the Manage tab (card actions
  cover it).
- Accepted Preserves can never be modified (Jeremy, 2026-10-28): the "Report an issue" tab is gone. The Tour, Credits,
  link name and Live/Archived stay editable. The only exception is an admin-only, recorded removal for legal reasons.

## Fonts step (review, 2026-10-27)

When a Preserve has fonts to check (`copy.fonts`), review starts with **Fonts**: one row per font with the original's
name, a picture of it in the page's own words (taken at capture, since Adobe files can't be shipped), the font the
Preserve uses, and Show on page. Choices follow who holds the license: Squarespace's Adobe fonts get a lookalike unless
the person uploads their own file; fonts the owner uploaded are kept unless they say they don't have the rights; a font
covered by a file saved in Your fonts needs no look. An upload is checked (same family, matching widths) and rebuilds
only the fonts. Above Accept Preserve, the person confirms rights to the fonts kept as on the site; that, and every
choice, is recorded with who and when. Demo only so far: the database side (copy fonts, studio fonts, the record) and
the capture-time samples are still to build, and Show on page outlining needs the Preserve viewer redeployed.
