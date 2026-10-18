-- Pages and stored captures (2026-10-18). Two things later work builds on without reshaping data:
--   1. A page level: a copy is a set of pages (today always one, the page the person submitted). Pins, versions and
--      captures say which page they belong to. Design: product/runner-and-pages-design.md, section A1.
--   2. The original capture of each page is kept (privately, in R2 under captures/<copy>/<page>/) while the copy is
--      being built or refined, so refinements and fixes can rebuild from what the site looked like at capture time.
--      Retention (Jeremy, 2026-10-18): deleted when the copy is accepted, or after 30 days with no activity if it never
--      is, or when the copy is deleted. The copy runner does the deleting (runner.mjs, sweepCaptures).
-- Safe to run more than once.

-- Pages ------------------------------------------------------------------------------------------------------------
create table if not exists copy_page (
  copy_id     text not null references copy (id) on delete cascade,
  page_id     text not null check (page_id ~ '^[a-z0-9]{4}$'),              -- short, random, stable for the copy's life
  path        text not null check (path ~ '^([a-z0-9-]+(/[a-z0-9-]+)*)?$'),  -- '' = the entry page; 'about', 'work/kosa'
  source_url  text not null,
  title       text,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  primary key (copy_id, page_id),
  unique (copy_id, path),
  -- First path segments the viewer uses for its own routes.
  check (split_part(path, '/', 1) not in ('a', 'desktop', 'mobile', '_p', 'c'))
);
alter table copy_page enable row level security;
drop policy if exists page_read on copy_page;
create policy page_read on copy_page for select using (exists (select 1 from copy c where c.id = copy_id and is_member(c.studio_id)));
revoke insert, update, delete on copy_page from authenticated, anon;

create or replace function new_page_id(cid text) returns text language plpgsql as $$
declare pid text;
begin
  loop
    pid := array_to_string(array(select substr('abcdefghijkmnpqrstuvwxyz23456789', 1 + floor(random() * 32)::int, 1) from generate_series(1, 4)), '');
    exit when not exists (select 1 from copy_page where copy_id = cid and page_id = pid);
  end loop;
  return pid;
end $$;

-- Every copy starts with its entry page.
create or replace function copy_page_add_entry() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into copy_page (copy_id, page_id, path, source_url) values (new.id, new_page_id(new.id), '', new.source_url)
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists copy_page_add_entry on copy;
create trigger copy_page_add_entry after insert on copy for each row execute function copy_page_add_entry();

insert into copy_page (copy_id, page_id, path, source_url, title)
select c.id, new_page_id(c.id), '', c.source_url, c.title from copy c
where not exists (select 1 from copy_page p where p.copy_id = c.id);

alter table copy add column if not exists page_count int not null default 1;  -- for pricing by pages, if we ever do

-- Pins belong to a page, except credits, which are for the whole copy. A pin added without a page goes on the entry
-- page, so today's app needs no change.
alter table copy_pin add column if not exists page_id text;
update copy_pin p set page_id = cp.page_id from copy_page cp
where cp.copy_id = p.copy_id and cp.path = '' and p.page_id is null and p.kind <> 'credit';
create or replace function copy_pin_default_page() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.page_id is null and new.kind <> 'credit' then
    select page_id into new.page_id from copy_page where copy_id = new.copy_id and path = '';
  end if;
  return new;
end $$;
drop trigger if exists copy_pin_default_page on copy_pin;
create trigger copy_pin_default_page before insert on copy_pin for each row execute function copy_pin_default_page();
alter table copy_pin drop constraint if exists copy_pin_page;
alter table copy_pin add constraint copy_pin_page foreign key (copy_id, page_id) references copy_page (copy_id, page_id) on delete cascade;
alter table copy_pin drop constraint if exists copy_pin_page_needed;
alter table copy_pin add constraint copy_pin_page_needed check (page_id is not null or kind = 'credit');

-- Versions ---------------------------------------------------------------------------------------------------------
-- A version is the whole copy (every page). pages: [{page_id, path, verdict, findings, files}].
-- pipeline_version: the code that made it (git commit, "+dirty" if the checkout had local changes).
alter table copy_version add column if not exists pages jsonb not null default '[]';
alter table copy_version add column if not exists pipeline_version text;
update copy_version v set pages = jsonb_build_array(jsonb_build_object('page_id', cp.page_id, 'path', '', 'verdict', v.verdict, 'files', v.file_count))
from copy_page cp where cp.copy_id = v.copy_id and cp.path = '' and v.pages = '[]';

-- A job's version number is reserved when the job is queued, so two jobs (or two runners) can't pick the same one.
alter table copy add column if not exists next_version int not null default 1;
update copy c set next_version = greatest(c.next_version, 1 + coalesce((select max(version) from copy_version v where v.copy_id = c.id), 0),
  1 + coalesce((select max(version) from copy_job j where j.copy_id = c.id), 0));
create or replace function copy_job_reserve_version() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.version is null then
    update copy set next_version = next_version + 1 where id = new.copy_id returning next_version - 1 into new.version;
  end if;
  return new;
end $$;
drop trigger if exists copy_job_reserve_version on copy_job;
create trigger copy_job_reserve_version before insert on copy_job for each row execute function copy_job_reserve_version();
-- Jobs already queued from before this migration get theirs now.
update copy_job j set version = r.v from (
  select j2.id, c.next_version - 1 + row_number() over (partition by j2.copy_id order by j2.queued_at) as v
  from copy_job j2 join copy c on c.id = j2.copy_id where j2.version is null and j2.state in ('queued', 'working')) r
where r.id = j.id;
update copy c set next_version = 1 + (select max(version) from copy_job j where j.copy_id = c.id)
where (select max(version) from copy_job j where j.copy_id = c.id) >= c.next_version;

-- Stored captures --------------------------------------------------------------------------------------------------
-- One row per stored capture (one page, one job). Kept after its copy is deleted (no foreign key), so the runner can
-- still find and delete the files. Never visible to people: the files hold the site's real contact details.
create table if not exists copy_capture (
  id          uuid primary key default gen_random_uuid(),
  copy_id     text not null,
  page_id     text not null,
  job_id      uuid,
  attempt     int,
  prefix      text not null unique,           -- captures/<copy>/<page>/a<attempt>/ in the preserve-copies bucket
  parts       int not null,                   -- part-000 ... (tar.gz split so each upload stays small)
  bytes       bigint not null,
  files       int,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_why text check (deleted_why in ('accepted', 'idle', 'copy-deleted'))
);
create index if not exists copy_capture_kept on copy_capture (copy_id) where deleted_at is null;
alter table copy_capture enable row level security;
revoke all on copy_capture from anon, authenticated;

-- Which stored captures are due for deletion, and why. Accepted = the copy has a live version (accepted copies never
-- change, so the capture has no further use). Idle = never accepted and nothing has happened for 30 days.
create or replace view capture_due as
select k.id, k.prefix, k.parts,
  case when c.id is null then 'copy-deleted' when c.live_version is not null then 'accepted' else 'idle' end as why
from copy_capture k left join copy c on c.id = k.copy_id
where k.deleted_at is null and (
  c.id is null or c.live_version is not null or
  greatest(c.updated_at, k.created_at,
    (select max(greatest(p.created_at, p.resolved_at, (p.meta->>'marked_at')::timestamptz)) from copy_pin p where p.copy_id = c.id),
    (select max(j.queued_at) from copy_job j where j.copy_id = c.id)) < now() - interval '30 days');
revoke all on capture_due from anon, authenticated;
