begin;
-- current_date below must be the Qatar operating date the RPCs enforce.
set local timezone = 'Asia/Qatar';
create extension if not exists pgtap with schema extensions;
select no_plan();

-- OPS-01B slice 1: controlled invoice void (20261103150000). The concurrent void-versus-void and
-- void-versus-payment races need two sessions and live in tests/integration/operations/invoice-void.test.ts.

create function pg_temp.act(who text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', case who
    when 'owner' then '10000000-0000-4000-8000-000000000101' when 'staff' then '10000000-0000-4000-8000-000000000102'
    when 'staff2' then '10000000-0000-4000-8000-000000000103' when 'manager' then '10000000-0000-4000-8000-000000000104' end)::text, true)
$$;
create function pg_temp.s1() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.s2() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.inv(n int) returns uuid language sql immutable as $$ select ('a7000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.void(n int, key text, why text default 'Customer cancelled the order', sid uuid default null) returns jsonb language sql as $$
  select public.void_invoice(jsonb_build_object('shop_id', coalesce(sid, pg_temp.s1()), 'invoice_id', pg_temp.inv(n), 'reason', why, 'idempotency_key', key)) $$;
create function pg_temp.eff(n int) returns public.effective_invoices language sql as $$
  select * from public.effective_invoices where canonical_invoice_id = pg_temp.inv(n) $$;

-- Fixtures (as the database owner). C1 owns V1 (voided by the owner) and K1 (stays open); C2 owns CR1 (credit applied).
insert into public.customers(id, shop_id, public_id, name) values
  ('c7000000-0000-4000-8000-000000000001', pg_temp.s1(), 'CUS-VOID-1', 'Void customer one'),
  ('c7000000-0000-4000-8000-000000000002', pg_temp.s1(), 'CUS-VOID-2', 'Void customer two');
insert into public.invoices(id, shop_id, customer_id, invoice_id, total_amount_dirham, business_date, delivered, created_by) values
  (pg_temp.inv(1), pg_temp.s1(), 'c7000000-0000-4000-8000-000000000001', 'VOID-V1', 10000, current_date - 3, true, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(2), pg_temp.s1(), null, 'VOID-V2', 5000, current_date - 2, false, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(3), pg_temp.s1(), null, 'VOID-V3', 5000, current_date, false, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(4), pg_temp.s1(), null, 'VOID-PAID', 6000, current_date, false, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(5), pg_temp.s1(), 'c7000000-0000-4000-8000-000000000002', 'VOID-CREDIT', 7000, current_date, true, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(6), pg_temp.s1(), null, 'VOID-CLOSED', 4000, current_date - 5, false, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(7), pg_temp.s1(), 'c7000000-0000-4000-8000-000000000001', 'VOID-K1', 3000, current_date, true, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(8), pg_temp.s2(), null, 'VOID-S2', 2000, current_date, false, '10000000-0000-4000-8000-000000000103'),
  (pg_temp.inv(9), pg_temp.s1(), null, 'VOID-TODAY', 1500, current_date, false, '10000000-0000-4000-8000-000000000102');
insert into public.invoice_number_registry(shop_id, invoice_number, canonical_invoice_id) select shop_id, invoice_id, id from public.invoices where invoice_id like 'VOID-%';
-- The original date of VOID-CLOSED is closed before anything is voided.
insert into public.daily_closes(shop_id, business_date, event_type, actor_id) values (pg_temp.s1(), current_date - 5, 'closed', '10000000-0000-4000-8000-000000000101');
insert into public.customer_credits(shop_id, customer_id, amount_dirham, business_date, reason, created_by, approved_by) values
  (pg_temp.s1(), 'c7000000-0000-4000-8000-000000000002', 1000, current_date, 'fixture credit', '10000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000101');

-- 1. Catalog and privileges ------------------------------------------------------------------------------
select has_table('public', 'invoice_voids', 'the append-only void marker exists');
select has_function('public', 'void_invoice', array['jsonb'], 'void RPC exists');
select has_column('public', 'effective_invoices', 'is_void', 'effective_invoices exposes is_void');
select is((select attnum from pg_attribute where attrelid = 'public.effective_invoices'::regclass and attname = 'is_void'),
  (select max(attnum) from pg_attribute where attrelid = 'public.effective_invoices'::regclass and attnum > 0), 'is_void is the last column, existing columns keep their positions');
select ok((select prosecdef from pg_proc where oid = 'public.void_invoice(jsonb)'::regprocedure), 'void_invoice is SECURITY DEFINER');
select ok(not has_function_privilege('anon', 'public.void_invoice(jsonb)', 'EXECUTE'), 'anon cannot execute void_invoice');
select ok(not has_table_privilege('authenticated', 'public.invoice_voids', 'INSERT') and not has_table_privilege('authenticated', 'public.invoice_voids', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.invoice_voids', 'DELETE'), 'no direct write grants on invoice_voids');
select ok((select relrowsecurity from pg_class where oid = 'public.invoice_voids'::regclass), 'RLS is enabled on invoice_voids');
select ok(exists(select 1 from pg_trigger where tgrelid = 'public.invoice_voids'::regclass and tgname = 'invoice_voids_active_shop'), 'invoice_voids carries the OPS-01A active-shop guard');
select ok(not has_function_privilege('authenticated', 'private.enforce_invoice_not_void()', 'EXECUTE'), 'the post-void guard is not callable through the Data API');
select is((select count(*)::int from pg_trigger where tgfoid = 'private.enforce_invoice_not_void()'::regprocedure), 8, 'post-void guard on all eight invoice-scoped write tables');

-- 2. Authorization ------------------------------------------------------------------------------------------------
set local role anon;
select throws_ok($$select pg_temp.void(3, 'anon-1')$$, '42501', null, 'anon cannot void');
reset role;
set local role authenticated;
select pg_temp.act('staff');
select throws_ok($$select pg_temp.void(3, 'staff-1')$$, '42501', 'INSUFFICIENT_ROLE', 'staff gets INSUFFICIENT_ROLE');
select throws_ok($$insert into public.invoice_voids(shop_id, invoice_id, reason, actor_user_id, business_date, idempotency_key, fingerprint)
  values (pg_temp.s1(), pg_temp.inv(3), 'direct write attempt', '10000000-0000-4000-8000-000000000102', current_date, 'x', 'x')$$, '42501', null, 'staff cannot insert a void row directly');
select pg_temp.act('staff2');
select throws_ok($$select pg_temp.void(3, 'staff2-1')$$, '42501', 'UNAUTHORIZED_SHOP', 'an unassigned user gets UNAUTHORIZED_SHOP');
select pg_temp.act('manager');
select throws_ok($$select pg_temp.void(8, 'mgr-s2', 'Customer cancelled the order', pg_temp.s2())$$, '42501', 'UNAUTHORIZED_SHOP', 'a manager cannot void in an unassigned shop');
select throws_ok($$select pg_temp.void(8, 'mgr-wrong-shop')$$, 'P0001', 'INVOICE_NOT_FOUND', 'an invoice of another shop is not found in the requested shop');

-- 3. Validation ------------------------------------------------------------------------------------------------
select throws_ok($$select pg_temp.void(2, 'v-blank', '')$$, 'P0001', 'REASON_REQUIRED', 'empty reason blocked');
select throws_ok($$select pg_temp.void(2, 'v-space', '    ')$$, 'P0001', 'REASON_REQUIRED', 'whitespace-only reason blocked');
select throws_ok($$select pg_temp.void(2, 'v-tabs', E'\t\n\r\n   \t\t\n  \t')$$, 'P0001', 'REASON_REQUIRED', 'tabs and newlines only are whitespace too');
select throws_ok($$select pg_temp.void(2, 'v-short', '  too short ')$$, 'P0001', 'REASON_TOO_SHORT', 'reason under 10 characters after trimming blocked');
select throws_ok($$select pg_temp.void(2, 'v-long', repeat('x', 2001))$$, 'P0001', 'INVALID_REQUEST', 'reason over 2000 characters blocked');
select throws_ok($$select public.void_invoice(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(2), 'idempotency_key', 'v-none'))$$, 'P0001', 'INVALID_REQUEST', 'missing reason blocked');
select throws_ok($$select public.void_invoice(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(2), 'reason', 'Customer cancelled', 'idempotency_key', 'v-x', 'amount_delta_dirham', -1))$$, 'P0001', 'INVALID_REQUEST', 'unknown fields blocked');
select throws_ok($$select public.void_invoice(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(2), 'reason', 'Customer cancelled', 'idempotency_key', 'v-x', 'actor', '10000000-0000-4000-8000-000000000101'))$$, 'P0001', 'INVALID_REQUEST', 'caller cannot supply the actor');
select is((select count(*)::int from public.invoice_voids), 0, 'rejected attempts write nothing');

