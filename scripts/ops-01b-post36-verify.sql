-- OPS-01B mandatory verification right after migration 36 (runbook W2b), BEFORE maintenance is enabled or anything else
-- proceeds. READ-ONLY: every statement is a SELECT. Run it with the same $DB_URL as the push. Prints ONE json line:
--   {"verdict":"PASS"|"STOP","checks":[{"id","ok","got"}...]}
-- The pre-window gate (ops-01b-preflight.sql) can only prove the catalog prerequisites of the Storage trigger; this proves
-- that migration 36 actually installed exactly the reviewed objects on the hosted database. Any STOP: firewall stays ON,
-- do not proceed to W3, follow the runbook's "migration 36 bootstrap gate" failure branch.
-- EXPECTED-STATE MODE (P00, P08). One statement, so the mode is the literal below:
--   'w2b'     (this file)                              : exactly one singleton, maintenance OFF, no bypass; P10 no context.
--   'restore' (scripts/ops-01b-post36-verify-restore.sql): exactly one singleton, no bypass, enabled either way (a backup
--                                                          can be locked); P10 no context. That file is this one with only
--                                                          the mode literal changed (enforced by tests/integration/operations/release-gates.test.ts).
-- An absent or unknown mode STOPs (P00, and P08 fails closed).
-- LINE-ENDING CANONICALIZATION (P03). One rule for every function-body fingerprint in the OPS-01B gates:
-- a body is hashed as regexp_replace(prosrc, E'\r\n?', E'\n', 'g'): CRLF -> LF, then any remaining lone CR -> LF.
-- Nothing else is normalized: spaces, tabs, comments, case and every other character stay significant. PostgreSQL keeps
-- prosrc byte-for-byte as the migration file was materialized by Git (core.autocrlf), so a raw hash differs between an LF
-- and a CRLF checkout of the same reviewed migration (P1A 2026-11-05: production bodies carry CRLF, the reference LF).
with
mode(expected) as (values ('w2b')),
guard_fns(sig) as (values ('private.storage_receipt_maintenance_guard()'), ('private.maintenance_admit(uuid)'),
  ('private.maintenance_allows(private.system_maintenance,uuid)'), ('private.assert_not_in_maintenance()'), ('private.maintenance_lock_exclusive()'),
  ('private.receipt_restore_open(text,text[],integer)'), ('private.receipt_restore_close(text)'),
  ('public.set_maintenance(jsonb)'), ('public.set_maintenance_bypass(jsonb)')),
fns as (select g.sig, p.oid, p.prosecdef, p.proconfig, p.proowner, regexp_replace(p.prosrc, E'\r\n?', E'\n', 'g') as prosrc from guard_fns g left join pg_proc p on p.oid = to_regprocedure(g.sig)),
guard as (select t.oid, t.tgname, t.tgenabled::text as tgenabled, t.tgtype, t.tgfoid::regprocedure::text as fn, pg_get_triggerdef(t.oid) as def
  from pg_trigger t where t.tgrelid = 'storage.objects'::regclass and t.tgname = 'expense_receipts_maintenance_guard'),
