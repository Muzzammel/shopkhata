begin;
-- current_date below must be the Qatar operating date the RPCs enforce.
set local timezone = 'Asia/Qatar';
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Partial delivery, step 1 (20261112090000). The concurrent-delivery races need two sessions and live in
-- tests/integration/operations/partial-delivery.test.ts.

create function pg_temp.act(who text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', case who
    when 'owner' then '10000000-0000-4000-8000-000000000101' when 'staff' then '10000000-0000-4000-8000-000000000102'
    when 'staff2' then '10000000-0000-4000-8000-000000000103' when 'manager' then '10000000-0000-4000-8000-000000000104' end)::text, true)
$$;
create function pg_temp.s1() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.s2() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.c1() returns uuid language sql immutable as $$ select 'c8000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.inv(n int) returns uuid language sql immutable as $$ select ('a8000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.deliver(n int, pieces jsonb, key text, sid uuid default null) returns jsonb language sql as $$
  select public.record_invoice_delivery(jsonb_build_object('shop_id', coalesce(sid, pg_temp.s1()), 'invoice_id', pg_temp.inv(n), 'pieces', pieces, 'idempotency_key', key)) $$;
create function pg_temp.totals(n int) returns text language sql as $$
  select concat_ws('|', ordered_pieces, delivered_pieces, remaining_pieces, delivery_status) from public.invoice_delivery_totals where canonical_invoice_id = pg_temp.inv(n) $$;
create function pg_temp.delivered(n int) returns boolean language sql as $$
  select effective_delivered from public.effective_invoices where canonical_invoice_id = pg_temp.inv(n) $$;
-- submit_batch outcome as text: 'ok' or the error message plus its row-error detail.
create function pg_temp.batch(rows jsonb, key text) returns text language plpgsql as $$
declare d text;
begin
  perform public.submit_batch(jsonb_build_object('shop_id', pg_temp.s1(), 'business_date', current_date::text, 'idempotency_key', key, 'rows', rows));
  return 'ok';
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return sqlerrm || ' ' || coalesce(d, '');
end $$;

-- Fixtures (as the database owner) ---------------------------------------------------------------------------------
-- T1 customer, 10 pieces, unpaid | T2 no customer, unpaid | T3/T4 no customer, paid in full below | T5 customer, unpaid
-- V  voided below | L  legacy (ordered_pieces null, delivered) | S2 shop 2 | C  closed-date test
insert into public.customers(id, shop_id, public_id, name) values (pg_temp.c1(), pg_temp.s1(), 'CUS-PD-1', 'Partial delivery customer');
insert into public.invoices(id, shop_id, customer_id, invoice_id, total_amount_dirham, business_date, delivered, ordered_pieces, created_by) values
  (pg_temp.inv(1), pg_temp.s1(), pg_temp.c1(), 'PD-T1', 10000, current_date - 2, false, 10, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(2), pg_temp.s1(), null, 'PD-T2', 5000, current_date, false, 4, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(3), pg_temp.s1(), null, 'PD-T3', 5000, current_date, false, 4, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(4), pg_temp.s1(), null, 'PD-T4', 5000, current_date, false, 4, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(5), pg_temp.s1(), pg_temp.c1(), 'PD-T5', 5000, current_date, false, 4, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(6), pg_temp.s1(), null, 'PD-V', 5000, current_date, false, 3, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(7), pg_temp.s1(), pg_temp.c1(), 'PD-L', 3000, current_date, true, null, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(8), pg_temp.s2(), null, 'PD-S2', 2000, current_date, false, 5, '10000000-0000-4000-8000-000000000103'),
  (pg_temp.inv(9), pg_temp.s1(), pg_temp.c1(), 'PD-C', 4000, current_date, false, 5, '10000000-0000-4000-8000-000000000102');
insert into public.invoice_number_registry(shop_id, invoice_number, canonical_invoice_id) select shop_id, invoice_id, id from public.invoices where invoice_id like 'PD-%';

