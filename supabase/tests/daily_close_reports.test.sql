begin;
-- current_date below must be the Qatar operating date the RPCs enforce.
set local timezone = 'Asia/Qatar';
create extension if not exists pgtap with schema extensions;
select plan(122);

-- Helpers -------------------------------------------------------------------
create function pg_temp.act(who text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', case who
    when 'owner' then '10000000-0000-4000-8000-000000000101' when 'staff' then '10000000-0000-4000-8000-000000000102'
    when 'staff2' then '10000000-0000-4000-8000-000000000103' when 'manager' then '10000000-0000-4000-8000-000000000104' end)::text, true)
$$;
create function pg_temp.s1() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.s2() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.cmd(extra jsonb, shop uuid default pg_temp.s1()) returns jsonb language sql as $$ select jsonb_build_object('shop_id', shop) || extra $$;
create function pg_temp.inv(number text) returns uuid language sql as $$ select id from public.invoices where shop_id = pg_temp.s1() and invoice_id = number $$;
create function pg_temp.day(d date, shop uuid default pg_temp.s1()) returns jsonb language sql as $$
  select coalesce((select to_jsonb(r) - 'business_date' from public.report_daily_summary(shop, d, d) r), '{}'::jsonb) $$;
-- Change in one daily-summary metric since the baseline, so rows left in a
-- reused local database cannot affect the expected values.
create function pg_temp.delta(metric text) returns bigint language sql as $$
  select coalesce((pg_temp.day(current_date) ->> metric)::bigint, 0) - coalesce((current_setting('dc4.base')::jsonb ->> metric)::bigint, 0) $$;
create function pg_temp.batch(key text, d date, rows jsonb, reason text default null) returns jsonb language sql as $$
  select pg_temp.cmd(jsonb_build_object('business_date', d::text, 'idempotency_key', key, 'rows', rows)
    || case when reason is null then '{}'::jsonb else jsonb_build_object('is_backdated', true, 'backdated_reason', reason) end) $$;
create function pg_temp.row(number text, total bigint, received bigint, delivered boolean, customer uuid default null) returns jsonb language sql as $$
  select jsonb_build_object('row_id', number, 'invoice_number', number, 'total_dirham', total, 'received_dirham', received, 'payment_method', 'cash',
    'delivered', delivered, 'customer', case when customer is null then null else jsonb_build_object('type', 'existing', 'customer_id', customer) end) $$;
create function pg_temp.correction_decision(request_key text, key text, decision text default 'approved') returns jsonb language sql as $$
  select pg_temp.cmd(jsonb_build_object('request_id', (select id from public.correction_requests where shop_id = pg_temp.s1() and idempotency_key = request_key),
    'expected_revision', 0, 'decision', decision, 'reason', null, 'idempotency_key', key)) $$;
create function pg_temp.expense_decision(request_key text, key text) returns jsonb language sql as $$
  select pg_temp.cmd(jsonb_build_object('request_id', (select id from public.expense_correction_requests where shop_id = pg_temp.s1() and idempotency_key = request_key),
    'decision', 'approved', 'idempotency_key', key)) $$;
create function pg_temp.state(d date, shop uuid default pg_temp.s1()) returns text language sql as $$
  select coalesce((select event_type from public.daily_closes where shop_id = shop and business_date = d order by event_sequence desc limit 1), 'open') $$;

insert into public.customers(id, shop_id, name, mobile, created_by) values
  ('c4000000-0000-4000-8000-000000000001', pg_temp.s1(), 'DC4 Customer', '55540001', '10000000-0000-4000-8000-000000000102');
select set_config('dc4.base', pg_temp.day(current_date)::text, true);
select set_config('dc4.old', (current_date - 77)::text, true);

-- 1. Schema ---------------------------------------------------------------------
select has_function('public', 'close_business_date', array['jsonb'], 'close RPC exists');
select has_function('public', 'reopen_business_date', array['jsonb'], 'reopen RPC exists');
select has_view('public', 'report_payments', 'payment report projection exists');
select has_column('public', 'daily_closes', 'note', 'a close event can carry a note');
select is((select count(*)::int from pg_trigger where tgname like '%\_open\_business\_date' and not tgisinternal), 7, 'every dated financial table enforces the closed-date rule on insert');
select ok(not has_function_privilege('anon', 'public.close_business_date(jsonb)', 'EXECUTE') and not has_function_privilege('anon', 'public.reopen_business_date(jsonb)', 'EXECUTE'), 'anon cannot execute close or reopen');
select ok(not has_function_privilege('authenticated', 'private.record_day_close_event(jsonb,text)', 'EXECUTE'), 'the close worker is not directly callable');
select ok(not has_table_privilege('authenticated', 'public.daily_closes', 'INSERT'), 'close events cannot be inserted outside the RPC');
select throws_ok($$insert into public.daily_closes(shop_id, business_date, event_type, actor_id, reason, note) values (pg_temp.s1(), current_date - 500, 'reopened', '10000000-0000-4000-8000-000000000101', 'why', 'note')$$, '23514', null, 'only a close event may carry a note');

