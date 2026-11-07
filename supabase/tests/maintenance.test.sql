begin;
set local timezone = 'Asia/Qatar';
create extension if not exists pgtap with schema extensions;
select no_plan();

-- OPS-01B slice 1: global maintenance boundary (release migration 36, 20261103140000; void_invoice is 37). Cross-session
-- behaviour (a control transition waiting for an in-flight write or upload, a write started after the transition refusing,
-- lock ordering) lives in tests/integration/operations/maintenance.test.ts, because one pgTAP transaction cannot hold two
-- sessions.

create function pg_temp.act(who text) returns void language sql as $$
  select set_config('request.jwt.claims', case when who is null then '{"role":"authenticated"}' else jsonb_build_object('role', 'authenticated', 'sub', case who
    when 'owner' then '10000000-0000-4000-8000-000000000101' when 'staff' then '10000000-0000-4000-8000-000000000102'
    when 'staff2' then '10000000-0000-4000-8000-000000000103' when 'manager' then '10000000-0000-4000-8000-000000000104' end)::text end, true)
$$;
create function pg_temp.uid(who text) returns uuid language sql immutable as $$
  select (case who when 'owner' then '10000000-0000-4000-8000-000000000101' when 'staff' then '10000000-0000-4000-8000-000000000102'
    when 'manager' then '10000000-0000-4000-8000-000000000104' end)::uuid $$;
create function pg_temp.s1() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.s2() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.mt(enabled boolean, why text default 'Release 5603633 maintenance window', ref text default '5603633') returns jsonb language sql as $$
  select public.set_maintenance(jsonb_build_object('enabled', enabled, 'reason', why, 'release_ref', ref)) $$;
create function pg_temp.bypass(who text, mins int default 10) returns jsonb language sql as $$
  select public.set_maintenance_bypass(jsonb_build_object('user_id', pg_temp.uid(who), 'minutes', mins, 'reason', 'Operator smoke of candidate')) $$;
create function pg_temp.audits(a text) returns bigint language sql as $$ select count(*) from public.audit_events where action = a $$;
-- The error a call raises, or 'ok'.
create function pg_temp.outcome(statement text) returns text language plpgsql as $$
begin execute statement; return 'ok'; exception when others then return sqlerrm; end $$;
-- Same, but as the authenticated API role (Storage RLS).
create function pg_temp.as_auth(statement text) returns text language plpgsql as $$
begin
  set local role authenticated;
  begin execute statement; reset role; return 'ok';
  exception when others then reset role; return sqlstate; end;
end $$;
grant execute on function pg_temp.as_auth(text) to public;
create function pg_temp.upload(n int) returns text language sql as $$
  select pg_temp.as_auth(format($u$insert into storage.objects(bucket_id, name, owner_id) values ('expense-receipts', '%s/%s/%s.pdf', auth.uid()::text)$u$,
    pg_temp.s1(), 'e9000000-0000-4000-8000-000000000001', 'f9000000-0000-4000-8000-' || lpad(n::text, 12, '0'))) $$;
