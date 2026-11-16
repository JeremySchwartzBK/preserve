# Hosting the copy runner (Cloudflare Containers)

Decided 2026-10-18: Cloudflare Containers, sleeping when idle (no always-on machine for v1; revisit after launch).

- `../../Dockerfile` builds the runner image (Playwright's Chromium, Node, Python + fonttools, ffmpeg). In the image the
  runner listens on port 8080 for `/health`, runs 2 jobs at a time and keeps its working files in `/tmp/runs`.
- `src/index.js` is the Worker that owns the container:
  - `POST /wake` (bearer `WAKE_SECRET`) starts the runner at once;
  - a cron check every minute starts it if queued jobs or serving changes are waiting;
  - after 3 quiet minutes it asks the runner whether it's busy and stops it only if not. On SIGTERM the runner hands
    any running job back to the queue (`release_copy_job`).

## More than one runner (2026-11-16)
One runner makes two Preserves at a time. When more are waiting, the minute check starts more runners (`src/scale.js`):
enough for the jobs waiting and being made, up to the variable `RUNNERS_MAX` in `wrangler.jsonc` (never above the
container's `max_instances` there). Each runner goes back to sleep by itself once the queue is empty, so extra runners
cost only while a queue is being worked through. Runner 1 also does the upkeep (what visitors see, stills, capture
clean-up); the host tells the others to leave that alone. `RUNNERS_MAX` "1" is one runner, as before.
`max_instances` is 3 (36 GiB, 12 vCPU at once); before going higher, check the account's Containers limits.
Test: `node test-scale.mjs`.

## Deploying from GitHub (2026-11-16)
Actions, "deploy", "Run workflow", choose runner, viewer, app or everything (`.github/workflows/deploy.yml`). It runs
the tests first, deploys the commit `main` is on, and never runs by itself. Needs the repository secret
`CLOUDFLARE_API_TOKEN`. The runner's secrets stay on the Worker and are untouched.
The runner image is tagged with the commit (`preserve-runner:<12 characters>`); to go back to an earlier one, run the
workflow for the runner with that tag filled in. A runner deploy restarts the runner: jobs being made go back to the
queue and start again.

## Seeing failures (2026-11-11)
- Each copy job's log is saved by the runner to R2 at `logs/<copy>/a<round>-t<try>.log` (what the job printed, then its
  steps, timings and result). The viewer never serves `logs/`. `copy_job.verdict` carries `steps`, `minutes` and `log`.
- The host's own logs are kept (`observability` in `wrangler.jsonc`).
- Every 15 minutes the host emails an alert (`src/alerts.js`, through Resend) when a job failed on our side, a job has
  waited more than 15 minutes, the runner won't start, or the database can't be reached. Off until all three secrets
  are set: `RESEND_API_KEY`, `ALERT_TO` (comma-separated addresses), `ALERT_FROM` (an address on our sending domain).
  Test: `node test-alerts.mjs`.

## Before the first deploy (Jeremy)
1. Workers Paid plan on the Cloudflare account (Containers need it).
2. A Cloudflare API token with Workers Scripts and Containers edit (for deploying), plus R2 read/write for the runner.
3. A database password for a dedicated runner role in Supabase (becomes `DATABASE_URL`).

## Deploy
```sh
cd platform/host && npm ci
npx wrangler@4.151.1 secret put DATABASE_URL
npx wrangler@4.151.1 secret put CLOUDFLARE_API_TOKEN
npx wrangler@4.151.1 secret put WAKE_SECRET
npx wrangler@4.151.1 deploy
```
Then point the database at `/wake` (a `pg_net` call from a trigger on new copy jobs and on `serving_outbox`), so new
requests start the runner without waiting for the minute check, and stop the runner in this workspace.

Checked 2026-10-18: the image builds (3.9 GB, within the 20 GB disk of `standard-4`), and a container from it ran a
breathpod copy alongside the workspace runner through the shared queue. The quality check's live-site screenshot inside
the test container missed images because this workspace's network proxy isn't trusted by Chromium there; that doesn't
apply on Cloudflare, but the first hosted copies should be compared with workspace ones.