-- 1. Catalog and privileges ---------------------------------------------------------------------------------------
select has_column('public', 'invoices', 'ordered_pieces', 'invoices.ordered_pieces exists');
-- Data-independent: a nullable column added without a default (and no backfill update) leaves existing rows NULL.
select ok(not (select attnotnull or atthasdef from pg_attribute where attrelid = 'public.invoices'::regclass and attname = 'ordered_pieces'),
  'every pre-existing invoice stays legacy (ordered_pieces nullable, no default)');
select has_table('public', 'invoice_deliveries', 'delivery event table exists');
select has_view('public', 'invoice_delivery_totals', 'delivery totals view exists');
select has_function('public', 'record_invoice_delivery', array['jsonb'], 'delivery RPC exists');
select ok((select prosecdef from pg_proc where oid = 'public.record_invoice_delivery(jsonb)'::regprocedure), 'record_invoice_delivery is SECURITY DEFINER');
select ok(not has_function_privilege('anon', 'public.record_invoice_delivery(jsonb)', 'EXECUTE'), 'anon cannot execute record_invoice_delivery');
select ok(not has_table_privilege('authenticated', 'public.invoice_deliveries', 'INSERT') and not has_table_privilege('authenticated', 'public.invoice_deliveries', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.invoice_deliveries', 'DELETE'), 'no direct write grants on invoice_deliveries');
select ok(not has_table_privilege('anon', 'public.invoice_delivery_totals', 'SELECT'), 'anon cannot read delivery totals');
select ok((select relrowsecurity from pg_class where oid = 'public.invoice_deliveries'::regclass), 'RLS is enabled on invoice_deliveries');
select set_eq($$select tgname::text from pg_trigger where tgrelid = 'public.invoice_deliveries'::regclass and not tgisinternal$$,
  array['invoice_deliveries_append_only', 'invoice_deliveries_active_shop', 'invoice_deliveries_open_business_date', 'invoice_deliveries_invoice_not_void', 'invoice_deliveries_delivery_customer', 'invoice_deliveries_full_reversal'],
  'invoice_deliveries carries the append-only, active-shop, open-date, not-void, customer and full-reversal (20261112110000) guards');
select set_eq($$select tgrelid::regclass::text from pg_trigger where tgfoid = 'private.enforce_delivery_customer()'::regprocedure$$,
  array['invoice_deliveries', 'corrections', 'replacement_decisions'], 'customer guard on every write that can deliver, raise the due or drop the customer');
select ok(not has_function_privilege('authenticated', 'private.enforce_delivery_customer()', 'EXECUTE'), 'the customer guard is not callable through the Data API');
select is((select array_agg(attname::text order by attnum) from pg_attribute where attrelid = 'public.effective_invoices'::regclass and attnum > 0),
  array['canonical_invoice_id', 'shop_id', 'original_invoice_number', 'effective_invoice_number', 'effective_customer_id', 'effective_delivered', 'revision',
    'original_total_dirham', 'business_date', 'recorded_at', 'created_by', 'effective_total_dirham', 'effective_paid_dirham', 'effective_due_dirham',
    'effective_credit_applied_dirham', 'is_void', 'ordered_pieces', 'delivered_pieces', 'delivery_status'], 'effective_invoices keeps its columns and order (step 4 appends the delivery columns)');

-- 2. Legacy invoices ------------------------------------------------------------------------------------------------
select is(pg_temp.delivered(7), true, 'legacy invoice keeps its delivered flag');
select is((select count(*)::int from public.invoice_delivery_totals where canonical_invoice_id = pg_temp.inv(7)), 0, 'legacy invoice has no piece totals');
select is(pg_temp.delivered(1), false, 'tracked invoice with no deliveries is not delivered');
select is(pg_temp.totals(1), '10|0|10|none', 'tracked invoice starts at none');

-- 3. Authorization ----------------------------------------------------------------------------------------------------
set local role anon;
select throws_ok($$select pg_temp.deliver(1, '1', 'anon-1')$$, '42501', null, 'anon cannot record a delivery');
reset role;
set local role authenticated;
select pg_temp.act('staff2');
select throws_ok($$select pg_temp.deliver(1, '1', 's2-1')$$, '42501', 'UNAUTHORIZED_SHOP', 'a user of another shop gets UNAUTHORIZED_SHOP');
select pg_temp.act('staff');
select throws_ok($$select pg_temp.deliver(8, '1', 'st-s2', pg_temp.s2())$$, '42501', 'UNAUTHORIZED_SHOP', 'staff cannot deliver in an unassigned shop');
select throws_ok($$select pg_temp.deliver(8, '1', 'st-wrong-shop')$$, 'P0001', 'INVOICE_NOT_FOUND', 'an invoice of another shop is not found in the requested shop');
select throws_ok($$insert into public.invoice_deliveries(shop_id, invoice_id, pieces, business_date, created_by, idempotency_key, fingerprint)
  values (pg_temp.s1(), pg_temp.inv(1), 1, current_date, '10000000-0000-4000-8000-000000000102', 'x', 'x')$$, '42501', null, 'staff cannot insert a delivery row directly');

-- 4. Validation --------------------------------------------------------------------------------------------------------
select throws_ok($$select pg_temp.deliver(1, '0', 'v-0')$$, 'P0001', 'PIECES_INVALID', 'zero pieces blocked');
select throws_ok($$select pg_temp.deliver(1, '-2', 'v-neg')$$, 'P0001', 'PIECES_INVALID', 'negative pieces blocked');
select throws_ok($$select pg_temp.deliver(1, '2147483648', 'v-big')$$, 'P0001', 'PIECES_INVALID', 'pieces beyond integer range blocked');
select throws_ok($$select pg_temp.deliver(1, '1.5', 'v-frac')$$, 'P0001', 'INVALID_REQUEST', 'fractional pieces blocked');
select throws_ok($$select pg_temp.deliver(1, '"2"', 'v-str')$$, 'P0001', 'INVALID_REQUEST', 'pieces as a string blocked');
select throws_ok($$select public.record_invoice_delivery(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(1), 'idempotency_key', 'v-miss'))$$, 'P0001', 'INVALID_REQUEST', 'missing pieces blocked');
select throws_ok($$select public.record_invoice_delivery(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(1), 'pieces', 1, 'idempotency_key', 'v-date', 'business_date', current_date))$$, 'P0001', 'INVALID_REQUEST', 'the caller cannot choose the date');
select throws_ok($$select public.record_invoice_delivery(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(1), 'pieces', 1, 'idempotency_key', 'v-actor', 'actor', '10000000-0000-4000-8000-000000000101'))$$, 'P0001', 'INVALID_REQUEST', 'the caller cannot supply the actor');
select throws_ok($$select public.record_invoice_delivery(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', 'not-a-uuid', 'pieces', 1, 'idempotency_key', 'v-uuid'))$$, 'P0001', 'INVALID_REQUEST', 'invalid invoice id blocked');
select throws_ok($$select pg_temp.deliver(7, '1', 'v-legacy')$$, 'P0001', 'LEGACY_INVOICE', 'legacy invoices cannot receive piece deliveries');
select is((select count(*)::int from public.invoice_deliveries where invoice_id::text like 'a8000000-0000-4000-8000-%'), 0, 'rejected attempts write nothing');

-- 5. Record, replay, over-delivery --------------------------------------------------------------------------------------
select set_config('pd.first', pg_temp.deliver(1, '3', 'd1-a')::text, true);
select is(current_setting('pd.first')::jsonb - 'delivery_id', jsonb_build_object('ok', true, 'invoice_id', pg_temp.inv(1), 'pieces', 3, 'business_date', current_date),
  'staff records 3 pieces, dated today (Qatar)');
select is(pg_temp.totals(1), '10|3|7|partial', 'ordered 10, delivered 3, remaining 7, partial');
select is(pg_temp.delivered(1), true, 'effective_delivered is true once any piece is delivered');
select is((select row(pieces, business_date, created_by::text, batch_id is null)::text from public.invoice_deliveries where invoice_id = pg_temp.inv(1)),
  row(3, current_date, '10000000-0000-4000-8000-000000000102', true)::text, 'event stores pieces, business date and actor');
select is(pg_temp.deliver(1, '3', 'd1-a'), current_setting('pd.first')::jsonb, 'same key + same payload replays the original result');
select is((select count(*)::int from public.invoice_deliveries where invoice_id = pg_temp.inv(1)), 1, 'the replay wrote nothing');
select throws_ok($$select pg_temp.deliver(1, '4', 'd1-a')$$, 'P0001', 'IDEMPOTENCY_CONFLICT', 'same key + different pieces is a conflict');
select throws_ok($$select pg_temp.deliver(5, '3', 'd1-a')$$, 'P0001', 'IDEMPOTENCY_CONFLICT', 'same key + different invoice is a conflict');
select pg_temp.act('manager');
select throws_ok($$select pg_temp.deliver(1, '3', 'd1-a')$$, 'P0001', 'IDEMPOTENCY_CONFLICT', 'same key + different actor is a conflict');
select throws_ok($$select pg_temp.deliver(1, '8', 'd1-over')$$, 'P0001', 'OVER_DELIVERY', 'cannot deliver more than the remaining pieces');
select lives_ok($$select pg_temp.deliver(1, '7', 'd1-rest')$$, 'a second event delivers the remaining 7');
select is(pg_temp.totals(1), '10|10|0|full', 'fully delivered');
select throws_ok($$select pg_temp.deliver(1, '1', 'd1-more')$$, 'P0001', 'OVER_DELIVERY', 'nothing more after full delivery');
select is((select count(*)::int from public.invoice_deliveries where invoice_id = pg_temp.inv(1)), 2, 'two events on the original invoice');
select is((select effective_due_dirham from public.effective_invoices where canonical_invoice_id = pg_temp.inv(1)), 10000::bigint, 'deliveries never change money');
select is((select count(*)::int from public.audit_events where action = 'delivery.record' and entity_id = pg_temp.inv(1)::text), 2, 'one audit row per event, none for replays or refusals');

-- 6. Customer rule -------------------------------------------------------------------------------------------------------
select pg_temp.act('staff');
select throws_ok($$select pg_temp.deliver(2, '1', 'c-t2')$$, 'P0001', 'CUSTOMER_REQUIRED', 'no customer and money due: delivery refused');
select lives_ok($$select public.record_payment(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(3), 'amount_dirham', 5000, 'payment_method', 'cash', 'business_date', current_date, 'idempotency_key', 'c-pay-3'))$$, 'T3 paid in full');
select lives_ok($$select public.record_payment(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(4), 'amount_dirham', 5000, 'payment_method', 'cash', 'business_date', current_date, 'idempotency_key', 'c-pay-4'))$$, 'T4 paid in full');
select lives_ok($$select pg_temp.deliver(3, '2', 'c-t3')$$, 'fully paid without customer: delivery allowed');
select lives_ok($$select pg_temp.deliver(4, '1', 'c-t4')$$, 'fully paid without customer: delivery allowed (T4)');
select lives_ok($$select pg_temp.deliver(5, '1', 'c-t5')$$, 'customer present with money due: delivery allowed');
-- Bypass attempts after the delivery: raise the total, reduce a payment, drop the customer.
select lives_ok($$select public.request_invoice_correction(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(3), 'reason', 'Price was higher', 'idempotency_key', 'c-corr-3', 'payment_id', null, 'amount_delta_dirham', 1000))$$, 'total increase requested on T3');
select lives_ok($$select public.request_invoice_correction(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(4), 'reason', 'Payment was less', 'idempotency_key', 'c-corr-4',
  'payment_id', (select id from public.payments where invoice_id = pg_temp.inv(4)), 'amount_delta_dirham', -1000))$$, 'payment decrease requested on T4');
