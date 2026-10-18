# Preserve

Fast, frozen copies of Squarespace sites that designers can show in their portfolios.

| Folder | What it is |
|---|---|
| `harness/` | The copy job: capture a page in a real browser, build the scripts-free copy, export, subset fonts, scrub trackers and contact details, quality check. Entry point `make-copy.mjs`. See `harness/README.md`. |
| `platform/` | Database schema (Supabase), the copy runner (`runner.mjs`: takes queued jobs, runs the harness, uploads to R2), and the serving Worker (`worker/`). See `platform/README.md`. |
| `app/` | The web app at preserve-app.pages.dev: sign-in, dashboard, new copy, review with pins, tour and credits, plan. Plain JS, no build step. See `app/README.md`. |

## Setup

```bash
cd harness && npm ci && python3 -m pip install -r requirements.txt   # Node 22, Python 3; Chromium via Playwright
cd ../platform/worker && npm ci
```

## Common tasks

```bash
node harness/make-copy.mjs https://www.example.com/ --id example --work /tmp/work --out /tmp/ready   # one copy, locally
node platform/runner.mjs                                                                               # process queued jobs
node platform/worker/test-local.mjs <ready>/<copyId>                                                   # serving tests
npx wrangler pages deploy app --project-name preserve-app --branch main                               # app
# serving Worker: copy platform/worker/src/index.js to <dir>/_worker.js (+ _routes.json), deploy <dir> to preserve-view
```

Database changes: the SQL files in `platform/` are applied in order (`schema.sql`, `schema-actions.sql`, `schema-findings.sql`).

## Rules of the road

- Code lives here. The project's shared folder is for outputs and documents, not code.
- Outputs (captures, work folders, finished copies, logs) never go in the repo.
- No secrets in the repo. The Supabase publishable key in `app/config.js` is meant to be public.