set local role authenticated;

-- 2. A full day of activity while the date is open --------------------------------
select pg_temp.act('staff');
select set_config('dc4.batch1', pg_temp.batch('dc4-batch-1', current_date, jsonb_build_array(
  pg_temp.row('DC4-A', 1000, 400, true, 'c4000000-0000-4000-8000-000000000001'), pg_temp.row('DC4-B', 500, 500, false)))::text, true);
select set_config('dc4.batch1_receipt', public.submit_batch(current_setting('dc4.batch1')::jsonb)::text, true);
select set_config('dc4.pay', pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('DC4-A'), 'amount_dirham', 100, 'payment_method', 'cash', 'business_date', current_date::text, 'idempotency_key', 'dc4-pay-1'))::text, true);
select set_config('dc4.pay_receipt', public.record_payment(current_setting('dc4.pay')::jsonb)::text, true);
select set_config('dc4.cpay', pg_temp.cmd(jsonb_build_object('customer_id', 'c4000000-0000-4000-8000-000000000001', 'amount_dirham', 200, 'business_date', current_date::text, 'idempotency_key', 'dc4-cpay-1'))::text, true);
select set_config('dc4.cpay_receipt', public.record_customer_payment(current_setting('dc4.cpay')::jsonb)::text, true);
select lives_ok($$select public.submit_batch(pg_temp.batch('dc4-batch-2', current_date, jsonb_build_array(pg_temp.row('DC4-C', 300, 0, true, 'c4000000-0000-4000-8000-000000000001'))))$$, 'a second batch is saved on the open date');
select pg_temp.act('manager');
select set_config('dc4.over', pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('DC4-A'), 'amount_dirham', 350, 'payment_method', 'cash', 'business_date', current_date::text, 'idempotency_key', 'dc4-over-1', 'reason', 'customer paid extra'))::text, true);
select set_config('dc4.over_receipt', public.approve_overpayment(current_setting('dc4.over')::jsonb)::text, true);
select pg_temp.act('staff');
select set_config('dc4.credit', pg_temp.cmd(jsonb_build_object('customer_id', 'c4000000-0000-4000-8000-000000000001', 'amount_dirham', 50, 'business_date', current_date::text, 'idempotency_key', 'dc4-credit-1'))::text, true);
select set_config('dc4.credit_receipt', public.apply_customer_credit(current_setting('dc4.credit')::jsonb)::text, true);
select public.request_invoice_correction(pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('DC4-C'), 'payment_id', null, 'amount_delta_dirham', -30, 'reason', 'price agreed lower', 'idempotency_key', 'dc4-corr-1')));
select public.request_invoice_correction(pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('DC4-A'), 'payment_id', (select id from public.payments where shop_id = pg_temp.s1() and idempotency_key = 'dc4-pay-1'), 'amount_delta_dirham', -10, 'reason', 'counted cash again', 'idempotency_key', 'dc4-corr-2')));
select set_config('dc4.expense', pg_temp.cmd(jsonb_build_object('amount_dirham', 120, 'business_date', current_date::text, 'category', 'supplies', 'description', 'DC4 paper', 'idempotency_key', 'dc4-exp-1'))::text, true);
select set_config('dc4.expense_receipt', public.create_expense(current_setting('dc4.expense')::jsonb)::text, true);
select public.create_expense(pg_temp.cmd(jsonb_build_object('amount_dirham', 80, 'business_date', current_date::text, 'category', 'rent', 'description', 'DC4 rent', 'idempotency_key', 'dc4-exp-2')));
select public.request_expense_correction(pg_temp.cmd(jsonb_build_object('expense_id', current_setting('dc4.expense_receipt')::jsonb ->> 'expense_id', 'amount_dirham', 150, 'category', 'supplies', 'description', 'DC4 paper', 'reason', 'receipt total', 'idempotency_key', 'dc4-expcorr-1')));
select public.request_invoice_replacement(pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('DC4-B'), 'expected_revision', 0, 'invoice_number', 'DC4-B2', 'customer_id', null, 'delivered', false, 'reason', 'number typo', 'idempotency_key', 'dc4-repl-1')));
select pg_temp.act('manager');
select public.decide_invoice_correction(pg_temp.correction_decision('dc4-corr-1', 'dc4-corr-dec-1'));
select public.decide_invoice_correction(pg_temp.correction_decision('dc4-corr-2', 'dc4-corr-dec-2'));
select public.decide_expense_correction(pg_temp.expense_decision('dc4-expcorr-1', 'dc4-expdec-1'));
select public.decide_invoice_replacement(pg_temp.cmd(jsonb_build_object('request_id', (select id from public.replacement_requests where shop_id = pg_temp.s1() and idempotency_key = 'dc4-repl-1'), 'expected_revision', 0, 'decision', 'approved', 'reason', null, 'idempotency_key', 'dc4-repl-dec-1')));
-- Left pending on purpose: used by the closed-date approval checks below.
select pg_temp.act('staff');
select public.request_invoice_correction(pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('DC4-C'), 'payment_id', null, 'amount_delta_dirham', -5, 'reason', 'pending one', 'idempotency_key', 'dc4-corr-3')));
select public.request_invoice_correction(pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('DC4-C'), 'payment_id', null, 'amount_delta_dirham', -7, 'reason', 'pending two', 'idempotency_key', 'dc4-corr-4')));
select public.request_expense_correction(pg_temp.cmd(jsonb_build_object('expense_id', (select id from public.expenses where shop_id = pg_temp.s1() and idempotency_key = 'dc4-exp-2'), 'amount_dirham', 90, 'category', 'rent', 'description', 'DC4 rent', 'reason', 'pending expense', 'idempotency_key', 'dc4-expcorr-2')));

