-- The line ahead of a pending Preserve, for the time estimate on its dashboard card (app.js eta; Jeremy 2026-11-24:
-- "a progress bar and estimated time until the Preserve will be ready for review"). Load after schema-guards.sql.
-- Only counts, never whose: how many jobs are waiting ahead of this one, how many are being made now, and how many can be
-- made at once (runners x RUNNER_SLOTS: one runner, two slots, RUNNERS_MAX in platform/host/wrangler.jsonc).
-- "Ahead" follows claim_copy_job's order closely enough for an estimate: higher priority first, then earlier queued.
-- Safe to run more than once.
create or replace function copy_queue(cid text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me copy_job;
begin
  if not exists (select 1 from copy where id = cid and is_member(studio_id)) then raise exception 'not-found'; end if;
  select * into me from copy_job where copy_id = cid order by attempt desc limit 1;
  if me.id is null or me.state <> 'queued' then return jsonb_build_object('ahead', 0, 'working', 0, 'slots', 2); end if;
  return jsonb_build_object(
    'ahead', (select count(*) from copy_job t where t.state = 'queued' and t.id <> me.id
               and (t.priority > me.priority or (t.priority = me.priority and t.queued_at < me.queued_at))),
    'working', (select count(*) from copy_job w where w.state = 'working' and w.lease_until >= now()),
    'slots', 2);
end $$;
revoke all on function copy_queue(text) from public, anon;
grant execute on function copy_queue(text) to authenticated;
