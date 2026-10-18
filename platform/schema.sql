-- Preserve data model: who owns which copies, and every copy's versions, jobs and pins.
-- Written for Supabase (Postgres + Supabase Auth). auth.users holds sign-in; everything else is ours.
--
-- Shape:
--   person ──< studio_member >── studio ──< copy ──< copy_version
--                                              ├──< copy_job      (each capture attempt; attempt 2 = retry with the user's notes)
--                                              ├──< copy_name     (current and old friendly names; old ones redirect)
--                                              └──< copy_pin      (tour notes, credits and issue reports, pinned to a block)
--   person ──< notification
--
-- The serving Worker never reads this database. On every change that affects what visitors see (publish, rename,
-- pause, delete), the app writes a small record to the edge lookup (Cloudflare KV); see platform/README.md.

create extension if not exists pgcrypto;

-- People sign in; studios own copies and pay. One person per studio at launch, several later, no model change.
create table person (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  name        text,
  created_at  timestamptz not null default now()
);

create table studio (
  id                   uuid primary key default gen_random_uuid(),
  slug                 text not null unique check (slug ~ '^[a-z0-9](-?[a-z0-9])*$' and length(slug) between 2 and 40),
  name                 text not null,
  logo_path            text,
  -- Billing lives in Stripe; we keep only what we need to decide what a studio may do.
  stripe_customer_id   text unique,
  plan                 text not null default 'free',            -- free | <plan names from Stripe prices>
  subscription_status  text not null default 'none'             -- none | active | past_due | canceled
                       check (subscription_status in ('none', 'active', 'past_due', 'canceled')),
  copy_limit           int not null default 1,                  -- set from the plan by the Stripe webhook
  created_at           timestamptz not null default now()
);

create table studio_member (
  studio_id   uuid not null references studio (id) on delete cascade,
  person_id   uuid not null references person (id) on delete cascade,
  role        text not null default 'owner' check (role in ('owner', 'member')),
  created_at  timestamptz not null default now(),
  primary key (studio_id, person_id)
);

-- A copy has a permanent random ID that never changes (embeds use it) and a friendly name (links use it).
create table copy (
  id               text primary key check (id ~ '^[a-z0-9]{8}$'),   -- e.g. k7f2qx9m; see new_copy_id()
  studio_id        uuid not null references studio (id) on delete cascade,
  source_url       text not null,
  title            text,                                           -- page title at capture, shown in the dashboard
  -- processing: first job running; review: waiting for the user to approve (or describe issues); ready: approved
  -- and live; paused: hidden from visitors (lapsed plan or user choice); failed: we couldn't copy the page at all.
  status           text not null default 'processing'
                   check (status in ('processing', 'review', 'ready', 'paused', 'failed', 'archived')),
  live_version     int,                                            -- version visitors see; null until approved
  created_by       uuid references person (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index copy_studio on copy (studio_id, created_at desc);

-- Friendly names, scoped per studio: <studio>/<name>. Renaming adds a row and marks the old one as a redirect, so
-- links already shared keep working. A name stays reserved for its copy until the copy is deleted.
create table copy_name (
  studio_id   uuid not null references studio (id) on delete cascade,
  name        text not null check (name ~ '^[a-z0-9](-?[a-z0-9])*$' and length(name) between 1 and 60),
  copy_id     text not null references copy (id) on delete cascade,
  is_current  boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (studio_id, name)
);
create unique index copy_name_one_current on copy_name (copy_id) where is_current;

-- Each finished capture is a version: its files live in R2 under copies/<copy_id>/v<version>/.
create table copy_version (
  copy_id      text not null references copy (id) on delete cascade,
  version      int not null,
  job_id       uuid,
  verdict      text not null check (verdict in ('pass', 'ship-with-note', 'fail')),
  findings     jsonb not null default '[]',   -- what the quality check found ("we noticed..." in review)
  notes        jsonb not null default '[]',   -- known limitations to mention ("ship with note")
  file_count   int,
  bytes        bigint,
  created_at   timestamptz not null default now(),
  approved_at  timestamptz,
  primary key (copy_id, version)
);

-- One row per capture attempt. Attempt 1 is the plain copy; attempt 2 is the one automated retry, fed the user's
-- issue pins. The copy job (harness/make-copy.mjs) reports state and step; the gap log is the failed/flagged rows.
create table copy_job (
  id            uuid primary key default gen_random_uuid(),
  copy_id       text not null references copy (id) on delete cascade,
  attempt       int not null default 1 check (attempt in (1, 2)),
  state         text not null default 'queued'
                check (state in ('queued', 'working', 'ready', 'needs-review', 'failed')),
  step          text,                          -- check-url | capture-and-build | export | ... | quality-check
  url           text not null,
  user_context  jsonb,                         -- for attempt 2: the issue pins the retry should address
  verdict       jsonb,                         -- full quality-check result
  error         text,
  version       int,                           -- copy_version this job produced
  queued_at     timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  triaged_at    timestamptz                    -- set when the team has looked at this gap
);
create index copy_job_open on copy_job (state) where state in ('queued', 'working');
create index copy_job_gaps on copy_job (finished_at desc) where state in ('needs-review', 'failed') and triaged_at is null;

-- Things pinned to a spot on the page: tour notes, credits, and issue reports from review. Each is anchored to a
-- Squarespace block ID plus a fractional position inside it, which is the same in the phone and desktop layouts.
create table copy_pin (
  id           uuid primary key default gen_random_uuid(),
  copy_id      text not null references copy (id) on delete cascade,
  kind         text not null check (kind in ('tour', 'credit', 'issue')),
  block_id     text,                           -- null for page-level items (e.g. a credit not tied to a spot)
  x            real check (x between 0 and 1),
  y            real check (y between 0 and 1),
  layout       text check (layout in ('desktop', 'mobile')),  -- where it was placed (issues can be layout-specific)
  body         text not null,                  -- the note, credit line, or the user's description of the problem
  meta         jsonb not null default '{}',    -- credit role/link, tour order, etc.
  version      int,                            -- for issues: the version being reviewed
  sort         int not null default 0,
  created_by   uuid references person (id) on delete set null,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);
create index copy_pin_copy on copy_pin (copy_id, kind, sort);

-- In-app notifications ("your copy is ready"); email comes later from the same rows.
create table notification (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references person (id) on delete cascade,
  kind        text not null,                   -- copy-ready | copy-needs-review | copy-failed | ...
  copy_id     text references copy (id) on delete cascade,
  body        text not null,
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  emailed_at  timestamptz
);
create index notification_unread on notification (person_id, created_at desc) where read_at is null;

-- Permanent copy IDs: 8 characters from a 32-letter alphabet without look-alikes (no 0/o, 1/l/i).
create or replace function new_copy_id() returns text language plpgsql as $$
declare
  abc constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  out text;
begin
  loop
    out := '';
    for i in 1..8 loop out := out || substr(abc, 1 + floor(random() * length(abc))::int, 1); end loop;
    exit when not exists (select 1 from copy where id = out);
  end loop;
  return out;
end $$;
alter table copy alter column id set default new_copy_id();

-- Plan limit: copies that count are everything not archived or failed.
create or replace function studio_copy_count(s uuid) returns int language sql stable as $$
  select count(*)::int from copy where studio_id = s and status not in ('archived', 'failed');
$$;

-- Row-level security: members see and change only their studios' rows. The copy job worker and the Stripe webhook
-- use the service role, which bypasses these.
create or replace function is_member(s uuid) returns boolean language sql stable security definer as $$
  select exists (select 1 from studio_member where studio_id = s and person_id = auth.uid());
$$;

alter table person enable row level security;
alter table studio enable row level security;
alter table studio_member enable row level security;
alter table copy enable row level security;
alter table copy_name enable row level security;
alter table copy_version enable row level security;
alter table copy_job enable row level security;
alter table copy_pin enable row level security;
alter table notification enable row level security;

create policy person_self on person for all using (id = auth.uid()) with check (id = auth.uid());
create policy studio_read on studio for select using (is_member(id));
create policy studio_update on studio for update using (is_member(id));  -- name/logo; billing columns are set by the webhook
create policy member_read on studio_member for select using (is_member(studio_id));
create policy copy_all on copy for all using (is_member(studio_id)) with check (is_member(studio_id));
create policy name_all on copy_name for all using (is_member(studio_id)) with check (is_member(studio_id));
create policy version_read on copy_version for select using (exists (select 1 from copy c where c.id = copy_id and is_member(c.studio_id)));
create policy job_read on copy_job for select using (exists (select 1 from copy c where c.id = copy_id and is_member(c.studio_id)));
create policy pin_all on copy_pin for all
  using (exists (select 1 from copy c where c.id = copy_id and is_member(c.studio_id)))
  with check (exists (select 1 from copy c where c.id = copy_id and is_member(c.studio_id)));
create policy notification_own on notification for all using (person_id = auth.uid()) with check (person_id = auth.uid());
