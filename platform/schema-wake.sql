-- Instant runner wake-up (Jeremy, 2026-10-29). The runner sleeps when idle; a queued copy job or a change visitors see
-- now wakes it at once through the host's /wake address, instead of waiting for the once-a-minute check (which stays as
-- the backup). The wake secret lives in Supabase Vault as 'runner_wake_secret', the same value as the host's
-- WAKE_SECRET (set with `wrangler secret put WAKE_SECRET` in platform/host). Without the secret nothing is sent.
-- Undo: drop the two triggers.

create extension if not exists pg_net;

create or replace function wake_runner() returns trigger language plpgsql security definer set search_path = public as $$
declare s text;
begin
  select decrypted_secret into s from vault.decrypted_secrets where name = 'runner_wake_secret';
  if s is null then return null; end if;
  -- Sent after the change commits and never waits for an answer; a failed wake leaves it to the one-minute check.
  perform net.http_post(
    url := 'https://preserve-runner.jeremy-schwartz.workers.dev/wake',
    headers := jsonb_build_object('Authorization', 'Bearer ' || s, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000);
  return null;
end $$;
revoke execute on function wake_runner() from public, anon, authenticated;

drop trigger if exists wake_on_job on copy_job;
create trigger wake_on_job after insert on copy_job for each row when (new.state = 'queued') execute function wake_runner();
-- Once per statement: one change can queue several copies at once.
drop trigger if exists wake_on_serving on serving_outbox;
create trigger wake_on_serving after insert on serving_outbox for each statement execute function wake_runner();
