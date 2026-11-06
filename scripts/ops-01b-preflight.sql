-- OPS-01B production inventory gate (database side). READ-ONLY: every statement is a SELECT; run it against the
-- production database BEFORE the release window and keep the output as evidence. It prints ONE json line:
--   {"verdict":"PASS"|"STOP","checks":[{"id","ok","got"}...],"evidence":{...},"manual":[...]}
-- Any ok=false is a STOP: do not enter the release window; the reviewed assumptions below no longer hold.
--
-- RUN IT OVER THE SAME CONNECTION PATH THAT WILL APPLY MIGRATION 36 ($DB_URL + PGPASSWORD, `supabase db query --db-url`).
-- Each CLI call is its own session; what C13c checks is the role and privileges of that path, i.e. of the migration
-- role (current_user/session_user are recorded in "evidence"). What this gate can and cannot prove is listed in the runbook (section 4.1, "What C13
-- proves"): it proves the catalog prerequisites of `CREATE TRIGGER` on storage.objects, not that the hosted DDL will
-- succeed; migration 36 itself is therefore a controlled bootstrap gate followed by scripts/ops-01b-post36-verify.sql.
--
-- Expected values are the reviewed state of production at migration 35 (20261031165915), captured from the local stack
-- built from the same migrations. A hosted-only difference (extra object, drifted function body, extra grant) shows up as
-- a STOP and must be understood by a human before the release is attempted.
-- LINE-ENDING CANONICALIZATION (C05, C15). One rule for every function-body fingerprint in the OPS-01B gates:
-- a body is hashed as regexp_replace(prosrc, E'\r\n?', E'\n', 'g'): CRLF -> LF, then any remaining lone CR -> LF.
-- Nothing else is normalized: spaces, tabs, comments, case and every other character stay significant. PostgreSQL keeps
-- prosrc byte-for-byte as the migration file was materialized by Git (core.autocrlf), so a raw hash differs between an LF
-- and a CRLF checkout of the same reviewed migration (P1A 2026-11-05: production bodies carry CRLF, the reference LF).
with
-- Schemas owned and managed by Supabase itself. Everything else (public, private, graphql_public, any schema someone
-- added) is inventoried for mutation paths.
internal(nspname) as (values ('pg_catalog'), ('information_schema'), ('pg_toast'), ('auth'), ('storage'), ('realtime'), ('_realtime'),
  ('vault'), ('extensions'), ('graphql'), ('supabase_functions'), ('supabase_migrations'), ('pgsodium'), ('pgsodium_masks'), ('net'),
  ('cron'), ('pgbouncer'), ('_analytics'), ('pgtle'), ('topology')),
app_rel as (   -- every relation an API role could reach outside the Supabase-internal schemas
  select c.oid, n.nspname, c.relname, c.relkind, c.reloptions, c.relacl from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and n.nspname not in (select nspname from internal)
    and n.nspname not like 'pg\_temp\_%' and n.nspname not like 'pg\_toast\_temp\_%'),
-- C08: EFFECTIVE direct mutation rights (has_*_privilege follows PUBLIC grants and role membership, unlike
-- information_schema.role_table_grants).
write_rights as (
  select r.role || ':' || a.nspname || '.' || a.relname || ':' || p.priv as x
  from app_rel a cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
  cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('USAGE')) p(priv)
  where (a.relkind = 'S' and p.priv in ('USAGE', 'UPDATE') and has_sequence_privilege(r.role, a.oid, p.priv))
     or (a.relkind <> 'S' and p.priv <> 'USAGE' and has_table_privilege(r.role, a.oid, p.priv))),
public_grants as (   -- explicit grants to PUBLIC (grantee 0) on application relations, any privilege but SELECT
  select a.nspname || '.' || a.relname || ':' || g.privilege_type as x from app_rel a, aclexplode(a.relacl) g
  where g.grantee = 0 and g.privilege_type <> 'SELECT'),