-- 3. Daily summary formulas ---------------------------------------------------------
select is(pg_temp.delta('invoice_count'), 3::bigint, 'invoice count is one per canonical invoice; an approved replacement adds none');
select is(pg_temp.delta('gross_invoice_dirham'), 1800::bigint, 'gross invoice amount is the original totals entered for the date');
select is(pg_temp.delta('initial_received_dirham'), 900::bigint, 'received at entry is the cash taken with the batch');
select is(pg_temp.delta('due_created_dirham'), 900::bigint, 'due created at entry is gross minus received at entry');
select is(pg_temp.delta('followup_payments_dirham'), 400::bigint, 'follow-up payments include the applied part of an approved overpayment');
select is(pg_temp.delta('customer_payments_dirham'), 200::bigint, 'customer payment allocations are reported separately');
select is(pg_temp.delta('payment_corrections_dirham'), -10::bigint, 'an approved payment correction counts once');
select is(pg_temp.delta('invoice_corrections_dirham'), -30::bigint, 'an approved invoice correction counts once; pending ones do not count');
select is(pg_temp.delta('credit_created_dirham'), 50::bigint, 'overpayment excess becomes customer credit');
select is(pg_temp.delta('credit_applied_dirham'), 50::bigint, 'a credit application counts once');
select is(pg_temp.delta('expense_count'), 2::bigint, 'expense count');
select is(pg_temp.delta('expenses_dirham'), 230::bigint, 'expenses use the effective (corrected) amount');
select is(pg_temp.delta('cash_received_dirham'), 1540::bigint, 'cash received = entry + follow-up + customer payments + payment corrections + credit created');
select is(pg_temp.delta('net_cash_movement_dirham'), 1310::bigint, 'net cash movement = cash received - expenses');
select is(pg_temp.delta('net_due_movement_dirham'), 230::bigint, 'net due movement = gross + invoice corrections - payments - payment corrections - credit applied');

-- 4. Reconciliation against the source projections -----------------------------------
select is((select sum(effective_due_dirham)::bigint from public.effective_invoices where shop_id = pg_temp.s1() and original_invoice_number like 'DC4-%'), pg_temp.delta('net_due_movement_dirham'), 'net due movement equals the effective due left on the day''s invoices');
select is((select outstanding_due_dirham from public.customer_financial_balances where shop_id = pg_temp.s1() and customer_id = 'c4000000-0000-4000-8000-000000000001'), 230::bigint, 'customer due equals the due on that customer''s invoices');
select is((select outstanding_due_dirham from public.report_customer_due_totals(pg_temp.s1())), (select coalesce(sum(outstanding_due_dirham), 0)::bigint from public.customer_financial_balances where shop_id = pg_temp.s1()), 'customer due report total equals the customer balance projection');
select is((select outstanding_due_dirham + unassigned_due_dirham from public.report_customer_due_totals(pg_temp.s1())), (select coalesce(sum(effective_due_dirham), 0)::bigint from public.effective_invoices where shop_id = pg_temp.s1()), 'customer due plus unassigned due equals all effective invoice due');
-- Sales are business-date movements (gross + invoice corrections, as the daily summary); paid/credit/due/delivery are the
-- current state of the invoices dated in the range (the effective projection).
select is((select to_jsonb(t) - array['gross_sales_dirham', 'sales_corrections_dirham', 'net_sales_dirham', 'effective_total_dirham'] from public.report_sales_totals(pg_temp.s1(), current_date, current_date) t),
  (select jsonb_build_object('invoice_count', count(*), 'effective_paid_dirham', coalesce(sum(effective_paid_dirham), 0),
    'credit_applied_dirham', coalesce(sum(effective_credit_applied_dirham), 0), 'effective_due_dirham', coalesce(sum(effective_due_dirham), 0),
    'delivered_count', count(*) filter (where effective_delivered), 'undelivered_count', count(*) filter (where not effective_delivered))
   from public.effective_invoices where shop_id = pg_temp.s1() and business_date = current_date), 'sales report current-state totals equal the effective invoice projection for the same filter');
