begin;
-- current_date below must be the Qatar operating date the RPCs enforce.
set local timezone = 'Asia/Qatar';
create extension if not exists pgtap with schema extensions;
select plan(64);

-- Helpers -------------------------------------------------------------------
create function pg_temp.act(who text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', case who
    when 'owner' then '10000000-0000-4000-8000-000000000101' when 'staff' then '10000000-0000-4000-8000-000000000102'
    when 'staff2' then '10000000-0000-4000-8000-000000000103' end)::text, true)
$$;
create function pg_temp.s1() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.inv(number text) returns uuid language sql as $$ select id from public.invoices where shop_id = pg_temp.s1() and invoice_id = number $$;
create function pg_temp.pay(inv text, amount bigint, method text, key text) returns jsonb language sql as $$
  select jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(inv), 'amount_dirham', amount, 'payment_method', method,
    'business_date', current_date::text, 'idempotency_key', key) $$;
create function pg_temp.cpay(customer uuid, amount bigint, key text, extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object('shop_id', pg_temp.s1(), 'customer_id', customer, 'amount_dirham', amount, 'business_date', current_date::text, 'idempotency_key', key) || extra $$;
create function pg_temp.line(number text, total bigint, received bigint, method text) returns jsonb language sql as $$
  select jsonb_build_object('row_id', number, 'invoice_number', number, 'total_dirham', total, 'received_dirham', received, 'payment_method', method,
    'delivered', false, 'customer', null) $$;
create function pg_temp.batch(key text, rows jsonb) returns jsonb language sql as $$
  select jsonb_build_object('shop_id', pg_temp.s1(), 'business_date', current_date::text, 'idempotency_key', key, 'rows', rows) $$;
create function pg_temp.day() returns jsonb language sql as $$
  select coalesce((select to_jsonb(r) from public.report_daily_summary(pg_temp.s1(), current_date, current_date) r), '{}'::jsonb) $$;
create function pg_temp.delta(metric text) returns bigint language sql as $$
  select coalesce((pg_temp.day() ->> metric)::bigint, 0) - coalesce((current_setting('bk.base')::jsonb ->> metric)::bigint, 0) $$;
create function pg_temp.methods(inv text) returns text language sql as $$
  select coalesce(string_agg(payment_method || ':' || amount_dirham, ',' order by recorded_at, id), '') from public.payments where invoice_id = pg_temp.inv(inv) $$;

insert into public.customers(id, shop_id, name, mobile, created_by) values
  ('c5000000-0000-4000-8000-000000000001', pg_temp.s1(), 'Bank FIFO A', '55550001', '10000000-0000-4000-8000-000000000102'),
  ('c5000000-0000-4000-8000-000000000002', pg_temp.s1(), 'Bank FIFO B', '55550002', '10000000-0000-4000-8000-000000000102'),
  ('c5000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'Other Shop', '55550003', '10000000-0000-4000-8000-000000000103');
-- Customers A and B carry identical dues, so identical payments must allocate identically.
insert into public.invoices(id, shop_id, customer_id, invoice_id, total_amount_dirham, business_date, delivered, created_by) values
  ('a5000000-0000-4000-8000-000000000001', pg_temp.s1(), 'c5000000-0000-4000-8000-000000000001', 'BK-A1', 300, current_date - 2, true, '10000000-0000-4000-8000-000000000102'),
  ('a5000000-0000-4000-8000-000000000002', pg_temp.s1(), 'c5000000-0000-4000-8000-000000000001', 'BK-A2', 200, current_date - 1, true, '10000000-0000-4000-8000-000000000102'),
  ('a5000000-0000-4000-8000-000000000003', pg_temp.s1(), 'c5000000-0000-4000-8000-000000000002', 'BK-B1', 300, current_date - 2, true, '10000000-0000-4000-8000-000000000102'),
  ('a5000000-0000-4000-8000-000000000004', pg_temp.s1(), 'c5000000-0000-4000-8000-000000000002', 'BK-B2', 200, current_date - 1, true, '10000000-0000-4000-8000-000000000102'),
  ('a5000000-0000-4000-8000-000000000005', pg_temp.s1(), null, 'BK-P1', 1000, current_date, true, '10000000-0000-4000-8000-000000000102'),
  ('a5000000-0000-4000-8000-000000000006', pg_temp.s1(), null, 'BK-P2', 1000, current_date, true, '10000000-0000-4000-8000-000000000102'),
  ('a5000000-0000-4000-8000-000000000007', pg_temp.s1(), 'c5000000-0000-4000-8000-000000000001', 'BK-OV', 100, current_date, true, '10000000-0000-4000-8000-000000000102'),
  ('a5000000-0000-4000-8000-000000000008', pg_temp.s1(), null, 'BK-PROBE', 1000, current_date, true, '10000000-0000-4000-8000-000000000102');

-- 1. Database constraints ----------------------------------------------------
select lives_ok($$insert into public.payments(shop_id, invoice_id, amount_dirham, business_date, payment_method, created_by)
  values ('10000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000008', 1, current_date, 'cash', '10000000-0000-4000-8000-000000000101')$$, 'a cash payment row is accepted');
select lives_ok($$insert into public.payments(shop_id, invoice_id, amount_dirham, business_date, payment_method, created_by)
  values ('10000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000008', 1, current_date, 'bank', '10000000-0000-4000-8000-000000000101')$$, 'a bank payment row is accepted');
select throws_ok($$insert into public.payments(shop_id, invoice_id, amount_dirham, business_date, payment_method, created_by)
  values ('10000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000008', 1, current_date, 'card', '10000000-0000-4000-8000-000000000101')$$, '23514', null, 'any other payment method is rejected by the database');
select throws_ok($$insert into public.payments(shop_id, invoice_id, amount_dirham, business_date, payment_method, created_by)
  values ('10000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000008', 1, current_date, 'Bank', '10000000-0000-4000-8000-000000000101')$$, '23514', null, 'the stored value is exactly lower-case: Bank is rejected');
select is((select column_default from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'payment_method'), '''cash''::text', 'the payment method default is still cash');
select is((select column_default from information_schema.columns where table_schema = 'public' and table_name = 'customer_credits' and column_name = 'payment_method'), '''cash''::text', 'an overpayment credit defaults to cash, which is what every existing credit was');
select throws_ok($$insert into public.customer_credits(shop_id, customer_id, amount_dirham, business_date, payment_method, created_by, approved_by)
  values ('10000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 1, current_date, 'wallet', '10000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000101')$$, '23514', null, 'a credit cannot carry an unsupported method');
select is((select count(*)::int from public.payments where payment_method not in ('cash', 'bank')), 0, 'no stored payment holds another method');
-- Payments are append-only, so the two accepted probes stay; the daily baseline is taken after them.
select set_config('bk.base', pg_temp.day()::text, true);

-- 2. record_payment ------------------------------------------------------------
select pg_temp.act('staff');
set local role authenticated;
select is((public.record_payment(pg_temp.pay('BK-P1', 400, 'bank', 'bk-pay-1')) ->> 'ok')::boolean, true, 'record_payment accepts bank');
select is((select payment_method from public.payments where invoice_id = pg_temp.inv('BK-P1')), 'bank', 'the bank payment is stored as bank');
select is((public.record_payment(pg_temp.pay('BK-P1', 400, 'bank', 'bk-pay-1')) ->> 'payment_id'), (select id::text from public.payments where invoice_id = pg_temp.inv('BK-P1')), 'replaying the same bank command returns the same payment');
select is((select count(*)::int from public.payments where invoice_id = pg_temp.inv('BK-P1')), 1, 'the replay created no second payment');
select throws_ok($$select public.record_payment(pg_temp.pay('BK-P1', 400, 'cash', 'bk-pay-1'))$$, 'P0001', 'IDEMPOTENCY_CONFLICT', 'the same key cannot be replayed as cash after bank');
select throws_ok($$select public.record_payment(pg_temp.pay('BK-P1', 100, 'card', 'bk-pay-card'))$$, 'P0001', 'PAYMENT_VALIDATION_FAILED', 'record_payment rejects an unsupported method');
select throws_ok($$select public.record_payment(pg_temp.pay('BK-P1', 100, 'Bank', 'bk-pay-case'))$$, 'P0001', 'PAYMENT_VALIDATION_FAILED', 'record_payment rejects a differently cased method');
select throws_ok($$select public.record_payment(pg_temp.pay('BK-P1', 100, '', 'bk-pay-empty'))$$, 'P0001', 'PAYMENT_VALIDATION_FAILED', 'record_payment rejects an empty method');
select throws_ok($$select public.record_payment((pg_temp.pay('BK-P1', 100, 'bank', 'bk-pay-null')) || '{"payment_method": null}')$$, 'P0001', 'PAYMENT_VALIDATION_FAILED', 'record_payment rejects a null method');
select is((public.record_payment(pg_temp.pay('BK-P2', 250, 'cash', 'bk-pay-2')) ->> 'ok')::boolean, true, 'record_payment still accepts cash');
select is(pg_temp.methods('BK-P2'), 'cash:250', 'the cash payment is stored as cash');
reset role;
select pg_temp.act('staff2');
set local role authenticated;
select throws_ok($$select public.record_payment(jsonb_build_object('shop_id', '10000000-0000-4000-8000-000000000001', 'invoice_id', 'a5000000-0000-4000-8000-000000000005', 'amount_dirham', 100, 'payment_method', 'bank', 'business_date', current_date::text, 'idempotency_key', 'bk-pay-other-shop'))$$, '42501', null, 'a bank payment is still refused for a shop the actor is not assigned to');
reset role;

-- 3. approve_overpayment: the credit follows the payment's tender -----------------
select pg_temp.act('owner');
set local role authenticated;
select is((public.approve_overpayment(pg_temp.pay('BK-OV', 150, 'bank', 'bk-ov-1') || '{"reason": "customer overpaid by bank transfer"}') ->> 'ok')::boolean, true, 'approve_overpayment accepts bank');
select is(pg_temp.methods('BK-OV'), 'bank:100', 'only the applied amount is a bank payment');
select is((select payment_method from public.customer_credits where invoice_id = pg_temp.inv('BK-OV')), 'bank', 'the excess kept as credit is recorded as bank');
select is((select amount_dirham from public.customer_credits where invoice_id = pg_temp.inv('BK-OV')), 50::bigint, 'the credit amount is unchanged by the method');
select throws_ok($$select public.approve_overpayment(pg_temp.pay('BK-OV', 150, 'card', 'bk-ov-2') || '{"reason": "x"}')$$, 'P0001', 'OVERPAYMENT_VALIDATION_FAILED', 'approve_overpayment rejects an unsupported method');
reset role;

-- 4. submit_batch --------------------------------------------------------------
select pg_temp.act('staff');
set local role authenticated;
select is((public.submit_batch(pg_temp.batch('bk-batch-1', jsonb_build_array(
  pg_temp.line('BK-S1', 500, 500, 'bank'), pg_temp.line('BK-S2', 300, 100, 'cash'), pg_temp.line('BK-S3', 200, 0, 'cash')))) ->> 'ok')::boolean, true, 'submit_batch accepts a mixed Bank and Cash batch');
select is(pg_temp.methods('BK-S1'), 'bank:500', 'the bank invoice payment is stored as bank');
select is(pg_temp.methods('BK-S2'), 'cash:100', 'the cash invoice payment is stored as cash');
select is(pg_temp.methods('BK-S3'), '', 'an invoice with nothing received has no payment row');
select is((public.submit_batch(pg_temp.batch('bk-batch-1', jsonb_build_array(
  pg_temp.line('BK-S1', 500, 500, 'bank'), pg_temp.line('BK-S2', 300, 100, 'cash'), pg_temp.line('BK-S3', 200, 0, 'cash')))) ->> 'ok')::boolean, true, 'replaying the identical batch is accepted');
select is((select count(*)::int from public.payments where invoice_id in (pg_temp.inv('BK-S1'), pg_temp.inv('BK-S2'))), 2, 'the replay created no additional payment');
select throws_ok($$select public.submit_batch(pg_temp.batch('bk-batch-1', jsonb_build_array(
  pg_temp.line('BK-S1', 500, 500, 'cash'), pg_temp.line('BK-S2', 300, 100, 'cash'), pg_temp.line('BK-S3', 200, 0, 'cash'))))$$, 'P0001', 'IDEMPOTENCY_CONFLICT', 'the same key replayed with Bank changed to Cash is a conflict, not a second version');
select is((select payment_method from public.payments where invoice_id = pg_temp.inv('BK-S1')), 'bank', 'the original bank payment is untouched by the rejected replay');
select throws_ok($$select public.submit_batch(pg_temp.batch('bk-batch-2', jsonb_build_array(pg_temp.line('BK-S4', 500, 500, 'card'))))$$, 'P0001', 'BATCH_VALIDATION_FAILED', 'submit_batch rejects an unsupported method for a paid row');
select throws_ok($$select public.submit_batch(pg_temp.batch('bk-batch-3', jsonb_build_array(pg_temp.line('BK-S5', 500, 500, null))))$$, 'P0001', 'BATCH_VALIDATION_FAILED', 'submit_batch rejects a paid row with no method');
select is((select count(*)::int from public.invoices where invoice_id in ('BK-S4', 'BK-S5')), 0, 'rejected batches create no invoice');
reset role;

-- 5. record_customer_payment: the method is only a tender channel ------------------
select pg_temp.act('staff');
set local role authenticated;
create temporary table bk_result(label text, result jsonb);
grant all on bk_result to authenticated;
insert into bk_result select 'bank', public.record_customer_payment(pg_temp.cpay('c5000000-0000-4000-8000-000000000001', 350, 'bk-cp-bank', '{"payment_method": "bank"}'));
insert into bk_result select 'cash', public.record_customer_payment(pg_temp.cpay('c5000000-0000-4000-8000-000000000002', 350, 'bk-cp-cash', '{"payment_method": "cash"}'));
select is((select result -> 'allocations' from bk_result where label = 'bank') #- '{0,invoice_id}' #- '{1,invoice_id}' #- '{0,invoice_number}' #- '{1,invoice_number}',
  (select result -> 'allocations' from bk_result where label = 'cash') #- '{0,invoice_id}' #- '{1,invoice_id}' #- '{0,invoice_number}' #- '{1,invoice_number}',
  'a bank payment and a cash payment of the same amount allocate identically (amounts and oldest-first order)');
select is(pg_temp.methods('BK-A1') || '|' || pg_temp.methods('BK-A2'), 'bank:300|bank:50', 'bank allocated the oldest invoice first and stored every row as bank');
select is(pg_temp.methods('BK-B1') || '|' || pg_temp.methods('BK-B2'), 'cash:300|cash:50', 'the cash twin has the same allocation, stored as cash');
select is((select outstanding_due_dirham from public.customer_financial_balances where customer_id = 'c5000000-0000-4000-8000-000000000001'),
  (select outstanding_due_dirham from public.customer_financial_balances where customer_id = 'c5000000-0000-4000-8000-000000000002'), 'the customer balances are identical for Cash and Bank');
select is((select outstanding_due_dirham from public.customer_financial_balances where customer_id = 'c5000000-0000-4000-8000-000000000002'), 150::bigint, 'the remaining due is the same arithmetic as before');
select is((public.record_customer_payment(pg_temp.cpay('c5000000-0000-4000-8000-000000000001', 350, 'bk-cp-bank', '{"payment_method": "bank"}')) ->> 'batch_id'),
  (select result ->> 'batch_id' from bk_result where label = 'bank'), 'replaying the bank customer payment returns the original batch');
select throws_ok($$select public.record_customer_payment(pg_temp.cpay('c5000000-0000-4000-8000-000000000001', 350, 'bk-cp-bank', '{"payment_method": "cash"}'))$$, 'P0001', 'IDEMPOTENCY_CONFLICT', 'the bank key cannot be replayed as cash');
select throws_ok($$select public.record_customer_payment(pg_temp.cpay('c5000000-0000-4000-8000-000000000001', 350, 'bk-cp-bank'))$$, 'P0001', 'IDEMPOTENCY_CONFLICT', 'the bank key cannot be replayed with the method omitted (cash)');
select is((public.record_customer_payment(pg_temp.cpay('c5000000-0000-4000-8000-000000000002', 350, 'bk-cp-cash')) ->> 'batch_id'),
  (select result ->> 'batch_id' from bk_result where label = 'cash'), 'a command without a method is the same command as an explicit cash one (old clients and old replays still work)');
select throws_ok($$select public.record_customer_payment(pg_temp.cpay('c5000000-0000-4000-8000-000000000001', 10, 'bk-cp-card', '{"payment_method": "card"}'))$$, 'P0001', 'INVALID_PAYMENT_METHOD', 'an unsupported method is rejected');
select throws_ok($$select public.record_customer_payment(pg_temp.cpay('c5000000-0000-4000-8000-000000000001', 10, 'bk-cp-num', '{"payment_method": 1}'))$$, 'P0001', 'INVALID_PAYMENT_METHOD', 'a non-string method is rejected');
select throws_ok($$select public.record_customer_payment(pg_temp.cpay('c5000000-0000-4000-8000-000000000001', 10, 'bk-cp-null', '{"payment_method": null}'))$$, 'P0001', 'INVALID_PAYMENT_METHOD', 'a null method is rejected');
select throws_ok($$select public.record_customer_payment(pg_temp.cpay('c5000000-0000-4000-8000-000000000001', 151, 'bk-cp-over', '{"payment_method": "bank"}'))$$, 'P0001', 'AMOUNT_EXCEEDS_DUE', 'a bank payment above the due is refused exactly like cash');
select throws_ok($$select public.apply_customer_credit(pg_temp.cpay('c5000000-0000-4000-8000-000000000001', 10, 'bk-credit-method', '{"payment_method": "bank"}'))$$, 'P0001', 'INVALID_REQUEST', 'applying credit takes no payment method: it is not a cash or bank receipt');
reset role;
select pg_temp.act('staff2');
set local role authenticated;
select throws_ok($$select public.record_customer_payment(jsonb_build_object('shop_id', '10000000-0000-4000-8000-000000000001', 'customer_id', 'c5000000-0000-4000-8000-000000000001', 'amount_dirham', 10, 'payment_method', 'bank', 'business_date', current_date::text, 'idempotency_key', 'bk-cp-other-shop'))$$, '42501', null, 'a bank customer payment is refused for an unassigned shop');
reset role;

-- 6. Reports ---------------------------------------------------------------------
select pg_temp.act('owner');
set local role authenticated;
-- Cash today: 250 (BK-P2) + 100 (BK-S2) + 350 (cash customer payment); bank: 400 + 100 + 50 (credit) + 500 + 350.
select is(pg_temp.delta('cash_received_dirham'), 700::bigint, 'cash_received counts cash only');
select is(pg_temp.delta('bank_received_dirham'), 1400::bigint, 'bank_received counts bank only, including the part of an overpayment kept as credit');
select is(pg_temp.delta('total_received_dirham'), 2100::bigint, 'total_received is cash plus bank');
select is(pg_temp.delta('total_received_dirham'), pg_temp.delta('cash_received_dirham') + pg_temp.delta('bank_received_dirham'), 'total = cash + bank');
select is((select coalesce(sum(amount_dirham), 0)::bigint from public.report_payment_totals(pg_temp.s1(), current_date, current_date) where source is null and method = 'bank') - (current_setting('bk.base')::jsonb ->> 'bank_received_dirham')::bigint,
  1400::bigint, 'report_payment_totals agrees with the daily bank total');
select ok((select count(*) = 0 from public.report_payments where shop_id = pg_temp.s1() and method not in ('cash', 'bank', 'credit')), 'the payment report only contains cash, bank and applied credit');
reset role;
select is((select method from public.report_payments where entry_id = (select id from public.customer_credits where invoice_id = pg_temp.inv('BK-OV'))), 'bank', 'the overpayment credit row is reported with the payment tender');

-- A payment correction is reported under the method of the payment it corrects.
select pg_temp.act('owner');
set local role authenticated;
select is((public.request_invoice_correction(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv('BK-A1'), 'reason', 'bank amount typed wrongly',
  'idempotency_key', 'bk-corr-req', 'payment_id', (select id from public.payments where invoice_id = pg_temp.inv('BK-A1')), 'amount_delta_dirham', -100)) ->> 'ok')::boolean, true, 'a correction of a bank payment can be requested');
select is((public.decide_invoice_correction(jsonb_build_object('shop_id', pg_temp.s1(), 'request_id', (select id from public.correction_requests where shop_id = pg_temp.s1() and idempotency_key = 'bk-corr-req'),
  'expected_revision', 0, 'decision', 'approved', 'reason', null, 'idempotency_key', 'bk-corr-dec')) ->> 'ok')::boolean, true, 'it can be approved');
select is(pg_temp.delta('bank_received_dirham'), 1300::bigint, 'the correction reduces bank received, not cash');
select is(pg_temp.delta('cash_received_dirham'), 700::bigint, 'cash received is unaffected by a correction of a bank payment');
select is((select method from public.report_payments where reference = (select id::text from public.payments where invoice_id = pg_temp.inv('BK-A1')) and source = 'payment_correction'), 'bank', 'the correction row is reported as bank');
select is(pg_temp.delta('net_cash_movement_dirham'), pg_temp.delta('total_received_dirham') - pg_temp.delta('expenses_dirham'), 'net movement is total received minus expenses');
reset role;

select * from finish();
rollback;
