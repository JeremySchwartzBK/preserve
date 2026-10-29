# Preserve platform: copies that belong to accounts

Started 2026-10-15 (thread "Core copy gaps before user flows"), building on `product/accounts-billing-copies-review.md`.
This is the layer between the copy job (`prototype/harness/make-copy.mjs`) and the user experiences: who owns a copy,
how it is addressed, and how visitors are served.

## What's here

| File | What it is | Status |
|---|---|---|
| `schema.sql` | Data model for Supabase (Postgres): person, studio, studio_member, copy, copy_name, copy_version, copy_job, copy_pin, notification; row-level access rules | Loaded and tested on local Postgres 16 (a person sees only their studio's copies; can't add copies to another studio) |
| `worker/src/index.js` | One Cloudflare Worker that serves every copy from R2 | 21 of 21 local checks pass (`worker/test-local.mjs`) |
| `worker/copy-store.mjs` | Uploads a copy version to R2 and writes the lookup records to KV | Tested locally; real-account backend written, not yet run |
| `schema-findings.sql` | Quality-check findings as pins (kind `finding`), refine/approve updated, `finding_triage` view | Loaded 2026-10-16 |
| `schema-pages-captures.sql` | Page level (`copy_page`, `copy_pin.page_id`, `copy_version.pages` + `pipeline_version`, version reserved at queue time via `copy.next_version`, `copy.page_count`) and stored captures (`copy_capture`, `capture_due` retention view) | Loaded 2026-10-18 |
| `schema-page-serving.sql` | `copy_version.storage_format`: 1 = original single-page R2 layout, 2 = page layout (shared `copies/<id>/a/`, pages under `v<n>/p/<page>/`); the runner writes 2 for new versions and the lookup record gains `fmt` and `pages` | Loaded 2026-10-18 |
| `schema-runner.sql` | Several runners at once: job leases (`claim_copy_job`, `renew_copy_job`, `release_copy_job`), max 3 jobs per website, refinements first; `serving_outbox` filled by triggers so the runner publishes only changed copies | Loaded 2026-10-18 |
| `schema-review-flow.sql` | Accept goes live if the plan has a free live spot, otherwise starts Archived (`approve_copy`); plan limit counts live Preserves for accept and restore (`live_copy_count`, `set_copy_status`); suspected-issue answers `ignore` / `fix` / `not-a-problem` | Loaded 2026-10-29 |
| `schema-fonts.sql` | The review's Fonts step on real Preserves: `copy_version.fonts` (rows the runner writes), `copy_font` (the person's choice per font), `studio_font` (uploaded files, "Your fonts", checked by the runner), `copy_font_log` (every choice, upload and the confirmation at Accept Preserve, with who and when); `set_font_choice`, `upload_font`, `certify_fonts` work only during review. The viewer swaps fonts from KV `fonts:<id>` (runner `fontSwaps`) without rebuilding the Preserve | Not loaded yet |
| `schema-wake.sql` | Instant runner wake-up: `pg_net` call to the host's `/wake` when a copy job is queued or `serving_outbox` gets a row, with the secret from Vault (`runner_wake_secret`); the one-minute check stays as backup | Not loaded yet |
| `capture-store.mjs` | Packs a page's original capture into R2 `captures/<copy>/<page>/a<attempt>/` (tar.gz parts + index), restores and deletes it. Never served. Test: `node test-captures.mjs` | Used by the runner from 2026-10-18 |
| `worker/wrangler.toml` | Config for deploying as a standalone Worker (needs Workers Scripts: Edit on the key, which it doesn't have) | Not used yet |
| `worker/migrate.mjs`, `worker/test-live.mjs` | Upload the five test copies; check the deployed copies in a browser | Run 2026-10-16: 40 of 40 checks pass |
| `live-copies.md` / `.json` | Links, IDs and embed snippet for the copies on the new platform | Live |

## Addresses

- **Permanent:** `/c/<copyId>/` (8 characters, e.g. `k7f2qx9m`, never changes). Embed snippets use `/c/<copyId>/desktop` or `/mobile`, so nothing a designer pasted ever breaks.
- **Friendly:** `/<studio>/<name>/`, e.g. `/acme/minaab/`. Names are per studio, so two designers can both have "minaab". A renamed copy's old names redirect (301) to the new one.
- Both live on a copies domain separate from the app's sign-in domain (not yet picked; workers.dev until then).

Copy files now use relative paths (`a/<file>`, `mobile`), so the same folder works under `/c/<id>/`, under a friendly name, on the interim Pages site, or in any folder on a customer's own host. Changed in `harness/export-static.mjs` and `scrub.py` on 2026-10-15.

## How serving works

- R2 holds files at `copies/<copyId>/v<version>/{desktop.html, mobile.html, a/<file>}`. A new capture is uploaded as a new version; visitors switch only when the lookup is repointed, so a refresh is instant and can be rolled back.
- KV holds two small records the Worker reads:
  - `copy:<copyId>`: `{"v": 3, "status": "live" | "paused" | "deleted", "studio": "acme", "name": "minaab"}`
  - `name:<studio>/<name>`: `{"id": "k7f2qx9m", "current": "minaab"}` (current differs = old name, redirect)
- The app writes these whenever the database changes something visitors see (approve, rename, pause, delete). The Worker never touches the database.
- Paused copy: a neutral "This preview is paused for now." page, files hidden. Deleted: 410 "This preview has been removed."
- Every response carries `X-Robots-Tag: noindex...`; `/robots.txt` blocks AI-training crawlers. Files are cached at the edge for a year (content-hashed names); pages for a minute, so a pause or new version shows within about a minute. Byte-range requests work, which Safari needs for video.

## How the pieces connect (the user flows)

1. User submits a URL: insert `copy` (status `processing`, ID generated by `new_copy_id()`), a `copy_name`, and a `copy_job` (attempt 1, queued). Check `studio_copy_count()` against `studio.copy_limit` first.
2. A worker runs `make-copy.mjs <url> --id <copyId>`, updating `copy_job.state/step` from `job.json`. On finish: upload the folder with `uploadVersion()`, insert `copy_version` with the check's findings, set `copy.status = 'review'`, add a `notification`. A page we can't copy at all sets `copy.status = 'failed'`.
3. Review: the user sees the copy (served privately until approved; open question below), with the check's findings as "we noticed" items. They can pin issues on the page (`copy_pin` kind `issue`, same pin mechanism as Tour and Credits).
4. Approve: `copy.live_version = n`, `status = 'ready'`, `setCopy()` + `setNames()`. Or describe issues: queue `copy_job` attempt 2 with the pins as `user_context`; both versions are kept and the user approves either.
5. Every `copy_job` that ends `needs-review` or `failed` is the gap log; `triaged_at` marks the ones the team has looked at.

## Not done yet

- **Deployed 2026-10-16** at https://preserve-view.pages.dev: R2 bucket `preserve-copies`, KV namespace `preserve-lookup` (c67307a470e44d529efa87933c42942f; no longer read, lookup records moved to R2 `lookup/<kind>/<key>.json` 2026-10-16), Worker code deployed as the `_worker.js` of Pages project `preserve-view` with those bindings (the key has R2, KV and Pages edit, not Workers Scripts). Redeploy: copy `worker/src/index.js` to `<dir>/_worker.js` with `_routes.json` `{"version":1,"include":["/*"],"exclude":[]}` and `wrangler pages deploy <dir> --project-name preserve-view`. Old preserve-copies.pages.dev links still work and are untouched.
- **Previews before approval:** a copy under review shouldn't be publicly reachable. Plan: status `review` serves only with a short-lived signed token in the URL that the app adds.
- **The app itself:** Supabase project, sign-in, dashboard, Stripe. The schema is ready for them.
- **Migration:** the five test copies are on the new platform (re-exported from 2026-10-15 captures). The old Pages project stays until nothing links to it.
- Open decisions from the review still stand: domain/brand, lapsed-subscription behavior (defaulting to "paused"), teams at launch (model allows it), Google + email link (default), reuse Supabase (default).