select is((select array[gross_sales_dirham, sales_corrections_dirham, net_sales_dirham] from public.report_sales_totals(pg_temp.s1(), current_date, current_date)),
  (select array[gross_invoice_dirham, invoice_corrections_dirham, gross_invoice_dirham + invoice_corrections_dirham] from public.report_daily_summary(pg_temp.s1(), current_date, current_date)),
  'sales report gross / corrections / net equal the daily summary''s gross invoice amount and invoice corrections');
select is((select array_agg(effective_invoice_number order by effective_invoice_number) from public.effective_invoices where shop_id = pg_temp.s1() and original_invoice_number = 'DC4-B'), array['DC4-B2'], 'a replaced invoice is one report row under its current number');
select is((select amount_dirham from public.report_expense_totals(pg_temp.s1(), current_date, current_date) where category is null), (select sum(amount_dirham)::bigint from public.effective_expenses where shop_id = pg_temp.s1() and business_date = current_date), 'expense report total equals the effective expense projection');
select is((select sum(amount_dirham)::bigint from public.report_expense_totals(pg_temp.s1(), current_date, current_date) where category is not null), (select amount_dirham from public.report_expense_totals(pg_temp.s1(), current_date, current_date) where category is null), 'expense categories add up to the expense total');
select is((select amount_dirham from public.report_payment_totals(pg_temp.s1(), current_date, current_date) where source is null and method = 'cash'), (pg_temp.day(current_date) ->> 'cash_received_dirham')::bigint, 'cash rows of the payment report equal cash received in the daily summary');
select is((select amount_dirham from public.report_payment_totals(pg_temp.s1(), current_date, current_date) where source is null and method = 'credit'), (pg_temp.day(current_date) ->> 'credit_applied_dirham')::bigint, 'credit rows of the payment report equal credit applied in the daily summary');
select is((select count(*)::int from public.report_payments where shop_id = pg_temp.s1() and source = 'credit_application' and invoice_id = pg_temp.inv('DC4-C')), 1, 'a credit application appears exactly once');
select is((select count(*)::int from public.report_payments where shop_id = pg_temp.s1() and source = 'payment_correction' and invoice_id = pg_temp.inv('DC4-A')), 1, 'an approved payment correction appears exactly once');
select is((select sum(amount_dirham)::bigint from public.report_payments where shop_id = pg_temp.s1() and invoice_id = pg_temp.inv('DC4-A') and source in ('invoice_entry', 'follow_up', 'customer_payment', 'payment_correction')),
  (select effective_paid_dirham from public.effective_invoices where canonical_invoice_id = pg_temp.inv('DC4-A')), 'payment report rows for an invoice add up to its effective paid amount');
select ok((select pending_invoice_corrections >= 2 and pending_expense_corrections >= 1 from public.report_day_pending_requests(pg_temp.s1(), current_date)), 'undecided requests against the date are visible before closing');

-- 5. Close authorization ---------------------------------------------------------------
select pg_temp.act('staff');
select throws_ok($$select public.close_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_date::text)))$$, '42501', 'INSUFFICIENT_ROLE', 'staff cannot close a date');
select throws_ok($$select public.reopen_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_date::text, 'reason', 'x')))$$, '42501', 'INSUFFICIENT_ROLE', 'staff cannot reopen a date');
select pg_temp.act('staff2');
select throws_ok($$select public.close_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_date::text)))$$, '42501', 'UNAUTHORIZED_SHOP', 'an actor from another shop cannot close this shop');
select pg_temp.act('manager');
select throws_ok($$select public.close_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_date::text), pg_temp.s2()))$$, '42501', 'UNAUTHORIZED_SHOP', 'a manager cannot close an unassigned shop');
select throws_ok($$select public.close_business_date(pg_temp.cmd(jsonb_build_object('business_date', (current_date + 1)::text)))$$, 'P0001', 'INVALID_DATE', 'a future date cannot be closed');
select throws_ok($$select public.close_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_date::text, 'reason', 'x')))$$, 'P0001', 'INVALID_REQUEST', 'unknown close fields are rejected');
select throws_ok($$select public.close_business_date(pg_temp.cmd(jsonb_build_object('business_date', 'not-a-date')))$$, 'P0001', 'INVALID_REQUEST', 'an invalid date is rejected');
select throws_ok($$select public.reopen_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_date::text, 'reason', 'x')))$$, 'P0001', 'NOT_CLOSED', 'an open date cannot be reopened');
select set_config('dc4.at_close', pg_temp.day(current_date)::text, true);
select is(public.close_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_date::text, 'note', '  till counted  '))) ->> 'state', 'closed', 'a manager closes an assigned shop date');
select is(pg_temp.state(current_date), 'closed', 'the date is closed');
select is((select note from public.daily_closes where shop_id = pg_temp.s1() and business_date = current_date order by event_sequence desc limit 1), 'till counted', 'the close note is stored trimmed');
select throws_ok($$select public.close_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_date::text)))$$, 'P0001', 'ALREADY_CLOSED', 'a closed date cannot be closed twice');
select is((select metadata -> 'summary' from public.audit_events where shop_id = pg_temp.s1() and action = 'date.close' and entity_id = current_date::text order by recorded_at desc, id desc limit 1) - 'business_date', current_setting('dc4.at_close')::jsonb, 'the close audit event records the day totals as closed');
select is((select actor_id::text from public.audit_events where shop_id = pg_temp.s1() and action = 'date.close' and entity_id = current_date::text limit 1), '10000000-0000-4000-8000-000000000104', 'the close audit event records the actor');

