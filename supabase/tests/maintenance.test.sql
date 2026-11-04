begin;
set local timezone = 'Asia/Qatar';
create extension if not exists pgtap with schema extensions;
select no_plan();

-- OPS-01B slice 1: global maintenance boundary (20261103140000). Cross-session behaviour (an enable waiting for an
-- in-flight write, a write started after the enable refusing) lives in tests/integration/operations/maintenance.test.ts.

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
  select pg_temp.as_auth(format($u$insert into storage.objects(bucket_id, name) values ('expense-receipts', '%s/%s/%s.pdf')$u$,
    pg_temp.s1(), 'e9000000-0000-4000-8000-000000000001', 'f9000000-0000-4000-8000-' || lpad(n::text, 12, '0'))) $$;

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
  and not has_function_privilege('anon', 'private.maintenance_write_allowed()', 'EXECUTE'), 'the guard is not callable through the API');
select ok(has_function_privilege('authenticated', 'public.set_maintenance(jsonb)', 'EXECUTE') and not has_function_privilege('anon', 'public.set_maintenance(jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.set_maintenance_bypass(jsonb)', 'EXECUTE') and not has_function_privilege('anon', 'public.set_maintenance_bypass(jsonb)', 'EXECUTE'),
  'control RPCs: authenticated (owner check inside), never anon');
select ok((select prosrc from pg_proc where oid = 'private.assert_not_in_maintenance()'::regprocedure) ~* 'for share'
  and (select prosrc from pg_proc where oid = 'public.set_maintenance(jsonb)'::regprocedure) ~* 'for update'
  and (select prosrc from pg_proc where oid = 'public.set_maintenance_bypass(jsonb)'::regprocedure) ~* 'for update',
  'the guard share-locks the state row and the control RPCs update-lock it, so an enable is a barrier for writes');

-- Convention: every volatile API function except the controls calls the guard as its FIRST statement. A new write RPC
-- that forgets it, or a later migration that replaces a wrapper with a full body, fails here.
select is((select coalesce(array_agg(p.proname::text order by p.proname::text), '{}') from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.provolatile = 'v' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and p.proname not in ('set_maintenance', 'set_maintenance_bypass')
    and regexp_replace(substring(p.prosrc from '\mbegin\M(.*)$'), '^\s*(--[^\n]*\n\s*)*', '') not like 'perform private.assert_not_in_maintenance();%'),
  '{}'::text[], 'every write RPC calls private.assert_not_in_maintenance() before any other statement');
select is((select array_agg(p.proname::text order by p.proname::text) from pg_proc p
  where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.prosrc like '%assert_not_in_maintenance%'),
  (select array_agg(name order by name) from guarded), 'the guarded RPCs are exactly the 24 write RPCs');
select is((select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.provolatile <> 'v' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  and p.prosrc like '%assert_not_in_maintenance%'), 0::bigint, 'report RPCs are not guarded (reads stay RLS-scoped)');
select is((select count(*) from guarded g join pg_proc p on p.proname = g.name and p.pronamespace = 'private'::regnamespace
  where p.prosecdef and not has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('anon', p.oid, 'EXECUTE')),
  23::bigint, 'the 23 moved bodies live in private, still SECURITY DEFINER, with no API grant');

-- 2. Control authorization and validation -----------------------------------------------------------------------------
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

-- 3. Enable: audited once, idempotent ----------------------------------------------------------------------------------
select is(pg_temp.mt(true) - 'enabled_at', '{"ok":true,"changed":true,"enabled":true,"release_ref":"5603633","bypass_user_id":null,"bypass_expires_at":null}'::jsonb, 'owner enables maintenance');
select is(pg_temp.audits('maintenance.enabled'), 1::bigint, 'enable is audited');
select ok((select metadata @> jsonb_build_object('actor', pg_temp.uid('owner'), 'reason', 'Release 5603633 maintenance window', 'release_ref', '5603633') and metadata ? 'at'
  and shop_id is null and actor_id = pg_temp.uid('owner') and entity_type = 'system_maintenance' from public.audit_events where action = 'maintenance.enabled'),
  'the enable audit carries actor, time, reason and release ref');
