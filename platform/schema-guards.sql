-- Guards against misuse and runaway cost (production-readiness review, item A4, 2026-11-11). Load after schema-fonts.sql.
--   1. A studio can make at most 20 new Preserves in any 24 hours (Jeremy, 2026-11-11). Refinements don't count.
--      Deleting a Preserve doesn't give the day's allowance back. studio.daily_limit can be raised per studio.
--   2. Submitted addresses must be ordinary public web addresses: a named host, no port, no sign-in part, no IP number.
--   3. The queue is fair: among jobs of the same priority, a studio with nothing being made goes ahead of one that
--      already has jobs running, so one studio's long list can't hold everyone else up.
--   4. Accepting works only during review. An accepted Preserve can never be pointed at another version.
--   5. Limits on pins per Preserve, note length and font uploads per day.
--   6. Database functions can be called only by signed-in people, and only the ones the app uses.
-- Safe to run more than once.

-- 1. Daily limit --------------------------------------------------------------------------------------------------
alter table studio add column if not exists daily_limit int not null default 20;
-- Studios on the team-set Unlimited plan (test accounts, showcase runs) keep making as many as they need.
update studio set daily_limit = 1000000 where plan = 'unlimited' and daily_limit = 20;

-- A deleted Preserve still counts toward the day it was made, so the tombstone remembers whose it was and when.
alter table copy_tombstone add column if not exists studio_id uuid;
alter table copy_tombstone add column if not exists copy_created_at timestamptz;
create or replace function copy_tombstone_add() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into copy_tombstone (copy_id, studio_slug, names, studio_id, copy_created_at)
  values (old.id, (select slug from studio where id = old.studio_id), array(select name from copy_name where copy_id = old.id), old.studio_id, old.created_at)
  on conflict (copy_id) do nothing;
  return old;
end $$;

create or replace function studio_made_today(s uuid) returns int language sql stable security definer set search_path = public as $$
  select (select count(*) from copy where studio_id = s and created_at > now() - interval '24 hours')::int
       + (select count(*) from copy_tombstone where studio_id = s and copy_created_at > now() - interval '24 hours')::int;
$$;

-- 2. Submit a page: the address check and the daily limit, then as before (schema-actions.sql).
create or replace function request_copy(page_url text) returns text language plpgsql security definer set search_path = public as $$
declare
  s uuid := my_studio();
  cid text;
  base text;
  nm text;
  n int := 1;
begin
  if s is null then raise exception 'not-signed-in'; end if;
  if length(page_url) > 2000
     or page_url !~* '^https?://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]([/?#]|$)'
     or page_url ~ '\s'
     or page_url ~* '^https?://([^/?#]*\.)?(localhost|local|internal|lan|home|corp|test|invalid|example)([/?#]|$)' then
    raise exception 'bad-url';
  end if;
  -- One at a time per studio, so two submissions at once can't both take the day's last one.
  perform 1 from studio where id = s for update;
  perform check_limit(s);
  if studio_made_today(s) >= (select daily_limit from studio where id = s) then
    raise exception 'daily-limit' using hint = 'This studio has reached its limit of new Preserves for 24 hours.';
  end if;
  base := left(trim(both '-' from regexp_replace(lower(regexp_replace(substring(page_url from '^https?://([^/:]+)'), '^www\.', '')), '[^a-z0-9]+', '-', 'g')), 50);
  base := coalesce(nullif(split_part(base, '-', 1), ''), 'copy');
  nm := base;
  while exists (select 1 from copy_name where studio_id = s and name = nm) loop n := n + 1; nm := base || '-' || n; end loop;
  insert into copy (studio_id, source_url, created_by) values (s, page_url, auth.uid()) returning id into cid;
  insert into copy_name (studio_id, name, copy_id) values (s, nm, cid);
  insert into copy_job (copy_id, attempt, url) values (cid, 1, page_url);
  return cid;
end $$;

-- 3. Fair queue: same as schema-runner.sql, plus "fewest jobs running for this studio first" within a priority.
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
    order by t.priority desc,
      (select count(*) from copy_job w join copy wc on wc.id = w.copy_id
        where w.state = 'working' and w.lease_until >= now()
          and wc.studio_id = (select tc.studio_id from copy tc where tc.id = t.copy_id)),
      t.queued_at
    for update of t skip locked limit 1)
  returning j.id, j.copy_id, j.attempt, j.url, j.user_context, j.tries, j.version,
    (select p.page_id from copy_page p where p.copy_id = j.copy_id and p.path = '');