-- A correction request made before the void, still pending when the void happens.
select pg_temp.act('staff');
select lives_ok($$select public.request_invoice_correction(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(2), 'reason', 'Price typo', 'idempotency_key', 'pending-before-void', 'payment_id', null, 'amount_delta_dirham', 1000))$$, 'pending correction request on V2 before the void');

-- 4. Manager voids an unpaid invoice ------------------------------------------------------------------------------
select pg_temp.act('manager');
select lives_ok($$select pg_temp.void(2, 'mgr-v2', '  Duplicate entry of the same sale  ')$$, 'manager can void an unpaid invoice');
select is((select reason from public.invoice_voids where invoice_id = pg_temp.inv(2)), 'Duplicate entry of the same sale', 'the exact trimmed reason is stored');
select is((select actor_user_id::text from public.invoice_voids where invoice_id = pg_temp.inv(2)), '10000000-0000-4000-8000-000000000104', 'actor comes from the authenticated identity');
select is((pg_temp.eff(2)).effective_total_dirham, 0::bigint, 'effective total becomes 0');

-- 5. Owner voids V1 (customer invoice) ----------------------------------------------------------------------------
select pg_temp.act('owner');
select set_config('void.v1', pg_temp.void(1, 'own-v1')::text, true);
select ok((current_setting('void.v1')::jsonb ->> 'ok')::boolean, 'owner can void');
select is(current_setting('void.v1')::jsonb ->> 'business_date', current_date::text, 'the void is dated today (Qatar)');
select is(pg_temp.void(1, 'own-v1'), current_setting('void.v1')::jsonb, 'same key + same payload returns the original result');
select throws_ok($$select pg_temp.void(1, 'own-v1', 'A different reason for the same key')$$, 'P0001', 'IDEMPOTENCY_CONFLICT', 'same key + different payload is an idempotency conflict');
select throws_ok($$select pg_temp.void(1, 'own-v1-again')$$, 'P0001', 'ALREADY_VOID', 'different key after void returns ALREADY_VOID');
select is((select count(*)::int from public.invoice_voids where invoice_id = pg_temp.inv(1)), 1, 'exactly one void row');
select is((select count(*)::int from public.corrections where invoice_id = pg_temp.inv(1)), 1, 'exactly one void correction');

