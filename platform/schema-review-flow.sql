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
