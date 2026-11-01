begin;
-- current_date below must be the Qatar operating date the RPCs enforce.
set local timezone = 'Asia/Qatar';
create extension if not exists pgtap with schema extensions;
select plan(105);

-- OPS-01A: owner-only Active / Inactive controls for shops and accounts (20261031165915).
-- The concurrent deactivate-versus-write race needs two sessions and lives in
-- tests/integration/shops/status-controls.test.ts.

create function pg_temp.act(who text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', case who
    when 'owner' then '10000000-0000-4000-8000-000000000101' when 'staff' then '10000000-0000-4000-8000-000000000102'
    when 'staff2' then '10000000-0000-4000-8000-000000000103' when 'manager' then '10000000-0000-4000-8000-000000000104' end)::text, true)
$$;
create function pg_temp.s1() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.s2() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.staff() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000102'::uuid $$;
create function pg_temp.shop_cmd(sid uuid, active boolean, why text) returns jsonb language sql as $$
  select jsonb_build_object('shop_id', sid, 'is_active', active, 'reason', why) $$;
create function pg_temp.acct_cmd(uid uuid, active boolean, why text) returns jsonb language sql as $$
  select jsonb_build_object('user_id', uid, 'is_active', active, 'reason', why) $$;
create function pg_temp.audits(kind text) returns bigint language sql as $$ select count(*) from public.audit_events where entity_type = kind $$;
create function pg_temp.batch(key text, number text) returns jsonb language sql as $$
  select jsonb_build_object('shop_id', pg_temp.s1(), 'business_date', current_date::text, 'idempotency_key', key, 'rows', jsonb_build_array(
    jsonb_build_object('row_id', number, 'invoice_number', number, 'total_dirham', 500, 'received_dirham', 200, 'payment_method', 'cash', 'delivered', false, 'customer', null))) $$;
create function pg_temp.customer(sid uuid, nm text) returns jsonb language sql as $$ select jsonb_build_object('shop_id', sid, 'name', nm, 'mobile', null) $$;
create function pg_temp.expense(key text) returns jsonb language sql as $$
  select jsonb_build_object('shop_id', pg_temp.s1(), 'amount_dirham', 100, 'business_date', current_date::text, 'category', 'supplies', 'description', 'Paper', 'idempotency_key', key) $$;
-- Every row a shop's operations can produce, so "nothing was written" is checked across all of them.
create function pg_temp.s1_rows() returns bigint language sql as $$
  select (select count(*) from public.invoices where shop_id = pg_temp.s1()) + (select count(*) from public.payments where shop_id = pg_temp.s1())
    + (select count(*) from public.customers where shop_id = pg_temp.s1()) + (select count(*) from public.expenses where shop_id = pg_temp.s1())
    + (select count(*) from public.batches where shop_id = pg_temp.s1()) + (select count(*) from public.daily_closes where shop_id = pg_temp.s1())
    + (select count(*) from public.correction_requests where shop_id = pg_temp.s1()) + (select count(*) from public.customer_credits where shop_id = pg_temp.s1())
    + (select count(*) from public.customer_payment_batches where shop_id = pg_temp.s1()) + (select count(*) from public.invoice_number_registry where shop_id = pg_temp.s1()) $$;

-- History written before any status change: a customer with an open invoice, created by staff.
insert into public.customers(id, shop_id, name, mobile, created_by) values
  ('c6000000-0000-4000-8000-000000000001', pg_temp.s1(), 'Status Customer', '55560001', pg_temp.staff());
insert into public.invoices(id, shop_id, customer_id, invoice_id, total_amount_dirham, business_date, delivered, created_by) values
  ('a6000000-0000-4000-8000-000000000001', pg_temp.s1(), 'c6000000-0000-4000-8000-000000000001', 'ST-OPEN', 1000, current_date - 1, true, pg_temp.staff());

