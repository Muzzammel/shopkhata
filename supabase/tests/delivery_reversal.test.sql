begin;
-- current_date below must be the Qatar operating date the RPCs enforce.
set local timezone = 'Asia/Qatar';
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Partial delivery, step 6A (20261112110000): delivery reversals. Two-session races live in
-- tests/integration/operations/partial-delivery.test.ts. Every figure is scoped to this file's own rows.

create function pg_temp.act(who text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', case who
    when 'owner' then '10000000-0000-4000-8000-000000000101' when 'staff' then '10000000-0000-4000-8000-000000000102'
    when 'staff2' then '10000000-0000-4000-8000-000000000103' when 'manager' then '10000000-0000-4000-8000-000000000104' end)::text, true)
$$;
create function pg_temp.s1() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.s2() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.c1() returns uuid language sql immutable as $$ select 'c9000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.inv(n int) returns uuid language sql immutable as $$ select ('a9000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.del(n int) returns uuid language sql immutable as $$ select ('d9000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.reverse(i int, d int, why text, key text, sid uuid default null) returns jsonb language sql as $$
  select public.reverse_invoice_delivery(jsonb_build_object('shop_id', coalesce(sid, pg_temp.s1()), 'invoice_id', pg_temp.inv(i), 'delivery_id', pg_temp.del(d), 'reason', why, 'idempotency_key', key)) $$;
create function pg_temp.deliver(n int, pieces int, key text) returns jsonb language sql as $$
  select public.record_invoice_delivery(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(n), 'pieces', pieces, 'idempotency_key', key)) $$;
create function pg_temp.totals(n int) returns text language sql as $$
  select concat_ws('|', ordered_pieces, delivered_pieces, remaining_pieces, delivery_status) from public.invoice_delivery_totals where canonical_invoice_id = pg_temp.inv(n) $$;
create function pg_temp.eff(n int) returns text language sql as $$
  select concat_ws('|', effective_delivered, delivered_pieces, delivery_status) from public.effective_invoices where canonical_invoice_id = pg_temp.inv(n) $$;
-- Everything financial this file's rows could move: invoice money, customer balance, and the money ledgers' row counts.
create function pg_temp.money() returns jsonb language sql as $$
  select jsonb_build_object(
    'invoices', (select jsonb_agg(jsonb_build_array(canonical_invoice_id, original_total_dirham, effective_total_dirham, effective_paid_dirham, effective_due_dirham, effective_credit_applied_dirham, is_void) order by canonical_invoice_id)
      from public.effective_invoices where shop_id = pg_temp.s1() and canonical_invoice_id::text like 'a9000000-0000-4000-8000-%'),
    'balance', (select to_jsonb(b) from public.customer_financial_balances b where b.customer_id = pg_temp.c1()),
    'payments', (select count(*) from public.payments where invoice_id::text like 'a9000000-0000-4000-8000-%'),
    'corrections', (select count(*) from public.corrections where invoice_id::text like 'a9000000-0000-4000-8000-%'),
    'ledger', (select count(*) from public.customer_ledger where customer_id = pg_temp.c1()),
    'movements', (select count(*) from public.sales_movements where shop_id = pg_temp.s1() and invoice_id::text like 'a9000000-0000-4000-8000-%')) $$;

-- Fixtures (as the database owner) ---------------------------------------------------------------------------------
-- R1 10 pieces: 6 delivered on OLD (then closed), 4 today | R2 5 pieces, 5 delivered today | V delivered, voided below
-- L legacy | S2 shop 2 | N no customer, unpaid | OLD = 400 days ago: far from any other row of this database.
insert into public.customers(id, shop_id, public_id, name) values (pg_temp.c1(), pg_temp.s1(), 'CUS-DR-1', 'Delivery reversal customer');
insert into public.invoices(id, shop_id, customer_id, invoice_id, total_amount_dirham, business_date, delivered, ordered_pieces, created_by) values
  (pg_temp.inv(1), pg_temp.s1(), pg_temp.c1(), 'DR-R1', 10000, current_date - 400, false, 10, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(2), pg_temp.s1(), pg_temp.c1(), 'DR-R2', 5000, current_date, false, 5, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(3), pg_temp.s1(), pg_temp.c1(), 'DR-V', 5000, current_date, false, 3, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(4), pg_temp.s1(), pg_temp.c1(), 'DR-L', 3000, current_date, true, null, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(5), pg_temp.s2(), null, 'DR-S2', 2000, current_date, false, 5, '10000000-0000-4000-8000-000000000103'),
  (pg_temp.inv(6), pg_temp.s1(), null, 'DR-N', 4000, current_date, false, 5, '10000000-0000-4000-8000-000000000102');
