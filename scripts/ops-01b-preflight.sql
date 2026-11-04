-- OPS-01B production inventory gate (database side). READ-ONLY: every statement is a SELECT; run it against the
-- production database BEFORE the release window and keep the output as evidence. It prints ONE json line:
--   {"verdict":"PASS"|"STOP","checks":[{"id","ok","got"}...],"manual":[...]}
-- Any ok=false is a STOP: do not enter the release window; the reviewed assumptions below no longer hold.
--
-- Expected values are the reviewed state of production at migration 35 (20261031165915), captured from the local stack
-- built from the same migrations. A hosted-only difference (extra object, drifted function body, extra grant) shows up as
-- a STOP and must be understood by a human before the release is attempted. Nothing here is a statement of what production
-- "should" look like in general: it is what the OPS-01B migrations were reviewed against.
with
api_fns as (   -- every function in public that the signed-in API role can execute
  select p.oid, p.proname, p.oid::regprocedure::text as sig, p.provolatile, p.prosecdef, p.proconfig, p.proowner, p.prosrc
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
checks(id, ok, got) as (
  values
  ('C01 postgres major version is 17', (select current_setting('server_version_num')::int / 10000 = 17), (select to_jsonb(current_setting('server_version')))),
  ('C02 exactly the 35 reviewed migrations, last 20261031165915',
    (select count(*) = 35 and max(version) = '20261031165915' from supabase_migrations.schema_migrations),
    (select jsonb_build_object('count', count(*), 'latest', max(version)) from supabase_migrations.schema_migrations)),
  ('C03 none of the OPS-01B objects exist yet (maintenance state and controls, void, storage trigger, moved bodies)',
    (select to_regclass('private.system_maintenance') is null and to_regclass('public.invoice_voids') is null
       and not exists (select 1 from pg_proc p where p.proname in ('set_maintenance', 'set_maintenance_bypass', 'void_invoice', 'assert_not_in_maintenance', 'maintenance_admit', 'storage_receipt_maintenance_guard'))
       and not exists (select 1 from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname in ('submit_batch', 'record_payment', 'create_customer'))
       and not exists (select 1 from pg_trigger t where t.tgrelid = 'storage.objects'::regclass and t.tgname = 'expense_receipts_maintenance_guard')),
    (select jsonb_build_object('system_maintenance', to_regclass('private.system_maintenance')::text, 'invoice_voids', to_regclass('public.invoice_voids')::text))),
  ('C04 the API role executes exactly the 23 reviewed write RPCs and 9 reports, with the reviewed signatures and grants',
    (select count(*) = 32 and md5(string_agg(sig, '|' order by sig)) = '3803beb72a9d216a46538f66fdd1c301' from api_fns),
    (select jsonb_build_object('count', count(*), 'md5', md5(string_agg(sig, '|' order by sig))) from api_fns)),
  ('C05 the 32 function bodies, owners, security-definer flags and search_path settings are byte-identical to the reviewed ones (migration 36 moves them unchanged)',
    (select md5(string_agg(proname || '|' || prosecdef::text || '|' || coalesce(proconfig::text, '') || '|' || pg_get_userbyid(proowner) || '|' || prosrc, E'\n' order by proname)) = '5179935ff304c0d990bcde9eb78542bf' from api_fns),
    (select to_jsonb(md5(string_agg(proname || '|' || prosecdef::text || '|' || coalesce(proconfig::text, '') || '|' || pg_get_userbyid(proowner) || '|' || prosrc, E'\n' order by proname))) from api_fns)),
  ('C06 anon, service_role and PUBLIC cannot execute any public function',
    (select count(*) = 0 from pg_proc p where p.pronamespace = 'public'::regnamespace and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('service_role', p.oid, 'EXECUTE'))),
    (select to_jsonb(count(*)) from pg_proc p where p.pronamespace = 'public'::regnamespace and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('service_role', p.oid, 'EXECUTE')))),
  ('C07 no other schema offers a volatile (write-capable) function to anon or authenticated, except Supabase-owned schemas',
    (select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.provolatile = 'v' and n.nspname not in ('public', 'pg_catalog', 'information_schema', 'auth', 'storage', 'realtime', 'extensions', 'graphql', 'graphql_public', 'vault', 'supabase_functions', 'supabase_migrations', 'pgsodium', 'net', 'cron', 'pgbouncer')
        and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
    (select coalesce(jsonb_agg(p.oid::regprocedure::text), '[]') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.provolatile = 'v' and n.nspname not in ('public', 'pg_catalog', 'information_schema', 'auth', 'storage', 'realtime', 'extensions', 'graphql', 'graphql_public', 'vault', 'supabase_functions', 'supabase_migrations', 'pgsodium', 'net', 'cron', 'pgbouncer')
        and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')))),
  ('C08 direct table write grants: only service_role INSERT on backup_records (the backup tool); nothing for anon, authenticated or PUBLIC',
    (select coalesce(jsonb_agg(g.grantee || ':' || g.table_name || ':' || g.privilege_type order by g.grantee, g.table_name, g.privilege_type), '[]') = '["service_role:backup_records:INSERT"]'::jsonb
      from information_schema.role_table_grants g where g.table_schema = 'public' and g.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC') and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
    (select coalesce(jsonb_agg(g.grantee || ':' || g.table_name || ':' || g.privilege_type order by g.grantee, g.table_name, g.privilege_type), '[]')
      from information_schema.role_table_grants g where g.table_schema = 'public' and g.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC') and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'))),
  ('C09 row level security is on for every public table',
    (select count(*) = 0 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity),
    (select coalesce(jsonb_agg(c.relname), '[]') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity)),
  ('C10 the 24 public RLS policies are the reviewed ones',
    (select count(*) = 24 and md5(string_agg(tablename || policyname || cmd || roles::text || coalesce(qual, '') || coalesce(with_check, ''), '|' order by tablename, policyname)) = 'fe0cc76c0f07a988e98c5a4943569432' from pg_policies where schemaname = 'public'),
    (select jsonb_build_object('count', count(*), 'md5', md5(string_agg(tablename || policyname || cmd || roles::text || coalesce(qual, '') || coalesce(with_check, ''), '|' order by tablename, policyname))) from pg_policies where schemaname = 'public')),
  ('C11 the only Storage bucket is private expense-receipts with the reviewed size and type limits',
    (select count(*) = 1 and bool_and(id = 'expense-receipts' and not public and file_size_limit = 10485760 and allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) from storage.buckets),
    (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'public', public, 'limit', file_size_limit, 'types', allowed_mime_types)), '[]') from storage.buckets)),
  ('C12 storage.objects carries exactly the four reviewed expense-receipts policies, unchanged',
    (select count(*) = 4 and string_agg(policyname || ':' || cmd || ':' || md5(coalesce(qual, '') || '|' || coalesce(with_check, '')), ',' order by policyname) =
        'expense_receipts_no_delete:DELETE:a1f94f5b6390b515dc6714c2ca6f51b9,expense_receipts_no_update:UPDATE:18b6c82111707e214f8aaa30c5b6e717,expense_receipts_shop_insert:INSERT:4f6d10fb65fbb7ad45a6cbdc833e737f,expense_receipts_shop_read:SELECT:1429e0adada81893c106554f9f906d4a'
      from pg_policies where schemaname = 'storage' and tablename = 'objects'),
    (select coalesce(jsonb_agg(policyname || ':' || cmd || ':' || md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) order by policyname), '[]') from pg_policies where schemaname = 'storage' and tablename = 'objects')),
  ('C13 no trigger on storage.objects runs code outside the Storage schema, and the migration role may create one (migration 36 adds the receipt guard trigger)',
    (select count(*) = 0 from pg_trigger t where t.tgrelid = 'storage.objects'::regclass and not t.tgisinternal and t.tgfoid::regproc::text not like 'storage.%')
      and has_table_privilege('postgres', 'storage.objects', 'TRIGGER'),
    (select jsonb_build_object('foreign_triggers', (select coalesce(jsonb_agg(t.tgname), '[]') from pg_trigger t where t.tgrelid = 'storage.objects'::regclass and not t.tgisinternal and t.tgfoid::regproc::text not like 'storage.%'),
        'postgres_can_create_trigger', has_table_privilege('postgres', 'storage.objects', 'TRIGGER')))),
  ('C14 Realtime publishes no table (no change feed of business data)',
    (select count(*) = 0 from pg_publication_tables),
    (select coalesce(jsonb_agg(pubname || ':' || schemaname || '.' || tablename), '[]') from pg_publication_tables)),
  ('C15 the 46 triggers on public tables are the reviewed ones (no added webhook or mutation trigger)',
    (select count(*) = 46 and md5(string_agg(c.relname || '.' || t.tgname || '.' || t.tgfoid::regproc::text, '|' order by c.relname, t.tgname)) = 'c447e4f0df8549d625a6769175746f16'
      from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relnamespace = 'public'::regnamespace),
    (select jsonb_build_object('count', count(*), 'md5', md5(string_agg(c.relname || '.' || t.tgname || '.' || t.tgfoid::regproc::text, '|' order by c.relname, t.tgname)))
      from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relnamespace = 'public'::regnamespace)),
  ('C16 no scheduled job and no database webhook exists',
    (select (to_regclass('cron.job') is null or (xpath('/row/v/text()', query_to_xml('select count(*)::text v from cron.job', false, true, '')))[1]::text = '0')
       and (to_regclass('supabase_functions.hooks') is null or (xpath('/row/v/text()', query_to_xml('select count(*)::text v from supabase_functions.hooks', false, true, '')))[1]::text = '0')),
    (select jsonb_build_object('cron_jobs', case when to_regclass('cron.job') is null then null else (xpath('/row/v/text()', query_to_xml('select count(*)::text v from cron.job', false, true, '')))[1]::text end,
        'webhooks', case when to_regclass('supabase_functions.hooks') is null then null else (xpath('/row/v/text()', query_to_xml('select count(*)::text v from supabase_functions.hooks', false, true, '')))[1]::text end))),
  ('C17 exposed API schemas (when stored on the authenticator role) are only public and graphql_public',
    (select not exists (select 1 from pg_roles r, unnest(r.rolconfig) cfg, unnest(string_to_array(substring(cfg from '^pgrst\.db_schemas=(.*)$'), ',')) s
       where r.rolname = 'authenticator' and cfg like 'pgrst.db_schemas=%' and btrim(s) not in ('public', 'graphql_public'))),
    (select coalesce(jsonb_agg(cfg), '[]') from pg_roles r, unnest(r.rolconfig) cfg where r.rolname = 'authenticator' and cfg like 'pgrst.db_schemas=%'))
)
select jsonb_build_object(
  'verdict', case when bool_and(coalesce(ok, false)) then 'PASS' else 'STOP' end,
  'checks', jsonb_agg(jsonb_build_object('id', id, 'ok', coalesce(ok, false), 'got', got) order by id),
  -- Not visible from SQL: record the evidence by hand (commands in the runbook, section 4).
  'manual', jsonb_build_array(
    'Edge Functions: `supabase functions list --project-ref <ref>` is empty',
    'GraphQL: pg_graphql present? ' || coalesce((select 'yes (' || extversion || '): C08 proves no table mutation is granted; its function mutations go through the guarded RPCs' from pg_extension where extname = 'pg_graphql'), 'no'),
    'API settings: exposed schemas shown in the dashboard (Settings -> API) are public/graphql_public only (C17 covers it when the value is stored on the role)',
    'Auth hooks (dashboard -> Authentication -> Hooks): none that writes business data',
    'Extensions installed: ' || (select string_agg(extname, ', ' order by extname) from pg_extension))
) as preflight from checks;