select lives_ok($$select public.request_invoice_replacement(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(5), 'reason', 'Wrong customer', 'idempotency_key', 'c-repl-5',
  'expected_revision', 0, 'invoice_number', 'PD-T5', 'customer_id', null, 'delivered', false))$$, 'customer removal requested on T5');
select pg_temp.act('owner');
select throws_ok($$select public.decide_invoice_correction(jsonb_build_object('shop_id', pg_temp.s1(), 'request_id', (select id from public.correction_requests where idempotency_key = 'c-corr-3'),
  'expected_revision', 0, 'decision', 'approved', 'reason', null, 'idempotency_key', 'c-dec-3'))$$, 'P0001', 'CUSTOMER_REQUIRED', 'approving a total increase on a delivered, customer-less invoice is refused');
select throws_ok($$select public.decide_invoice_correction(jsonb_build_object('shop_id', pg_temp.s1(), 'request_id', (select id from public.correction_requests where idempotency_key = 'c-corr-4'),
  'expected_revision', 0, 'decision', 'approved', 'reason', null, 'idempotency_key', 'c-dec-4'))$$, 'P0001', 'CUSTOMER_REQUIRED', 'approving a payment decrease on a delivered, customer-less invoice is refused');
select throws_ok($$select public.decide_invoice_replacement(jsonb_build_object('shop_id', pg_temp.s1(), 'request_id', (select id from public.replacement_requests where idempotency_key = 'c-repl-5'),
  'expected_revision', 0, 'decision', 'approved', 'reason', null, 'idempotency_key', 'c-dec-5'))$$, 'P0001', 'CUSTOMER_REQUIRED', 'approving a customer removal with delivered pieces and money due is refused (replacement sent delivered=false)');