insert into public.invoice_number_registry(shop_id, invoice_number, canonical_invoice_id) select shop_id, invoice_id, id from public.invoices where invoice_id like 'DR-%';
insert into public.invoice_deliveries(id, shop_id, invoice_id, pieces, business_date, created_by, idempotency_key, fingerprint) values
  (pg_temp.del(1), pg_temp.s1(), pg_temp.inv(1), 6, current_date - 400, '10000000-0000-4000-8000-000000000102', 'dr-fix-1', 'x'),
  (pg_temp.del(2), pg_temp.s1(), pg_temp.inv(1), 4, current_date, '10000000-0000-4000-8000-000000000102', 'dr-fix-2', 'x'),
  (pg_temp.del(3), pg_temp.s1(), pg_temp.inv(2), 5, current_date, '10000000-0000-4000-8000-000000000102', 'dr-fix-3', 'x'),
  (pg_temp.del(4), pg_temp.s1(), pg_temp.inv(3), 2, current_date, '10000000-0000-4000-8000-000000000102', 'dr-fix-4', 'x');
insert into public.daily_closes(shop_id, business_date, event_type, actor_id) values (pg_temp.s1(), current_date - 400, 'closed', '10000000-0000-4000-8000-000000000101');
create temp table before_reversal as select pg_temp.money() m, (select to_jsonb(d) from public.invoice_deliveries d where d.id = pg_temp.del(1)) d1;
grant select on before_reversal to public;