-- Financial blocks
select lives_ok($$select public.record_payment(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(4), 'amount_dirham', 2000, 'payment_method', 'cash', 'business_date', current_date, 'idempotency_key', 'void-paid-pay'))$$, 'payment on VOID-PAID');
select throws_ok($$select pg_temp.void(4, 'own-paid')$$, 'P0001', 'PAYMENTS_OUTSTANDING', 'paid invoice gets PAYMENTS_OUTSTANDING');
select lives_ok($$select public.apply_customer_credit(jsonb_build_object('shop_id', pg_temp.s1(), 'customer_id', 'c7000000-0000-4000-8000-000000000002', 'amount_dirham', 1000, 'business_date', current_date, 'idempotency_key', 'void-credit-apply'))$$, 'credit applied to VOID-CREDIT');
select throws_ok($$select pg_temp.void(5, 'own-credit')$$, 'P0001', 'CREDIT_APPLIED', 'credit-applied invoice gets CREDIT_APPLIED');
select is((select count(*)::int from public.invoice_voids where invoice_id in (pg_temp.inv(4), pg_temp.inv(5))), 0, 'blocked invoices are not voided');

-- Closed dates: the original date may be closed; today's correction is what must be open.
select lives_ok($$select pg_temp.void(6, 'own-closed-original')$$, 'invoice whose original date is closed can be voided');
select is((select business_date from public.corrections where invoice_id = pg_temp.inv(6)), current_date, 'its correction is on today, not the closed original date');
select is((select event_type from public.daily_closes where shop_id = pg_temp.s1() and business_date = current_date - 5 order by event_sequence desc limit 1), 'closed', 'the original date stays closed');

