-- Quality-check findings as pins (2026-10-16). The copy job's quality check now records where on the page each
-- problem was seen; the runner adds those as pins of kind 'finding' on the version under review. The person marks
-- each one in meta.verdict:
--   'fine'           looks fine to them (nothing to do)
--   'fix'            needs fixing: counts as a new note for a refinement round, like a pin they placed themselves
--   'not-a-problem'  the check was wrong: kept for our triage (see finding_triage below)
-- Unmarked findings never block publishing. A new version's findings replace the previous version's.

alter table copy_pin drop constraint if exists copy_pin_kind_check;
alter table copy_pin add constraint copy_pin_kind_check check (kind in ('tour', 'credit', 'issue', 'finding'));

-- Only the runner adds or removes findings; people only mark them.
create or replace function guard_finding_pins() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') and (case when tg_op = 'DELETE' then old.kind else new.kind end) = 'finding' and tg_op <> 'UPDATE' then
    raise exception 'findings-are-read-only';
  end if;
  if tg_op = 'UPDATE' and current_user in ('authenticated', 'anon') and (old.kind = 'finding' or new.kind = 'finding')
     and (new.kind, new.block_id, new.x, new.y, new.layout, new.body, new.version, new.copy_id) is distinct from (old.kind, old.block_id, old.x, old.y, old.layout, old.body, old.version, old.copy_id) then
    raise exception 'findings-are-read-only';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists copy_pin_guard_findings on copy_pin;
create trigger copy_pin_guard_findings before insert or update or delete on copy_pin for each row execute function guard_finding_pins();

-- Approving closes the review's notes and findings (their marks stay for triage).
create or replace function approve_copy(cid text, ver int) returns void language plpgsql security definer set search_path = public as $$
declare c copy;
begin
  select * into c from copy where id = cid and is_member(studio_id);
  if c.id is null then raise exception 'not-found'; end if;
  if c.status not in ('review', 'ready') then raise exception 'not-ready'; end if;
  if not exists (select 1 from copy_version where copy_id = cid and version = ver) then raise exception 'no-such-version'; end if;
  update copy_version set approved_at = now() where copy_id = cid and version = ver;
  update copy_pin set resolved_at = now() where copy_id = cid and resolved_at is null
    and ((kind = 'issue' and coalesce(meta->>'report', '') = '') or kind = 'finding');
  update copy set status = 'ready', live_version = ver, updated_at = now() where id = cid;
end $$;

-- A refinement round needs something new to act on: a pin placed since the last round, or a finding marked
-- "needs fixing" (findings belong to the latest version, so any such mark is new). Both go into the job's notes.
create or replace function refine_copy(cid text) returns int language plpgsql security definer set search_path = public as $$
declare c copy; pins jsonb; last_round timestamptz; rounds int;
begin
  select * into c from copy where id = cid and is_member(studio_id);
  if c.id is null then raise exception 'not-found'; end if;
  if c.status <> 'review' then raise exception 'not-in-review'; end if;
  select count(*) - 1, max(queued_at) into rounds, last_round from copy_job where copy_id = cid;
  if rounds >= 20 then raise exception 'refine-cap'; end if;
  if not exists (select 1 from copy_pin where copy_id = cid and resolved_at is null and (
        (kind = 'issue' and coalesce(meta->>'report', '') = '' and created_at > last_round)
     or (kind = 'finding' and meta->>'verdict' = 'fix'))) then raise exception 'no-new-notes'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('block_id', block_id, 'x', x, 'y', y, 'layout', layout,
           'body', case when kind = 'finding' then body || coalesce(' — ' || nullif(meta->>'note', ''), '') else body end,
           'from', case when kind = 'finding' then 'quality-check:' || coalesce(meta->>'code', '') else 'person' end,
           'version', version, 'at', created_at) order by created_at), '[]')
    into pins from copy_pin where copy_id = cid and resolved_at is null and (
        (kind = 'issue' and coalesce(meta->>'report', '') = '') or (kind = 'finding' and meta->>'verdict' = 'fix'));
  insert into copy_job (copy_id, attempt, url, user_context) values (cid, rounds + 2, c.source_url, pins);
  if rounds + 1 >= 20 then update copy set flagged_at = now() where id = cid; end if;
  update copy set status = 'processing', updated_at = now() where id = cid;
  return rounds + 1;
end $$;
grant execute on function refine_copy(text) to authenticated;

-- For us (not visible to users): findings people marked, newest first. 'not-a-problem' rows are false alarms to
-- tune the check; 'fix' rows are real gaps.
create or replace view finding_triage as
  select p.created_at, p.copy_id, c.source_url, p.version, p.meta->>'code' as code, p.meta->>'verdict' as verdict,
         p.meta->>'note' as note, p.layout, p.block_id, p.meta->>'marked_at' as marked_at
  from copy_pin p join copy c on c.id = p.copy_id
  where p.kind = 'finding' and p.meta ? 'verdict'
  order by p.created_at desc;
revoke all on finding_triage from public, anon, authenticated;