end $$;

-- 4. Accept only during review (schema-review-flow.sql allowed 'ready' too, which let an accepted Preserve be pointed
-- at another version by calling this directly; the app never did).
create or replace function approve_copy(cid text, ver int) returns void language plpgsql security definer set search_path = public as $$
declare c copy; room boolean;
begin
  select * into c from copy where id = cid and is_member(studio_id);
  if c.id is null then raise exception 'not-found'; end if;
  -- Lock the studio's row so two accepts at once can't both take the last live spot.
  perform 1 from studio where id = c.studio_id for update;
  select * into c from copy where id = cid for update;
  if c.status <> 'review' then raise exception 'not-ready'; end if;
  if not exists (select 1 from copy_version where copy_id = cid and version = ver) then raise exception 'no-such-version'; end if;
  room := live_copy_count(c.studio_id) < (select copy_limit from studio where id = c.studio_id);
  update copy_version set approved_at = now() where copy_id = cid and version = ver;
  update copy_pin set resolved_at = now() where copy_id = cid and resolved_at is null
    and ((kind = 'issue' and coalesce(meta->>'report', '') = '') or kind = 'finding');
  update copy set status = case when room then 'ready' else 'archived' end, live_version = ver, updated_at = now() where id = cid;
end $$;

-- 5. Pins and fonts ---------------------------------------------------------------------------------------------------
-- People add pins directly (row rules limit them to their studio's Preserves), so the limits live in a trigger:
-- 300 open pins per Preserve, notes up to 2,000 characters, and a small extras field.
-- Not "security definer": it has to see who is really asking (the runner's own pins are not limited).
create or replace function guard_pin_limits() returns trigger language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if length(new.body) > 2000 then raise exception 'note-too-long'; end if;
  if pg_column_size(new.meta) > 8000 then raise exception 'note-too-long'; end if;
  if tg_op = 'INSERT' and (select count(*) from copy_pin where copy_id = new.copy_id and resolved_at is null) >= 300 then
    raise exception 'too-many-pins';
  end if;
  return new;
end $$;
drop trigger if exists copy_pin_guard_limits on copy_pin;
create trigger copy_pin_guard_limits before insert or update on copy_pin for each row execute function guard_pin_limits();

-- Font uploads (schema-fonts.sql), plus at most 30 uploads per studio in 24 hours.
create or replace function upload_font(cid text, fid text, fname text, b64 text) returns uuid language plpgsql security definer set search_path = public as $$
declare c copy := font_copy(cid); f jsonb := review_font(cid, fid); bytes bytea; sid uuid;
begin
  if f is null then raise exception 'no-such-font'; end if;
  if fname !~* '\.(woff2|woff|otf|ttf)$' then raise exception 'not-a-font'; end if;
  if length(b64) > 7 * 1024 * 1024 then raise exception 'font-too-big'; end if;
  bytes := decode(b64, 'base64');
  if length(bytes) > 5 * 1024 * 1024 then raise exception 'font-too-big'; end if;
  if (select count(*) from studio_font where studio_id = c.studio_id and created_at > now() - interval '24 hours') >= 30 then
    raise exception 'too-many-fonts';
  end if;
  insert into studio_font (studio_id, font_key, name, file_name, data) values (c.studio_id, fid, coalesce(f->>'name', fid), fname, bytes) returning id into sid;
  insert into copy_font (copy_id, font_id, decision, studio_font_id) values (cid, fid, 'upload', sid)
    on conflict (copy_id, font_id) do update set decision = 'upload', studio_font_id = sid, decided_by = auth.uid(), decided_at = now();
  insert into copy_font_log (copy_id, font_id, decision, file_name) values (cid, fid, 'upload', fname);
  return sid;
end $$;

-- 6. Who may call what ----------------------------------------------------------------------------------------------------
-- Postgres lets everyone call a new function unless told otherwise. Take that away for everything here, then give
-- signed-in people exactly the functions the app calls (and is_member, which the row rules use). Triggers still fire:
-- firing a trigger needs no such right. The runner and the service role keep theirs.
alter function is_member(uuid) set search_path = public;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  is_member(uuid), my_studio(), studio_copy_count(uuid), live_copy_count(uuid),
  request_copy(text), approve_copy(text, int), refine_copy(text), set_copy_status(text, text), rename_copy(text, text), delete_copy(text),
  set_font_choice(text, text, text), upload_font(text, text, text, text), certify_fonts(text, jsonb)
  to authenticated;
-- The same for functions added later: nobody outside gets them by default.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