select lives_ok($$select public.decide_invoice_replacement(jsonb_build_object('shop_id', pg_temp.s1(), 'request_id', (select id from public.replacement_requests where idempotency_key = 'c-repl-5'),
  'expected_revision', 0, 'decision', 'rejected', 'reason', null, 'idempotency_key', 'c-dec-5r'))$$, 'the request can still be rejected');
select lives_ok($$select public.decide_invoice_correction(jsonb_build_object('shop_id', pg_temp.s1(), 'request_id', (select id from public.correction_requests where idempotency_key = 'c-corr-3'),
  'expected_revision', 0, 'decision', 'rejected', 'reason', null, 'idempotency_key', 'c-dec-3r'))$$, 'T3 request rejected (no pending requests left for the close below)');
select lives_ok($$select public.decide_invoice_correction(jsonb_build_object('shop_id', pg_temp.s1(), 'request_id', (select id from public.correction_requests where idempotency_key = 'c-corr-4'),
  'expected_revision', 0, 'decision', 'rejected', 'reason', null, 'idempotency_key', 'c-dec-4r'))$$, 'T4 request rejected');
reset role;
select throws_ok($$insert into public.corrections(shop_id, invoice_id, amount_delta_dirham, reason, business_date, approved_by) values (pg_temp.s1(), pg_temp.inv(3), 100, 'x', current_date, '10000000-0000-4000-8000-000000000101')$$,
  'P0001', 'CUSTOMER_REQUIRED', 'a direct correction row as the database owner hits the same guard');
