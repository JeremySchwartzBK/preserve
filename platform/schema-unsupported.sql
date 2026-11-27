-- Sites we couldn't cover yet, and who asked (Jeremy, 2026-11-24: "We'll let you know when we've expanded coverage to
-- this site." is a promise, so keep a list to keep it). One row per person and site. Written by the host's address check
-- (platform/host/src/page-check.js) and by the runner when a copy turns out to be on a platform we don't cover
-- (platform/runner.mjs). Nobody reads it from the app; the coverage email (email doc) is sent from it, and notified_at
-- records when. seen: platforms the page showed signs of (harness/make-copy.mjs PLATFORM_SIGNS), to pick the next one.
-- Safe to run more than once.
create table if not exists unsupported_site (
  id bigint generated always as identity primary key,
  person_id uuid not null references person(id) on delete cascade,
  studio_id uuid references studio(id) on delete cascade,
  url text not null,
  host text not null,
  seen text[] not null default '{}',
  source text not null check (source in ('start', 'copy')),
  copy_id text,
  created_at timestamptz not null default now(),
  notified_at timestamptz
);
create unique index if not exists unsupported_site_person_host on unsupported_site (person_id, host);
alter table unsupported_site enable row level security;   -- no policies: not readable or writable from the app
revoke all on unsupported_site from anon, authenticated;
grant select, insert, update on unsupported_site to preserve_runner;