-- 1. Catalog and privileges ---------------------------------------------------------------------------------------
select has_column('public', 'invoice_deliveries', 'reverses_delivery_id', 'reversal link column exists');
select has_column('public', 'invoice_deliveries', 'reason', 'reversal reason column exists');
select has_function('public', 'reverse_invoice_delivery', array['jsonb'], 'reversal RPC exists');
select ok(not has_function_privilege('anon', 'public.reverse_invoice_delivery(jsonb)', 'EXECUTE'), 'anon cannot execute the reversal RPC');
select ok(has_function_privilege('authenticated', 'public.reverse_invoice_delivery(jsonb)', 'EXECUTE'), 'authenticated can execute the reversal RPC');
select ok(not has_function_privilege('authenticated', 'private.enforce_delivery_reversal()', 'EXECUTE'), 'the reversal guard is not callable through the Data API');
select ok(not has_table_privilege('authenticated', 'public.invoice_deliveries', 'INSERT') and not has_table_privilege('authenticated', 'public.invoice_deliveries', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.invoice_deliveries', 'DELETE'), 'authenticated still cannot write delivery events directly');
select ok(exists(select 1 from pg_trigger where tgrelid = 'public.invoice_deliveries'::regclass and tgname = 'invoice_deliveries_append_only'), 'delivery events stay append-only');
select ok(exists(select 1 from pg_trigger where tgrelid = 'public.invoice_deliveries'::regclass and tgname = 'invoice_deliveries_delivery_customer'), 'the customer rule guard still covers delivery events');
select is(pg_temp.totals(1), '10|10|0|full', 'R1 starts fully delivered (6 + 4)');

-- 2. Authorization ------------------------------------------------------------------------------------------------
set local role anon;
select throws_ok($$select pg_temp.reverse(1, 1, 'Wrong invoice was delivered', 'anon-1')$$, '42501', null, 'anon cannot reverse a delivery');
reset role;
set local role authenticated;
select pg_temp.act('staff');
select throws_ok($$select pg_temp.reverse(1, 1, 'Wrong invoice was delivered', 'st-1')$$, '42501', 'INSUFFICIENT_ROLE', 'staff cannot reverse a delivery');
select pg_temp.act('staff2');
select throws_ok($$select pg_temp.reverse(1, 1, 'Wrong invoice was delivered', 's2-1')$$, '42501', 'UNAUTHORIZED_SHOP', 'a user of another shop gets UNAUTHORIZED_SHOP');
select pg_temp.act('manager');
select throws_ok($$select pg_temp.reverse(5, 5, 'Wrong invoice was delivered', 'm-s2', pg_temp.s2())$$, '42501', 'UNAUTHORIZED_SHOP', 'a manager cannot reverse in an unassigned shop');
select throws_ok($$select pg_temp.reverse(5, 5, 'Wrong invoice was delivered', 'm-wrong-shop')$$, 'P0001', 'INVOICE_NOT_FOUND', 'an invoice of another shop is not found in the requested shop');

-- 3. Validation ---------------------------------------------------------------------------------------------------
select throws_ok($$select public.reverse_invoice_delivery(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(1), 'delivery_id', pg_temp.del(1), 'idempotency_key', 'v-miss'))$$, 'P0001', 'INVALID_REQUEST', 'a missing reason is blocked');
select throws_ok($$select pg_temp.reverse(1, 1, E' \t\n ', 'v-blank')$$, 'P0001', 'REASON_REQUIRED', 'a blank reason is blocked');
select throws_ok($$select pg_temp.reverse(1, 1, 'too short', 'v-short')$$, 'P0001', 'REASON_TOO_SHORT', 'a reason under 10 characters is blocked');
select throws_ok($$select pg_temp.reverse(1, 1, repeat('x', 2001), 'v-long')$$, 'P0001', 'INVALID_REQUEST', 'a reason over 2000 characters is blocked');
select throws_ok($$select public.reverse_invoice_delivery(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(1), 'delivery_id', 'not-a-uuid', 'reason', 'Wrong invoice was delivered', 'idempotency_key', 'v-uuid'))$$, 'P0001', 'INVALID_REQUEST', 'an invalid delivery id is blocked');
select throws_ok($$select public.reverse_invoice_delivery(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(1), 'delivery_id', pg_temp.del(1), 'reason', 'Wrong invoice was delivered', 'idempotency_key', 'v-pieces', 'pieces', 3))$$, 'P0001', 'INVALID_REQUEST', 'the caller cannot choose the pieces (full reversal only)');
select throws_ok($$select public.reverse_invoice_delivery(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(1), 'delivery_id', pg_temp.del(1), 'reason', 'Wrong invoice was delivered', 'idempotency_key', 'v-date', 'business_date', current_date - 400))$$, 'P0001', 'INVALID_REQUEST', 'the caller cannot choose the date');
select throws_ok($$select pg_temp.reverse(1, 99, 'Wrong invoice was delivered', 'v-unknown')$$, 'P0001', 'DELIVERY_NOT_FOUND', 'an unknown delivery is not found');
select throws_ok($$select pg_temp.reverse(1, 3, 'Wrong invoice was delivered', 'v-other')$$, 'P0001', 'DELIVERY_NOT_FOUND', 'a delivery of another invoice is not found');
select throws_ok($$select pg_temp.reverse(4, 1, 'Wrong invoice was delivered', 'v-legacy')$$, 'P0001', 'LEGACY_INVOICE', 'legacy invoices have nothing to reverse');
select is((select count(*)::int from public.invoice_deliveries where invoice_id::text like 'a9000000-0000-4000-8000-%' and reverses_delivery_id is not null), 0, 'rejected attempts write nothing');

