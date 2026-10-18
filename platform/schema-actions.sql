-- Runs after schema.sql. What signed-in people may do, as functions, so the rules can't be skipped from the browser:
-- plan limits, the single retry, and that only our copy job marks a copy ready for review. Direct writes to copies,
-- names and studios are turned off for signed-in users; reads still go through the row-level rules in schema.sql.

-- New sign-in: make the person, a studio named after them, and the membership.
create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare
  base text := coalesce(nullif(regexp_replace(lower(split_part(new.email, '@', 1)), '[^a-z0-9]+', '-', 'g'), ''), 'studio');
  new_slug text;
  sid uuid;
  nm text := coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1));
begin
  base := trim(both '-' from left(base, 30));
  if length(base) < 2 then base := 'studio'; end if;
  new_slug := base;
  while exists (select 1 from studio where studio.slug = new_slug) loop
    new_slug := base || '-' || substr(md5(random()::text), 1, 4);
  end loop;
  insert into person (id, email, name) values (new.id, new.email, nm);
  insert into studio (slug, name) values (new_slug, nm || '''s studio') returning id into sid;
  insert into studio_member (studio_id, person_id, role) values (sid, new.id, 'owner');
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

revoke insert, update, delete on studio, studio_member, copy, copy_name, copy_version, copy_job from authenticated, anon;
grant update (name, logo_path) on studio to authenticated;
revoke all on all tables in schema public from anon;

create or replace function my_studio() returns uuid language sql stable security definer set search_path = public as $$
  select studio_id from studio_member where person_id = auth.uid() order by created_at limit 1;
$$;

create or replace function check_limit(s uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if studio_copy_count(s) >= (select copy_limit from studio where id = s) then
    raise exception 'plan-limit' using hint = 'Your plan''s copies are all in use. Upgrade or archive one.';
  end if;
end $$;

-- Submit a page: makes the copy (processing), its friendly name, and the first job for the copy worker.
create or replace function request_copy(page_url text) returns text language plpgsql security definer set search_path = public as $$
declare
  s uuid := my_studio();
  cid text;
  base text;
  nm text;
  n int := 1;
begin
  if s is null then raise exception 'not-signed-in'; end if;
  if page_url !~* '^https?://[^/\s]+' then raise exception 'bad-url'; end if;
  perform check_limit(s);
  base := left(trim(both '-' from regexp_replace(lower(regexp_replace(substring(page_url from '^https?://([^/:]+)'), '^www\.', '')), '[^a-z0-9]+', '-', 'g')), 50);
  base := coalesce(nullif(split_part(base, '-', 1), ''), 'copy');
  nm := base;
  while exists (select 1 from copy_name where studio_id = s and name = nm) loop n := n + 1; nm := base || '-' || n; end loop;
  insert into copy (studio_id, source_url, created_by) values (s, page_url, auth.uid()) returning id into cid;
  insert into copy_name (studio_id, name, copy_id) values (s, nm, cid);
  insert into copy_job (copy_id, attempt, url) values (cid, 1, page_url);
  return cid;
end $$;

-- Approve a version: it becomes what visitors see.
create or replace function approve_copy(cid text, ver int) returns void language plpgsql security definer set search_path = public as $$
declare c copy;
begin
  select * into c from copy where id = cid and is_member(studio_id);
  if c.id is null then raise exception 'not-found'; end if;
  if c.status not in ('review', 'ready') then raise exception 'not-ready'; end if;
  if not exists (select 1 from copy_version where copy_id = cid and version = ver) then raise exception 'no-such-version'; end if;
  update copy_version set approved_at = now() where copy_id = cid and version = ver;
  update copy set status = 'ready', live_version = ver, updated_at = now() where id = cid;
end $$;

-- (Replaced below by refine_copy; kept so the file loads in order on a fresh database.)
-- The one automated retry, guided by the issue pins on the version under review.
create or replace function retry_copy(cid text) returns void language plpgsql security definer set search_path = public as $$
declare c copy; pins jsonb;
begin
  select * into c from copy where id = cid and is_member(studio_id);
  if c.id is null then raise exception 'not-found'; end if;
  if c.status <> 'review' then raise exception 'not-in-review'; end if;
  if exists (select 1 from copy_job where copy_id = cid and attempt = 2) then raise exception 'already-retried'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('block_id', block_id, 'x', x, 'y', y, 'layout', layout, 'body', body, 'version', version)), '[]')
    into pins from copy_pin where copy_id = cid and kind = 'issue' and resolved_at is null;
  if pins = '[]' then raise exception 'no-notes'; end if;
  insert into copy_job (copy_id, attempt, url, user_context) values (cid, 2, c.source_url, pins);
  update copy set status = 'processing', updated_at = now() where id = cid;
end $$;

-- Archive, restore, pause. Restoring counts against the plan again.
create or replace function set_copy_status(cid text, new_status text) returns void language plpgsql security definer set search_path = public as $$
declare c copy;
begin
  select * into c from copy where id = cid and is_member(studio_id);
  if c.id is null then raise exception 'not-found'; end if;
  if new_status not in ('archived', 'ready', 'paused') then raise exception 'bad-status'; end if;
  if new_status = 'ready' then
    if c.live_version is null then raise exception 'never-approved'; end if;
    if c.status = 'archived' then perform check_limit(c.studio_id); end if;
  end if;
  if c.status in ('processing', 'failed') then raise exception 'not-allowed'; end if;
  update copy set status = new_status, updated_at = now() where id = cid;
end $$;

-- Rename: the old name keeps redirecting to the copy.
create or replace function rename_copy(cid text, new_name text) returns text language plpgsql security definer set search_path = public as $$
declare c copy; nm text := trim(both '-' from regexp_replace(lower(new_name), '[^a-z0-9]+', '-', 'g'));
begin
  select * into c from copy where id = cid and is_member(studio_id);
  if c.id is null then raise exception 'not-found'; end if;
  if nm = '' or length(nm) > 60 then raise exception 'bad-name'; end if;
  if exists (select 1 from copy_name where studio_id = c.studio_id and name = nm and copy_id <> cid) then raise exception 'name-taken'; end if;
  update copy_name set is_current = false where copy_id = cid and is_current and name <> nm;
  insert into copy_name (studio_id, name, copy_id, is_current) values (c.studio_id, nm, cid, true)
    on conflict (studio_id, name) do update set is_current = true;
  return nm;
end $$;

-- Delete for good (files are removed by the serving sync).
create or replace function delete_copy(cid text) returns void language plpgsql security definer set search_path = public as $$
begin
  delete from copy where id = cid and is_member(studio_id);
  if not found then raise exception 'not-found'; end if;
end $$;

revoke execute on function handle_new_user(), check_limit(uuid), new_copy_id() from public, anon, authenticated;
grant execute on function my_studio(), request_copy(text), approve_copy(text, int), set_copy_status(text, text), rename_copy(text, text), delete_copy(text), studio_copy_count(uuid) to authenticated;

-- Serving sync: the copy runner keeps the edge lookup (KV) in step with the database. `served` is the last record it
-- wrote; a deleted copy leaves a tombstone so its links can be turned off.
alter table copy add column if not exists served jsonb;
create table if not exists copy_tombstone (copy_id text primary key, studio_slug text, names text[], deleted_at timestamptz not null default now(), cleared_at timestamptz);
alter table copy_tombstone enable row level security;
revoke all on copy_tombstone from anon, authenticated;
create or replace function copy_tombstone_add() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into copy_tombstone (copy_id, studio_slug, names)
  values (old.id, (select slug from studio where id = old.studio_id), array(select name from copy_name where copy_id = old.id))
  on conflict (copy_id) do nothing;
  return old;
end $$;
drop trigger if exists copy_tombstone_add on copy;
create trigger copy_tombstone_add before delete on copy for each row execute function copy_tombstone_add();

-- Triage detail: the real cause of a failure (never shown to the person), and how many times we've retried our side.
alter table copy_job add column if not exists internal_error text;
alter table copy_job add column if not exists tries int not null default 0;
revoke select on copy_job from authenticated;
grant select (id, copy_id, attempt, state, step, url, user_context, error, version, queued_at, started_at, finished_at) on copy_job to authenticated;

-- Approving a version closes the review notes on it; later problem reports are new issue pins.
create or replace function approve_copy(cid text, ver int) returns void language plpgsql security definer set search_path = public as $$
declare c copy;
begin
  select * into c from copy where id = cid and is_member(studio_id);
  if c.id is null then raise exception 'not-found'; end if;
  if c.status not in ('review', 'ready') then raise exception 'not-ready'; end if;
  if not exists (select 1 from copy_version where copy_id = cid and version = ver) then raise exception 'no-such-version'; end if;
  update copy_version set approved_at = now() where copy_id = cid and version = ver;
  update copy_pin set resolved_at = now() where copy_id = cid and kind = 'issue' and resolved_at is null and coalesce(meta->>'report', '') = '';
  update copy set status = 'ready', live_version = ver, updated_at = now() where id = cid;
end $$;

-- Refinements (Jeremy, 2026-10-16): after a copy is made, the person can ask for rounds of refinement. Each round
-- builds on the latest version plus every issue pin so far, needs at least one new pin since the last round, and is
-- free on every plan. After 20 rounds the copy is flagged for us and the person is told it's the best we can do for now.
alter table copy_job drop constraint if exists copy_job_attempt_check;
alter table copy_job add constraint copy_job_attempt_check check (attempt between 1 and 21);
alter table copy add column if not exists flagged_at timestamptz;   -- needs a human look (refinement cap reached)
drop function if exists retry_copy(text);
create or replace function refine_copy(cid text) returns int language plpgsql security definer set search_path = public as $$
declare c copy; pins jsonb; last_round timestamptz; rounds int;
begin
  select * into c from copy where id = cid and is_member(studio_id);
  if c.id is null then raise exception 'not-found'; end if;
  if c.status <> 'review' then raise exception 'not-in-review'; end if;
  select count(*) - 1, max(queued_at) into rounds, last_round from copy_job where copy_id = cid;
  if rounds >= 20 then raise exception 'refine-cap'; end if;
  if not exists (select 1 from copy_pin where copy_id = cid and kind = 'issue' and resolved_at is null
                 and coalesce(meta->>'report', '') = '' and created_at > last_round) then raise exception 'no-new-notes'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('block_id', block_id, 'x', x, 'y', y, 'layout', layout, 'body', body, 'version', version, 'at', created_at) order by created_at), '[]')
    into pins from copy_pin where copy_id = cid and kind = 'issue' and resolved_at is null and coalesce(meta->>'report', '') = '';
  insert into copy_job (copy_id, attempt, url, user_context) values (cid, rounds + 2, c.source_url, pins);
  if rounds + 1 >= 20 then update copy set flagged_at = now() where id = cid; end if;
  update copy set status = 'processing', updated_at = now() where id = cid;
  return rounds + 1;
end $$;
grant execute on function refine_copy(text) to authenticated;

-- Live-copy limit on downgrade or lapse (for the billing webhook; not callable by users): copies over the plan's limit
-- are archived, never deleted. The most recently published stay live; the person can swap which ones are live later.
create or replace function enforce_copy_limit(s uuid) returns int language plpgsql security definer set search_path = public as $$
declare lim int; n int;
begin
  select copy_limit into lim from studio where id = s;
  with live as (
    select id, row_number() over (order by (select max(approved_at) from copy_version v where v.copy_id = copy.id) desc nulls last, created_at desc) as rn
    from copy where studio_id = s and status in ('ready', 'paused')
  )
  update copy set status = 'archived', updated_at = now() from live where copy.id = live.id and live.rn > lim;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function enforce_copy_limit(uuid) from public, anon, authenticated;