-- Inactive shop
reset role;
update public.shops set is_active = false where id = pg_temp.s2();
set local role authenticated;
select pg_temp.act('owner');
select throws_ok($$select pg_temp.void(8, 'own-s2', 'Customer cancelled the order', pg_temp.s2())$$, 'P0001', 'SHOP_INACTIVE', 'inactive shop blocked');
reset role;
update public.shops set is_active = true where id = pg_temp.s2();

-- 6. Original invoice preserved and immutable -------------------------------------------------------------------
select is((select row(invoice_id, total_amount_dirham, business_date, customer_id, delivered)::text from public.invoices where id = pg_temp.inv(1)),
  row('VOID-V1', 10000::bigint, current_date - 3, 'c7000000-0000-4000-8000-000000000001'::uuid, true)::text, 'original invoice unchanged');
select throws_ok($$update public.invoices set total_amount_dirham = 0 where id = pg_temp.inv(1)$$, '55000', null, 'invoice UPDATE rejected');
select throws_ok($$delete from public.invoices where id = pg_temp.inv(1)$$, '55000', null, 'invoice DELETE rejected');
select throws_ok($$update public.invoice_voids set reason = 'rewritten reason text' where invoice_id = pg_temp.inv(1)$$, '55000', null, 'invoice_voids UPDATE rejected');
select throws_ok($$delete from public.invoice_voids where invoice_id = pg_temp.inv(1)$$, '55000', null, 'invoice_voids DELETE rejected');

-- 7. Read models ---------------------------------------------------------------------------------------------------
select is(((pg_temp.eff(1)).effective_total_dirham, (pg_temp.eff(1)).effective_paid_dirham, (pg_temp.eff(1)).effective_due_dirham, (pg_temp.eff(1)).original_total_dirham, (pg_temp.eff(1)).is_void)::text,
  (0::bigint, 0::bigint, 0::bigint, 10000::bigint, true)::text, 'effective_invoices: total/paid/due 0, original total kept, is_void');
select is((pg_temp.eff(7)).is_void, false, 'an untouched invoice is not void');
select is((select effective_total_dirham from public.invoice_effective_balances where canonical_invoice_id = pg_temp.inv(1)), 0::bigint, 'invoice_effective_balances total 0');
select is((select outstanding_due_dirham from public.customer_financial_balances where customer_id = 'c7000000-0000-4000-8000-000000000001'), 3000::bigint, 'customer balance keeps only the open invoice');
select is((select available_credit_dirham from public.customer_financial_balances where customer_id = 'c7000000-0000-4000-8000-000000000001'), 0::bigint, 'void creates no customer credit');
select results_eq($$select entry_type, debit_dirham, credit_dirham, business_date from public.customer_ledger where customer_id = 'c7000000-0000-4000-8000-000000000001' and invoice_id = pg_temp.inv(1) order by business_date, entry_type$$,
  $$values ('invoice'::text, 10000::bigint, 0::bigint, current_date - 3), ('invoice_void'::text, 0::bigint, 10000::bigint, current_date)$$, 'customer_ledger: original debit kept, void credit on today, nets to 0');
