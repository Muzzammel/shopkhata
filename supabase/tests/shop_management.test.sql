begin;
create extension if not exists pgtap with schema extensions;
select plan(54);

create function pg_temp.act(who text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', case who
    when 'owner' then '10000000-0000-4000-8000-000000000101' when 'staff' then '10000000-0000-4000-8000-000000000102'
    when 'manager' then '10000000-0000-4000-8000-000000000104' end)::text, true)
$$;
create function pg_temp.audits() returns bigint language sql as $$ select count(*) from public.audit_events where entity_type = 'shop' $$;
create function pg_temp.new_shop() returns uuid language sql as $$ select current_setting('shp.sid')::uuid $$;
create function pg_temp.visible(sid uuid) returns bigint language sql as $$ select count(*) from public.shops where id = sid $$;

select set_config('shp.audits', pg_temp.audits()::text, true);
select set_config('shp.s1_invoices', (select count(*)::text from public.invoices where shop_id = '10000000-0000-4000-8000-000000000001'), true);

-- 1. Privileges -----------------------------------------------------------------
select has_function('public', 'admin_create_shop', array['jsonb'], 'create RPC exists');
select has_function('public', 'admin_update_shop', array['jsonb'], 'rename RPC exists');
select ok(not has_function_privilege('anon', 'public.admin_create_shop(jsonb)', 'EXECUTE') and not has_function_privilege('anon', 'public.admin_update_shop(jsonb)', 'EXECUTE'), 'anon cannot execute either shop RPC');
select ok(has_function_privilege('authenticated', 'public.admin_create_shop(jsonb)', 'EXECUTE') and has_function_privilege('authenticated', 'public.admin_update_shop(jsonb)', 'EXECUTE'), 'the owner check lives inside the RPCs, not in the grant');
select ok(not has_table_privilege('authenticated', 'public.shops', 'INSERT') and not has_table_privilege('authenticated', 'public.shops', 'UPDATE') and not has_table_privilege('authenticated', 'public.shops', 'DELETE'), 'authenticated has no write privilege on shops');
select ok(not has_table_privilege('anon', 'public.shops', 'INSERT') and not has_table_privilege('anon', 'public.shops', 'UPDATE') and not has_table_privilege('anon', 'public.shops', 'DELETE'), 'anon has no write privilege on shops');
select ok((select prosecdef from pg_proc where oid = 'public.admin_create_shop(jsonb)'::regprocedure) and (select prosecdef from pg_proc where oid = 'public.admin_update_shop(jsonb)'::regprocedure), 'both RPCs are SECURITY DEFINER');

-- 2. Anonymous ------------------------------------------------------------------------
set local role anon;
select throws_ok($$select public.admin_create_shop('{"name":"Anon Shop"}')$$, '42501', null, 'anon cannot create a shop');
select throws_ok($$select public.admin_update_shop('{"shop_id":"10000000-0000-4000-8000-000000000001","name":"Anon Rename"}')$$, '42501', null, 'anon cannot rename a shop');

-- 3. Non-owners ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act('manager');
select throws_ok($$select public.admin_create_shop('{"name":"Manager Shop"}')$$, '42501', 'INSUFFICIENT_ROLE', 'a manager cannot create a shop');
select throws_ok($$select public.admin_update_shop('{"shop_id":"10000000-0000-4000-8000-000000000001","name":"Manager Rename"}')$$, '42501', 'INSUFFICIENT_ROLE', 'a manager cannot rename a shop');
select pg_temp.act('staff');
select throws_ok($$select public.admin_create_shop('{"name":"Staff Shop"}')$$, '42501', 'INSUFFICIENT_ROLE', 'staff cannot create a shop');
select throws_ok($$select public.admin_update_shop('{"shop_id":"10000000-0000-4000-8000-000000000001","name":"Staff Rename"}')$$, '42501', 'INSUFFICIENT_ROLE', 'staff cannot rename a shop');
select throws_ok($$insert into public.shops(name) values ('Direct Insert')$$, '42501', null, 'staff cannot insert into shops directly');
select throws_ok($$update public.shops set name = 'Direct Update' where id = '10000000-0000-4000-8000-000000000001'$$, '42501', null, 'staff cannot update shops directly');
select is(pg_temp.audits(), current_setting('shp.audits')::bigint, 'rejected non-owner attempts write no audit row');

