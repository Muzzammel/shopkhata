-- Owner-visible ledger of backups taken with scripts/backup.mjs.
--
-- Backups are taken and kept outside the application (see
-- docs/operations/backup-restore.md). The operator registers each one with
-- `node scripts/backup.mjs record --from <dir>`, which re-checks every file
-- hash first. This table is what Admin > Backup & Recovery reads. No
-- application account can write to it: rows arrive only through the operator's
-- service-role session, and the application never holds that key.

create table public.backup_records (
  id uuid primary key default gen_random_uuid(),
  backup_created_at timestamptz not null,
  environment text not null check (environment ~ '^[a-z0-9-]{1,40}$'),
  source text not null check (length(source) between 1 and 200),
  app_version text check (length(app_version) <= 40),
  git_commit text check (git_commit ~ '^[0-9a-f]{7,64}$'),
  latest_migration text not null check (latest_migration ~ '^[0-9]{1,20}$'),
  dump_bytes bigint not null check (dump_bytes > 0),
  receipt_count integer not null check (receipt_count >= 0),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  -- Restore rehearsal (pnpm backup:verify) evidence, when one was run.
  restore_verified_at timestamptz,
  restore_verified_ok boolean,
  recorded_at timestamptz not null default now(),
  check ((restore_verified_at is null) = (restore_verified_ok is null)),
  -- Recording the same backup twice is a no-op; recording it again after a
  -- rehearsal adds the rehearsal as a new row.
  unique nulls not distinct (manifest_sha256, restore_verified_at)
);
create index backup_records_created_idx on public.backup_records(backup_created_at desc);

alter table public.backup_records enable row level security;
revoke all on public.backup_records from public,anon,authenticated;
grant select on public.backup_records to authenticated;
-- The operator tool may add records and read them back; it may not alter or remove one.
grant select, insert on public.backup_records to service_role;
create policy backup_records_owner_read on public.backup_records for select to authenticated using(private.is_owner());
create trigger backup_records_append_only before update or delete on public.backup_records for each row execute function public.reject_append_only_mutation();