-- The Storage service writes the real object row as a service-role connection with NO RLS; the uploader is only in
-- owner_id. This is that insert (current role = the test's table owner, claims = {"role":"service_role"}).
create function pg_temp.final_insert(uploader text, n int, bucket text default 'expense-receipts') returns text language plpgsql as $$
declare saved text := current_setting('request.jwt.claims', true); outcome text := 'ok';
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  begin
    insert into storage.objects(bucket_id, name, owner_id) values (bucket, format('%s/%s/%s.pdf', pg_temp.s1(), 'e9000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-' || lpad(n::text, 12, '0')), uploader);
  exception when others then outcome := sqlerrm; end;
  perform set_config('request.jwt.claims', coalesce(saved, ''), true);
  return outcome;
end $$;
-- The guard-first rule as a function, so the real catalog scan and its fail-closed samples use the same code.
create function pg_temp.guard_first_ok(lang text, raw text) returns boolean language sql immutable as $$
  with s as (select regexp_replace(regexp_replace(raw, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g') as src),
  p as (select substring(src from '(?i)^(.*?)\mbegin\M') as declared, substring(src from '(?i)\mbegin\M(.*)$') as body from s)
  select coalesce(lang = 'plpgsql' and declared is not null and body is not null
    and declared !~* ':=|\mdefault\M|='
    and body ~* '^\s*perform\s+private\.assert_not_in_maintenance\(\)\s*;', false) from p
$$;

-- The guarded surface: every public write RPC. Reports and the two control RPCs are not guarded.
create temp table guarded(name text primary key);
insert into guarded values ('admin_create_shop'), ('admin_register_account'), ('admin_set_account_status'), ('admin_set_shop_assignment'),
  ('admin_set_shop_status'), ('admin_update_account'), ('admin_update_shop'), ('apply_customer_credit'), ('approve_overpayment'),
  ('close_business_date'), ('create_customer'), ('create_expense'), ('decide_expense_correction'), ('decide_invoice_correction'),
  ('decide_invoice_replacement'), ('record_customer_payment'), ('record_payment'), ('register_expense_attachment'),
  ('reopen_business_date'), ('request_expense_correction'), ('request_invoice_correction'), ('request_invoice_replacement'),
  ('submit_batch'), ('void_invoice');

insert into public.expenses(id, shop_id, description, amount_dirham, business_date)
values ('e9000000-0000-4000-8000-000000000001', pg_temp.s1(), 'Maintenance fixture expense', 1000, current_date);

-- 1. Catalog -----------------------------------------------------------------------------------------------------------
select is((select count(*) from private.system_maintenance), 1::bigint, 'maintenance state is a single row');
select ok(not (select enabled from private.system_maintenance), 'maintenance starts disabled');
select is((select count(*) from unnest(array['anon', 'authenticated', 'service_role']) r cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
  where has_table_privilege(r, 'private.system_maintenance', p)), 0::bigint, 'no API role can read or write the maintenance state');
select ok((select relrowsecurity from pg_class where oid = 'private.system_maintenance'::regclass), 'the maintenance table has RLS enabled');
select ok(not has_function_privilege('authenticated', 'private.assert_not_in_maintenance()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.maintenance_admit(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.maintenance_lock_exclusive()', 'EXECUTE')
  and not has_function_privilege('anon', 'private.storage_receipt_maintenance_guard()', 'EXECUTE'), 'the guard and lock helpers are not callable through the API');
select ok(has_function_privilege('authenticated', 'public.set_maintenance(jsonb)', 'EXECUTE') and not has_function_privilege('anon', 'public.set_maintenance(jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.set_maintenance_bypass(jsonb)', 'EXECUTE') and not has_function_privilege('anon', 'public.set_maintenance_bypass(jsonb)', 'EXECUTE'),
  'control RPCs: authenticated (owner check inside), never anon');

-- Lock contract (see the migration header): L1 = the state row (FOR SHARE for writes and Storage inserts, FOR UPDATE for
-- the controls), L2 = account-administration advisory lock, L3 = the rest. Order L1 -> L2 -> L3, never the reverse.
select ok((select prosrc from pg_proc where oid = 'private.maintenance_admit(uuid)'::regprocedure) ~* 'for share'
  and (select prosrc from pg_proc where oid = 'private.maintenance_lock_exclusive()'::regprocedure) ~* 'for update',
  'L1: writes share-lock the state row, the controls update-lock it, so a transition is a barrier for writes');
select ok((select prosrc from pg_proc where oid = 'private.assert_not_in_maintenance()'::regprocedure) ~ 'maintenance_admit'
  and (select prosrc from pg_proc where oid = 'private.storage_receipt_maintenance_guard()'::regprocedure) ~ 'maintenance_admit',
  'the business guard and the Storage trigger take the same L1 share lock through one function');
select ok((select position('maintenance_lock_exclusive' in prosrc) > 0 and position('maintenance_lock_exclusive' in prosrc) < position('assert_account_admin' in prosrc)
    from pg_proc where oid = 'public.set_maintenance(jsonb)'::regprocedure)
  and (select position('maintenance_lock_exclusive' in prosrc) > 0 and position('maintenance_lock_exclusive' in prosrc) < position('assert_account_admin' in prosrc)
    from pg_proc where oid = 'public.set_maintenance_bypass(jsonb)'::regprocedure),
  'lock order: both control RPCs take L1 before L2 (the admin RPCs reach L2 only after their L1 guard)');
select ok((select prosrc from pg_proc where oid = 'private.assert_maintenance_controller()'::regprocedure) ~* 'is_owner'
  and (select prosrc from pg_proc where oid = 'private.assert_maintenance_controller()'::regprocedure) !~* 'for (update|share)',
  'only an active owner can queue for the exclusive lock, and the check itself takes no lock');
-- Storage: the guard is a trigger, because it fires in the transaction that commits the object row (see the migration header).
select ok(exists (select 1 from pg_trigger t where t.tgrelid = 'storage.objects'::regclass and t.tgname = 'expense_receipts_maintenance_guard'
  and not t.tgisinternal and t.tgenabled = 'O' and t.tgfoid = 'private.storage_receipt_maintenance_guard()'::regprocedure
  and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4 and (t.tgtype & (8 | 16 | 32)) = 0), 'storage.objects has the enabled BEFORE INSERT row trigger');
select is((select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd in ('UPDATE', 'DELETE') and policyname like 'expense_receipts%'
  and coalesce(qual, 'false') = 'false' and coalesce(with_check, 'false') = 'false'), 2::bigint,
  'Storage update and delete stay denied to the API roles, so insert is the only user-reachable Storage mutation');

-- Structural state (the CHECKs) ----------------------------------------------------------------------------------------
select is((select string_agg(conname::text, ',' order by conname::text) from pg_constraint where conrelid = 'private.system_maintenance'::regclass and contype = 'c'),
  'system_maintenance_bypass_group,system_maintenance_bypass_needs_maintenance,system_maintenance_enabled_group,system_maintenance_id_check,system_maintenance_release_ref',
  'the state table carries its structural CHECK constraints');
select throws_ok($$insert into private.system_maintenance(id) values (false)$$, '23514', null, 'the singleton cannot hold an id other than true');
select throws_ok($$insert into private.system_maintenance(id) values (true)$$, '23505', null, 'there can never be a second row');
-- Disabled state must be fully cleared: no stale enabled metadata.
select throws_like($$update private.system_maintenance set enabled_at = now()$$, '%system_maintenance_enabled_group%', 'disabled with a stale enabled_at is refused');
select throws_like($$update private.system_maintenance set enabled_by = '10000000-0000-4000-8000-000000000101'$$, '%system_maintenance_enabled_group%', 'disabled with a stale enabled_by is refused');
select throws_like($$update private.system_maintenance set reason = 'stale'$$, '%system_maintenance_enabled_group%', 'disabled with a stale reason is refused');
select throws_like($$update private.system_maintenance set release_ref = 'stale'$$, '%system_maintenance_enabled_group%', 'disabled with a stale release_ref is refused');
-- Enabled state needs its full metadata.
select throws_like($$update private.system_maintenance set enabled = true$$, '%system_maintenance_enabled_group%', 'enabled with no metadata is refused');
select throws_like($$update private.system_maintenance set enabled = true, enabled_at = now(), enabled_by = '10000000-0000-4000-8000-000000000101'$$, '%system_maintenance_enabled_group%', 'enabled with no reason is refused');
select throws_like($$update private.system_maintenance set enabled = true, enabled_at = now(), enabled_by = '10000000-0000-4000-8000-000000000101', reason = '   '$$, '%system_maintenance_enabled_group%', 'enabled with a blank reason is refused');
select throws_like($$update private.system_maintenance set enabled = true, enabled_at = now(), reason = 'x'$$, '%system_maintenance_enabled_group%', 'enabled with no actor is refused');
select throws_like($$update private.system_maintenance set enabled = true, enabled_by = '10000000-0000-4000-8000-000000000101', reason = 'x'$$, '%system_maintenance_enabled_group%', 'enabled with no time is refused');
select throws_like($$update private.system_maintenance set enabled = true, enabled_at = now(), enabled_by = '10000000-0000-4000-8000-000000000101', reason = 'x', release_ref = ' padded '$$, '%system_maintenance_release_ref%', 'an untrimmed release_ref is refused');
select throws_like($$update private.system_maintenance set enabled = true, enabled_at = now(), enabled_by = '10000000-0000-4000-8000-000000000101', reason = 'x', release_ref = ''$$, '%system_maintenance_release_ref%', 'an empty release_ref is refused');
-- Bypass is all-or-nothing and needs maintenance.
select throws_like($$update private.system_maintenance set bypass_user_id = '10000000-0000-4000-8000-000000000101'$$, '%system_maintenance_bypass%', 'a bypass user without maintenance is refused');
select throws_like($$update private.system_maintenance set bypass_reason = 'orphan'$$, '%system_maintenance_bypass_group%', 'an orphan bypass reason is refused');
select throws_like($$update private.system_maintenance set bypass_expires_at = now()$$, '%system_maintenance_bypass_group%', 'an orphan bypass expiry is refused');
select throws_like($$update private.system_maintenance set bypass_enabled_by = '10000000-0000-4000-8000-000000000101'$$, '%system_maintenance_bypass_group%', 'an orphan bypass actor is refused');

-- Convention: every volatile API function except the controls calls the guard as its FIRST statement: no declaration
-- initializers (they run before BEGIN), comments do not count, and a function the check cannot parse FAILS the check
-- instead of being skipped. A new write RPC that forgets the guard, or a later migration that replaces a wrapper with a
-- full body, fails here.
select is(pg_temp.guard_first_ok('plpgsql', E'begin\n  perform private.assert_not_in_maintenance();\n  return 1;\nend'), true, 'checker: a plain guard-first wrapper passes');
select is(pg_temp.guard_first_ok('plpgsql', E'declare\n  actor uuid;\nbegin\n  -- guard\n  perform private.assert_not_in_maintenance();\n  actor := 1;\nend'), true, 'checker: declarations without initializers, then a commented guard-first body pass');
select is(pg_temp.guard_first_ok('plpgsql', E'declare\n  actor uuid := auth.uid();\nbegin\n  perform private.assert_not_in_maintenance();\nend'), false, 'checker: a := declaration initializer fails');
select is(pg_temp.guard_first_ok('plpgsql', E'declare\n  actor uuid default auth.uid();\nbegin\n  perform private.assert_not_in_maintenance();\nend'), false, 'checker: a DEFAULT declaration initializer fails');
select is(pg_temp.guard_first_ok('plpgsql', E'declare\n  actor uuid = auth.uid();\nbegin\n  perform private.assert_not_in_maintenance();\nend'), false, 'checker: an = declaration initializer fails');
select is(pg_temp.guard_first_ok('plpgsql', E'begin\n  perform 1;\n  perform private.assert_not_in_maintenance();\nend'), false, 'checker: a guard that is not first fails');
select is(pg_temp.guard_first_ok('plpgsql', E'begin\n  -- perform private.assert_not_in_maintenance();\n  return 1;\nend'), false, 'checker: a guard only in a line comment fails');
select is(pg_temp.guard_first_ok('plpgsql', E'begin\n  /* perform private.assert_not_in_maintenance(); */\n  return 1;\nend'), false, 'checker: a guard only in a block comment fails');
select is(pg_temp.guard_first_ok('plpgsql', 'select 1'), false, 'checker: a body with no BEGIN fails closed');
select is(pg_temp.guard_first_ok('plpgsql', null), false, 'checker: a NULL body fails closed');
select is(pg_temp.guard_first_ok('sql', E'begin\n  perform private.assert_not_in_maintenance();\nend'), false, 'checker: a non-plpgsql function fails closed');
select is(pg_temp.guard_first_ok(null, E'begin\n  perform private.assert_not_in_maintenance();\nend'), false, 'checker: an unknown language fails closed');
select is((select coalesce(array_agg(p.proname::text order by p.proname::text), '{}') from pg_proc p join pg_language l on l.oid = p.prolang
  where p.pronamespace = 'public'::regnamespace and p.provolatile = 'v' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and p.proname not in ('set_maintenance', 'set_maintenance_bypass')
    and not pg_temp.guard_first_ok(l.lanname::text, p.prosrc)),
  '{}'::text[], 'every write RPC calls private.assert_not_in_maintenance() before any other statement, with no declaration initializers');
select is((select array_agg(p.proname::text order by p.proname::text) from pg_proc p
  where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.prosrc like '%assert_not_in_maintenance%'),
  (select array_agg(name order by name) from guarded), 'the guarded RPCs are exactly the 24 write RPCs');
select is((select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.provolatile <> 'v' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  and p.prosrc like '%assert_not_in_maintenance%'), 0::bigint, 'report RPCs are not guarded (reads stay RLS-scoped)');
select is((select count(*) from guarded g join pg_proc p on p.proname = g.name and p.pronamespace = 'private'::regnamespace
  where p.prosecdef and not has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('anon', p.oid, 'EXECUTE')),
  23::bigint, 'the 23 moved bodies live in private, still SECURITY DEFINER, with no API grant');

-- 2. Singleton row: a missing row fails closed, loudly, and audits nothing ----------------------------------------------
delete from private.system_maintenance;
select pg_temp.act('owner');
select throws_ok($$select pg_temp.mt(true)$$, 'P0001', 'MAINTENANCE_STATE_MISSING', 'enable with no state row: invariant error');
select throws_ok($$select pg_temp.mt(false)$$, 'P0001', 'MAINTENANCE_STATE_MISSING', 'disable with no state row: invariant error');
select throws_ok($$select pg_temp.bypass('owner')$$, 'P0001', 'MAINTENANCE_STATE_MISSING', 'bypass grant with no state row: invariant error');
select throws_ok($$select public.set_maintenance_bypass('{"user_id":null,"reason":"x"}')$$, 'P0001', 'MAINTENANCE_STATE_MISSING', 'bypass revoke with no state row: invariant error');
select is(pg_temp.audits('maintenance.enabled') + pg_temp.audits('maintenance.disabled') + pg_temp.audits('maintenance.operator_bypass_enabled') + pg_temp.audits('maintenance.operator_bypass_disabled'),
  0::bigint, 'no transition audit is written when no row was updated');
select pg_temp.act('staff');
select is(pg_temp.outcome($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'No State Row', 'mobile', '55519900'))$$),
  'MAINTENANCE_ACTIVE', 'business writes fail closed with no state row');
select is(pg_temp.final_insert(pg_temp.uid('staff')::text, 90), 'MAINTENANCE_ACTIVE', 'a Storage insert fails closed with no state row');
select is((select count(*) from public.customers where name = 'No State Row'), 0::bigint, 'nothing was written');
select throws_ok($$select private.receipt_restore_open('no-state', array['x'], 10)$$, 'P0001', 'MAINTENANCE_STATE_MISSING', 'the restore context cannot open with no state row');
select is((select count(*) from private.receipt_restore_objects) + (select count(*) from private.receipt_restore_log), 0::bigint, 'no restore listing or log row is created with no state row');
insert into private.system_maintenance(id) values (true);
select ok(not (select enabled from private.system_maintenance), 'the restored singleton starts disabled');

-- 3. Control authorization and validation -----------------------------------------------------------------------------
select pg_temp.act('staff');
select throws_ok($$select pg_temp.mt(true)$$, '42501', 'INSUFFICIENT_ROLE', 'staff cannot enable maintenance');
select throws_ok($$select pg_temp.bypass('staff')$$, '42501', 'INSUFFICIENT_ROLE', 'staff cannot grant a bypass');
select pg_temp.act('manager');
select throws_ok($$select pg_temp.mt(true)$$, '42501', 'INSUFFICIENT_ROLE', 'a manager cannot enable maintenance');
select throws_ok($$select public.set_maintenance_bypass('{"user_id":null,"reason":"x"}')$$, '42501', 'INSUFFICIENT_ROLE', 'a manager cannot revoke a bypass');
select pg_temp.act(null);
select throws_ok($$select pg_temp.mt(true)$$, '28000', 'AUTHENTICATION_REQUIRED', 'no session: refused');
update public.profiles set is_active = false where id = pg_temp.uid('owner');
select pg_temp.act('owner');
select throws_ok($$select pg_temp.mt(true)$$, '42501', 'INSUFFICIENT_ROLE', 'an inactive owner cannot enable maintenance');
update public.profiles set is_active = true where id = pg_temp.uid('owner');
select throws_ok($$select public.set_maintenance('{"enabled":true}')$$, 'P0001', 'REASON_REQUIRED', 'a reason is required');
select throws_ok($$select public.set_maintenance('{"enabled":true,"reason":"   "}')$$, 'P0001', 'REASON_REQUIRED', 'a blank reason is refused');
select throws_ok($$select public.set_maintenance('{"enabled":"yes","reason":"Release window"}')$$, 'P0001', 'INVALID_REQUEST', 'enabled must be a boolean');
select throws_ok($$select public.set_maintenance('{"enabled":true,"reason":"Release window","extra":1}')$$, 'P0001', 'INVALID_REQUEST', 'unknown keys are refused');
select throws_ok($$select pg_temp.bypass('owner')$$, 'P0001', 'MAINTENANCE_NOT_ACTIVE', 'no bypass while maintenance is off');
select is(pg_temp.audits('maintenance.enabled') + pg_temp.audits('maintenance.operator_bypass_enabled'), 0::bigint, 'refused control calls audit nothing');
select throws_ok($$select private.receipt_restore_open('while-off', array['x'], 10)$$, 'P0001', 'MAINTENANCE_NOT_ACTIVE', 'the restore context cannot open while maintenance is off');
select is((select count(*) from private.receipt_restore_objects) + (select count(*) from private.receipt_restore_log), 0::bigint, 'a refused open creates no listing and no log row');
select is((select count(*) from public.audit_events where action like 'maintenance.%'), 0::bigint, 'a refused open writes no audit event');

-- 4. Enable: audited once, idempotent ----------------------------------------------------------------------------------
select is(pg_temp.mt(true) - 'enabled_at', '{"ok":true,"changed":true,"enabled":true,"release_ref":"5603633","bypass_user_id":null,"bypass_expires_at":null}'::jsonb, 'owner enables maintenance');
select ok((select enabled and enabled_at is not null and enabled_by = pg_temp.uid('owner') and reason is not null from private.system_maintenance), 'the enabled state carries time, actor and reason');
select is(pg_temp.audits('maintenance.enabled'), 1::bigint, 'enable is audited');
select ok((select metadata @> jsonb_build_object('actor', pg_temp.uid('owner'), 'reason', 'Release 5603633 maintenance window', 'release_ref', '5603633') and metadata ? 'at'
  and shop_id is null and actor_id = pg_temp.uid('owner') and entity_type = 'system_maintenance' from public.audit_events where action = 'maintenance.enabled'),
  'the enable audit carries actor, time, reason and release ref');
select is(pg_temp.mt(true, 'Second click') ->> 'changed', 'false', 'enabling again is a no-op');
select is(pg_temp.audits('maintenance.enabled'), 1::bigint, 'the no-op writes no audit row');
select is((select reason from private.system_maintenance), 'Release 5603633 maintenance window', 'the no-op keeps the original reason');
-- Enabled-state structure: a complete bypass group is valid, a partial one is not.
select throws_like($$update private.system_maintenance set bypass_user_id = '10000000-0000-4000-8000-000000000101'$$, '%system_maintenance_bypass_group%', 'a bypass user without expiry, actor and reason is refused');
select throws_like($$update private.system_maintenance set bypass_user_id = '10000000-0000-4000-8000-000000000101', bypass_expires_at = now() + interval '1 hour', bypass_enabled_by = '10000000-0000-4000-8000-000000000101'$$,
  '%system_maintenance_bypass_group%', 'a bypass with no reason is refused');
select throws_like($$update private.system_maintenance set bypass_user_id = '10000000-0000-4000-8000-000000000101', bypass_expires_at = now() + interval '1 hour', bypass_enabled_by = '10000000-0000-4000-8000-000000000101', bypass_reason = '  '$$,
  '%system_maintenance_bypass_group%', 'a bypass with a blank reason is refused');
select throws_like($$update private.system_maintenance set bypass_user_id = '10000000-0000-4000-8000-000000000101', bypass_expires_at = now() + interval '1 hour', bypass_reason = 'x'$$,
  '%system_maintenance_bypass_group%', 'a bypass with no actor is refused');
select throws_like($$update private.system_maintenance set bypass_user_id = '10000000-0000-4000-8000-000000000101', bypass_enabled_by = '10000000-0000-4000-8000-000000000101', bypass_reason = 'x'$$,
  '%system_maintenance_bypass_group%', 'a bypass with no expiry is refused');
select throws_like($$update private.system_maintenance set bypass_expires_at = now() + interval '1 hour', bypass_enabled_by = '10000000-0000-4000-8000-000000000101', bypass_reason = 'x'$$,
  '%system_maintenance_bypass_group%', 'an expiry, actor and reason with no bypass user are refused');

-- 5. Every write RPC refuses for every role, before any validation or work -------------------------------------------
select is((select coalesce(array_agg(r || ':' || g.name || '=' || o order by r, g.name), '{}') from unnest(array['owner', 'manager', 'staff']) r cross join guarded g
  cross join lateral (select pg_temp.act(r)) a
  cross join lateral (select pg_temp.outcome(format('select public.%I(%L::jsonb)', g.name, '{}')) o) x where o <> 'MAINTENANCE_ACTIVE'),
  '{}'::text[], 'owner, manager and staff: all 24 write RPCs refuse with MAINTENANCE_ACTIVE (even an invalid command, so the guard runs first)');
select pg_temp.act('staff');
select throws_ok($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'Maintenance Customer', 'mobile', '55519901'))$$,
  'P0001', 'MAINTENANCE_ACTIVE', 'a valid create_customer refuses');
