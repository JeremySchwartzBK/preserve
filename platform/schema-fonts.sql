-- The Fonts step on real Preserves (Jeremy, 2026-10-29: the demo's font review in production). Load after
-- schema-review-flow.sql.
--
-- Each version records its fonts that need a person's look (copy_version.fonts, written by the runner): one row per font
-- family, with who holds the license, the picture from the live site and the lookalike. The person's choice per font is
-- copy_font; every choice, upload and the confirmation at Accept Preserve is kept in copy_font_log with who and when.
-- Choices are made only during review: an accepted Preserve never changes.
--
-- Uploaded font files ("Your fonts") belong to the studio (studio_font), so a later Preserve using the same font is
-- covered by the upload. Font files are small, so the file itself is kept here; the runner checks that it is the font it
-- claims to be, converts it for the web and puts it beside each Preserve that uses it. The viewer then draws the font
-- from that file (or from the lookalike) without rebuilding the Preserve.

alter table copy_version add column if not exists fonts jsonb;

create table if not exists studio_font (
  id          uuid primary key default gen_random_uuid(),
  studio_id   uuid not null references studio (id) on delete cascade,
  font_key    text not null,            -- the font's id in the review rows (its family name, squashed)
  name        text not null,            -- the font's name as the review shows it
  file_name   text not null,            -- as uploaded
  data        bytea not null,           -- the uploaded file
  web         bytea,                    -- the checked file, as WOFF2 (runner)
  asset       text,                     -- its name beside each Preserve (copies/<id>/a/<asset>), a content hash
  state       text not null default 'checking' check (state in ('checking', 'ok', 'rejected')),
  problem     text,                     -- why it was turned down, in the person's words
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists studio_font_key on studio_font (studio_id, font_key);

create table if not exists copy_font (
  copy_id         text not null references copy (id) on delete cascade,
  font_id         text not null,
  decision        text not null check (decision in ('keep', 'lookalike', 'upload')),
  studio_font_id  uuid references studio_font (id) on delete set null,
  decided_by      uuid default auth.uid(),
  decided_at      timestamptz not null default now(),
  primary key (copy_id, font_id)
);

create table if not exists copy_font_log (
  id         bigserial primary key,
  copy_id    text not null references copy (id) on delete cascade,
  font_id    text,
  decision   text not null,             -- keep | lookalike | upload | certify (the confirmation at Accept Preserve)
  file_name  text,
  cert       jsonb,                     -- certify: the fonts confirmed and the wording the person agreed to
  by_person  uuid default auth.uid(),
  at         timestamptz not null default now()
);

alter table studio_font enable row level security;
alter table copy_font enable row level security;
alter table copy_font_log enable row level security;
drop policy if exists studio_font_read on studio_font;
create policy studio_font_read on studio_font for select using (is_member(studio_id));
drop policy if exists copy_font_read on copy_font;
create policy copy_font_read on copy_font for select using (exists (select 1 from copy c where c.id = copy_id and is_member(c.studio_id)));
drop policy if exists copy_font_log_read on copy_font_log;
create policy copy_font_log_read on copy_font_log for select using (exists (select 1 from copy c where c.id = copy_id and is_member(c.studio_id)));
-- The app never reads the files themselves.
revoke select on studio_font from anon, authenticated;
grant select (id, studio_id, font_key, name, file_name, asset, state, problem, created_at) on studio_font to authenticated;

-- The font row the person is answering, from the Preserve's latest version.
create or replace function review_font(cid text, fid text) returns jsonb language sql stable security definer set search_path = public as $$
  select e from copy_version v, jsonb_array_elements(coalesce(v.fonts, '[]')) e
  where v.copy_id = cid and e->>'id' = fid order by v.version desc limit 1;
$$;

create or replace function font_copy(cid text) returns copy language plpgsql stable security definer set search_path = public as $$
declare c copy;
begin
  select * into c from copy where id = cid and is_member(studio_id);
  if c.id is null then raise exception 'not-found'; end if;
  if c.status <> 'review' then raise exception 'not-in-review'; end if;
  return c;
end $$;

-- "I have the rights" (keep) or a lookalike.
create or replace function set_font_choice(cid text, fid text, choice text) returns void language plpgsql security definer set search_path = public as $$
declare c copy := font_copy(cid);
begin
  if choice not in ('keep', 'lookalike') then raise exception 'bad-choice'; end if;
  if review_font(cid, fid) is null then raise exception 'no-such-font'; end if;
  insert into copy_font (copy_id, font_id, decision) values (cid, fid, choice)
    on conflict (copy_id, font_id) do update set decision = excluded.decision, studio_font_id = null, decided_by = auth.uid(), decided_at = now();
  insert into copy_font_log (copy_id, font_id, decision) values (cid, fid, choice);
end $$;

-- An uploaded font file (base64). It is checked by the runner; until then the row reads "checking".
create or replace function upload_font(cid text, fid text, fname text, b64 text) returns uuid language plpgsql security definer set search_path = public as $$
declare c copy := font_copy(cid); f jsonb := review_font(cid, fid); bytes bytea; sid uuid;
begin
  if f is null then raise exception 'no-such-font'; end if;
  if fname !~* '\.(woff2|woff|otf|ttf)$' then raise exception 'not-a-font'; end if;
  bytes := decode(b64, 'base64');
  if length(bytes) > 5 * 1024 * 1024 then raise exception 'font-too-big'; end if;
  insert into studio_font (studio_id, font_key, name, file_name, data) values (c.studio_id, fid, coalesce(f->>'name', fid), fname, bytes) returning id into sid;
  insert into copy_font (copy_id, font_id, decision, studio_font_id) values (cid, fid, 'upload', sid)
    on conflict (copy_id, font_id) do update set decision = 'upload', studio_font_id = sid, decided_by = auth.uid(), decided_at = now();
  insert into copy_font_log (copy_id, font_id, decision, file_name) values (cid, fid, 'upload', fname);
  return sid;
end $$;

-- The confirmation above Accept Preserve: which fonts stay as on the site, in the words the person agreed to.
create or replace function certify_fonts(cid text, cert jsonb) returns void language plpgsql security definer set search_path = public as $$
declare c copy := font_copy(cid);
begin
  insert into copy_font_log (copy_id, decision, cert) values (cid, 'certify', cert);
end $$;

grant execute on function set_font_choice(text, text, text), upload_font(text, text, text, text), certify_fonts(text, jsonb) to authenticated;
revoke execute on function review_font(text, text), font_copy(text) from public, anon, authenticated;

-- A choice, or a checked upload, changes what visitors see: the runner updates the Preserve's fonts for the viewer.
drop trigger if exists serving_outbox_font on copy_font;
create trigger serving_outbox_font after insert or update or delete on copy_font for each row execute function serving_outbox_add();
create or replace function studio_font_outbox() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into serving_outbox (copy_id) select id from copy where studio_id = coalesce(new.studio_id, old.studio_id) and status <> 'failed'
    on conflict (copy_id) do update set queued_at = now();
  return null;
end $$;
drop trigger if exists serving_outbox_studio_font on studio_font;
create trigger serving_outbox_studio_font after insert or update of state, asset or delete on studio_font for each row execute function studio_font_outbox();