-- 4. Reversal of a delivery from a closed date: posted today ----------------------------------------------------------
select lives_ok($$select set_config('dr.first', pg_temp.reverse(1, 1, E'  Delivered to the wrong customer \n', 'r1-a')::text, true)$$, 'manager reverses the 6-piece delivery of the closed date');
select is(current_setting('dr.first')::jsonb ->> 'pieces', '6', 'the result reports the 6 reversed pieces');
select is((current_setting('dr.first')::jsonb ->> 'business_date')::date, current_date, 'the reversal is posted on today''s Qatar date');
select is((select concat_ws('|', pieces, business_date, reason, created_by) from public.invoice_deliveries where reverses_delivery_id = pg_temp.del(1)),
  concat_ws('|', -6, current_date, 'Delivered to the wrong customer', '10000000-0000-4000-8000-000000000104'), 'the reversal is a new event: -6, today, trimmed reason, the manager');
select is((select to_jsonb(d) from public.invoice_deliveries d where d.id = pg_temp.del(1)), (select d1 from before_reversal), 'the original delivery event is byte-for-byte unchanged');
select is((select count(*)::int from public.invoice_deliveries where invoice_id = pg_temp.inv(1) and business_date = current_date - 400), 1, 'nothing new is dated on the closed day');
select is(pg_temp.totals(1), '10|4|6|partial', 'totals use net delivered pieces: 10 - 6 = 4, partial');
select is(pg_temp.eff(1), 't|4|partial', 'effective_invoices reads the same net figures');
select is((select count(*)::int from public.audit_events where action = 'delivery.reverse' and entity_id = pg_temp.inv(1)::text and reason = 'Delivered to the wrong customer'
  and metadata ->> 'delivery_id' = pg_temp.del(1)::text and metadata ->> 'delivered_before' = '10' and metadata ->> 'delivered_after' = '4'), 1, 'one audit event with reason, original delivery and before/after');

-- 5. Idempotency and once-only ----------------------------------------------------------------------------------------
select is(pg_temp.reverse(1, 1, E'  Delivered to the wrong customer \n', 'r1-a'), current_setting('dr.first')::jsonb, 'an exact retry returns the original result');
select is((select count(*)::int from public.invoice_deliveries where reverses_delivery_id = pg_temp.del(1)), 1, 'the retry wrote nothing');
select throws_ok($$select pg_temp.reverse(1, 1, 'A different reason this time', 'r1-a')$$, 'P0001', 'IDEMPOTENCY_CONFLICT', 'same key with another command conflicts');
select throws_ok($$select pg_temp.reverse(1, 2, 'Delivered to the wrong customer', 'dr-fix-2')$$, 'P0001', 'IDEMPOTENCY_CONFLICT', 'a key already used by a delivery cannot carry a reversal');
select throws_ok($$select pg_temp.reverse(1, 1, 'Delivered to the wrong customer', 'r1-b')$$, 'P0001', 'ALREADY_REVERSED', 'a delivery is reversed only once');
select pg_temp.act('owner');
select throws_ok($$select public.reverse_invoice_delivery(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(1), 'delivery_id',
  (select id from public.invoice_deliveries where reverses_delivery_id = pg_temp.del(1)), 'reason', 'Undo the reversal please', 'idempotency_key', 'r1-undo'))$$, 'P0001', 'NOT_A_DELIVERY', 'a reversal cannot itself be reversed');

-- 6. Down to zero, then ordinary delivery again ------------------------------------------------------------------------
select lives_ok($$select pg_temp.reverse(1, 2, 'Second lot also went to the wrong shop', 'r1-c')$$, 'owner reverses the remaining 4-piece delivery');
select is(pg_temp.totals(1), '10|0|10|none', 'net delivered is 0, never negative');
select is(pg_temp.eff(1), 'f|0|none', 'the invoice reads as not delivered');
select pg_temp.act('staff');
select lives_ok($$select pg_temp.deliver(1, 10, 'r1-redeliver')$$, 'ordinary delivery recording still works after reversals (staff)');
select is(pg_temp.totals(1), '10|10|0|full', 'the corrected delivery brings the invoice back to full');
select throws_ok($$select pg_temp.deliver(1, 1, 'r1-over')$$, 'P0001', 'OVER_DELIVERY', 'over-delivery is still refused against the net total');
select throws_ok($$select pg_temp.deliver(6, 1, 'n-1')$$, 'P0001', 'CUSTOMER_REQUIRED', 'the customer rule still applies to deliveries');
select ok((select min(s) >= 0 from (select sum(pieces) s from public.invoice_deliveries where invoice_id::text like 'a9000000-0000-4000-8000-%' group by invoice_id) x), 'no invoice has a negative net delivered total');