select is(pg_temp.mt(true, 'Second click') ->> 'changed', 'false', 'enabling again is a no-op');
select is(pg_temp.audits('maintenance.enabled'), 1::bigint, 'the no-op writes no audit row');
select is((select reason from private.system_maintenance), 'Release 5603633 maintenance window', 'the no-op keeps the original reason');

-- 4. Every write RPC refuses for every role, before any validation or work -------------------------------------------
select is((select coalesce(array_agg(r || ':' || g.name || '=' || o order by r, g.name), '{}') from unnest(array['owner', 'manager', 'staff']) r cross join guarded g
  cross join lateral (select pg_temp.act(r)) a
  cross join lateral (select pg_temp.outcome(format('select public.%I(%L::jsonb)', g.name, '{}')) o) x where o <> 'MAINTENANCE_ACTIVE'),
  '{}'::text[], 'owner, manager and staff: all 24 write RPCs refuse with MAINTENANCE_ACTIVE (even an invalid command, so the guard runs first)');
select pg_temp.act('staff');
select throws_ok($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'Maintenance Customer', 'mobile', '55519901'))$$,
  'P0001', 'MAINTENANCE_ACTIVE', 'a valid create_customer refuses');
select is((select count(*) from public.customers where name = 'Maintenance Customer'), 0::bigint, 'nothing was written');
select is(pg_temp.upload(1), '42501', 'staff receipt upload is refused by the Storage policy');
select is((select count(*) from storage.objects where name like '%f9000000-0000-4000-8000-000000000001%'), 0::bigint, 'no orphan object is created');
select lives_ok($$select * from public.report_sales_totals(pg_temp.s1(), current_date - 7, current_date)$$, 'reports still answer (RLS-scoped read)');
select pg_temp.act('owner');
select is(pg_temp.upload(2), '42501', 'owner receipt upload without a bypass is refused');

-- 5. Operator bypass ---------------------------------------------------------------------------------------------------
select throws_ok($$select pg_temp.bypass('manager')$$, 'P0001', 'BYPASS_USER_NOT_ACTIVE_OWNER', 'a manager cannot be the operator');
select throws_ok($$select pg_temp.bypass('staff')$$, 'P0001', 'BYPASS_USER_NOT_ACTIVE_OWNER', 'staff cannot be the operator');
select throws_ok($$select pg_temp.bypass('owner', 0)$$, 'P0001', 'INVALID_REQUEST', 'zero minutes is refused');
select throws_ok($$select pg_temp.bypass('owner', 121)$$, 'P0001', 'INVALID_REQUEST', 'more than 120 minutes is refused');
select throws_ok($$select public.set_maintenance_bypass(jsonb_build_object('user_id', pg_temp.uid('owner'), 'minutes', 10))$$, 'P0001', 'REASON_REQUIRED', 'a bypass needs a reason');
select is(pg_temp.bypass('owner') ->> 'bypass_user_id', pg_temp.uid('owner')::text, 'owner grants the bypass to the owner account');
select ok((select bypass_expires_at = now() + interval '10 minutes' from private.system_maintenance), 'the bypass expires after the requested minutes');
select ok((select metadata @> jsonb_build_object('user_id', pg_temp.uid('owner'), 'minutes', 10, 'release_ref', '5603633') and metadata ? 'expires_at'
  from public.audit_events where action = 'maintenance.operator_bypass_enabled'), 'the bypass grant is audited with user, expiry and release ref');
select ok((public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'Operator Smoke', 'mobile', '55519902')) ->> 'ok')::boolean,
  'the bypass owner can write');
select is(pg_temp.upload(3), 'ok', 'the bypass owner can upload a receipt');
select isnt(pg_temp.outcome($$select public.create_customer(jsonb_build_object('shop_id', gen_random_uuid(), 'name', 'Nowhere', 'mobile', '55519903'))$$),
  'ok','the bypass does not skip the RPC''s own checks (unknown shop still refused)');