-- 6. Every mutation path is blocked on the closed date ---------------------------------
select pg_temp.act('staff');
select throws_ok($$select public.submit_batch(pg_temp.batch('dc4-closed-batch', current_date, jsonb_build_array(pg_temp.row('DC4-CLOSED', 100, 0, false))))$$, 'P0001', 'CLOSED_DATE', 'a new batch is blocked');
select throws_ok($$select public.record_payment(pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('DC4-C'), 'amount_dirham', 1, 'payment_method', 'cash', 'business_date', current_date::text, 'idempotency_key', 'dc4-closed-pay')))$$, 'P0001', 'CLOSED_DATE', 'a follow-up payment is blocked');
select throws_ok($$select public.record_customer_payment(pg_temp.cmd(jsonb_build_object('customer_id', 'c4000000-0000-4000-8000-000000000001', 'amount_dirham', 1, 'business_date', current_date::text, 'idempotency_key', 'dc4-closed-cpay')))$$, 'P0001', 'CLOSED_DATE', 'a customer payment is blocked');
select throws_ok($$select public.apply_customer_credit(pg_temp.cmd(jsonb_build_object('customer_id', 'c4000000-0000-4000-8000-000000000001', 'amount_dirham', 1, 'business_date', current_date::text, 'idempotency_key', 'dc4-closed-credit')))$$, 'P0001', 'CLOSED_DATE', 'a credit application is blocked');
select throws_ok($$select public.create_expense(pg_temp.cmd(jsonb_build_object('amount_dirham', 5, 'business_date', current_date::text, 'category', 'other', 'description', 'blocked', 'idempotency_key', 'dc4-closed-exp')))$$, 'P0001', 'CLOSED_DATE', 'a new expense is blocked');
select lives_ok($$select public.request_invoice_correction(pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('DC4-C'), 'payment_id', null, 'amount_delta_dirham', -1, 'reason', 'request while closed', 'idempotency_key', 'dc4-corr-5')))$$, 'a correction request has no financial effect and is still accepted');
select pg_temp.act('manager');
select throws_ok($$select public.approve_overpayment(pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('DC4-C'), 'amount_dirham', 9999, 'payment_method', 'cash', 'business_date', current_date::text, 'idempotency_key', 'dc4-closed-over', 'reason', 'r')))$$, 'P0001', 'CLOSED_DATE', 'an overpayment approval is blocked');
select throws_ok($$select public.decide_invoice_correction(pg_temp.correction_decision('dc4-corr-3', 'dc4-corr-dec-3'))$$, 'P0001', 'CLOSED_DATE', 'approving an invoice correction is blocked');
select throws_ok($$select public.decide_expense_correction(pg_temp.expense_decision('dc4-expcorr-2', 'dc4-expdec-2'))$$, 'P0001', 'CLOSED_DATE', 'approving an expense correction on a closed date is blocked');
select lives_ok($$select public.decide_invoice_correction(pg_temp.correction_decision('dc4-corr-4', 'dc4-corr-dec-4', 'rejected'))$$, 'rejecting a request changes no totals and is allowed');
select pg_temp.act('staff2');
select lives_ok($$select public.create_expense(pg_temp.cmd(jsonb_build_object('amount_dirham', 5, 'business_date', current_date::text, 'category', 'other', 'description', 'DC4 other shop', 'idempotency_key', 'dc4-shop2-exp'), pg_temp.s2()))$$, 'closing one shop does not close the other');
reset role;
select throws_ok($$insert into public.payments(shop_id, invoice_id, amount_dirham, business_date) values (pg_temp.s1(), pg_temp.inv('DC4-C'), 1, current_date)$$, 'P0001', 'CLOSED_DATE', 'the rule is enforced on the table itself, not only inside the RPCs');
set local role authenticated;