-- 7. Table guards, whichever function writes the row (as the database owner) -------------------------------------------
reset role;
select throws_ok($$insert into public.invoice_deliveries(shop_id, invoice_id, pieces, business_date, created_by, idempotency_key, fingerprint, reverses_delivery_id, reason)
  values (pg_temp.s1(), pg_temp.inv(2), -3, current_date, '10000000-0000-4000-8000-000000000101', 'g-partial', 'x', pg_temp.del(3), 'Partial reversal attempt')$$, 'P0001', 'REVERSAL_INVALID', 'a partial reversal is refused by the table');
select throws_ok($$insert into public.invoice_deliveries(shop_id, invoice_id, pieces, business_date, created_by, idempotency_key, fingerprint, reverses_delivery_id, reason)
  values (pg_temp.s1(), pg_temp.inv(1), -6, current_date, '10000000-0000-4000-8000-000000000101', 'g-twice', 'x', pg_temp.del(1), 'Second reversal attempt')$$, '23505', null, 'a second reversal of one delivery is refused by the table');
select throws_ok($$insert into public.invoice_deliveries(shop_id, invoice_id, pieces, business_date, created_by, idempotency_key, fingerprint, reverses_delivery_id, reason)
  values (pg_temp.s1(), pg_temp.inv(1), -5, current_date, '10000000-0000-4000-8000-000000000101', 'g-cross', 'x', pg_temp.del(3), 'Cross invoice reversal')$$, '23503', null, 'a reversal cannot point at a delivery of another invoice');
select throws_ok($$insert into public.invoice_deliveries(shop_id, invoice_id, pieces, business_date, created_by, idempotency_key, fingerprint, reverses_delivery_id)
  values (pg_temp.s1(), pg_temp.inv(2), -5, current_date, '10000000-0000-4000-8000-000000000101', 'g-noreason', 'x', pg_temp.del(3))$$, '23514', null, 'a reversal without a reason is refused by the table');
select throws_ok($$insert into public.invoice_deliveries(shop_id, invoice_id, pieces, business_date, created_by, idempotency_key, fingerprint)
  values (pg_temp.s1(), pg_temp.inv(2), -1, current_date, '10000000-0000-4000-8000-000000000101', 'g-neg', 'x')$$, '23514', null, 'negative pieces without a reversed delivery are refused by the table');
select throws_ok($$update public.invoice_deliveries set pieces = 1 where id = pg_temp.del(1)$$, null, null, 'delivery events cannot be updated');

-- 8. Void and money ---------------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act('manager');
select is(pg_temp.money(), (select m from before_reversal), 'invoice money, customer balance, payments, corrections, ledger and sales movements are unchanged by reversals');
select lives_ok($$select public.void_invoice(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(3), 'reason', 'Customer cancelled the order', 'idempotency_key', 'dr-void-3'))$$, 'DR-V voided');
select throws_ok($$select pg_temp.reverse(3, 4, 'Wrong invoice was delivered', 'v-void')$$, 'P0001', 'INVOICE_VOID', 'deliveries of a void invoice cannot be reversed');

-- 9. Today closed (last: closing today blocks every later write) --------------------------------------------------------
select lives_ok($$select public.close_business_date(jsonb_build_object('shop_id', pg_temp.s1(), 'business_date', current_date::text))$$, 'today closed');
select throws_ok($$select pg_temp.reverse(2, 3, 'Wrong invoice was delivered', 'cl-2')$$, 'P0001', 'CLOSED_DATE', 'no reversal can be posted while today is closed');
select is((select count(*)::int from public.invoice_deliveries where reverses_delivery_id = pg_temp.del(3)), 0, 'nothing written on a closed day');
select is(pg_temp.reverse(1, 1, E'  Delivered to the wrong customer \n', 'r1-a'), current_setting('dr.first')::jsonb, 'an exact retry still returns its result after today closes');

select * from finish();
rollback;
