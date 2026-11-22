-- Checks on the database rules (run by test-db.sh). Each line either passes silently or stops the run.
create schema t; grant usage on schema t to public;
-- The statement must fail with a message matching the pattern.
create function t.fails(q text, pattern text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then
    if sqlerrm !~ pattern then raise exception 'expected error like "%", got "%": %', pattern, sqlerrm, q; end if;
    return;
  end;
  raise exception 'expected error like "%", but it worked: %', pattern, q;
end $$;
create function t.is(got anyelement, want anyelement, what text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception '%: got %, want %', what, got, want; end if; end $$;
create function t.as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, false) $$;
grant execute on all functions in schema t to public;

-- Two people sign up; each gets a studio.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'ann@example.com'), ('00000000-0000-0000-0000-00000000000b', 'bob@example.com');
select t.is((select count(*)::int from studio), 2, 'a studio per person');
update studio set copy_limit = 100, daily_limit = 3;

-- Not signed in: no functions at all.
set role anon;
select t.fails($$select request_copy('https://www.example-site.com/')$$, 'permission denied');
select t.fails($$select studio_copy_count('00000000-0000-0000-0000-00000000000a')$$, 'permission denied');
reset role;

-- Ann, signed in.
set role authenticated; select t.as_user('00000000-0000-0000-0000-00000000000a');
select t.fails($$select claim_copy_job('x')$$, 'permission denied');
select t.fails($$select enforce_copy_limit(my_studio())$$, 'permission denied');
-- Only ordinary public addresses.
select t.fails(format('select request_copy(%L)', u), 'bad-url') from unnest(array[
  'http://127.0.0.1/', 'http://localhost/', 'http://localhost:8080/health', 'https://www.site.com:8443/', 'https://user:pw@site.com/',
  'http://169.254.169.254/latest/meta-data', 'https://intranet/', 'http://[::1]/', 'https://db.internal/', 'https://printer.local/',
  'ftp://site.com/', 'https://site.com/a b', 'javascript:alert(1)', 'https://10.0.0.5/admin']) u;
select request_copy('https://www.first-site.com/');
select request_copy('https://second-site.co.uk/work?x=1');
select request_copy('http://third.squarespace.com');
-- The fourth in 24 hours is turned down, and deleting one doesn't give the allowance back.
select t.fails($$select request_copy('https://fourth-site.com/')$$, 'daily-limit');
select delete_copy((select id from copy where source_url like '%third%'));
select t.fails($$select request_copy('https://fourth-site.com/')$$, 'daily-limit');
select t.is((select count(*)::int from copy), 2, 'Ann sees her two Preserves');
-- Pins: long notes are turned down.
select t.fails(format($$insert into copy_pin (copy_id, kind, body) values (%L, 'credit', repeat('x', 2001))$$, (select id from copy limit 1)), 'note-too-long');
insert into copy_pin (copy_id, kind, body) select id, 'credit', 'Ann' from copy limit 1;
reset role;

-- Bob sees none of Ann's, and queues one of his own after hers.
set role authenticated; select t.as_user('00000000-0000-0000-0000-00000000000b');
select t.is((select count(*)::int from copy), 0, 'Bob sees nothing of Ann''s');
select t.is((select count(*)::int from copy_pin), 0, 'nor her pins');
select request_copy('https://bobs-site.com/');
reset role;

-- Fair queue: Ann's first job, then Bob's (Ann already has one running), then Ann's second.
update copy_job set queued_at = queued_at + (case when url like '%bob%' then interval '2 seconds' when url like '%second%' then interval '1 second' else interval '0' end);
select t.is((select url from claim_copy_job('w1')), 'https://www.first-site.com/', 'first claim');
select t.is((select url from claim_copy_job('w1')), 'https://bobs-site.com/', 'second claim goes to the other studio');
select t.is((select url from claim_copy_job('w1')), 'https://second-site.co.uk/work?x=1', 'third claim');
select t.is((select count(*)::int from claim_copy_job('w1')), 0, 'nothing left');