select is((select count(*) from public.customers where name = 'Maintenance Customer'), 0::bigint, 'nothing was written');
select is(pg_temp.upload(1), 'P0001', 'staff receipt upload is refused (the trigger runs before the policy check)');
select is((select count(*) from storage.objects where name like '%f9000000-0000-4000-8000-000000000001%'), 0::bigint, 'no orphan object is created');
select lives_ok($$select * from public.report_sales_totals(pg_temp.s1(), current_date - 7, current_date)$$, 'reports still answer (RLS-scoped read)');
select pg_temp.act('owner');
select is(pg_temp.upload(2), 'P0001', 'owner receipt upload without a bypass is refused');

-- 5b. The Storage authority: the trigger on the committing insert (the policy is bypassed exactly as Storage bypasses it)
select is(pg_temp.final_insert(pg_temp.uid('staff')::text, 1), 'MAINTENANCE_ACTIVE', 'service-role insert for a staff uploader is refused');
select is(pg_temp.final_insert(pg_temp.uid('owner')::text, 2), 'MAINTENANCE_ACTIVE', 'service-role insert for an owner with no bypass is refused');
select is(pg_temp.final_insert(null, 3), 'MAINTENANCE_ACTIVE', 'service-role insert with no uploader is refused');
select is(pg_temp.final_insert('not-a-uuid', 4), 'MAINTENANCE_ACTIVE', 'service-role insert with a malformed uploader id is refused');
select is((select count(*) from storage.objects where name like '%f8000000-0000-4000-8000-%'), 0::bigint, 'refused inserts leave no object row');
insert into storage.buckets(id, name) values ('zz-other-bucket', 'zz-other-bucket');
select is(pg_temp.final_insert(pg_temp.uid('staff')::text, 5, 'zz-other-bucket'), 'ok', 'the trigger leaves other buckets alone');