-- 7. Exact retries of work committed before the close return the stored result -----
select pg_temp.act('staff');
select is(public.submit_batch(current_setting('dc4.batch1')::jsonb)::text, current_setting('dc4.batch1_receipt'), 'batch retry after close returns the original receipt');
select is(public.record_payment(current_setting('dc4.pay')::jsonb)::text, current_setting('dc4.pay_receipt'), 'payment retry after close returns the original receipt');
select is(public.record_customer_payment(current_setting('dc4.cpay')::jsonb)::text, current_setting('dc4.cpay_receipt'), 'customer payment retry after close returns the original receipt');
select is(public.apply_customer_credit(current_setting('dc4.credit')::jsonb)::text, current_setting('dc4.credit_receipt'), 'credit application retry after close returns the original receipt');
select is(public.create_expense(current_setting('dc4.expense')::jsonb)::text, current_setting('dc4.expense_receipt'), 'expense retry after close returns the original receipt');
select pg_temp.act('manager');
select is(public.approve_overpayment(current_setting('dc4.over')::jsonb)::text, current_setting('dc4.over_receipt'), 'overpayment retry after close returns the original receipt');
select is(pg_temp.day(current_date), current_setting('dc4.at_close')::jsonb, 'nothing changed the closed day''s totals');

-- 8. Reopen ----------------------------------------------------------------------------
select throws_ok($$select public.reopen_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_date::text)))$$, 'P0001', 'REASON_REQUIRED', 'reopen without a reason is rejected');
select throws_ok($$select public.reopen_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_date::text, 'reason', '   ')))$$, 'P0001', 'REASON_REQUIRED', 'reopen requires a non-blank reason');
select is(public.reopen_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_date::text, 'reason', 'late delivery to record'))) ->> 'state', 'open', 'a manager reopens today with a reason');
select is((select reason from public.audit_events where shop_id = pg_temp.s1() and action = 'date.reopen' and entity_id = current_date::text limit 1), 'late delivery to record', 'the reopen reason is in the audit trail');
select lives_ok($$select public.decide_invoice_correction(pg_temp.correction_decision('dc4-corr-3', 'dc4-corr-dec-3'))$$, 'the pending invoice correction can be approved once reopened');
select lives_ok($$select public.decide_expense_correction(pg_temp.expense_decision('dc4-expcorr-2', 'dc4-expdec-2'))$$, 'the pending expense correction can be approved once reopened');
select pg_temp.act('staff');
select lives_ok($$select public.submit_batch(pg_temp.batch('dc4-closed-batch', current_date, jsonb_build_array(pg_temp.row('DC4-CLOSED', 100, 0, false))))$$, 'the batch rejected while closed saves with the same key once reopened');
select pg_temp.act('manager');
select lives_ok($$select public.close_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_date::text)))$$, 'the date can be closed again');
select is((select array_agg(event_type order by event_sequence) from public.daily_closes where shop_id = pg_temp.s1() and business_date = current_date and recorded_at = now()), array['closed', 'reopened', 'closed'], 'close, reopen and close again are all kept as history');
reset role;
select throws_ok($$update public.daily_closes set reason = 'edited' where shop_id = pg_temp.s1() and business_date = current_date$$, '55000', null, 'close history cannot be edited');
select throws_ok($$delete from public.daily_closes where shop_id = pg_temp.s1() and business_date = current_date$$, '55000', null, 'close history cannot be deleted');
select throws_ok($$update public.audit_events set reason = 'edited' where action = 'date.reopen'$$, '55000', null, 'audit history cannot be edited');
set local role authenticated;
select lives_ok($$select public.reopen_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_date::text, 'reason', 'continue test')))$$, 'reopened again for the remaining checks');

