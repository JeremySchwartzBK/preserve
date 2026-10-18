-- Page-aware storage (2026-10-18, design A2): which R2 layout a version's files use. 1 = the original single-page
-- layout (copies/<id>/v<n>/{desktop,mobile}.html, a/*); 2 = the page layout (shared copies/<id>/a/*, pages under
-- copies/<id>/v<n>/p/<page>/). Versions made before this keep 1; the runner writes 2 for every new version.
-- Safe to run more than once.
alter table copy_version add column if not exists storage_format int not null default 1 check (storage_format in (1, 2));