-- 4. Owner: direct writes stay closed, input is validated -----------------------------------
select pg_temp.act('owner');
select throws_ok($$insert into public.shops(name) values ('Direct Insert')$$, '42501', null, 'even an owner cannot insert into shops directly');
select throws_ok($$update public.shops set name = 'Direct Update' where id = '10000000-0000-4000-8000-000000000001'$$, '42501', null, 'even an owner cannot update shops directly');
select throws_ok($$delete from public.shops where id = '10000000-0000-4000-8000-000000000002'$$, '42501', null, 'even an owner cannot delete a shop');
select throws_ok($$select public.admin_create_shop('{"name":"  "}')$$, 'P0001', 'INVALID_REQUEST', 'a blank name is rejected');
select throws_ok($$select public.admin_create_shop('{}')$$, 'P0001', 'INVALID_REQUEST', 'a missing name is rejected');
select throws_ok($$select public.admin_create_shop('{"name":42}')$$, 'P0001', 'INVALID_REQUEST', 'a non-string name is rejected');
select throws_ok($$select public.admin_create_shop(jsonb_build_object('name', repeat('x', 101)))$$, 'P0001', 'INVALID_REQUEST', 'an over-long name is rejected');
select throws_ok($$select public.admin_create_shop('{"name":"Doha Branch","is_active":false}')$$, 'P0001', 'INVALID_REQUEST', 'unknown keys are rejected on create');
select throws_ok($$select public.admin_create_shop('{"name":"Doha Branch","id":"10000000-0000-4000-8000-0000000000aa"}')$$, 'P0001', 'INVALID_REQUEST', 'a client-chosen id is rejected on create');
select throws_ok($$select public.admin_create_shop('["Doha Branch"]')$$, 'P0001', 'INVALID_REQUEST', 'a non-object command is rejected');
select throws_ok($$select public.admin_create_shop('{"name":" shop 1 "}')$$, 'P0001', 'SHOP_NAME_EXISTS', 'a duplicate of an active shop is rejected case-insensitively, ignoring outer spaces');
select is(pg_temp.audits(), current_setting('shp.audits')::bigint, 'rejected owner attempts write no audit row');

-- 5. Owner creates a shop ---------------------------------------------------------------------
select is(public.admin_create_shop('{"name":"  Doha Branch  "}') ->> 'name', 'Doha Branch', 'owner creates a shop; the name is trimmed');
select set_config('shp.sid', (select id::text from public.shops where name = 'Doha Branch'), true);
select isnt(pg_temp.new_shop(), null, 'the new shop exists with a database-generated id');
select is((select is_active from public.shops where id = pg_temp.new_shop()), true, 'the new shop is active');
select is((select count(*)::int from public.user_shop_assignments where shop_id = pg_temp.new_shop()), 0, 'no assignment row is created for the owner');
select is(pg_temp.visible(pg_temp.new_shop()), 1::bigint, 'the owner sees the new shop without any assignment');
select is((select count(*)::int from public.audit_events where action = 'shop.create' and entity_type = 'shop' and entity_id = pg_temp.new_shop()::text and shop_id = pg_temp.new_shop()
  and metadata = '{"name":"Doha Branch"}'::jsonb and actor_id = '10000000-0000-4000-8000-000000000101'), 1, 'creation is audited once with the shop id and name');
select throws_ok($$select public.admin_create_shop('{"name":"DOHA BRANCH"}')$$, 'P0001', 'SHOP_NAME_EXISTS', 'creating the same name in another case is rejected');

-- 6. A new shop is empty and isolated -----------------------------------------------------------
select ok((select count(*) from public.invoices where shop_id = pg_temp.new_shop()) = 0
  and (select count(*) from public.customers where shop_id = pg_temp.new_shop()) = 0
  and (select count(*) from public.payments where shop_id = pg_temp.new_shop()) = 0
  and (select count(*) from public.expenses where shop_id = pg_temp.new_shop()) = 0, 'the new shop starts with no invoices, customers, payments or expenses');
select is((select count(*)::text from public.invoices where shop_id = '10000000-0000-4000-8000-000000000001'), current_setting('shp.s1_invoices'), 'Shop 1 data is unchanged by creating a shop');

