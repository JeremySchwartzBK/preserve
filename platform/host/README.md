# Hosting the copy runner (Cloudflare Containers)

Decided 2026-10-18: Cloudflare Containers, sleeping when idle (no always-on machine for v1; revisit after launch).

- `../../Dockerfile` builds the runner image (Playwright's Chromium, Node, Python + fonttools, ffmpeg). In the image the
  runner listens on port 8080 for `/health`, runs 2 jobs at a time and keeps its working files in `/tmp/runs`.
- `src/index.js` is the Worker that owns the container:
  - `POST /wake` (bearer `WAKE_SECRET`) starts the runner at once;
  - a cron check every minute starts it if queued jobs or serving changes are waiting;
  - after 3 quiet minutes it asks the runner whether it's busy and stops it only if not. On SIGTERM the runner hands
    any running job back to the queue (`release_copy_job`).

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