-- 5c. Receipt restore context (disaster recovery into a LOCKED database): exact names, no uploader, unexpired, closed after.
create function pg_temp.receipt(n int) returns text language sql immutable as $$
  select format('%s/%s/%s.pdf', pg_temp.s1(), 'e9000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-' || lpad(n::text, 12, '0')) $$;
select is((select count(*) from pg_class c, (values ('anon'), ('authenticated'), ('service_role')) r(role)
  where c.oid in ('private.receipt_restore_objects'::regclass, 'private.receipt_restore_log'::regclass) and has_table_privilege(r.role, c.oid, 'SELECT,INSERT,UPDATE,DELETE')),
  0::bigint, 'no API role can read or write the restore context or its log');
select is((select count(*) from pg_proc p, (values ('anon'), ('authenticated'), ('service_role')) r(role)
  where p.oid in ('private.receipt_restore_open(text,text[],integer)'::regprocedure, 'private.receipt_restore_close(text)'::regprocedure) and has_function_privilege(r.role, p.oid, 'EXECUTE')),
  0::bigint, 'no API role can open or close the restore context');
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('private.receipt_restore_objects'::regclass, 'private.receipt_restore_log'::regclass)), 'RLS is on for both');
select throws_ok($$select private.receipt_restore_open('r1', array[]::text[], 10)$$, 'P0001', 'INVALID_REQUEST', 'an empty name list is refused');
select throws_ok($$select private.receipt_restore_open('r1', array['x'], 61)$$, 'P0001', 'INVALID_REQUEST', 'more than 60 minutes is refused');
select throws_ok($$select private.receipt_restore_open(null, array['x'], 10)$$, 'P0001', 'INVALID_REQUEST', 'a missing restore reference is refused');
select is(private.receipt_restore_open('restore-test', array[pg_temp.receipt(20), pg_temp.receipt(21)], 10), 2, 'the restore operator lists exactly two objects');
select throws_ok($$select private.receipt_restore_open('another-restore', array['x'], 10)$$, 'P0001', 'RESTORE_CONTEXT_BUSY', 'a second restore cannot open while one is open');
select is(pg_temp.final_insert(null, 20), 'ok', 'a listed object with no uploader (service key) is admitted while locked');
select is(pg_temp.final_insert(pg_temp.uid('staff')::text, 21), 'MAINTENANCE_ACTIVE', 'a listed name WITH an uploader (an ordinary user) is still refused');
select is(pg_temp.final_insert(null, 22), 'MAINTENANCE_ACTIVE', 'an unlisted name with no uploader is still refused (no service-role exemption)');
select is(pg_temp.final_insert(pg_temp.uid('owner')::text, 23), 'MAINTENANCE_ACTIVE', 'the owner without a bypass is still refused');
select pg_temp.act('staff');
select is(pg_temp.upload(24), 'P0001', 'an ordinary authenticated upload is still refused during the restore');
update private.receipt_restore_objects set expires_at = clock_timestamp() - interval '1 second' where name = pg_temp.receipt(21);
select is(pg_temp.final_insert(null, 21), 'MAINTENANCE_ACTIVE', 'an expired listing admits nothing');
select is(private.receipt_restore_close('restore-test'), 2, 'closing removes every listing of that restore');
select is(private.receipt_restore_close('restore-test'), 0, 'closing again is harmless');
select is((select count(*) from private.receipt_restore_objects), 0::bigint, 'the context is empty after closing');
select is(pg_temp.final_insert(null, 25), 'MAINTENANCE_ACTIVE', 'after closing, an uploader-less insert is refused again');
select is((select string_agg(action || ':' || object_count || ':' || restore_ref, ',' order by id) from private.receipt_restore_log),
  'opened:2:restore-test,closed:2:restore-test,closed:0:restore-test', 'every open and close is logged with its reference and count');
