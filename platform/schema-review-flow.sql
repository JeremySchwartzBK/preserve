-- Review flow feedback (Jeremy, 2026-10-26). Review ends with "Accept Preserve" after the look-and-feel check, the
-- tour and the credits. An accepted Preserve can't be refined (refine_copy already needs status 'review').
--
-- Accepting goes live when the plan has room for another live Preserve, and otherwise starts in Archived. A plan
-- limits LIVE Preserves (ready or paused); making a new one still checks the ones in use (request_copy, unchanged).
-- Restoring an archived Preserve checks live ones the same way as accepting does.
--
-- Suspected-issue answers (copy_pin kind 'finding', meta.verdict) are now 'ignore' (real, but leave it), 'fix'
-- (real, fix it in a refinement) and 'not-a-problem' (the check got it wrong). Older rows may say 'fine', which the
-- app shows as "Not an issue". Only 'fix' feeds a refinement, as before, so refine_copy is unchanged.

create or replace function live_copy_count(s uuid) returns int language sql stable as $$
  select count(*)::int from copy where studio_id = s and status in ('ready', 'paused');
$$;

create or replace function approve_copy(cid text, ver int) returns void language plpgsql security definer set search_path = public as $$
declare c copy; room boolean;
begin
  -- Lock the studio's row so two accepts at once can't both take the last live spot.
  select * into c from copy where id = cid and is_member(studio_id);
  if c.id is null then raise exception 'not-found'; end if;
  perform 1 from studio where id = c.studio_id for update;
  if c.status not in ('review', 'ready') then raise exception 'not-ready'; end if;
  if not exists (select 1 from copy_version where copy_id = cid and version = ver) then raise exception 'no-such-version'; end if;
  room := c.status = 'ready' or live_copy_count(c.studio_id) < (select copy_limit from studio where id = c.studio_id);
  update copy_version set approved_at = now() where copy_id = cid and version = ver;
  update copy_pin set resolved_at = now() where copy_id = cid and resolved_at is null
    and ((kind = 'issue' and coalesce(meta->>'report', '') = '') or kind = 'finding');
  update copy set status = case when room then 'ready' else 'archived' end, live_version = ver, updated_at = now() where id = cid;
end $$;

create or replace function set_copy_status(cid text, new_status text) returns void language plpgsql security definer set search_path = public as $$
declare c copy;
begin
  select * into c from copy where id = cid and is_member(studio_id);
  if c.id is null then raise exception 'not-found'; end if;
  perform 1 from studio where id = c.studio_id for update;
  if new_status not in ('archived', 'ready', 'paused') then raise exception 'bad-status'; end if;
  if c.status in ('processing', 'failed', 'review') then raise exception 'not-allowed'; end if;
  if new_status = 'ready' then
    if c.live_version is null then raise exception 'never-approved'; end if;
    if c.status = 'archived' and live_copy_count(c.studio_id) >= (select copy_limit from studio where id = c.studio_id) then
      raise exception 'plan-limit' using hint = 'Your plan''s live Preserves are all in use. Upgrade or archive one.';
    end if;
  end if;
  update copy set status = new_status, updated_at = now() where id = cid;
end $$;

grant execute on function live_copy_count(uuid) to authenticated;

-- Refinements (Jeremy, 2026-10-27): no one should have to pin the same issue twice. Every open pin goes into each
-- round, and the runner records how each one came out (copy_pin meta.round_result: looks-fixed, still-different or
-- not-found). A pin still different after a round is enough to ask for another one, without pinning it again.
create or replace function refine_copy(cid text) returns int language plpgsql security definer set search_path = public as $$
declare c copy; pins jsonb; last_round timestamptz; rounds int;
begin
  select * into c from copy where id = cid and is_member(studio_id);
  if c.id is null then raise exception 'not-found'; end if;
  if c.status <> 'review' then raise exception 'not-in-review'; end if;
  select count(*) - 1, max(queued_at) into rounds, last_round from copy_job where copy_id = cid;
  if rounds >= 20 then raise exception 'refine-cap'; end if;
  if not exists (select 1 from copy_pin where copy_id = cid and resolved_at is null and (
        (kind = 'issue' and coalesce(meta->>'report', '') = '' and (created_at > last_round or meta->>'round_result' in ('still-different', 'not-found')))
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