select is((select effective_due_dirham from public.effective_invoices where canonical_invoice_id = pg_temp.inv(3)), 0::bigint, 'T3 money unchanged');
-- Legacy behaviour is untouched: a legacy delivered invoice is governed only by the existing RPC checks.
select lives_ok($$insert into public.corrections(shop_id, invoice_id, amount_delta_dirham, reason, business_date, approved_by) values (pg_temp.s1(), pg_temp.inv(7), 100, 'legacy fixture', current_date, '10000000-0000-4000-8000-000000000101')$$,
  'the guard ignores legacy invoices');

-- 7. Voided invoice ------------------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act('manager');
select lives_ok($$select public.void_invoice(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(6), 'reason', 'Customer cancelled the order', 'idempotency_key', 'vd-6'))$$, 'PD-V voided');
select pg_temp.act('staff');
select throws_ok($$select pg_temp.deliver(6, '1', 'vd-6-d')$$, 'P0001', 'INVOICE_VOID', 'voided invoice cannot receive deliveries');
reset role;
select throws_ok($$insert into public.invoice_deliveries(shop_id, invoice_id, pieces, business_date, created_by, idempotency_key, fingerprint)
  values (pg_temp.s1(), pg_temp.inv(6), 1, current_date, '10000000-0000-4000-8000-000000000102', 'vd-direct', 'x')$$, 'P0001', 'INVOICE_VOID', 'a direct delivery row on a voided invoice is blocked');