views as (
  select a.nspname, a.relname, a.relkind::text as relkind, coalesce(a.reloptions::text, '') as opts, pg_relation_is_updatable(a.oid, false) & 28 as updatable,
    (select count(*) from pg_trigger t where t.tgrelid = a.oid and (t.tgtype & 64) <> 0) as instead_of,
    (select count(*) from pg_rewrite w where w.ev_class = a.oid and w.rulename <> '_RETURN') as rules,
    exists (select 1 from (values ('anon'), ('authenticated'), ('public')) r(role), (values ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
      where case when r.role = 'public' then exists (select 1 from aclexplode(a.relacl) g where g.grantee = 0 and g.privilege_type = p.priv)
                 else has_table_privilege(r.role, a.oid, p.priv) end) as api_write_grant
  from app_rel a where a.relkind in ('v', 'm', 'f')),
app_triggers as (
  select n.nspname, c.relname, t.tgname, t.tgenabled::text as tgenabled, t.tgtype, f.oid::regprocedure::text as fn, pg_get_triggerdef(t.oid) as def, md5(regexp_replace(f.prosrc, E'\r\n?', E'\n', 'g')) as body
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace join pg_proc f on f.oid = t.tgfoid
  where not t.tgisinternal and n.nspname not in (select nspname from internal)),
storage_triggers as (
  select t.tgname, t.tgenabled::text as tgenabled, t.tgtype, t.tgfoid::regprocedure::text as fn, pg_get_triggerdef(t.oid) as def
  from pg_trigger t where t.tgrelid = 'storage.objects'::regclass and not t.tgisinternal),
api_fns as (   -- every function in public that the signed-in API role can execute
  select p.oid, p.proname, p.oid::regprocedure::text as sig, p.provolatile, p.prosecdef, p.proconfig, p.proowner, regexp_replace(p.prosrc, E'\r\n?', E'\n', 'g') as prosrc   -- canonical body (C05)
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
objects_columns as (select jsonb_object_agg(attname, format_type(atttypid, atttypmod)) as cols from pg_attribute where attrelid = 'storage.objects'::regclass and attnum > 0 and not attisdropped),
checks(id, ok, got) as (
  values
  ('C01 postgres major version is 17', (select current_setting('server_version_num')::int / 10000 = 17), (select to_jsonb(current_setting('server_version')))),
  ('C02 exactly the 35 reviewed migrations, last 20261031165915',
    (select count(*) = 35 and max(version) = '20261031165915' from supabase_migrations.schema_migrations),
    (select jsonb_build_object('count', count(*), 'latest', max(version)) from supabase_migrations.schema_migrations)),
  ('C03 none of the OPS-01B objects exist yet (maintenance state and controls, restore context, void, storage trigger, moved bodies)',
    (select to_regclass('private.system_maintenance') is null and to_regclass('public.invoice_voids') is null
       and to_regclass('private.receipt_restore_objects') is null and to_regclass('private.receipt_restore_log') is null
       and not exists (select 1 from pg_proc p where p.proname in ('set_maintenance', 'set_maintenance_bypass', 'void_invoice', 'assert_not_in_maintenance', 'maintenance_admit', 'storage_receipt_maintenance_guard', 'receipt_restore_open', 'receipt_restore_close'))
       and not exists (select 1 from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname in ('submit_batch', 'record_payment', 'create_customer'))
       and not exists (select 1 from pg_trigger t where t.tgname = 'expense_receipts_maintenance_guard')),
    (select jsonb_build_object('system_maintenance', to_regclass('private.system_maintenance')::text, 'invoice_voids', to_regclass('public.invoice_voids')::text,
       'guard_trigger_name_taken', exists (select 1 from pg_trigger t where t.tgname = 'expense_receipts_maintenance_guard')))),
  ('C04 the API role executes exactly the 23 reviewed write RPCs and 9 reports, with the reviewed signatures and grants',
    (select count(*) = 32 and md5(string_agg(sig, '|' order by sig)) = '3803beb72a9d216a46538f66fdd1c301' from api_fns),
    (select jsonb_build_object('count', count(*), 'md5', md5(string_agg(sig, '|' order by sig))) from api_fns)),
  ('C05 the 32 function bodies, owners, security-definer flags and search_path settings are byte-identical to the reviewed ones (migration 36 moves them unchanged)',
    (select md5(string_agg(proname || '|' || prosecdef::text || '|' || coalesce(proconfig::text, '') || '|' || pg_get_userbyid(proowner) || '|' || prosrc, E'\n' order by proname)) = '81a19e9eeb0e97453269b242ac153eae' from api_fns),
    (select to_jsonb(md5(string_agg(proname || '|' || prosecdef::text || '|' || coalesce(proconfig::text, '') || '|' || pg_get_userbyid(proowner) || '|' || prosrc, E'\n' order by proname))) from api_fns)),
  ('C06 anon, service_role and PUBLIC cannot execute any public function',
    (select count(*) = 0 from pg_proc p where p.pronamespace = 'public'::regnamespace and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('service_role', p.oid, 'EXECUTE'))),
    (select to_jsonb(count(*)) from pg_proc p where p.pronamespace = 'public'::regnamespace and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('service_role', p.oid, 'EXECUTE')))),
  ('C07 no other schema offers a volatile (write-capable) function to anon or authenticated, except Supabase-owned schemas and the pg_graphql entry point (C21)',
    (select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.provolatile = 'v' and n.nspname not in ('public', 'graphql_public') and n.nspname not in (select nspname from internal)
        and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
    (select coalesce(jsonb_agg(p.oid::regprocedure::text), '[]') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.provolatile = 'v' and n.nspname not in ('public', 'graphql_public') and n.nspname not in (select nspname from internal)
        and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')))),
  ('C08 effective direct mutation rights (INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER, sequence USAGE/UPDATE) of anon, authenticated and service_role, including via PUBLIC, on every table, view, materialized view, foreign table and sequence outside the Supabase schemas: only service_role INSERT on backup_records',
    (select coalesce(jsonb_agg(x order by x), '[]') = '["service_role:public.backup_records:INSERT"]'::jsonb from write_rights),
    (select coalesce(jsonb_agg(x order by x), '[]') from write_rights)),
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
  ('C13a storage.objects has the columns the receipt guard and the restore context read, with the assumed types (id uuid, bucket_id text, name text, owner_id text)',
    (select cols ->> 'id' = 'uuid' and cols ->> 'bucket_id' = 'text' and cols ->> 'name' = 'text' and cols ->> 'owner_id' = 'text' from objects_columns),
    (select cols from objects_columns)),
  ('C13b storage.objects has no trigger running code outside the storage schema and every existing trigger is enabled (the guard is the only one migration 36 adds)',
    (select count(*) = 0 from storage_triggers where fn not like 'storage.%' or tgenabled <> 'O'),
    (select coalesce(jsonb_agg(jsonb_build_object('name', tgname, 'enabled', tgenabled, 'function', fn, 'definition', def) order by tgname), '[]') from storage_triggers)),
  ('C13c the role of THIS connection path (= the migration role when run over the same $DB_URL) has every catalog prerequisite migration 36 needs: TRIGGER on storage.objects, USAGE on schema storage, CREATE on schemas private and public, PL/pgSQL installed and usable, EXECUTE on private.is_valid_uuid_text, and ownership (or membership of the owner) of every public write RPC it moves',
    (select has_table_privilege(current_user, 'storage.objects', 'TRIGGER') and has_schema_privilege(current_user, 'storage', 'USAGE')
       and has_schema_privilege(current_user, 'private', 'CREATE') and has_schema_privilege(current_user, 'public', 'CREATE')
       and exists (select 1 from pg_language where lanname = 'plpgsql') and has_language_privilege(current_user, 'plpgsql', 'USAGE')
       and to_regprocedure('private.is_valid_uuid_text(text)') is not null and has_function_privilege(current_user, 'private.is_valid_uuid_text(text)', 'EXECUTE')
       and (select bool_and(pg_has_role(current_user, proowner, 'MEMBER')) from api_fns where provolatile = 'v')),
    (select jsonb_build_object('current_user', current_user, 'session_user', session_user,
       'trigger_on_objects', has_table_privilege(current_user, 'storage.objects', 'TRIGGER'), 'usage_storage', has_schema_privilege(current_user, 'storage', 'USAGE'),
       'create_private', has_schema_privilege(current_user, 'private', 'CREATE'), 'create_public', has_schema_privilege(current_user, 'public', 'CREATE'),
       'plpgsql', exists (select 1 from pg_language where lanname = 'plpgsql') and has_language_privilege(current_user, 'plpgsql', 'USAGE'),
       'is_valid_uuid_text', to_regprocedure('private.is_valid_uuid_text(text)') is not null,
       'owns_write_rpcs', (select bool_and(pg_has_role(current_user, proowner, 'MEMBER')) from api_fns where provolatile = 'v')))),
  ('C14 Realtime publishes no table (no change feed of business data)',
    (select count(*) = 0 from pg_publication_tables),
    (select coalesce(jsonb_agg(pubname || ':' || schemaname || '.' || tablename), '[]') from pg_publication_tables)),
  ('C15 the 46 application triggers are the reviewed ones: table, name, enabled state, timing/events, function identity and schema, full definition and function body',
    (select count(*) = 46 and md5(string_agg(concat_ws('|', nspname, relname, tgname, tgenabled, tgtype, fn, def, body), E'\n' order by nspname, relname, tgname)) = '0d7b1051a65dc974e1b7fa20368f38eb' from app_triggers),
    (select jsonb_build_object('count', count(*), 'md5', md5(string_agg(concat_ws('|', nspname, relname, tgname, tgenabled, tgtype, fn, def, body), E'\n' order by nspname, relname, tgname))) from app_triggers)),
  ('C15b no application trigger is disabled (a disabled integrity or audit trigger is a STOP)',
    (select count(*) = 0 from app_triggers where tgenabled <> 'O'),
    (select coalesce(jsonb_agg(nspname || '.' || relname || '.' || tgname || ':' || tgenabled), '[]') from app_triggers where tgenabled <> 'O')),
  ('C16 no scheduled job and no database webhook exists',
    (select (to_regclass('cron.job') is null or (xpath('/row/v/text()', query_to_xml('select count(*)::text v from cron.job', false, true, '')))[1]::text = '0')
       and (to_regclass('supabase_functions.hooks') is null or (xpath('/row/v/text()', query_to_xml('select count(*)::text v from supabase_functions.hooks', false, true, '')))[1]::text = '0')),
    (select jsonb_build_object('cron_jobs', case when to_regclass('cron.job') is null then null else (xpath('/row/v/text()', query_to_xml('select count(*)::text v from cron.job', false, true, '')))[1]::text end,
        'webhooks', case when to_regclass('supabase_functions.hooks') is null then null else (xpath('/row/v/text()', query_to_xml('select count(*)::text v from supabase_functions.hooks', false, true, '')))[1]::text end))),
  ('C17 exposed API schemas (when stored on the authenticator role) are only public and graphql_public',
    (select not exists (select 1 from pg_roles r, unnest(r.rolconfig) cfg, unnest(string_to_array(substring(cfg from '^pgrst\.db_schemas=(.*)$'), ',')) s
       where r.rolname = 'authenticator' and cfg like 'pgrst.db_schemas=%' and btrim(s) not in ('public', 'graphql_public'))),
    (select coalesce(jsonb_agg(cfg), '[]') from pg_roles r, unnest(r.rolconfig) cfg where r.rolname = 'authenticator' and cfg like 'pgrst.db_schemas=%')),
  ('C18 no explicit PUBLIC grant other than SELECT on any application relation',
    (select count(*) = 0 from public_grants),
    (select coalesce(jsonb_agg(x order by x), '[]') from public_grants)),
  ('C19 no view, materialized view or foreign table is a mutation path for anon, authenticated or PUBLIC (auto-updatable, INSTEAD OF trigger or rule, AND a write grant)',
    (select count(*) = 0 from views where (updatable <> 0 or instead_of > 0 or rules > 0) and api_write_grant),
    (select coalesce(jsonb_agg(nspname || '.' || relname order by nspname, relname), '[]') from views where (updatable <> 0 or instead_of > 0 or rules > 0) and api_write_grant)),
  ('C20 the 7 application views are the reviewed ones: name, security_invoker, updatability, INSTEAD OF triggers, rules',
    (select count(*) = 7 and md5(string_agg(concat_ws('|', nspname, relname, relkind, opts, updatable, instead_of, rules, api_write_grant), E'\n' order by nspname, relname)) = '70921428318cad9bf3e45fb25d23e950' from views),
    (select jsonb_build_object('count', count(*), 'md5', md5(string_agg(concat_ws('|', nspname, relname, relkind, opts, updatable, instead_of, rules, api_write_grant), E'\n' order by nspname, relname)),
       'views', jsonb_agg(concat_ws('|', nspname, relname, opts, updatable, instead_of, rules, api_write_grant) order by nspname, relname)) from views)),
  ('C21 the only function anon or authenticated may execute in an exposed schema other than public is the pg_graphql entry point graphql_public.graphql (its mutations resolve to the relations and functions C04-C08/C19 cover)',
    (select coalesce(jsonb_agg(p.oid::regprocedure::text order by 1), '[]') = '["graphql_public.graphql(text,text,jsonb,jsonb)"]'::jsonb from pg_proc p
      where p.pronamespace = 'graphql_public'::regnamespace and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
    (select coalesce(jsonb_agg(p.oid::regprocedure::text order by 1), '[]') from pg_proc p
      where p.pronamespace = 'graphql_public'::regnamespace and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')))),
  ('C22 Storage: every storage table anon or authenticated can write has RLS on, and no storage table other than objects has a policy',
    (select not exists (select 1 from pg_class c where c.relnamespace = 'storage'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity
        and (has_table_privilege('anon', c.oid, 'INSERT,UPDATE,DELETE') or has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE')))
      and not exists (select 1 from pg_policies where schemaname = 'storage' and tablename <> 'objects')),
    (select jsonb_build_object(
       'writable_without_rls', (select coalesce(jsonb_agg(c.relname), '[]') from pg_class c where c.relnamespace = 'storage'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity
          and (has_table_privilege('anon', c.oid, 'INSERT,UPDATE,DELETE') or has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE'))),
       'other_policies', (select coalesce(jsonb_agg(tablename || '.' || policyname), '[]') from pg_policies where schemaname = 'storage' and tablename <> 'objects'))))
)
select jsonb_build_object(
  'verdict', case when bool_and(coalesce(ok, false)) then 'PASS' else 'STOP' end,
  'checks', jsonb_agg(jsonb_build_object('id', id, 'ok', coalesce(ok, false), 'got', got) order by id),
  -- Recorded, not judged: compare with the previous release log and explain any change.
  'evidence', jsonb_build_object(
    'session', jsonb_build_object('current_user', current_user, 'session_user', session_user, 'superuser', (select rolsuper from pg_roles where rolname = current_user),
       'member_of', (select coalesce(jsonb_agg(b.rolname order by b.rolname), '[]') from pg_auth_members m join pg_roles b on b.oid = m.roleid where m.member = (select oid from pg_roles where rolname = current_user))),
    'storage_objects_owner', (select pg_get_userbyid(relowner) from pg_class where oid = 'storage.objects'::regclass),
    'storage_service_schema', (select jsonb_build_object('migrations', count(*), 'latest', (select name from storage.migrations order by id desc limit 1)) from storage.migrations),
    'storage_objects_before_insert_triggers_in_firing_order', (select coalesce(jsonb_agg(tgname order by tgname), '[]') from storage_triggers where (tgtype & 2) <> 0 and (tgtype & 4) <> 0),
    'event_triggers', (select coalesce(jsonb_agg(evtname || ':' || evtevent || ':' || evtfoid::regproc::text || ':' || evtenabled::text order by evtname), '[]') from pg_event_trigger)),
  -- Not visible from SQL: record the evidence by hand (commands in the runbook, section 4).
  'manual', jsonb_build_array(
    'Edge Functions: `supabase functions list --project-ref <ref>` is empty',
    'GraphQL: pg_graphql present? ' || coalesce((select 'yes (' || extversion || '): C08/C19 prove no relation mutation is granted, C21 that graphql_public offers only the entry point; its function mutations go through the guarded RPCs' from pg_extension where extname = 'pg_graphql'), 'no'),
    'API settings: exposed schemas shown in the dashboard (Settings -> API) are public/graphql_public only (C17 covers it when the value is stored on the role)',
    'Auth hooks (dashboard -> Authentication -> Hooks): none that writes business data',
    'Extensions installed: ' || (select string_agg(extname, ', ' order by extname) from pg_extension))
) as preflight from checks;