-- 9. Backdating and earlier dates --------------------------------------------------------
select pg_temp.act('staff');
select throws_ok($$select public.create_expense(pg_temp.cmd(jsonb_build_object('amount_dirham', 5, 'business_date', current_setting('dc4.old'), 'category', 'other', 'description', 'late', 'backdated_reason', 'late', 'idempotency_key', 'dc4-old-exp-staff')))$$, '42501', 'INSUFFICIENT_ROLE', 'staff cannot backdate an expense');
select throws_ok($$select public.submit_batch(pg_temp.batch('dc4-old-batch-staff', current_setting('dc4.old')::date, jsonb_build_array(pg_temp.row('DC4-OLD-STAFF', 100, 0, false)), 'late'))$$, '42501', 'INSUFFICIENT_ROLE', 'staff cannot backdate a batch');
select pg_temp.act('manager');
select throws_ok($$select public.submit_batch(pg_temp.batch('dc4-old-batch-manager', current_setting('dc4.old')::date, jsonb_build_array(pg_temp.row('DC4-OLD-MANAGER', 100, 0, false)), 'late'))$$, '42501', 'INSUFFICIENT_ROLE', 'a manager cannot backdate a batch');
select pg_temp.act('owner');
select throws_ok($$select public.create_expense(pg_temp.cmd(jsonb_build_object('amount_dirham', 5, 'business_date', current_setting('dc4.old'), 'category', 'other', 'description', 'late', 'idempotency_key', 'dc4-old-exp-noreason')))$$, '42501', 'INSUFFICIENT_ROLE', 'an owner cannot backdate an expense without a reason');
select throws_ok($$select public.submit_batch(pg_temp.batch('dc4-old-batch-noreason', current_setting('dc4.old')::date, jsonb_build_array(pg_temp.row('DC4-OLD-NOREASON', 100, 0, false))))$$, 'P0001', 'BATCH_VALIDATION_FAILED', 'an owner cannot backdate a batch without a reason');
select lives_ok($$select public.submit_batch(pg_temp.batch('dc4-old-batch', current_setting('dc4.old')::date, jsonb_build_array(pg_temp.row('DC4-OLD', 400, 0, false)), 'missed sale'))$$, 'an owner backdates a batch with a reason');
select ok((select is_backdated and backdated_reason = 'missed sale' and recorded_at::date > business_date from public.batches where shop_id = pg_temp.s1() and idempotency_key = 'dc4-old-batch'), 'the backdated batch keeps its reason, business date and later recorded time');
select throws_ok($$select public.record_payment(pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('DC4-OLD'), 'amount_dirham', 50, 'payment_method', 'cash', 'business_date', current_setting('dc4.old'), 'idempotency_key', 'dc4-old-pay-noreason')))$$, 'P0001', 'PAYMENT_VALIDATION_FAILED', 'an owner cannot backdate a payment without a reason');
select throws_ok($$select public.record_payment(pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('DC4-OLD'), 'amount_dirham', 50, 'payment_method', 'cash', 'business_date', current_date::text, 'backdated_reason', 'not backdated', 'idempotency_key', 'dc4-today-pay-reason')))$$, 'P0001', 'PAYMENT_VALIDATION_FAILED', 'a backdate reason is rejected on a current-date payment');
select lives_ok($$select public.record_payment(pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('DC4-OLD'), 'amount_dirham', 50, 'payment_method', 'cash', 'business_date', current_setting('dc4.old'), 'backdated_reason', 'paid that day', 'idempotency_key', 'dc4-old-pay')))$$, 'an owner backdates a payment with a reason');
select ok((select a.reason = 'paid that day' and (a.metadata ->> 'is_backdated')::boolean from public.audit_events a join public.payments p on p.id::text = a.entity_id where p.idempotency_key = 'dc4-old-pay' and a.action = 'record_payment'), 'the backdated payment reason is in the audit trail');
select lives_ok($$select public.create_expense(pg_temp.cmd(jsonb_build_object('amount_dirham', 60, 'business_date', current_setting('dc4.old'), 'category', 'other', 'description', 'DC4 old expense', 'backdated_reason', 'found receipt', 'idempotency_key', 'dc4-old-exp')))$$, 'an owner backdates an expense with a reason');

select lives_ok($$select public.close_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_setting('dc4.old'))))$$, 'an earlier date can be closed');
select set_config('dc4.old_at_close', pg_temp.day(current_setting('dc4.old')::date)::text, true);
select throws_ok($$select public.create_expense(pg_temp.cmd(jsonb_build_object('amount_dirham', 5, 'business_date', current_setting('dc4.old'), 'category', 'other', 'description', 'late', 'backdated_reason', 'late', 'idempotency_key', 'dc4-old-exp-closed')))$$, 'P0001', 'CLOSED_DATE', 'an owner cannot backdate into a closed date');
select throws_ok($$select public.submit_batch(pg_temp.batch('dc4-old-batch-closed', current_setting('dc4.old')::date, jsonb_build_array(pg_temp.row('DC4-OLD-CLOSED', 100, 0, false)), 'late'))$$, 'P0001', 'CLOSED_DATE', 'an owner cannot backdate a batch into a closed date');
select pg_temp.act('manager');
select throws_ok($$select public.reopen_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_setting('dc4.old'), 'reason', 'manager wants it open')))$$, '42501', 'INSUFFICIENT_ROLE', 'a manager cannot reopen an earlier date');