-- 8. Append-only history -----------------------------------------------------------------------------------------------
select throws_ok($$update public.invoice_deliveries set pieces = 1 where invoice_id = pg_temp.inv(1)$$, '55000', null, 'delivery UPDATE rejected');
select throws_ok($$delete from public.invoice_deliveries where invoice_id = pg_temp.inv(1)$$, '55000', null, 'delivery DELETE rejected');
select throws_ok($$insert into public.invoice_deliveries(shop_id, invoice_id, pieces, business_date, created_by, idempotency_key, fingerprint)
  values (pg_temp.s1(), pg_temp.inv(9), 0, current_date, '10000000-0000-4000-8000-000000000102', 'zero', 'x')$$, '23514', null, 'zero-piece rows are impossible');
select throws_ok($$insert into public.invoices(shop_id, invoice_id, total_amount_dirham, business_date, ordered_pieces) values (pg_temp.s1(), 'PD-ZERO', 100, current_date, 0)$$,
  '23514', null, 'ordered_pieces must be at least 1');

-- 9. submit_batch -------------------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act('staff');
select is(pg_temp.batch(jsonb_build_array(jsonb_build_object('row_id', 'b1', 'invoice_number', 'PD-B1', 'total_dirham', 6000, 'received_dirham', 1000, 'payment_method', 'cash',
  'ordered_pieces', 5, 'delivered_pieces', 2, 'customer', jsonb_build_object('type', 'quick_add', 'name', 'Batch delivery customer')),
  jsonb_build_object('row_id', 'b2', 'invoice_number', 'PD-B2', 'total_dirham', 3000, 'ordered_pieces', 4, 'delivered_pieces', 0),
  jsonb_build_object('row_id', 'b3', 'invoice_number', 'PD-B3', 'total_dirham', 3000, 'received_dirham', 3000, 'payment_method', 'bank', 'ordered_pieces', 2, 'delivered_pieces', 2),
  jsonb_build_object('row_id', 'b4', 'invoice_number', 'PD-B4', 'total_dirham', 2000, 'delivered', true, 'customer', jsonb_build_object('type', 'quick_add', 'name', 'Legacy row'))), 'pd-batch-1'),
  'ok', 'a batch mixing tracked and legacy rows is accepted');
create temp table b as select i.invoice_id as number, i.id, i.ordered_pieces, i.delivered, i.batch_id from public.invoices i where i.invoice_id like 'PD-B%';
select is((select concat_ws('|', (select ordered_pieces from b where number = 'PD-B1'), (select delivered from b where number = 'PD-B1')::text)), '5|true', 'B1 stores ordered pieces; delivered flag derived from pieces');
select is((select concat_ws('|', ordered_pieces, delivered_pieces, remaining_pieces, delivery_status) from public.invoice_delivery_totals where canonical_invoice_id = (select id from b where number = 'PD-B1')),
  '5|2|3|partial', 'B1: initial delivery of 2 of 5');
select is((select row(d.pieces, d.business_date, d.batch_id = b.batch_id, d.idempotency_key is null)::text from public.invoice_deliveries d join b on b.id = d.invoice_id where b.number = 'PD-B1'),
  row(2, current_date, true, true)::text, 'B1 initial delivery is an event of the sale''s batch');
select is((select concat_ws('|', delivery_status, (select delivered from b where number = 'PD-B2')::text) from public.invoice_delivery_totals where canonical_invoice_id = (select id from b where number = 'PD-B2')),
  'none|false', 'B2: nothing delivered, no event row');