update public.shops set is_active = false where id = pg_temp.s2();
select throws_ok($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s2(), 'name', 'Inactive Shop', 'mobile', '55519904'))$$,
  'P0001', 'SHOP_INACTIVE', 'the bypass does not skip shop status');
update public.shops set is_active = true where id = pg_temp.s2();
select pg_temp.act('manager');
select is(pg_temp.outcome($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'Manager Try', 'mobile', '55519905'))$$),
  'MAINTENANCE_ACTIVE', 'a manager is still refused while the owner holds the bypass');
select is(pg_temp.upload(4), '42501', 'a manager upload is still refused');
select pg_temp.act('staff');
select is(pg_temp.outcome($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'Staff Try', 'mobile', '55519906'))$$),
  'MAINTENANCE_ACTIVE', 'staff are still refused while the owner holds the bypass');

-- Expiry: an expired grant is ignored.
update private.system_maintenance set bypass_expires_at = now() - interval '1 second';
select pg_temp.act('owner');
select is(pg_temp.outcome($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'After Expiry', 'mobile', '55519907'))$$),
  'MAINTENANCE_ACTIVE', 'an expired bypass is refused');
select is(pg_temp.upload(5), '42501', 'an expired bypass cannot upload');

-- Revoke: immediate, audited, idempotent.
select pg_temp.bypass('owner');
select is(public.set_maintenance_bypass('{"user_id":null,"reason":"Smoke finished"}') ->> 'changed', 'true', 'owner revokes the bypass');
select is(pg_temp.outcome($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'After Revoke', 'mobile', '55519908'))$$),
  'MAINTENANCE_ACTIVE', 'a revoked bypass is refused at once');
select ok((select metadata @> '{"cause":"revoked"}' from public.audit_events where action = 'maintenance.operator_bypass_disabled'), 'the revoke is audited');
select is(public.set_maintenance_bypass('{"user_id":null,"reason":"Smoke finished"}') ->> 'changed', 'false', 'revoking again is a no-op');
select is(pg_temp.audits('maintenance.operator_bypass_disabled'), 1::bigint, 'the no-op revoke writes no audit row');

-- 6. Disable: clears a live bypass, audited, idempotent; writes work again --------------------------------------------
select pg_temp.bypass('owner');
select throws_ok($$update private.system_maintenance set enabled = false$$, '23514', null, 'the state cannot hold a bypass without maintenance');
select is(pg_temp.mt(false, 'Candidate healthy') - 'enabled_at', '{"ok":true,"changed":true,"enabled":false,"release_ref":null,"bypass_user_id":null,"bypass_expires_at":null}'::jsonb,
  'owner disables maintenance and the bypass goes with it');
select ok((select metadata @> '{"cause":"maintenance_disabled"}' from public.audit_events where action = 'maintenance.operator_bypass_disabled' and metadata @> '{"cause":"maintenance_disabled"}'),
  'the bypass removal is audited');
select ok((select metadata @> '{"reason":"Candidate healthy","release_ref":"5603633"}' from public.audit_events where action = 'maintenance.disabled'), 'disable is audited');
select is(pg_temp.mt(false, 'Again') ->> 'changed', 'false', 'disabling again is a no-op');
select is(pg_temp.audits('maintenance.disabled'), 1::bigint, 'the no-op disable writes no audit row');
select pg_temp.act('staff');
select ok((public.create_customer(jsonb_build_object('shop_id', pg_temp.s1(), 'name', 'Back To Normal', 'mobile', '55519909')) ->> 'ok')::boolean, 'staff can write again');
select is(pg_temp.upload(6), 'ok', 'staff can upload again');
select is(pg_temp.outcome($$select public.create_customer(jsonb_build_object('shop_id', pg_temp.s2(), 'name', 'Wrong Shop', 'mobile', '55519910'))$$),
  'UNAUTHORIZED_SHOP', 'shop isolation is unchanged');

-- 7. Global audit rows are owner-only reads.
select pg_temp.act('staff');
set local role authenticated;
select is((select count(*) from public.audit_events where entity_type = 'system_maintenance'), 0::bigint, 'staff cannot read maintenance audit rows');
reset role;

select * from finish();
rollback;
