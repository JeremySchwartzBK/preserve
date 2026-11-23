-- Adobe Fonts connection (Jeremy, 2026-11-21/22; design: https://claude.ai/artifact/3CY4ExxxcE3SsLoyWC8eSV). Load after
-- schema-fonts.sql.
--
-- A designer pastes their Adobe Fonts API key once per studio. We keep one web project ("kit") named "Preserve" in
-- their Adobe account and add the Adobe fonts their Preserves use to it. The viewer then loads that kit from Adobe on
-- top of each Preserve, with the lookalike still underneath: if the kit stops loading, the lookalike shows.
--
-- Which Preserves get Adobe's fonts (decided by Jeremy):
--   - every Preserve in review, and every one accepted after connecting;
--   - Preserves accepted before connecting only if the person said yes to the one all-or-nothing question
--     (accepted_too), asked once when they connect;
--   - none while the connection is off: disconnected, or the key refused or the fonts not loading at the daily check.
--     Reconnecting restores them all. This is the one accepted exception to "accepted Preserves never change"
--     (stated in the help and Terms of Use).
--
-- The key itself is kept in Supabase Vault; this table holds only the Vault id. People see whether they are connected,
-- never the key. The runner reads it through adobe_key(), which only the runner's role may call.

create table if not exists studio_adobe (
  studio_id     uuid primary key references studio (id) on delete cascade,
  secret_id     uuid,                     -- vault.secrets id of the key; null once disconnected
  kit_id        text,                     -- the "Preserve" web project in their Adobe account (runner)
  state         text not null default 'checking'
                check (state in ('checking', 'ok', 'key-refused', 'not-loading', 'disconnected')),
  accepted_too  boolean,                  -- the one question at connect: Preserves accepted before connecting too? null = not answered
  families      jsonb not null default '{}',  -- Adobe family css name -> Adobe family id, or null when Adobe doesn't have it (runner)
  problem       text,                     -- what the last check found, for us (never shown as-is)
  connected_at  timestamptz,
  checked_at    timestamptz,              -- last key-and-load check (runner, daily)
  changed_by    uuid default auth.uid(),
  changed_at    timestamptz not null default now()
);

-- Every connect, disconnect and state change, with who and when.
create table if not exists studio_adobe_log (
  id         bigserial primary key,
  studio_id  uuid not null references studio (id) on delete cascade,
  event      text not null,               -- connect | disconnect | accepted-too | state:<state>
  detail     text,
  by_person  uuid default auth.uid(),
  at         timestamptz not null default now()
);

alter table studio_adobe enable row level security;
alter table studio_adobe_log enable row level security;
drop policy if exists studio_adobe_read on studio_adobe;
create policy studio_adobe_read on studio_adobe for select using (is_member(studio_id));
-- Only what the app needs: whether they are connected and whether the question was answered.
revoke select on studio_adobe from anon, authenticated;
grant select (studio_id, state, accepted_too, families, connected_at, checked_at) on studio_adobe to authenticated;

-- Connect (or replace the key): the key goes into Vault, the connection starts as 'checking' until the runner has
-- tried it against Adobe and made or found the kit.
create or replace function connect_adobe(api_key text) returns void language plpgsql security definer set search_path = public as $$
declare s uuid := my_studio(); old uuid; sid uuid;
begin
  if s is null then raise exception 'not-found'; end if;
  api_key := btrim(api_key);
  if api_key !~ '^[A-Za-z0-9]{20,80}$' then raise exception 'not-an-adobe-key'; end if;
  select secret_id into old from studio_adobe where studio_id = s for update;
  sid := vault.create_secret(api_key, 'adobe-fonts:' || s || ':' || gen_random_uuid(), 'Adobe Fonts API key for a studio');
  insert into studio_adobe (studio_id, secret_id, state, connected_at, changed_at)
    values (s, sid, 'checking', now(), now())
    on conflict (studio_id) do update set secret_id = sid, state = 'checking', problem = null, connected_at = now(), changed_by = auth.uid(), changed_at = now();
  if old is not null then delete from vault.secrets where id = old; end if;
  insert into studio_adobe_log (studio_id, event) values (s, 'connect');
end $$;

-- Disconnect: the key is deleted; every Preserve goes back to its lookalikes. The kit stays in their Adobe account
-- (theirs to delete) and is reused if they connect again.
create or replace function disconnect_adobe() returns void language plpgsql security definer set search_path = public as $$
declare s uuid := my_studio(); old uuid;
begin
  if s is null then raise exception 'not-found'; end if;
  select secret_id into old from studio_adobe where studio_id = s for update;
  update studio_adobe set secret_id = null, state = 'disconnected', changed_by = auth.uid(), changed_at = now() where studio_id = s;
  if old is not null then delete from vault.secrets where id = old; end if;
  insert into studio_adobe_log (studio_id, event) values (s, 'disconnect');
end $$;

-- The one question at connect: switch Preserves accepted before connecting to Adobe's fonts too. All or nothing.
create or replace function set_adobe_accepted_too(yes boolean) returns void language plpgsql security definer set search_path = public as $$
declare s uuid := my_studio();
begin
  update studio_adobe set accepted_too = yes, changed_by = auth.uid(), changed_at = now() where studio_id = s;
  if not found then raise exception 'not-connected'; end if;
  insert into studio_adobe_log (studio_id, event, detail) values (s, 'accepted-too', yes::text);
end $$;

-- The runner's only way to the key.
create or replace function adobe_key(s uuid) returns text language plpgsql stable security definer set search_path = public as $$
begin
  return (select v.decrypted_secret from studio_adobe a join vault.decrypted_secrets v on v.id = a.secret_id where a.studio_id = s);
end $$;

grant execute on function connect_adobe(text), disconnect_adobe(), set_adobe_accepted_too(boolean) to authenticated;
revoke execute on function adobe_key(uuid) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'preserve_runner') then
    grant execute on function adobe_key(uuid) to preserve_runner;
  end if;
end $$;

-- A change to the connection changes what visitors see on every Preserve of the studio: the runner updates them.
create or replace function studio_adobe_outbox() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into serving_outbox (copy_id) select id from copy where studio_id = coalesce(new.studio_id, old.studio_id) and status <> 'failed'
    on conflict (copy_id) do update set queued_at = now();
  if tg_op = 'UPDATE' and new.state is distinct from old.state then
    insert into studio_adobe_log (studio_id, event, detail) values (new.studio_id, 'state:' || new.state, new.problem);
  end if;
  return null;
end $$;
drop trigger if exists serving_outbox_studio_adobe on studio_adobe;
create trigger serving_outbox_studio_adobe after insert or update of state, accepted_too, kit_id, families or delete on studio_adobe
  for each row execute function studio_adobe_outbox();