select is((select count(*) from public.audit_events where action like 'maintenance.%' and metadata ? 'restore_ref'), 0::bigint, 'the restore context writes nothing to the business audit trail (a restored fingerprint stays equal)');

-- 6. Operator bypass ---------------------------------------------------------------------------------------------------
select pg_temp.act('owner');
select throws_ok($$select pg_temp.bypass('manager')$$, 'P0001', 'BYPASS_USER_NOT_ACTIVE_OWNER', 'a manager cannot be the operator');
select throws_ok($$select pg_temp.bypass('staff')$$, 'P0001', 'BYPASS_USER_NOT_ACTIVE_OWNER', 'staff cannot be the operator');
select throws_ok($$select pg_temp.bypass('owner', 0)$$, 'P0001', 'INVALID_REQUEST', 'zero minutes is refused');
select throws_ok($$select pg_temp.bypass('owner', 121)$$, 'P0001', 'INVALID_REQUEST', 'more than 120 minutes is refused');
select throws_ok($$select public.set_maintenance_bypass(jsonb_build_object('user_id', pg_temp.uid('owner'), 'minutes', 10))$$, 'P0001', 'REASON_REQUIRED', 'a bypass needs a reason');
select is(pg_temp.bypass('owner') ->> 'bypass_user_id', pg_temp.uid('owner')::text, 'owner grants the bypass to the owner account');
select ok((select bypass_expires_at >= now() + interval '10 minutes' and bypass_expires_at <= clock_timestamp() + interval '10 minutes'
  and bypass_enabled_by = pg_temp.uid('owner') and bypass_reason = 'Operator smoke of candidate' from private.system_maintenance),
  'the bypass expires after the requested minutes, measured on the wall clock, and carries actor and reason');
