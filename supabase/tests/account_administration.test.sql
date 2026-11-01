begin;
create extension if not exists pgtap with schema extensions;
select plan(42);

create function pg_temp.act(who text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', case who
    when 'owner' then '10000000-0000-4000-8000-000000000101' when 'staff' then '10000000-0000-4000-8000-000000000102'
    when 'staff2' then '10000000-0000-4000-8000-000000000103' when 'manager' then '10000000-0000-4000-8000-000000000104'
    when 'nobody' then 'a5000000-0000-4000-8000-000000000001' end)::text, true)
$$;
create function pg_temp.account(target text, new_role text, active boolean) returns jsonb language sql as $$
  select jsonb_build_object('user_id', target, 'role', new_role, 'is_active', active) $$;
create function pg_temp.assign(target text, shop text, assigned boolean) returns jsonb language sql as $$
  select jsonb_build_object('user_id', target, 'shop_id', shop, 'assigned', assigned) $$;
create function pg_temp.audits() returns bigint language sql as $$ select count(*) from public.audit_events where entity_type = 'profile' $$;

-- A sign-in with no ShopKhata profile yet, as the Supabase dashboard creates it.
insert into auth.users(id, instance_id, aud, role, email, encrypted_password, email_confirmed_at)
values ('a5000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'New.Hire@shopkhata.local', '', now());
insert into public.invoices(shop_id, invoice_id, total_amount_dirham, business_date) values ('10000000-0000-4000-8000-000000000001', 'ADMIN-TEST-1', 100, current_date - 400);
select set_config('adm.audits', pg_temp.audits()::text, true);

-- 1. Privileges -----------------------------------------------------------------
select has_function('public', 'admin_update_account', array['jsonb'], 'account update RPC exists');
select ok(not has_function_privilege('anon', 'public.admin_update_account(jsonb)', 'EXECUTE') and not has_function_privilege('anon', 'public.admin_register_account(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_set_shop_assignment(jsonb)', 'EXECUTE'), 'anon cannot execute any administration RPC');
select ok(not has_function_privilege('authenticated', 'private.assert_account_admin()', 'EXECUTE'), 'the administration guard is not directly callable');
select ok(not has_table_privilege('authenticated', 'public.profiles', 'INSERT') and not has_table_privilege('authenticated', 'public.profiles', 'UPDATE') and not has_table_privilege('authenticated', 'public.profiles', 'DELETE'), 'profiles cannot be written outside the RPCs');
select ok(not has_table_privilege('authenticated', 'public.user_shop_assignments', 'INSERT') and not has_table_privilege('authenticated', 'public.user_shop_assignments', 'DELETE'), 'shop assignments cannot be written outside the RPCs');

set local role authenticated;

-- 2. Non-owners ---------------------------------------------------------------------
select pg_temp.act('staff');
select throws_ok($$select public.admin_update_account(pg_temp.account('10000000-0000-4000-8000-000000000102', 'owner', true))$$, '42501', 'INSUFFICIENT_ROLE', 'staff cannot make themselves owner');
select throws_ok($$select public.admin_set_shop_assignment(pg_temp.assign('10000000-0000-4000-8000-000000000102', '10000000-0000-4000-8000-000000000002', true))$$, '42501', 'INSUFFICIENT_ROLE', 'staff cannot assign themselves another shop');
select throws_ok($$update public.profiles set role = 'owner' where id = '10000000-0000-4000-8000-000000000102'$$, '42501', null, 'staff cannot update their profile directly');
select throws_ok($$insert into public.user_shop_assignments(user_id, shop_id) values ('10000000-0000-4000-8000-000000000102', '10000000-0000-4000-8000-000000000002')$$, '42501', null, 'staff cannot insert an assignment directly');
select is((select count(*)::int from public.profiles), 1, 'staff see only their own profile');
select pg_temp.act('manager');
select throws_ok($$select public.admin_update_account(pg_temp.account('10000000-0000-4000-8000-000000000102', 'manager', true))$$, '42501', 'INSUFFICIENT_ROLE', 'a manager cannot change a role');
select throws_ok($$select public.admin_update_account(pg_temp.account('10000000-0000-4000-8000-000000000104', 'owner', true))$$, '42501', 'INSUFFICIENT_ROLE', 'a manager cannot grant themselves owner authority');
select throws_ok($$select public.admin_set_shop_assignment(pg_temp.assign('10000000-0000-4000-8000-000000000104', '10000000-0000-4000-8000-000000000002', true))$$, '42501', 'INSUFFICIENT_ROLE', 'a manager cannot assign themselves an unauthorized shop');
select throws_ok($$select public.admin_register_account('{"email":"new.hire@shopkhata.local","display_name":"New Hire","role":"owner"}')$$, '42501', 'INSUFFICIENT_ROLE', 'a manager cannot register an account');
select pg_temp.act('nobody');
select throws_ok($$select public.admin_update_account(pg_temp.account('10000000-0000-4000-8000-000000000102', 'owner', true))$$, '42501', 'INSUFFICIENT_ROLE', 'a sign-in without a profile cannot administer');
select is(pg_temp.audits(), current_setting('adm.audits')::bigint, 'rejected attempts write no audit row');

-- 3. Owner: validation --------------------------------------------------------------
select pg_temp.act('owner');
select throws_ok($$select public.admin_update_account(pg_temp.account('10000000-0000-4000-8000-000000000101', 'staff', true))$$, 'P0001', 'SELF_CHANGE_FORBIDDEN', 'an owner cannot demote themselves');
select throws_ok($$select public.admin_set_account_status('{"user_id":"10000000-0000-4000-8000-000000000101","is_active":false,"reason":"leaving"}')$$, 'P0001', 'SELF_CHANGE_FORBIDDEN', 'an owner cannot deactivate themselves');
select throws_ok($$select public.admin_update_account(pg_temp.account('10000000-0000-4000-8000-000000000102', 'admin', true))$$, 'P0001', 'INVALID_REQUEST', 'an unknown role is rejected');
select throws_ok($$select public.admin_update_account(pg_temp.account('10000000-0000-4000-8000-000000000102', 'staff', true) || '{"actor_id":"10000000-0000-4000-8000-000000000101"}')$$, 'P0001', 'INVALID_REQUEST', 'unexpected client fields are rejected');
select throws_ok($$select public.admin_update_account(pg_temp.account('a5000000-0000-4000-8000-000000000099', 'staff', true))$$, 'P0001', 'ACCOUNT_NOT_FOUND', 'an unknown account is rejected');
select throws_ok($$select public.admin_set_shop_assignment(pg_temp.assign('10000000-0000-4000-8000-000000000102', 'a5000000-0000-4000-8000-000000000098', true))$$, 'P0001', 'SHOP_NOT_FOUND', 'an unknown shop is rejected');
select is(public.admin_update_account(pg_temp.account('10000000-0000-4000-8000-000000000102', 'staff', true)) ->> 'changed', 'false', 'saving an unchanged account changes nothing');
select is(pg_temp.audits(), current_setting('adm.audits')::bigint, 'an unchanged save writes no audit row');

-- 4. Shop assignment takes effect on the next statement -----------------------------
select is(public.admin_set_shop_assignment(pg_temp.assign('10000000-0000-4000-8000-000000000102', '10000000-0000-4000-8000-000000000001', false)) ->> 'changed', 'true', 'owner removes the Shop 1 assignment');
select pg_temp.act('staff');
select is((select count(*)::int from public.invoices), 0, 'after removal the account reads no invoice');
select throws_ok($$select public.create_customer('{"shop_id":"10000000-0000-4000-8000-000000000001","name":"Removed Staff Customer","mobile":null}')$$, '42501', 'UNAUTHORIZED_SHOP', 'after removal the account cannot write to the shop');
select pg_temp.act('owner');
select lives_ok($$select public.admin_set_shop_assignment(pg_temp.assign('10000000-0000-4000-8000-000000000102', '10000000-0000-4000-8000-000000000002', true))$$, 'owner assigns Shop 2 instead');
select pg_temp.act('staff');
select ok((select count(*) from public.invoices where shop_id = '10000000-0000-4000-8000-000000000001') = 0 and (select count(*) from public.shops) = 1, 'the account now reaches only Shop 2');
select pg_temp.act('owner');
select public.admin_set_shop_assignment(pg_temp.assign('10000000-0000-4000-8000-000000000102', '10000000-0000-4000-8000-000000000002', false));
select public.admin_set_shop_assignment(pg_temp.assign('10000000-0000-4000-8000-000000000102', '10000000-0000-4000-8000-000000000001', true));

-- 5. Deactivation -------------------------------------------------------------------
select lives_ok($$select public.admin_set_account_status('{"user_id":"10000000-0000-4000-8000-000000000102","is_active":false,"reason":"on leave"}')$$, 'owner deactivates the staff account (with a reason, through the status RPC)');
select pg_temp.act('staff');
select is((select count(*)::int from public.invoices), 0, 'a deactivated account reads nothing although its assignment remains');
select throws_ok($$select public.create_customer('{"shop_id":"10000000-0000-4000-8000-000000000001","name":"Deactivated Staff Customer","mobile":null}')$$, '28000', 'AUTHENTICATION_REQUIRED', 'a deactivated account cannot write');
select pg_temp.act('owner');
select public.admin_set_account_status('{"user_id":"10000000-0000-4000-8000-000000000102","is_active":true,"reason":"back from leave"}');
select pg_temp.act('staff');
select ok((select count(*) from public.invoices) > 0, 'reactivation restores access');

-- 6. Owner authority can be handed over but never lost --------------------------------
select pg_temp.act('owner');
select lives_ok($$select public.admin_update_account(pg_temp.account('10000000-0000-4000-8000-000000000104', 'owner', true))$$, 'an owner can promote a manager to owner');
select pg_temp.act('manager');
select lives_ok($$select public.admin_update_account(pg_temp.account('10000000-0000-4000-8000-000000000101', 'manager', true))$$, 'the new owner can demote the previous owner');
select pg_temp.act('owner');
select throws_ok($$select public.admin_update_account(pg_temp.account('10000000-0000-4000-8000-000000000104', 'staff', true))$$, '42501', 'INSUFFICIENT_ROLE', 'a demoted owner loses administration immediately');
select pg_temp.act('manager');
select throws_ok($$select public.admin_update_account(pg_temp.account('10000000-0000-4000-8000-000000000104', 'manager', true))$$, 'P0001', 'SELF_CHANGE_FORBIDDEN', 'the only remaining owner cannot remove their own authority');
select is((select count(*)::int from public.profiles where role = 'owner' and is_active), 1, 'an active owner always remains');

-- 7. Registration ---------------------------------------------------------------------
select throws_ok($$select public.admin_register_account('{"email":"missing@shopkhata.local","display_name":"Missing","role":"staff"}')$$, 'P0001', 'ACCOUNT_NOT_FOUND', 'an email with no sign-in cannot be registered');
select public.admin_register_account('{"email":" new.hire@shopkhata.local ","display_name":"New Hire","role":"staff"}');
select is((select role || ':' || is_active from public.profiles where id = 'a5000000-0000-4000-8000-000000000001'), 'staff:true', 'owner registers an existing sign-in, matched case-insensitively');
select throws_ok($$select public.admin_register_account('{"email":"new.hire@shopkhata.local","display_name":"New Hire","role":"staff"}')$$, 'P0001', 'ACCOUNT_EXISTS', 'an account cannot be registered twice');

-- 8. Audit ------------------------------------------------------------------------------
select is((select array_agg(action order by recorded_at, action) from public.audit_events where entity_type = 'profile' and action not like 'assignment.%'),
  array['account.deactivate', 'account.reactivate', 'account.register', 'account.update', 'account.update'], 'every account change is audited once (pgTAP runs in one transaction, so the timestamps are equal)');

select * from finish();
rollback;