-- V3 (runbook section 6), identical text: API-executable volatile functions that do not call the guard first.
unguarded as (
  select p.oid::regprocedure::text as fn from pg_proc p left join pg_language l on l.oid = p.prolang
  cross join lateral (select regexp_replace(regexp_replace(coalesce(p.prosrc, ''), '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g') as src) s
  cross join lateral (select substring(s.src from '(?i)^(.*?)\mbegin\M') as declared, substring(s.src from '(?i)\mbegin\M(.*)$') as body) b
  where p.pronamespace = 'public'::regnamespace and p.provolatile = 'v' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and p.proname not in ('set_maintenance', 'set_maintenance_bypass')
    and not coalesce(l.lanname = 'plpgsql' and b.declared is not null and b.body is not null and b.declared !~* ':=|\mdefault\M|='
      and b.body ~* '^\s*perform\s+private\.assert_not_in_maintenance\(\)\s*;', false)),
private_objs(rel) as (values ('private.system_maintenance'), ('private.receipt_restore_objects'), ('private.receipt_restore_log')),
checks(id, ok, got) as (
  values
  ('P01 exactly 36 migrations, the last one 20261103140000 (the guard), nothing later',
    (select count(*) = 36 and max(version) = '20261103140000' from supabase_migrations.schema_migrations),
    (select jsonb_build_object('count', count(*), 'latest', max(version)) from supabase_migrations.schema_migrations)),
  ('P02 the receipt guard trigger exists exactly once on storage.objects, ENABLED (O), BEFORE INSERT FOR EACH ROW, calling private.storage_receipt_maintenance_guard(), with the exact reviewed definition',
    (select count(*) = 1 and bool_and(tgenabled = 'O' and tgtype = 7 and fn = 'private.storage_receipt_maintenance_guard()'
       and def = 'CREATE TRIGGER expense_receipts_maintenance_guard BEFORE INSERT ON storage.objects FOR EACH ROW WHEN ((new.bucket_id = ''expense-receipts''::text)) EXECUTE FUNCTION private.storage_receipt_maintenance_guard()') from guard),
    (select coalesce(jsonb_agg(jsonb_build_object('enabled', tgenabled, 'tgtype', tgtype, 'function', fn, 'definition', def)), '[]') from guard)),
  ('P03 the maintenance, restore-context and control functions exist with the reviewed bodies, security-definer flags, search_path and owner',
    (select bool_and(oid is not null) and md5(string_agg(sig || '|' || prosecdef::text || '|' || coalesce(proconfig::text, '') || '|' || pg_get_userbyid(proowner) || '|' || prosrc, E'\n' order by sig)) = '3822757383203729978b7c00aea758bc' from fns),
    (select jsonb_build_object('missing', (select coalesce(jsonb_agg(sig), '[]') from fns where oid is null),
       'md5', md5(string_agg(sig || '|' || prosecdef::text || '|' || coalesce(proconfig::text, '') || '|' || pg_get_userbyid(proowner) || '|' || prosrc, E'\n' order by sig))) from fns)),
  ('P04 the trigger''s assumptions still hold: storage.objects.owner_id is text and bucket_id/name are text',
    (select bool_and(case attname when 'owner_id' then format_type(atttypid, atttypmod) = 'text' else format_type(atttypid, atttypmod) = 'text' end) and count(*) = 3
       from pg_attribute where attrelid = 'storage.objects'::regclass and attname in ('owner_id', 'bucket_id', 'name') and not attisdropped),
    (select jsonb_object_agg(attname, format_type(atttypid, atttypmod)) from pg_attribute where attrelid = 'storage.objects'::regclass and attname in ('owner_id', 'bucket_id', 'name') and not attisdropped)),
  ('P05 no API role and not PUBLIC holds any privilege on the maintenance state or the restore context; none may execute the private guard, restore or moved functions',
    (select not exists (select 1 from private_objs o, (values ('anon'), ('authenticated'), ('service_role')) r(role)
         where has_table_privilege(r.role, o.rel::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
       and not exists (select 1 from private_objs o join pg_class c on c.oid = o.rel::regclass, aclexplode(c.relacl) g where g.grantee = 0)
       and not exists (select 1 from pg_proc p, (values ('anon'), ('authenticated'), ('service_role')) r(role)
         where p.pronamespace = 'private'::regnamespace and has_function_privilege(r.role, p.oid, 'EXECUTE')
           and (p.proname in ('storage_receipt_maintenance_guard', 'maintenance_admit', 'maintenance_allows', 'assert_not_in_maintenance', 'maintenance_lock_exclusive',
                  'receipt_restore_open', 'receipt_restore_close', 'maintenance_reason', 'maintenance_state', 'assert_maintenance_controller')
             or exists (select 1 from pg_proc w where w.pronamespace = 'public'::regnamespace and w.proname = p.proname)))),
    (select jsonb_build_object('relation_grants', (select coalesce(jsonb_agg(o.rel || ':' || r.role), '[]') from private_objs o, (values ('anon'), ('authenticated'), ('service_role')) r(role)
         where has_table_privilege(r.role, o.rel::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
       'function_grants', (select coalesce(jsonb_agg(distinct p.oid::regprocedure::text), '[]') from pg_proc p, (values ('anon'), ('authenticated'), ('service_role')) r(role)
         where p.pronamespace = 'private'::regnamespace and has_function_privilege(r.role, p.oid, 'EXECUTE')
           and (p.proname in ('storage_receipt_maintenance_guard', 'maintenance_admit', 'maintenance_allows', 'assert_not_in_maintenance', 'maintenance_lock_exclusive',
                  'receipt_restore_open', 'receipt_restore_close', 'maintenance_reason', 'maintenance_state', 'assert_maintenance_controller')
             or exists (select 1 from pg_proc w where w.pronamespace = 'public'::regnamespace and w.proname = p.proname)))))),
  ('P06 the two control RPCs are executable by authenticated only (not anon, not service_role)',
    (select bool_and(has_function_privilege('authenticated', oid, 'EXECUTE') and not has_function_privilege('anon', oid, 'EXECUTE') and not has_function_privilege('service_role', oid, 'EXECUTE'))
       from fns where sig like 'public.%'),
    (select jsonb_agg(sig || ':' || has_function_privilege('authenticated', oid, 'EXECUTE')::text || '/' || has_function_privilege('anon', oid, 'EXECUTE')::text || '/' || has_function_privilege('service_role', oid, 'EXECUTE')::text) from fns where sig like 'public.%')),
  ('P07 no unexpected trigger on storage.objects: every trigger runs Storage code except the guard, and every one is enabled',
    (select count(*) = 0 from pg_trigger t where t.tgrelid = 'storage.objects'::regclass and not t.tgisinternal
       and ((t.tgfoid::regproc::text not like 'storage.%' and t.tgname <> 'expense_receipts_maintenance_guard') or t.tgenabled <> 'O')),
    (select coalesce(jsonb_agg(t.tgname || ':' || t.tgenabled::text || ':' || t.tgfoid::regproc::text order by t.tgname), '[]') from pg_trigger t where t.tgrelid = 'storage.objects'::regclass and not t.tgisinternal)),
  ('P00 the expected-state mode is known (w2b or restore)',
    (select count(*) = 1 and bool_and(expected in ('w2b', 'restore')) from mode),
    (select jsonb_agg(expected) from mode)),
  ('P08 exactly one maintenance singleton in the expected state (w2b: enabled=false, no bypass; restore: no bypass)',
    (select count(*) = 1 and bool_and(id and bypass_user_id is null and bypass_expires_at is null
       and case (select expected from mode) when 'w2b' then not enabled when 'restore' then true else false end)
     from private.system_maintenance),
    (select coalesce(jsonb_agg(jsonb_build_object('enabled', enabled, 'bypass', bypass_user_id is not null)), '[]') from private.system_maintenance)),
  ('P09 V3: every API-executable write function calls private.assert_not_in_maintenance() first (no initializer, not commented out, PL/pgSQL)',
    (select count(*) = 0 from unguarded) and (select count(*) = 23 from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.prosrc like '%assert_not_in_maintenance%'),
    (select jsonb_build_object('unguarded', (select coalesce(jsonb_agg(fn), '[]') from unguarded),
       'guarded', (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.prosrc like '%assert_not_in_maintenance%')))),
  ('P10 the receipt restore context is empty (no object is admitted past maintenance)',
    (select count(*) = 0 from private.receipt_restore_objects),
    (select to_jsonb(count(*)) from private.receipt_restore_objects))
)
select jsonb_build_object(
  'verdict', case when bool_and(coalesce(ok, false)) then 'PASS' else 'STOP' end,
  'checks', jsonb_agg(jsonb_build_object('id', id, 'ok', coalesce(ok, false), 'got', got) order by id),
  'session', jsonb_build_object('current_user', current_user, 'session_user', session_user)
) as post36 from checks;