-- Accept only during review; once accepted it can't be pointed at another version.
insert into copy_version (copy_id, version, verdict) select id, v, 'pass' from copy, generate_series(1, 2) v where source_url like '%first%';
update copy set status = 'review' where source_url like '%first%';
set role authenticated; select t.as_user('00000000-0000-0000-0000-00000000000a');
select approve_copy((select id from copy where source_url like '%first%'), 2);
select t.is((select status || ' v' || live_version from copy where source_url like '%first%'), 'ready v2', 'accepted');
select t.fails(format('select approve_copy(%L, 1)', (select id from copy where source_url like '%first%')), 'not-ready');
select t.fails(format('select refine_copy(%L)', (select id from copy where source_url like '%first%')), 'not-in-review');
select t.fails(format($$update copy set live_version = 1 where id = %L$$, (select id from copy where source_url like '%first%')), 'permission denied');
reset role;
-- Private review links (schema-review-links.sql). No secret yet: nothing to sign with, so no token.
set role authenticated; select t.as_user('00000000-0000-0000-0000-00000000000a');
select t.is(review_link((select id from copy where source_url like '%second%')), null::text, 'no token before the secret is set');
reset role;
create schema vault; create table vault.decrypted_secrets (name text, decrypted_secret text);
insert into vault.decrypted_secrets values ('review_link_secret', 'test-secret');
-- The signing matches the viewer's and the runner's (the same fixed example is in test-review-links.mjs).
select t.is(encode(hmac(convert_to('abcd1234.2000000000', 'utf8'), convert_to('test-secret', 'utf8'), 'sha256'), 'hex'),
  '86861552fd66e66dcb51ea4e4a8dea4ac86c7be192fe65d8104b1670929e29ff', 'fixed example');
set role authenticated; select t.as_user('00000000-0000-0000-0000-00000000000a');
select t.is(tok ~ '^\d{10}\.[0-9a-f]{64}$' and split_part(tok, '.', 1)::bigint between extract(epoch from now())::bigint + 11 * 3600 and extract(epoch from now())::bigint + 13 * 3600,
  true, 'a signed token good for about 12 hours') from (select review_link((select id from copy where source_url like '%second%')) tok) x;
select t.fails($$select decrypted_secret from vault.decrypted_secrets$$, 'permission denied');
select t.as_user('00000000-0000-0000-0000-00000000000b');
select t.fails(format('select review_link(%L)', (select id from copy where source_url like '%bob%') || 'x'), 'not-found');
reset role;
select t.fails(format($$set role authenticated; select t.as_user('00000000-0000-0000-0000-00000000000b'); select review_link(%L)$$, (select id from copy where source_url like '%second%')), 'not-found');
reset role;
set role anon;
select t.fails($$select review_link('abcd1234')$$, 'permission denied');
reset role;

-- Adobe Fonts connection (schema-adobe.sql). Vault stand-in: secrets with ids, and create_secret.
alter table vault.decrypted_secrets add column id uuid default gen_random_uuid();
create view vault.secrets as select * from vault.decrypted_secrets;
create function vault.create_secret(secret text, name text, description text) returns uuid language sql as $$
  insert into vault.decrypted_secrets (name, decrypted_secret) values (name, secret) returning id $$;
set role authenticated; select t.as_user('00000000-0000-0000-0000-00000000000a');
select t.fails($$select connect_adobe('not a key!')$$, 'not-an-adobe-key');
select connect_adobe('  abcdef0123456789abcdef0123456789abcdef01  ');
select t.is((select state from studio_adobe), 'checking', 'connecting starts with a check');
select t.fails($$select secret_id from studio_adobe$$, 'permission denied');
select t.fails($$select adobe_key(my_studio())$$, 'permission denied');
select t.fails($$select decrypted_secret from vault.decrypted_secrets$$, 'permission denied');
select set_adobe_accepted_too(true);
select t.is((select accepted_too from studio_adobe), true, 'the one question is recorded');
reset role;
select t.is(adobe_key(s.id), 'abcdef0123456789abcdef0123456789abcdef01', 'the key, trimmed, for the runner only')
  from studio s join studio_adobe a on a.studio_id = s.id;
select t.is((select count(*) from serving_outbox o join copy c on c.id = o.copy_id join studio_adobe a on a.studio_id = c.studio_id) > 0, true, 'connecting updates the studio''s Preserves');
set role authenticated; select t.as_user('00000000-0000-0000-0000-00000000000b');
select t.is((select count(*) from studio_adobe), 0::bigint, 'another studio sees nothing');
select t.fails($$select set_adobe_accepted_too(false)$$, 'not-connected');
select t.as_user('00000000-0000-0000-0000-00000000000a');
select connect_adobe('ffffffff0123456789abcdef0123456789abcdef');
reset role;
select t.is((select count(*) from vault.decrypted_secrets where name like 'adobe-fonts:%'), 1::bigint, 'a new key replaces the old one in the vault');
set role authenticated; select t.as_user('00000000-0000-0000-0000-00000000000a');
select disconnect_adobe();
select t.is((select state from studio_adobe), 'disconnected', 'disconnect');
reset role;
select t.is((select count(*) from vault.decrypted_secrets where name like 'adobe-fonts:%'), 0::bigint, 'disconnect deletes the key');
select t.is((select count(*) from studio_adobe_log), 5::bigint, 'every step is logged');
\echo database rules: all checks pass
