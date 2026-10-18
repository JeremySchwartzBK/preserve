-- A copy runner that can run on several machines at once (2026-10-18, design B1 and B4, product/runner-and-pages-design.md).
--   - Jobs are claimed with a lease that the runner renews while it works. A runner that crashes or is redeployed
--     simply stops renewing, and another runner picks the job up when the lease runs out. This replaces "put every
--     working job back in the queue at start", which was only safe with a single runner.
--   - At most 3 jobs per website run at the same time, so copying many pages of one site doesn't trip its bot defences.
--   - Refinements go ahead of new copies (someone is waiting on them in review).
--   - Changes visitors should see are queued in serving_outbox by triggers, so the runner updates only those copies
--     instead of re-reading every copy every few seconds. An hourly full pass stays as a safety net.
-- Safe to run more than once.

alter table copy_job add column if not exists worker_id text;
alter table copy_job add column if not exists lease_until timestamptz;
alter table copy_job add column if not exists source_host text
  generated always as (lower(regexp_replace(substring(url from '^[a-zA-Z]+://([^/:?#]+)'), '^www\.', ''))) stored;
alter table copy_job add column if not exists priority int
  generated always as (case when attempt > 1 then 10 else 0 end) stored;
create index if not exists copy_job_claim on copy_job (priority desc, queued_at) where state in ('queued', 'working');

-- Take the next job for this runner: queued, or working under a lease that ran out. Returns nothing when there's no
-- job (or every waiting job's site already has 3 running). tries counts claims, so a job whose runner keeps dying
-- is given up after 3 (marked failed with the usual "something went wrong on our side" message).
create or replace function claim_copy_job(worker text, lease_seconds int default 120)
returns table (id uuid, copy_id text, attempt int, url text, user_context jsonb, tries int, version int, page_id text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare lost record;
begin
  for lost in update copy_job j set state = 'failed', step = null, finished_at = now(), worker_id = null, lease_until = null,
      error = 'Something went wrong on our side while making this copy. We’ve logged it and will try again.',
      internal_error = coalesce(j.internal_error || ' | ', '') || 'runner stopped responding ' || j.tries || ' times'
    where j.state = 'working' and j.lease_until < now() and j.tries >= 3 returning j.copy_id
  loop
    update copy c set status = case when exists (select 1 from copy_version v where v.copy_id = c.id) then 'review' else 'failed' end, updated_at = now()
    where c.id = lost.copy_id;
  end loop;

  return query
  update copy_job j set state = 'working', step = 'check-url', worker_id = worker, lease_until = now() + make_interval(secs => lease_seconds),
    started_at = now(), tries = j.tries + 1
  where j.id = (
    select t.id from copy_job t
    where (t.state = 'queued' or (t.state = 'working' and t.lease_until < now()))
      and (select count(*) from copy_job w where w.state = 'working' and w.lease_until >= now() and w.source_host = t.source_host) < 3
    order by t.priority desc, t.queued_at
    for update skip locked limit 1)
  returning j.id, j.copy_id, j.attempt, j.url, j.user_context, j.tries, j.version,
    (select p.page_id from copy_page p where p.copy_id = j.copy_id and p.path = '');
end $$;

-- Renew a lease; false means the job is no longer this runner's (another runner took it over), so stop working on it.
create or replace function renew_copy_job(job uuid, worker text, lease_seconds int default 120) returns boolean
language sql security definer set search_path = public as $$
  update copy_job set lease_until = now() + make_interval(secs => lease_seconds) where id = job and worker_id = worker and state = 'working'
  returning true;
$$;

-- Give a job back (runner shutting down): straight back to the queue, and the claim doesn't count against it.
create or replace function release_copy_job(job uuid, worker text) returns void
language sql security definer set search_path = public as $$
  update copy_job set state = 'queued', step = null, started_at = null, worker_id = null, lease_until = null, tries = greatest(tries - 1, 0)
  where id = job and worker_id = worker and state = 'working';
$$;

revoke execute on function claim_copy_job(text, int), renew_copy_job(uuid, text, int), release_copy_job(uuid, text) from public, anon, authenticated;

-- Serving outbox -----------------------------------------------------------------------------------------------------
create table if not exists serving_outbox (copy_id text primary key, queued_at timestamptz not null default now());
alter table serving_outbox enable row level security;
revoke all on serving_outbox from anon, authenticated;

create or replace function serving_outbox_add() returns trigger language plpgsql security definer set search_path = public as $$
declare cid text;
begin
  if tg_table_name = 'copy' then
    -- The runner's own bookkeeping (served, updated_at) is not a change visitors see.
    if tg_op = 'UPDATE' and (to_jsonb(old) - 'served' - 'updated_at') = (to_jsonb(new) - 'served' - 'updated_at') then return null; end if;
    cid := coalesce(new.id, old.id);
  elsif tg_table_name = 'copy_pin' then
    if coalesce(new.kind, old.kind) not in ('tour', 'credit') then return null; end if;
    cid := coalesce(new.copy_id, old.copy_id);
  else
    cid := coalesce(new.copy_id, old.copy_id);
  end if;
  insert into serving_outbox (copy_id) values (cid) on conflict (copy_id) do update set queued_at = now();
  return null;
end $$;

drop trigger if exists serving_outbox_copy on copy;
create trigger serving_outbox_copy after insert or update on copy for each row execute function serving_outbox_add();
drop trigger if exists serving_outbox_name on copy_name;
create trigger serving_outbox_name after insert or update or delete on copy_name for each row execute function serving_outbox_add();
drop trigger if exists serving_outbox_pin on copy_pin;
create trigger serving_outbox_pin after insert or update or delete on copy_pin for each row execute function serving_outbox_add();
drop trigger if exists serving_outbox_version on copy_version;
create trigger serving_outbox_version after insert or update on copy_version for each row execute function serving_outbox_add();
-- Deleted copies already leave a copy_tombstone row, which the runner drains the same way.