-- 7. Managers and staff see the shop only after assignment -----------------------------------------
select pg_temp.act('manager');
select is(pg_temp.visible(pg_temp.new_shop()), 0::bigint, 'a manager does not see an unassigned new shop');
select throws_ok(format($$select public.create_customer('{"shop_id":"%s","name":"Blocked","mobile":null}')$$, pg_temp.new_shop()), '42501', 'UNAUTHORIZED_SHOP', 'a manager cannot write to an unassigned new shop');
select pg_temp.act('owner');
select is(public.admin_set_shop_assignment(jsonb_build_object('user_id', '10000000-0000-4000-8000-000000000104', 'shop_id', pg_temp.new_shop(), 'assigned', true)) ->> 'changed', 'true', 'owner assigns the manager through the existing assignment RPC');
select pg_temp.act('manager');
select is(pg_temp.visible(pg_temp.new_shop()), 1::bigint, 'assignment grants the manager access');
select pg_temp.act('staff');
select is(pg_temp.visible(pg_temp.new_shop()), 0::bigint, 'staff without an assignment still do not see it');
select pg_temp.act('owner');
select public.admin_set_shop_assignment(jsonb_build_object('user_id', '10000000-0000-4000-8000-000000000104', 'shop_id', pg_temp.new_shop(), 'assigned', false));
select pg_temp.act('manager');
select is(pg_temp.visible(pg_temp.new_shop()), 0::bigint, 'removing the assignment revokes access');

-- 8. Rename ------------------------------------------------------------------------------------------------
select pg_temp.act('owner');
select throws_ok($$select public.admin_update_shop('{"name":"Rename"}')$$, 'P0001', 'INVALID_REQUEST', 'rename needs a shop id');
select throws_ok($$select public.admin_update_shop('{"shop_id":"not-a-uuid","name":"Rename"}')$$, 'P0001', 'INVALID_REQUEST', 'rename rejects a malformed id');
select throws_ok($$select public.admin_update_shop('{"shop_id":"10000000-0000-4000-8000-000000000001","name":"Rename","is_active":false}')$$, 'P0001', 'INVALID_REQUEST', 'rename cannot carry an is_active change');
select throws_ok($$select public.admin_update_shop('{"shop_id":"a5000000-0000-4000-8000-000000000098","name":"Ghost"}')$$, 'P0001', 'SHOP_NOT_FOUND', 'rename of an unknown shop is rejected');
select throws_ok(format($$select public.admin_update_shop('{"shop_id":"%s","name":"shop 2"}')$$, pg_temp.new_shop()), 'P0001', 'SHOP_NAME_EXISTS', 'renaming onto another active shop is rejected case-insensitively');
select is(public.admin_update_shop(jsonb_build_object('shop_id', pg_temp.new_shop(), 'name', 'doha branch')) ->> 'changed', 'true', 'a case-only rename of the shop itself is allowed');
select is(public.admin_update_shop(jsonb_build_object('shop_id', pg_temp.new_shop(), 'name', ' Doha Central ')) ->> 'changed', 'true', 'owner renames the shop');
select is(public.admin_update_shop(jsonb_build_object('shop_id', pg_temp.new_shop(), 'name', 'Doha Central')) ->> 'changed', 'false', 'saving the same name changes nothing');
select is((select count(*)::int from public.shops where name = 'Doha Central' and id = pg_temp.new_shop() and is_active), 1, 'the rename keeps the same id and active state');
select ok((select count(*) from public.audit_events where action = 'shop.update' and entity_type = 'shop' and entity_id = pg_temp.new_shop()::text and shop_id = pg_temp.new_shop()) = 2
  and exists (select 1 from public.audit_events where action = 'shop.update' and metadata = '{"old_name":"Doha Branch","new_name":"doha branch"}'::jsonb)
  and exists (select 1 from public.audit_events where action = 'shop.update' and metadata = '{"old_name":"doha branch","new_name":"Doha Central"}'::jsonb), 'each rename is audited with the old and new name (the unchanged save wrote nothing)');
select pg_temp.act('staff');
select throws_ok(format($$select public.admin_update_shop('{"shop_id":"%s","name":"Staff Rename"}')$$, pg_temp.new_shop()), '42501', 'INSUFFICIENT_ROLE', 'staff still cannot rename after the shop exists');

select * from finish();
rollback;