select is((select count(*)::int from public.invoice_deliveries where invoice_id = (select id from b where number = 'PD-B2')), 0, 'B2 has no event');
select is((select delivery_status from public.invoice_delivery_totals where canonical_invoice_id = (select id from b where number = 'PD-B3')), 'full', 'B3: paid in full, delivered in full, no customer needed');
select is((select concat_ws('|', coalesce(ordered_pieces::text, 'null'), delivered::text) from b where number = 'PD-B4'), 'null|true', 'B4: a row without piece keys stays legacy');
select is((select count(*)::int from public.invoice_deliveries where invoice_id = (select id from b where number = 'PD-B4')), 0, 'B4 has no events');
select is(pg_temp.batch(jsonb_build_array(jsonb_build_object('row_id', 'b1', 'invoice_number', 'PD-B1', 'total_dirham', 6000, 'received_dirham', 1000, 'payment_method', 'cash',
  'ordered_pieces', 5, 'delivered_pieces', 2, 'customer', jsonb_build_object('type', 'quick_add', 'name', 'Batch delivery customer')),
  jsonb_build_object('row_id', 'b2', 'invoice_number', 'PD-B2', 'total_dirham', 3000, 'ordered_pieces', 4, 'delivered_pieces', 0),
  jsonb_build_object('row_id', 'b3', 'invoice_number', 'PD-B3', 'total_dirham', 3000, 'received_dirham', 3000, 'payment_method', 'bank', 'ordered_pieces', 2, 'delivered_pieces', 2),
  jsonb_build_object('row_id', 'b4', 'invoice_number', 'PD-B4', 'total_dirham', 2000, 'delivered', true, 'customer', jsonb_build_object('type', 'quick_add', 'name', 'Legacy row'))), 'pd-batch-1'),
  'ok', 'exact batch replay is accepted');
select is((select count(*)::int from public.invoice_deliveries d join b on b.id = d.invoice_id), 2, 'the replay wrote no second initial delivery');
select alike(pg_temp.batch(jsonb_build_array(jsonb_build_object('row_id', 'b1', 'invoice_number', 'PD-B1', 'total_dirham', 6000, 'received_dirham', 1000, 'payment_method', 'cash',
  'ordered_pieces', 5, 'delivered_pieces', 3, 'customer', jsonb_build_object('type', 'quick_add', 'name', 'Batch delivery customer')),
  jsonb_build_object('row_id', 'b2', 'invoice_number', 'PD-B2', 'total_dirham', 3000, 'ordered_pieces', 4, 'delivered_pieces', 0),
  jsonb_build_object('row_id', 'b3', 'invoice_number', 'PD-B3', 'total_dirham', 3000, 'received_dirham', 3000, 'payment_method', 'bank', 'ordered_pieces', 2, 'delivered_pieces', 2),
  jsonb_build_object('row_id', 'b4', 'invoice_number', 'PD-B4', 'total_dirham', 2000, 'delivered', true, 'customer', jsonb_build_object('type', 'quick_add', 'name', 'Legacy row'))), 'pd-batch-1'),
  'IDEMPOTENCY_CONFLICT%', 'same key with different delivered pieces is a conflict');
-- Row validation
select alike(pg_temp.batch(jsonb_build_array(jsonb_build_object('row_id', 'x', 'invoice_number', 'PD-X1', 'total_dirham', 3000, 'ordered_pieces', 3, 'delivered_pieces', 1)), 'pd-x1'),
  '%CUSTOMER_REQUIRED%', 'pieces delivered with money due and no customer: refused');
select alike(pg_temp.batch(jsonb_build_array(jsonb_build_object('row_id', 'x', 'invoice_number', 'PD-X2', 'total_dirham', 3000, 'ordered_pieces', 3, 'delivered_pieces', 4)), 'pd-x2'),
  '%PIECES_INVALID%', 'delivered more than ordered: refused');
select alike(pg_temp.batch(jsonb_build_array(jsonb_build_object('row_id', 'x', 'invoice_number', 'PD-X3', 'total_dirham', 3000, 'ordered_pieces', 3)), 'pd-x3'),
  '%PIECES_INVALID%', 'ordered without delivered: refused');
select alike(pg_temp.batch(jsonb_build_array(jsonb_build_object('row_id', 'x', 'invoice_number', 'PD-X4', 'total_dirham', 3000, 'delivered_pieces', 0)), 'pd-x4'),
  '%PIECES_INVALID%', 'delivered without ordered: refused');
