-- Release-window snapshot. READ-ONLY; run as the database owner (it must see every shop). Prints ONE json line.
--
-- It uses the same per-table technique as backup-fingerprint.sql (row count + hash of every row), but keeps the
-- release-control rows apart from the business rows so scripts/window-compare.mjs can tell an expected change (the
-- maintenance audit trail, applied migrations, a declared operator smoke) from an unexpected one. Do not use plain
-- equality of backup fingerprints across a release: migrations legitimately change the shape of the report totals.
select jsonb_build_object(
  'at', clock_timestamp(),
  -- Every public base table except the audit trail, whatever migrations have added to the schema.
  'tables', (
    select jsonb_object_agg(t.table_name, (xpath('/row/v/text()', query_to_xml(format(
      'select count(*) || '':'' || coalesce(md5(string_agg(r::text, ''|'' order by r::text)), '''') v from public.%I r', t.table_name), false, true, '')))[1]::text)
    from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE' and t.table_name <> 'audit_events'),
  -- The audit trail, split: business audit rows must not move; maintenance.* rows are release control.
  'audit_business', (select count(*) || ':' || coalesce(md5(string_agg(a::text, '|' order by a::text)), '') from public.audit_events a where a.action not like 'maintenance.%'),
  'audit_maintenance', (select coalesce(jsonb_agg(a.action order by (a.metadata ->> 'at')::timestamptz, a.id), '[]') from public.audit_events a where a.action like 'maintenance.%'),
  'receipts', (select count(*) || ':' || coalesce(md5(string_agg(o.name || ':' || coalesce(o.metadata ->> 'size', ''), '|' order by o.name)), '') from storage.objects o where o.bucket_id = 'expense-receipts'),
  'auth_users', (select count(*) || ':' || coalesce(md5(string_agg(u.id || u.email || coalesce(u.encrypted_password, ''), '|' order by u.id)), '') from auth.users u),
  'migrations', (select coalesce(jsonb_agg(m.version order by m.version), '[]') from supabase_migrations.schema_migrations m),
  -- null before migration 36 exists
  'maintenance', case when to_regclass('private.system_maintenance') is null then null else
    (xpath('/row/v/text()', query_to_xml('select enabled::text || '':'' || (bypass_user_id is not null)::text v from private.system_maintenance', false, true, '')))[1]::text end
) as snapshot;