-- 1. Catalog and privileges --------------------------------------------------------------------------
select has_function('public', 'admin_set_shop_status', array['jsonb'], 'shop status RPC exists');
select has_function('public', 'admin_set_account_status', array['jsonb'], 'account status RPC exists');
select ok(not has_function_privilege('anon', 'public.admin_set_shop_status(jsonb)', 'EXECUTE') and not has_function_privilege('anon', 'public.admin_set_account_status(jsonb)', 'EXECUTE'), 'anon cannot execute either status RPC');
select ok(has_function_privilege('authenticated', 'public.admin_set_shop_status(jsonb)', 'EXECUTE') and has_function_privilege('authenticated', 'public.admin_set_account_status(jsonb)', 'EXECUTE'), 'the owner check lives inside the RPCs, not in the grant');
select ok((select prosecdef from pg_proc where oid = 'public.admin_set_shop_status(jsonb)'::regprocedure) and (select prosecdef from pg_proc where oid = 'public.admin_set_account_status(jsonb)'::regprocedure), 'both status RPCs are SECURITY DEFINER (they write tables the caller cannot)');
select ok(not (select prosecdef from pg_proc where oid = 'private.enforce_active_shop()'::regprocedure), 'the write guard runs with the privileges of the writing RPC, not as SECURITY DEFINER');
select ok(not has_function_privilege('authenticated', 'private.enforce_active_shop()', 'EXECUTE') and not has_function_privilege('anon', 'private.enforce_active_shop()', 'EXECUTE'), 'the write guard is not callable through the Data API');
select ok((select prosrc from pg_proc where oid = 'private.enforce_active_shop()'::regprocedure) ~* 'for share', 'the write guard locks the shop row, so it serializes with a deactivation');
select is((select array_agg(c.relname::text order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and t.tgfoid = 'private.enforce_active_shop()'::regprocedure and t.tgtype & 4 = 4),
  (select array_agg(c.table_name::text order by c.table_name) from information_schema.columns c join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'shop_id' and tb.table_type = 'BASE TABLE' and c.table_name not in ('audit_events', 'user_shop_assignments')),
  'every shop-scoped operational table has the INSERT guard; only the audit history and access assignments are exempt');
select ok(not has_table_privilege('authenticated', 'public.shops', 'UPDATE') and not has_table_privilege('authenticated', 'public.profiles', 'UPDATE'), 'status cannot be changed by a direct write');

-- 2. Anonymous ------------------------------------------------------------------------------------------
set local role anon;
select throws_ok($$select public.admin_set_shop_status(pg_temp.shop_cmd(pg_temp.s1(), false, 'anon'))$$, '42501', null, 'anon cannot deactivate a shop');
select throws_ok($$select public.admin_set_account_status(pg_temp.acct_cmd(pg_temp.staff(), false, 'anon'))$$, '42501', null, 'anon cannot deactivate an account');
reset role;
select set_config('st.shop_audits', pg_temp.audits('shop')::text, true);
select set_config('st.profile_audits', pg_temp.audits('profile')::text, true);

-- 3. Staff and managers ---------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act('staff');
select throws_ok($$select public.admin_set_shop_status(pg_temp.shop_cmd(pg_temp.s1(), false, 'staff'))$$, '42501', 'INSUFFICIENT_ROLE', 'staff cannot deactivate their own shop');
select throws_ok($$select public.admin_set_shop_status(pg_temp.shop_cmd(pg_temp.s2(), false, 'staff'))$$, '42501', 'INSUFFICIENT_ROLE', 'staff cannot deactivate another shop');
select throws_ok($$select public.admin_set_account_status(pg_temp.acct_cmd('10000000-0000-4000-8000-000000000103', false, 'staff'))$$, '42501', 'INSUFFICIENT_ROLE', 'staff cannot deactivate another account');
select throws_ok($$update public.shops set is_active = false where id = pg_temp.s1()$$, '42501', null, 'staff cannot flip a shop directly');
select throws_ok($$update public.profiles set is_active = false where id = pg_temp.staff()$$, '42501', null, 'staff cannot flip a profile directly');
select pg_temp.act('manager');
select throws_ok($$select public.admin_set_shop_status(pg_temp.shop_cmd(pg_temp.s1(), false, 'manager'))$$, '42501', 'INSUFFICIENT_ROLE', 'a manager cannot deactivate an assigned shop');
select throws_ok($$select public.admin_set_account_status(pg_temp.acct_cmd(pg_temp.staff(), false, 'manager'))$$, '42501', 'INSUFFICIENT_ROLE', 'a manager cannot deactivate staff');
select throws_ok($$select public.admin_set_account_status(pg_temp.acct_cmd('10000000-0000-4000-8000-000000000101', false, 'manager'))$$, '42501', 'INSUFFICIENT_ROLE', 'a manager cannot deactivate the owner');
reset role;
select is(pg_temp.audits('shop') + pg_temp.audits('profile'), current_setting('st.shop_audits')::bigint + current_setting('st.profile_audits')::bigint, 'rejected non-owner attempts write no audit row');
select is((select count(*)::int from public.shops where is_active) + (select count(*)::int from public.profiles where is_active), 6, 'rejected attempts change no status');

-- 4. Owner: validation ------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act('owner');
select throws_ok($$select public.admin_set_shop_status(jsonb_build_object('shop_id', pg_temp.s1(), 'is_active', false))$$, 'P0001', 'INVALID_REQUEST', 'a shop status change without a reason is rejected');
select throws_ok($$select public.admin_set_shop_status(pg_temp.shop_cmd(pg_temp.s1(), false, '   '))$$, 'P0001', 'REASON_REQUIRED', 'a blank shop reason is rejected');
select throws_ok($$select public.admin_set_shop_status(pg_temp.shop_cmd(pg_temp.s1(), false, repeat('x', 2001)))$$, 'P0001', 'INVALID_REQUEST', 'a shop reason over 2000 characters is rejected');
select throws_ok($$select public.admin_set_shop_status(jsonb_build_object('shop_id', pg_temp.s1(), 'is_active', false, 'reason', 42))$$, 'P0001', 'INVALID_REQUEST', 'a non-text reason is rejected');
select throws_ok($$select public.admin_set_shop_status(jsonb_build_object('shop_id', pg_temp.s1(), 'is_active', 'false', 'reason', 'x'))$$, 'P0001', 'INVALID_REQUEST', 'a non-boolean status is rejected');
select throws_ok($$select public.admin_set_shop_status(pg_temp.shop_cmd(pg_temp.s1(), false, 'x') || '{"actor_id":"10000000-0000-4000-8000-000000000104"}')$$, 'P0001', 'INVALID_REQUEST', 'a client-supplied actor is rejected');
select throws_ok($$select public.admin_set_shop_status(pg_temp.shop_cmd('a6000000-0000-4000-8000-000000000099', false, 'x'))$$, 'P0001', 'SHOP_NOT_FOUND', 'an unknown shop is rejected');
select throws_ok($$select public.admin_set_account_status(jsonb_build_object('user_id', pg_temp.staff(), 'is_active', false))$$, 'P0001', 'INVALID_REQUEST', 'an account status change without a reason is rejected');
select throws_ok($$select public.admin_set_account_status(pg_temp.acct_cmd(pg_temp.staff(), false, ''))$$, 'P0001', 'REASON_REQUIRED', 'a blank account reason is rejected');
select throws_ok($$select public.admin_set_account_status(pg_temp.acct_cmd('a6000000-0000-4000-8000-000000000098', false, 'x'))$$, 'P0001', 'ACCOUNT_NOT_FOUND', 'an unknown account is rejected');
select throws_ok($$select public.admin_set_account_status(pg_temp.acct_cmd('10000000-0000-4000-8000-000000000101', false, 'leaving'))$$, 'P0001', 'SELF_CHANGE_FORBIDDEN', 'the owner cannot deactivate themselves');
reset role;
select is(pg_temp.audits('shop') + pg_temp.audits('profile'), current_setting('st.shop_audits')::bigint + current_setting('st.profile_audits')::bigint, 'rejected owner attempts write no audit row');

-- 5. Before deactivation: a batch, a closed date, and a baseline ------------------------------------------------
set local role authenticated;
select pg_temp.act('staff');
select is((public.submit_batch(pg_temp.batch('st-before', 'ST-BEFORE')) ->> 'ok')::boolean, true, 'the active shop accepts a batch');
select pg_temp.act('manager');
select is((public.close_business_date(jsonb_build_object('shop_id', pg_temp.s1(), 'business_date', (current_date - 3)::text)) ->> 'ok')::boolean, true, 'a past date is closed while the shop is active');
reset role;
select set_config('st.rows', pg_temp.s1_rows()::text, true);
select set_config('st.daily', (select coalesce(jsonb_agg(to_jsonb(r) order by r.business_date), '[]'::jsonb)::text from public.report_daily_summary(pg_temp.s1(), current_date - 7, current_date) r), true);
select set_config('st.updated', (select updated_at::text from public.shops where id = pg_temp.s1()), true);

-- 6. Owner deactivates Shop 1 ----------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act('owner');
select is(public.admin_set_shop_status(pg_temp.shop_cmd(pg_temp.s1(), false, '  Branch closed for renovation  ')),
  jsonb_build_object('ok', true, 'shop_id', pg_temp.s1(), 'is_active', false, 'changed', true), 'the owner deactivates an active shop');
reset role;
select is((select is_active from public.shops where id = pg_temp.s1()), false, 'the shop is now inactive');
select is((select count(*)::int from public.shops where id = pg_temp.s1()), 1, 'the shop row is kept, not deleted');
select ok((select count(*) from public.audit_events where action = 'shop.deactivate' and entity_type = 'shop' and entity_id = pg_temp.s1()::text and shop_id = pg_temp.s1()
  and actor_id = '10000000-0000-4000-8000-000000000101' and reason = 'Branch closed for renovation' and recorded_at is not null
  and metadata = '{"name":"Shop 1","before":{"is_active":true},"after":{"is_active":false}}'::jsonb) = 1,
  'the deactivation is audited once: shop, actor, trimmed reason, previous and new state, timestamp');
set local role authenticated;
select pg_temp.act('owner');
select is(public.admin_set_shop_status(pg_temp.shop_cmd(pg_temp.s1(), false, 'again')) ->> 'changed', 'false', 'deactivating an inactive shop again changes nothing');
reset role;
select is(pg_temp.audits('shop'), current_setting('st.shop_audits')::bigint + 1, 'the repeated request writes no second audit row');

-- 7. Inactive shop: every write path is refused, history is kept ---------------------------------------------------------
set local role authenticated;
select pg_temp.act('staff');
select throws_ok($$select public.submit_batch(pg_temp.batch('st-after', 'ST-AFTER'))$$, 'P0001', 'SHOP_INACTIVE', 'staff cannot submit a new invoice batch');
select throws_ok($$select public.record_payment(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', 'a6000000-0000-4000-8000-000000000001', 'amount_dirham', 100, 'payment_method', 'cash', 'business_date', current_date::text, 'idempotency_key', 'st-pay'))$$,
  'P0001', 'SHOP_INACTIVE', 'staff cannot record an invoice payment');
select throws_ok($$select public.record_customer_payment(jsonb_build_object('shop_id', pg_temp.s1(), 'customer_id', 'c6000000-0000-4000-8000-000000000001', 'amount_dirham', 100, 'business_date', current_date::text, 'idempotency_key', 'st-cpay'))$$,
  'P0001', 'SHOP_INACTIVE', 'staff cannot record a customer payment');
select throws_ok($$select public.create_expense(pg_temp.expense('st-exp'))$$, 'P0001', 'SHOP_INACTIVE', 'staff cannot create an expense');
select throws_ok($$select public.create_customer(pg_temp.customer(pg_temp.s1(), 'Inactive Shop Customer'))$$, 'P0001', 'SHOP_INACTIVE', 'staff cannot create a customer');
select throws_ok($$select public.request_invoice_correction(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', 'a6000000-0000-4000-8000-000000000001', 'reason', 'typo', 'idempotency_key', 'st-corr', 'payment_id', null, 'amount_delta_dirham', -100))$$,
  'P0001', 'SHOP_INACTIVE', 'staff cannot request an invoice correction');
select is((public.submit_batch(pg_temp.batch('st-before', 'ST-BEFORE')) ->> 'ok')::boolean, true, 'an exact retry of a batch committed before deactivation still returns its original result');
select pg_temp.act('manager');
select throws_ok($$select public.close_business_date(jsonb_build_object('shop_id', pg_temp.s1(), 'business_date', current_date::text))$$, 'P0001', 'SHOP_INACTIVE', 'a manager cannot close a date');
select pg_temp.act('owner');
select throws_ok($$select public.reopen_business_date(jsonb_build_object('shop_id', pg_temp.s1(), 'business_date', (current_date - 3)::text, 'reason', 'late receipt'))$$, 'P0001', 'SHOP_INACTIVE', 'not even the owner can reopen a date');
select throws_ok($$select public.submit_batch(pg_temp.batch('st-owner', 'ST-OWNER'))$$, 'P0001', 'SHOP_INACTIVE', 'not even the owner can record a sale in an inactive shop');
select throws_ok($$select public.approve_overpayment(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', 'a6000000-0000-4000-8000-000000000001', 'amount_dirham', 1500, 'payment_method', 'cash', 'business_date', current_date::text, 'idempotency_key', 'st-ov', 'reason', 'overpaid'))$$,
  'P0001', 'SHOP_INACTIVE', 'the owner cannot approve an overpayment in an inactive shop');
reset role;
select throws_ok($$insert into public.customers(shop_id, name, created_by) values (pg_temp.s1(), 'Direct', pg_temp.staff())$$, 'P0001', 'SHOP_INACTIVE', 'the guard also refuses a write that bypasses the RPCs');
select is(pg_temp.s1_rows()::text, current_setting('st.rows'), 'no refused attempt left any row in the inactive shop');
select is((select total_amount_dirham from public.invoices where id = 'a6000000-0000-4000-8000-000000000001'), 1000::bigint, 'existing invoice amounts are untouched');
select is((select coalesce(jsonb_agg(to_jsonb(r) order by r.business_date), '[]'::jsonb)::text from public.report_daily_summary(pg_temp.s1(), current_date - 7, current_date) r),
  current_setting('st.daily'), 'the daily report of the inactive shop is unchanged');

set local role authenticated;
select pg_temp.act('staff');
select is((select count(*)::int from public.shops where id = pg_temp.s1()), 1, 'assigned staff still read the inactive shop');
select ok((select count(*) from public.invoices where shop_id = pg_temp.s1()) >= 2, 'assigned staff still read its invoices');
select is((select outstanding_due_dirham from public.customer_financial_balances where customer_id = 'c6000000-0000-4000-8000-000000000001'), 1000::bigint, 'customer balances still read');
select pg_temp.act('owner');
select ok((select count(*) from public.report_daily_summary(pg_temp.s1(), current_date - 7, current_date)) >= 1, 'the owner still reads reports of the inactive shop');
select ok((select count(*) from public.daily_closes where shop_id = pg_temp.s1()) >= 1, 'Daily Close history still reads');
select pg_temp.act('staff2');
select is((public.create_customer(pg_temp.customer(pg_temp.s2(), 'Shop 2 Still Open')) ->> 'ok')::boolean, true, 'another shop keeps working');
select is((select count(*)::int from public.shops where id = pg_temp.s1()), 0, 'shop isolation is unchanged: staff of Shop 2 still cannot read Shop 1');
reset role;

-- 8. Reactivation -------------------------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act('staff');
select throws_ok($$select public.admin_set_shop_status(pg_temp.shop_cmd(pg_temp.s1(), true, 'staff'))$$, '42501', 'INSUFFICIENT_ROLE', 'staff cannot reactivate a shop');
select pg_temp.act('owner');
select throws_ok($$select public.admin_set_shop_status(pg_temp.shop_cmd(pg_temp.s1(), true, ' '))$$, 'P0001', 'REASON_REQUIRED', 'reactivation needs a reason too');
select is(public.admin_set_shop_status(pg_temp.shop_cmd(pg_temp.s1(), true, 'Renovation finished')) ->> 'changed', 'true', 'the owner reactivates the shop');
reset role;
select is((select is_active from public.shops where id = pg_temp.s1()), true, 'the shop is active again');
select ok((select count(*) from public.audit_events where action = 'shop.reactivate' and entity_id = pg_temp.s1()::text and shop_id = pg_temp.s1()
  and actor_id = '10000000-0000-4000-8000-000000000101' and reason = 'Renovation finished'
  and metadata = '{"name":"Shop 1","before":{"is_active":false},"after":{"is_active":true}}'::jsonb) = 1, 'the reactivation is audited with its reason and state change');
set local role authenticated;
select pg_temp.act('staff');
select is((public.submit_batch(pg_temp.batch('st-after', 'ST-AFTER')) ->> 'ok')::boolean, true, 'the reactivated shop accepts the batch that was refused');
select is((public.create_expense(pg_temp.expense('st-exp')) ->> 'ok')::boolean, true, 'and an expense');
select is((public.create_customer(pg_temp.customer(pg_temp.s1(), 'After Reactivation')) ->> 'ok')::boolean, true, 'and a customer');
select pg_temp.act('owner');
select is(public.admin_set_shop_status(pg_temp.shop_cmd(pg_temp.s1(), true, 'again')) ->> 'changed', 'false', 'reactivating an active shop again changes nothing');
reset role;
select is((select array_agg(action order by action) from public.audit_events where entity_type = 'shop' and entity_id = pg_temp.s1()::text),
  array['shop.deactivate', 'shop.reactivate'], 'exactly one audit row per real transition');

-- A shop cannot come back under a name another active shop took while it was inactive.
set local role authenticated;
select pg_temp.act('owner');
select public.admin_set_shop_status(pg_temp.shop_cmd(pg_temp.s2(), false, 'merging'));
select is(public.admin_create_shop('{"name":"shop 2"}') ->> 'name', 'shop 2', 'a new shop may take the name of an inactive shop');
select throws_ok($$select public.admin_set_shop_status(pg_temp.shop_cmd(pg_temp.s2(), true, 'undo merge'))$$, 'P0001', 'SHOP_NAME_EXISTS', 'reactivating onto an active name is refused');
reset role;
select is((select is_active from public.shops where id = pg_temp.s2()), false, 'the refused reactivation left the shop inactive');

-- 9. Account status -------------------------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act('owner');
select throws_ok($$select public.admin_update_account(jsonb_build_object('user_id', pg_temp.staff(), 'role', 'staff', 'is_active', false))$$, 'P0001', 'STATUS_REASON_REQUIRED', 'the role RPC can no longer deactivate without a reason');
select is(public.admin_update_account(jsonb_build_object('user_id', pg_temp.staff(), 'role', 'staff', 'is_active', true)) ->> 'changed', 'false', 'the role RPC still accepts the unchanged status the previous release sends');
reset role;
select is((select is_active from public.profiles where id = pg_temp.staff()), true, 'the refused role call left the account active');
select set_config('st.profile_audits', pg_temp.audits('profile')::text, true);

set local role authenticated;
select pg_temp.act('owner');
select is(public.admin_set_account_status(pg_temp.acct_cmd(pg_temp.staff(), false, ' Left the business ')),
  jsonb_build_object('ok', true, 'user_id', pg_temp.staff(), 'is_active', false, 'changed', true), 'the owner deactivates a staff account');
reset role;
select is((select is_active from public.profiles where id = pg_temp.staff()), false, 'the account is inactive');
select ok(exists (select 1 from auth.users where id = pg_temp.staff()) and exists (select 1 from public.user_shop_assignments where user_id = pg_temp.staff()),
  'the sign-in and its shop assignment are kept, not deleted');
select ok((select count(*) from public.audit_events where action = 'account.deactivate' and entity_type = 'profile' and entity_id = pg_temp.staff()::text and shop_id is null
  and actor_id = '10000000-0000-4000-8000-000000000101' and reason = 'Left the business' and recorded_at is not null
  and metadata = '{"role":"staff","before":{"is_active":true},"after":{"is_active":false}}'::jsonb) = 1,
  'the deactivation is audited once: account, actor, trimmed reason, previous and new state, timestamp');
set local role authenticated;
select is(public.admin_set_account_status(pg_temp.acct_cmd(pg_temp.staff(), false, 'again')) ->> 'changed', 'false', 'deactivating an inactive account again changes nothing');
-- The same JWT claims the staff session already holds: nothing is re-issued.
select pg_temp.act('staff');
select throws_ok($$select public.create_customer(pg_temp.customer(pg_temp.s1(), 'Deactivated Staff'))$$, '28000', 'AUTHENTICATION_REQUIRED', 'the existing session of a deactivated account cannot write');
select throws_ok($$select public.submit_batch(pg_temp.batch('st-deact', 'ST-DEACT'))$$, '28000', 'AUTHENTICATION_REQUIRED', 'nor submit a sale');
select is((select count(*)::int from public.invoices), 0, 'nor read invoices');
select is((select count(*)::int from public.shops), 0, 'nor read shops');
select throws_ok($$select public.admin_set_account_status(pg_temp.acct_cmd(pg_temp.staff(), true, 'let me back'))$$, '42501', 'INSUFFICIENT_ROLE', 'a deactivated account cannot reactivate itself');
reset role;
select is((select created_by from public.invoices where id = 'a6000000-0000-4000-8000-000000000001'), pg_temp.staff(), 'records created by the deactivated account keep their author');
select ok((select count(*) from public.invoices where invoice_id in ('ST-BEFORE', 'ST-AFTER') and created_by = pg_temp.staff()) = 2, 'including records it created through the RPCs');
select is(pg_temp.audits('profile'), current_setting('st.profile_audits')::bigint + 1, 'one audit row for one real transition');

set local role authenticated;
select pg_temp.act('manager');
select throws_ok($$select public.admin_set_account_status(pg_temp.acct_cmd(pg_temp.staff(), true, 'manager'))$$, '42501', 'INSUFFICIENT_ROLE', 'a manager cannot reactivate staff');
select pg_temp.act('owner');
select is(public.admin_set_account_status(pg_temp.acct_cmd(pg_temp.staff(), true, 'Rehired')) ->> 'changed', 'true', 'the owner reactivates the account');
select pg_temp.act('staff');
select is((public.create_customer(pg_temp.customer(pg_temp.s1(), 'Rehired Staff Customer')) ->> 'ok')::boolean, true, 'the reactivated account writes again');
select ok((select count(*) from public.invoices) > 0, 'and reads its assigned shop again');
reset role;
select ok((select count(*) from public.audit_events where action = 'account.reactivate' and entity_id = pg_temp.staff()::text and reason = 'Rehired'
  and metadata = '{"role":"staff","before":{"is_active":false},"after":{"is_active":true}}'::jsonb) = 1, 'the reactivation is audited');

-- 10. An active owner always remains ----------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act('owner');
select lives_ok($$select public.admin_update_account(jsonb_build_object('user_id', '10000000-0000-4000-8000-000000000104', 'role', 'owner'))$$, 'the role RPC works without a status field');
select pg_temp.act('manager');
select is(public.admin_set_account_status(pg_temp.acct_cmd('10000000-0000-4000-8000-000000000101', false, 'handover complete')) ->> 'changed', 'true', 'a second owner can deactivate the first');
select throws_ok($$select public.admin_set_account_status(pg_temp.acct_cmd('10000000-0000-4000-8000-000000000104', false, 'last one out'))$$, 'P0001', 'SELF_CHANGE_FORBIDDEN', 'the only remaining active owner cannot deactivate themselves');
select pg_temp.act('owner');
select throws_ok($$select public.admin_set_account_status(pg_temp.acct_cmd('10000000-0000-4000-8000-000000000104', false, 'revenge'))$$, '42501', 'INSUFFICIENT_ROLE', 'a deactivated owner has no administration authority');
select throws_ok($$select public.admin_set_shop_status(pg_temp.shop_cmd(pg_temp.s1(), false, 'revenge'))$$, '42501', 'INSUFFICIENT_ROLE', 'nor shop authority');
reset role;
select is((select count(*)::int from public.profiles where role = 'owner' and is_active), 1, 'exactly one active owner remains');
select ok((select prosrc from pg_proc where oid = 'public.admin_set_account_status(jsonb)'::regprocedure) ~ 'LAST_ACTIVE_OWNER', 'the zero-active-owner rule is also stated in the database');

select * from finish();
rollback;