select ok((select metadata @> jsonb_build_object('user_id', pg_temp.uid('owner'), 'minutes', 10, 'release_ref', '5603633', 'renewal', false) and metadata ? 'expires_at'
  from public.audit_events where action = 'maintenance.operator_bypass_enabled'), 'the bypass grant is audited with user, expiry and release ref');
select ok((public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'Operator Smoke', 'mobile', '55519902')) ->> 'ok')::boolean,
  'the bypass owner can write');
select is(pg_temp.upload(3), 'ok', 'the bypass owner can upload a receipt');
select is(pg_temp.final_insert(pg_temp.uid('owner')::text, 6), 'ok', 'the Storage trigger admits the bypass owner');
select is(pg_temp.final_insert(pg_temp.uid('staff')::text, 7), 'MAINTENANCE_ACTIVE', 'the Storage trigger still refuses staff');
select is(pg_temp.final_insert(pg_temp.uid('manager')::text, 8), 'MAINTENANCE_ACTIVE', 'the Storage trigger still refuses a manager');
select isnt(pg_temp.outcome($$select public.create_customer(jsonb_build_object('shop_id', gen_random_uuid(), 'name', 'Nowhere', 'mobile', '55519903'))$$),
  'ok','the bypass does not skip the RPC''s own checks (unknown shop still refused)');
