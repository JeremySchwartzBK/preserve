-- Private review links (production-readiness review, item A5, 2026-11-11). Load after schema-guards.sql.
-- A Preserve in review used to open for anyone who had its address with "?review" on the end. Now the app asks here
-- for a signed link, good for 12 hours, and the viewer checks the signature (platform/worker/src/index.js).
-- The secret lives in Supabase Vault under the name review_link_secret, and the viewer has the same value as
-- REVIEW_SECRET. Until both are set this returns null and the viewer accepts the plain parameter, as before.
-- Safe to run more than once.
create or replace function review_link(cid text) returns text language plpgsql stable security definer set search_path = public, extensions as $$
declare s text; exp bigint;
begin
  if not exists (select 1 from copy where id = cid and is_member(studio_id)) then raise exception 'not-found'; end if;
  begin
    select decrypted_secret into s from vault.decrypted_secrets where name = 'review_link_secret';
  exception when undefined_table or invalid_schema_name then s := null;  -- no Vault here (local test database)
  end;
  if coalesce(s, '') = '' then return null; end if;
  exp := floor(extract(epoch from now()))::bigint + 12 * 3600;
  return exp || '.' || encode(hmac(convert_to(cid || '.' || exp, 'utf8'), convert_to(s, 'utf8'), 'sha256'), 'hex');
end $$;
revoke execute on function review_link(text) from public, anon;
grant execute on function review_link(text) to authenticated;