select is((select sum(debit_dirham - credit_dirham) from public.customer_ledger where customer_id = 'c7000000-0000-4000-8000-000000000001')::bigint,
  (select outstanding_due_dirham from public.customer_financial_balances where customer_id = 'c7000000-0000-4000-8000-000000000001'), 'ledger running balance equals customer balance');
select is((select invoice_corrections_dirham from public.report_daily_summary(pg_temp.s1(), current_date, current_date)), -19000::bigint, 'daily summary books the three voids as today''s invoice corrections');
select is((select (r.outstanding_due_dirham + r.unassigned_due_dirham) from public.report_customer_due_totals(pg_temp.s1()) r),
  (select sum(effective_due_dirham)::bigint from public.effective_invoices where shop_id = pg_temp.s1()), 'due totals equal the sum of effective due');
select is((select effective_total_dirham from public.report_sales_totals(pg_temp.s1(), current_date - 3, current_date - 3)), 0::bigint, 'sales report for the original date shows the voided invoice at 0');
select is((select count(*)::int from public.effective_invoices where shop_id = pg_temp.s1() and is_void), 3, 'voided invoices stay visible');

-- 8. Audit ---------------------------------------------------------------------------------------------------------
select results_eq($$select actor_id::text, shop_id::text, entity_type, reason, metadata ->> 'invoice_number', (metadata ->> 'original_total_dirham')::bigint,
    (metadata ->> 'effective_total_before_dirham')::bigint, (metadata ->> 'paid_before_dirham')::bigint, metadata ->> 'original_business_date',
    metadata ->> 'void_id' = (select id::text from public.invoice_voids where invoice_id = pg_temp.inv(1)),
    metadata ->> 'correction_id' = (select correction_id::text from public.invoice_voids where invoice_id = pg_temp.inv(1))
  from public.audit_events where action = 'invoice.void' and entity_id = pg_temp.inv(1)::text$$,
  $$values ('10000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000001', 'invoice', 'Customer cancelled the order', 'VOID-V1', 10000::bigint, 10000::bigint, 0::bigint, (current_date - 3)::text, true, true)$$,
  'one invoice.void audit row with actor, shop, entity, reason and the before-figures');
select is((select count(*)::int from public.audit_events where action = 'invoice.void'), 3, 'one audit row per void, none for replays or refusals');

-- 9. Post-void guards ------------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act('staff');
select throws_ok($$select public.request_invoice_correction(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(1), 'reason', 'Fix it', 'idempotency_key', 'g-corr', 'payment_id', null, 'amount_delta_dirham', 500))$$, 'P0001', 'INVOICE_VOID', 'new correction request blocked');
select throws_ok($$select public.request_invoice_replacement(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(1), 'reason', 'Renumber', 'idempotency_key', 'g-repl', 'expected_revision', 0, 'invoice_number', 'VOID-V1-B', 'customer_id', null, 'delivered', true))$$, 'P0001', 'INVOICE_VOID', 'new replacement request blocked');
select throws_ok($$select public.record_payment(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(1), 'amount_dirham', 100, 'payment_method', 'cash', 'business_date', current_date, 'idempotency_key', 'g-pay'))$$, 'P0001', null, 'payment on a voided invoice refused');
select pg_temp.act('owner');
select throws_ok($$select public.decide_invoice_correction(jsonb_build_object('shop_id', pg_temp.s1(), 'request_id', (select id from public.correction_requests where idempotency_key = 'pending-before-void'), 'expected_revision', 0, 'decision', 'approved', 'reason', null, 'idempotency_key', 'g-approve'))$$, 'P0001', 'INVOICE_VOID', 'a correction pending since before the void cannot be approved');
select lives_ok($$select public.decide_invoice_correction(jsonb_build_object('shop_id', pg_temp.s1(), 'request_id', (select id from public.correction_requests where idempotency_key = 'pending-before-void'), 'expected_revision', 0, 'decision', 'rejected', 'reason', 'Invoice voided', 'idempotency_key', 'g-reject'))$$, 'it can still be rejected');
reset role;
-- Direct writes as the database owner (any future path) hit the same guard.
select throws_ok($$insert into public.payments(shop_id, invoice_id, amount_dirham, business_date) values (pg_temp.s1(), pg_temp.inv(1), 100, current_date)$$, 'P0001', 'INVOICE_VOID', 'payment row against a voided invoice blocked');
select throws_ok($$insert into public.corrections(shop_id, invoice_id, amount_delta_dirham, reason, business_date, approved_by) values (pg_temp.s1(), pg_temp.inv(1), 100, 'x', current_date, '10000000-0000-4000-8000-000000000101')$$, 'P0001', 'INVOICE_VOID', 'ledger correction against a voided invoice blocked');
select throws_ok($$insert into public.customer_credits(shop_id, customer_id, invoice_id, amount_dirham, business_date, approved_by) values (pg_temp.s1(), 'c7000000-0000-4000-8000-000000000001', pg_temp.inv(1), 100, current_date, '10000000-0000-4000-8000-000000000101')$$, 'P0001', 'INVOICE_VOID', 'customer credit sourced from a voided invoice blocked');
select throws_ok($$insert into public.credit_applications(shop_id, customer_id, batch_id, credit_id, invoice_id, amount_dirham, business_date, created_by)
  values (pg_temp.s1(), 'c7000000-0000-4000-8000-000000000002', gen_random_uuid(), (select id from public.customer_credits where reason = 'fixture credit'), pg_temp.inv(1), 100, current_date, '10000000-0000-4000-8000-000000000101')$$, 'P0001', 'INVOICE_VOID', 'credit application against a voided invoice blocked');