update public.shops set is_active = false where id = pg_temp.s2();
select throws_ok($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s2(), 'name', 'Inactive Shop', 'mobile', '55519904'))$$,
  'P0001', 'SHOP_INACTIVE', 'the bypass does not skip shop status');
update public.shops set is_active = true where id = pg_temp.s2();
select pg_temp.act('manager');
select is(pg_temp.outcome($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'Manager Try', 'mobile', '55519905'))$$),
  'MAINTENANCE_ACTIVE', 'a manager is still refused while the owner holds the bypass');
select is(pg_temp.upload(4), 'P0001', 'a manager upload is still refused');
select pg_temp.act('staff');
select is(pg_temp.outcome($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'Staff Try', 'mobile', '55519906'))$$),
  'MAINTENANCE_ACTIVE', 'staff are still refused while the owner holds the bypass');

-- Renewal semantics: granting again is a RENEWAL (fresh expiry, new audit row marked renewal), not an idempotent no-op.
select pg_temp.act('owner');
update private.system_maintenance set bypass_expires_at = now() + interval '1 minute';
select is(pg_temp.bypass('owner', 30) ->> 'renewal', 'true', 'granting while a bypass is live is reported as a renewal');
select ok((select bypass_expires_at >= now() + interval '30 minutes' from private.system_maintenance), 'a renewal sets a fresh expiry');
select is(pg_temp.audits('maintenance.operator_bypass_enabled'), 2::bigint, 'a renewal is audited as its own event');
select ok((select metadata @> jsonb_build_object('renewal', true, 'minutes', 30, 'previous_user_id', pg_temp.uid('owner')) and metadata ? 'previous_expires_at'
  from public.audit_events where action = 'maintenance.operator_bypass_enabled' order by (metadata ->> 'at')::timestamptz desc limit 1), 'the renewal audit names the previous holder and expiry');
select is((select count(*) from private.system_maintenance where bypass_user_id is not null), 1::bigint, 'there is still one operator slot');

-- Expiry is judged on the wall clock at the moment of the decision, not at transaction start (now() is frozen here).
update private.system_maintenance set bypass_expires_at = clock_timestamp() + interval '700 milliseconds';
select is(pg_temp.outcome($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'Before Expiry', 'mobile', '55519911'))$$), 'ok', 'a bypass that has not expired admits');
select pg_sleep(1.0);
select ok(now() < clock_timestamp() - interval '900 milliseconds', 'precondition: now() is the transaction start, a second behind the wall clock');
select is(pg_temp.outcome($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'After Wall Expiry', 'mobile', '55519912'))$$),
  'MAINTENANCE_ACTIVE', 'the same transaction is refused once the wall clock passes the expiry');
select is(pg_temp.final_insert(pg_temp.uid('owner')::text, 9), 'MAINTENANCE_ACTIVE', 'the Storage trigger judges expiry on the wall clock too');
-- Expiry far in the past (e.g. left over from a long window): ignored without anyone revoking it.
update private.system_maintenance set bypass_expires_at = now() - interval '1 second';
select pg_temp.act('owner');
select is(pg_temp.outcome($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'After Expiry', 'mobile', '55519907'))$$),
  'MAINTENANCE_ACTIVE', 'an expired bypass is refused');
select is(pg_temp.upload(5), 'P0001', 'an expired bypass cannot upload');