-- 10. Corrections against a closed period ----------------------------------------------
select pg_temp.act('staff');
select public.request_invoice_correction(pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('DC4-OLD'), 'payment_id', null, 'amount_delta_dirham', -40, 'reason', 'old invoice overcharged', 'idempotency_key', 'dc4-corr-old')));
select public.request_expense_correction(pg_temp.cmd(jsonb_build_object('expense_id', (select id from public.expenses where shop_id = pg_temp.s1() and idempotency_key = 'dc4-old-exp'), 'amount_dirham', 70, 'category', 'other', 'description', 'DC4 old expense', 'reason', 'old expense wrong', 'idempotency_key', 'dc4-expcorr-old')));
select pg_temp.act('manager');
select lives_ok($$select public.decide_invoice_correction(pg_temp.correction_decision('dc4-corr-old', 'dc4-corr-dec-old'))$$, 'an invoice correction is dated on its approval day, so the open current date accepts it');
select is(pg_temp.day(current_setting('dc4.old')::date), current_setting('dc4.old_at_close')::jsonb, 'the closed earlier day''s summary is unchanged by that correction');
select is((select business_date from public.corrections where shop_id = pg_temp.s1() and invoice_id = pg_temp.inv('DC4-OLD')), current_date, 'the correction is reported on the day it was approved');
select throws_ok($$select public.decide_expense_correction(pg_temp.expense_decision('dc4-expcorr-old', 'dc4-expdec-old'))$$, 'P0001', 'CLOSED_DATE', 'an expense correction would change the closed day''s expenses, so it needs a reopen');
select pg_temp.act('owner');
select lives_ok($$select public.reopen_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_setting('dc4.old'), 'reason', 'approve expense correction')))$$, 'the owner reopens the earlier date with a reason');
select pg_temp.act('manager');
select lives_ok($$select public.decide_expense_correction(pg_temp.expense_decision('dc4-expcorr-old', 'dc4-expdec-old'))$$, 'the expense correction is approved after the reopen');
select is((pg_temp.day(current_setting('dc4.old')::date) ->> 'expenses_dirham')::bigint - (current_setting('dc4.old_at_close')::jsonb ->> 'expenses_dirham')::bigint, 10::bigint, 'the reopened day now reports the corrected expense');

-- 11. Shop isolation ---------------------------------------------------------------------
select pg_temp.act('staff2');
select is((select count(*)::int from public.report_daily_summary(pg_temp.s1(), current_date, current_date)), 0, 'another shop''s daily summary is not visible');
select is((select invoice_count from public.report_sales_totals(pg_temp.s1(), current_date, current_date)), 0::bigint, 'another shop''s sales totals are not visible');
select is((select count(*)::int from public.report_payments where shop_id = pg_temp.s1()), 0, 'another shop''s payment rows are not visible');
select is((select outstanding_due_dirham from public.report_customer_due_totals(pg_temp.s1())), 0::bigint, 'another shop''s customer due is not visible');
select is((select count(*)::int from public.report_expense_totals(pg_temp.s1(), current_date, current_date) where category is not null), 0, 'another shop''s expenses are not visible');
select is((select count(*)::int from public.daily_closes where shop_id = pg_temp.s1()), 0, 'another shop''s close history is not visible');
select ok((select expenses_dirham >= 5 from public.report_daily_summary(pg_temp.s2(), current_date, current_date)), 'the actor''s own shop is reported');

-- 12. Qatar date semantics ---------------------------------------------------------------
-- 22:30 UTC on 1 January is 01:30 on 2 January in Qatar: the UTC calendar date
-- is a day behind the business date for the first three hours of every day.
reset role;
insert into public.invoices(shop_id, invoice_id, total_amount_dirham, business_date, recorded_at) values (pg_temp.s2(), 'DC4-MIDNIGHT', 700, '2001-01-02', '2001-01-01 22:30:00+00');
select is(('2001-01-01 22:30:00+00'::timestamptz at time zone 'Asia/Qatar')::date, '2001-01-02'::date, 'the Qatar operating date for 22:30 UTC is the next calendar day');
select is((select gross_invoice_dirham from public.report_daily_summary(pg_temp.s2(), '2001-01-02', '2001-01-02')), 700::bigint, 'an entry recorded between 00:00 and 03:00 Qatar time is reported under its business date');
select is((select count(*)::int from public.report_daily_summary(pg_temp.s2(), '2001-01-01', '2001-01-01')), 0, 'it is not reported under the UTC calendar date of its recorded timestamp');
set local role authenticated;
select pg_temp.act('owner');
select set_config('dc4.qatar_today', (now() at time zone 'Asia/Qatar')::date::text, true);
-- Whatever the session time zone says "today" is, the RPC uses the Qatar date.
set local timezone = 'Pacific/Kiritimati';
select throws_ok($$select public.close_business_date(pg_temp.cmd(jsonb_build_object('business_date', (current_setting('dc4.qatar_today')::date + 1)::text), pg_temp.s2()))$$, 'P0001', 'INVALID_DATE', 'the day after the Qatar date is a future date even where the session date is ahead');
set local timezone = 'Etc/GMT+12';
select lives_ok($$select public.close_business_date(pg_temp.cmd(jsonb_build_object('business_date', current_setting('dc4.qatar_today')), pg_temp.s2()))$$, 'the Qatar date can be closed even where the session date is behind');
select pg_temp.act('manager');
select throws_ok($$select public.reopen_business_date(pg_temp.cmd(jsonb_build_object('business_date', (current_setting('dc4.qatar_today')::date - 1)::text, 'reason', 'x')))$$, '42501', 'INSUFFICIENT_ROLE', 'a manager''s reopen limit is measured against the Qatar date');

select * from finish();
rollback;
