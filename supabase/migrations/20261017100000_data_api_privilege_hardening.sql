-- Data API privilege hardening. ACLs and default ACLs only: no schema object, row or RLS policy changes.
--
-- Hosted projects created before Supabase's explicit-grants change still carry the old automatic grants:
-- every table, view, sequence and function that role postgres creates in public is handed to anon,
-- authenticated and service_role. RLS stops row reads and writes, but not TRUNCATE (or MAINTAIN), and
-- several older tables never had their grants trimmed (for example authenticated could INSERT
-- into daily_closes).
--
-- Target model:
--   anon            nothing on public tables, views, sequences or functions.
--   authenticated   SELECT on tables and views (RLS decides the rows) and EXECUTE on the RPCs that earlier
--                   migrations granted explicitly. All writes go through those SECURITY DEFINER RPCs.
--   service_role    used only by scripts/backup.mjs, which records backups in backup_records and otherwise
--                   talks to the storage and auth APIs. In public it holds SELECT and INSERT on backup_records
--                   and nothing else: no other table or view, no sequence, no function.
--
-- Revokes first, then the one explicit service_role grant (already present on a database that ran
-- 20261009090100_backup_records.sql, so it widens nothing).
--
-- PUBLIC's built-in EXECUTE default for new functions is deliberately left alone. A schema-scoped
-- "revoke execute on functions from public" is a no-op (verified: PostgreSQL only lets a global default
-- remove it), and the global form would also strip PUBLIC from every function postgres creates in any
-- schema (extension installs, pg_temp test helpers). The guard is the catalog test in
-- supabase/tests/data_api_privileges.test.sql, which fails if any public function is executable by
-- PUBLIC, anon or service_role, plus the repo convention of revoking PUBLIC in the migration that creates a function.

-- Tables and views.
revoke all on all tables in schema public from anon, service_role;
revoke insert, update, delete, truncate, references, trigger, maintain on all tables in schema public from authenticated;
grant select, insert on public.backup_records to service_role;

-- Sequences: the RPCs that draw from them are SECURITY DEFINER and run as the owner.
revoke all on all sequences in schema public from anon, authenticated, service_role;

-- Functions: PUBLIC, anon and service_role never call anything. The trigger function is not an RPC;
-- trigger execution does not check EXECUTE.
revoke all on all functions in schema public from public, anon, service_role;
revoke all on function public.reject_append_only_mutation() from authenticated;

-- Future objects created by postgres in public are no longer exposed automatically.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;