-- Revoke: immediate, audited, idempotent.
select pg_temp.bypass('owner');
select is(public.set_maintenance_bypass('{"user_id":null,"reason":"Smoke finished"}') ->> 'changed', 'true', 'owner revokes the bypass');
select is(pg_temp.outcome($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'After Revoke', 'mobile', '55519908'))$$),
  'MAINTENANCE_ACTIVE', 'a revoked bypass is refused at once');
select is(pg_temp.final_insert(pg_temp.uid('owner')::text, 10), 'MAINTENANCE_ACTIVE', 'a revoked bypass is refused by the Storage trigger at once');
select ok((select metadata @> '{"cause":"revoked"}' and metadata ? 'release_ref' from public.audit_events where action = 'maintenance.operator_bypass_disabled'), 'the revoke is audited with the release ref');
select ok((select bypass_user_id is null and bypass_expires_at is null and bypass_enabled_by is null and bypass_reason is null from private.system_maintenance), 'a revoke clears the whole bypass group');
select is(public.set_maintenance_bypass('{"user_id":null,"reason":"Smoke finished"}') ->> 'changed', 'false', 'revoking again is a no-op');
select is(pg_temp.audits('maintenance.operator_bypass_disabled'), 1::bigint, 'the no-op revoke writes no audit row');

-- 7. Disable: clears a live bypass, audited, idempotent; writes work again --------------------------------------------
select pg_temp.bypass('owner');
select throws_ok($$update private.system_maintenance set enabled = false$$, '23514', null, 'the state cannot hold a bypass without maintenance');
select is(pg_temp.mt(false, 'Candidate healthy') - 'enabled_at', '{"ok":true,"changed":true,"enabled":false,"release_ref":null,"bypass_user_id":null,"bypass_expires_at":null}'::jsonb,
  'owner disables maintenance and the bypass goes with it');
select ok((select enabled_at is null and enabled_by is null and reason is null and release_ref is null and bypass_user_id is null and bypass_expires_at is null
  and bypass_enabled_by is null and bypass_reason is null from private.system_maintenance), 'the disabled state is fully cleared');
select ok((select metadata @> '{"cause":"maintenance_disabled","release_ref":"5603633"}' from public.audit_events where action = 'maintenance.operator_bypass_disabled' and metadata @> '{"cause":"maintenance_disabled"}'),
  'the automatic bypass removal is audited with the same release ref as an explicit revoke');
select ok((select metadata @> '{"reason":"Candidate healthy","release_ref":"5603633"}' from public.audit_events where action = 'maintenance.disabled'), 'disable is audited');
select is(pg_temp.mt(false, 'Again') ->> 'changed', 'false', 'disabling again is a no-op');
select is(pg_temp.audits('maintenance.disabled'), 1::bigint, 'the no-op disable writes no audit row');
select pg_temp.act('staff');
select ok((public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'Back To Normal', 'mobile', '55519909')) ->> 'ok')::boolean, 'staff can write again');
select is(pg_temp.upload(6), 'ok', 'staff can upload again');
select is(pg_temp.final_insert(pg_temp.uid('staff')::text, 11), 'ok', 'the Storage trigger admits everyone again');
select is(pg_temp.outcome($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s2(), 'name', 'Wrong Shop', 'mobile', '55519910'))$$),
  'UNAUTHORIZED_SHOP', 'shop isolation is unchanged');

-- 7b. The restore context is bound to one maintenance period: disable clears it, re-enable never revives it ---------
select pg_temp.act('owner');
select throws_ok($$select private.receipt_restore_open('after-off', array[pg_temp.receipt(30)], 10)$$, 'P0001', 'MAINTENANCE_NOT_ACTIVE', 'after disable the context cannot open');
select pg_temp.mt(true, 'Second window', 'r2');
select is(private.receipt_restore_open('abandoned', array[pg_temp.receipt(30), pg_temp.receipt(31)], 60), 2, 'opened while on');
select is(pg_temp.final_insert(null, 30), 'ok', 'the listed uploader-less insert works inside the valid context');
-- The restore process is abandoned here (never closes). Maintenance goes OFF -> ON.
select pg_temp.mt(false, 'Abandon window', 'r2');
select is((select count(*) from private.receipt_restore_objects), 0::bigint, 'disabling maintenance clears the open context');
select is((select action || ':' || object_count || ':' || restore_ref from private.receipt_restore_log order by id desc limit 1), 'cleared:2:abandoned',
  'the automatic clear is logged with its reference and the listings it removed');
select pg_temp.mt(true, 'Third window', 'r3');
select is(pg_temp.final_insert(null, 31), 'MAINTENANCE_ACTIVE', 're-enabling does not reactivate the abandoned context');
-- Defense in depth: a listing from an earlier period (e.g. the state flipped outside set_maintenance) admits nothing.
insert into private.receipt_restore_objects values ('expense-receipts', pg_temp.receipt(31), 'stale', clock_timestamp() + interval '1 hour',
  (select enabled_at from private.system_maintenance) - interval '1 second');
select is(pg_temp.final_insert(null, 31), 'MAINTENANCE_ACTIVE', 'a listing from another maintenance period admits nothing');
delete from private.receipt_restore_objects;
select pg_temp.mt(false, 'Done', 'r3');

-- 8. Global audit rows are owner-only reads.
select pg_temp.act('staff');
set local role authenticated;
select is((select count(*) from public.audit_events where entity_type = 'system_maintenance'), 0::bigint, 'staff cannot read maintenance audit rows');
reset role;

select * from finish();
rollback;