insert into public.customer_credits(shop_id, customer_id, amount_dirham, business_date, reason, created_by, approved_by) values
  (pg_temp.s1(), 'c7000000-0000-4000-8000-000000000001', 500, current_date, 'later credit', '10000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000101');
set local role authenticated;
select pg_temp.act('owner');
select lives_ok($$select public.apply_customer_credit(jsonb_build_object('shop_id', pg_temp.s1(), 'customer_id', 'c7000000-0000-4000-8000-000000000001', 'amount_dirham', 500, 'business_date', current_date, 'idempotency_key', 'g-credit'))$$, 'customer credit allocation still works for the customer''s open invoice');
select is((select count(*)::int from public.credit_applications where invoice_id = pg_temp.inv(1)), 0, 'credit allocation skipped the voided invoice');
select is((select count(*)::int from public.credit_applications where invoice_id = pg_temp.inv(7)), 1, 'and went to the open invoice');
select throws_ok($$select pg_temp.void(7, 'own-k1-credit')$$, 'P0001', 'CREDIT_APPLIED', 'which now cannot be voided');

-- 10. RLS ---------------------------------------------------------------------------------------------------------
select pg_temp.act('staff2');
select is((select count(*)::int from public.invoice_voids), 0, 'other-shop user cannot read the void records');
select is((select count(*)::int from public.effective_invoices where shop_id = pg_temp.s1()), 0, 'nor the voided invoices');
select pg_temp.act('staff');
select is((select count(*)::int from public.invoice_voids), 3, 'same-shop staff can read the void records');

-- 11. Today closed (last: closing today blocks every later write) --------------------------------------------------
select pg_temp.act('manager');
select lives_ok($$select public.close_business_date(jsonb_build_object('shop_id', pg_temp.s1(), 'business_date', current_date::text))$$, 'today closed');
select throws_ok($$select pg_temp.void(3, 'mgr-closed-today')$$, 'P0001', 'CLOSED_DATE', 'closed today returns CLOSED_DATE');
select throws_ok($$select pg_temp.void(9, 'mgr-closed-today-2')$$, 'P0001', 'CLOSED_DATE', 'also for an invoice dated today');
select is((select count(*)::int from public.invoice_voids where invoice_id in (pg_temp.inv(3), pg_temp.inv(9))), 0, 'nothing written on a closed day');
select lives_ok($$select pg_temp.void(2, 'mgr-v2', '  Duplicate entry of the same sale  ')$$, 'an exact retry of an earlier void still returns its result after today closes');

select * from finish();
rollback;