select alike(pg_temp.batch(jsonb_build_array(jsonb_build_object('row_id', 'x', 'invoice_number', 'PD-X5', 'total_dirham', 3000, 'ordered_pieces', 0, 'delivered_pieces', 0)), 'pd-x5'),
  '%PIECES_INVALID%', 'zero ordered: refused');
select alike(pg_temp.batch(jsonb_build_array(jsonb_build_object('row_id', 'x', 'invoice_number', 'PD-X6', 'total_dirham', 3000, 'ordered_pieces', 2.5, 'delivered_pieces', 0)), 'pd-x6'),
  '%PIECES_INVALID%', 'fractional ordered: refused');
select alike(pg_temp.batch(jsonb_build_array(jsonb_build_object('row_id', 'x', 'invoice_number', 'PD-X7', 'total_dirham', 3000, 'ordered_pieces', '3', 'delivered_pieces', 0)), 'pd-x7'),
  '%PIECES_INVALID%', 'ordered as a string: refused');
select alike(pg_temp.batch(jsonb_build_array(jsonb_build_object('row_id', 'x', 'invoice_number', 'PD-X8', 'total_dirham', 3000, 'ordered_pieces', 3, 'delivered_pieces', 0, 'delivered', true)), 'pd-x8'),
  '%REQUEST_INVALID%', 'delivered flag contradicting the pieces: refused');
select is((select count(*)::int from public.invoices where invoice_id like 'PD-X%'), 0, 'refused batches wrote nothing');
-- Fingerprint compatibility: a row without piece keys canonicalises exactly as before this migration.
select is(private.canonical_batch_command(pg_temp.s1(), current_date, false, null, jsonb_build_array(jsonb_build_object('row_id', 'r', 'invoice_number', 'N', 'total_dirham', 1))) -> 'rows' -> 0,
  jsonb_build_object('row_id', 'r', 'invoice_number', 'N', 'total_dirham', 1, 'received_dirham', 0, 'payment_method', 'cash', 'delivered', false, 'note', null,
    'customer_type', null, 'customer_id', null, 'customer_name', null, 'customer_mobile', null), 'legacy rows keep the pre-migration canonical form (offline drafts replay)');

-- 10. RLS -------------------------------------------------------------------------------------------------------------
select pg_temp.act('staff2');
select is((select count(*)::int from public.invoice_deliveries where shop_id = pg_temp.s1()), 0, 'another shop cannot read the delivery history');
select is((select count(*)::int from public.invoice_delivery_totals where shop_id = pg_temp.s1()), 0, 'nor the delivery totals');
select pg_temp.act('staff');
select ok((select count(*)::int from public.invoice_deliveries where shop_id = pg_temp.s1()) > 0, 'same-shop staff can read the delivery history');

-- 11. Inactive shop ---------------------------------------------------------------------------------------------------
reset role;
update public.shops set is_active = false where id = pg_temp.s1();
set local role authenticated;
select pg_temp.act('owner');
select throws_ok($$select pg_temp.deliver(9, '1', 'in-9')$$, 'P0001', 'SHOP_INACTIVE', 'inactive shop blocked');
reset role;
update public.shops set is_active = true where id = pg_temp.s1();

-- 12. Today closed (last: closing today blocks every later write) ------------------------------------------------------
set local role authenticated;
select pg_temp.act('manager');
select lives_ok($$select public.close_business_date(jsonb_build_object('shop_id', pg_temp.s1(), 'business_date', current_date::text))$$, 'today closed');
select pg_temp.act('staff');
select throws_ok($$select pg_temp.deliver(9, '1', 'cl-9')$$, 'P0001', 'CLOSED_DATE', 'a closed date cannot receive delivery events');
select is((select count(*)::int from public.invoice_deliveries where invoice_id = pg_temp.inv(9)), 0, 'nothing written on a closed day');
select is(pg_temp.deliver(1, '3', 'd1-a'), current_setting('pd.first')::jsonb, 'an exact retry of an earlier delivery still returns its result after today closes');

select * from finish();
rollback;
