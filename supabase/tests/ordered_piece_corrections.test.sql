begin;
-- current_date below must be the Qatar operating date the RPCs enforce.
set local timezone = 'Asia/Qatar';
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Partial delivery, step 6B (20261112120000): ordered-piece corrections. Two-session races live in
-- tests/integration/operations/partial-delivery.test.ts. Every figure is scoped to this file's own rows.

create function pg_temp.act(who text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', case who
    when 'owner' then '10000000-0000-4000-8000-000000000101' when 'staff' then '10000000-0000-4000-8000-000000000102'
    when 'staff2' then '10000000-0000-4000-8000-000000000103' when 'manager' then '10000000-0000-4000-8000-000000000104' end)::text, true)
$$;
create function pg_temp.s1() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.s2() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.c1() returns uuid language sql immutable as $$ select 'c8000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.inv(n int) returns uuid language sql immutable as $$ select ('a8000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.del(n int) returns uuid language sql immutable as $$ select ('d8000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.fix(i int, expected int, pieces int, why text, key text, sid uuid default null) returns jsonb language sql as $$
  select public.correct_invoice_ordered_pieces(jsonb_build_object('shop_id', coalesce(sid, pg_temp.s1()), 'invoice_id', pg_temp.inv(i),
    'expected_ordered_pieces', expected, 'ordered_pieces', pieces, 'reason', why, 'idempotency_key', key)) $$;
create function pg_temp.deliver(n int, pieces int, key text) returns jsonb language sql as $$
  select public.record_invoice_delivery(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(n), 'pieces', pieces, 'idempotency_key', key)) $$;
create function pg_temp.totals(n int) returns text language sql as $$
  select concat_ws('|', ordered_pieces, delivered_pieces, remaining_pieces, delivery_status, original_ordered_pieces) from public.invoice_delivery_totals where canonical_invoice_id = pg_temp.inv(n) $$;
create function pg_temp.eff(n int) returns text language sql as $$
  select concat_ws('|', effective_delivered, ordered_pieces, delivered_pieces, delivery_status) from public.effective_invoices where canonical_invoice_id = pg_temp.inv(n) $$;
create function pg_temp.money() returns jsonb language sql as $$
  select jsonb_build_object(
    'invoices', (select jsonb_agg(jsonb_build_array(canonical_invoice_id, original_total_dirham, effective_total_dirham, effective_paid_dirham, effective_due_dirham, effective_credit_applied_dirham) order by canonical_invoice_id)
      from public.effective_invoices where shop_id = pg_temp.s1() and canonical_invoice_id::text like 'a8000000-0000-4000-8000-%'),
    'balance', (select to_jsonb(b) from public.customer_financial_balances b where b.customer_id = pg_temp.c1()),
    'payments', (select count(*) from public.payments where invoice_id::text like 'a8000000-0000-4000-8000-%'),
    'corrections', (select count(*) from public.corrections where invoice_id::text like 'a8000000-0000-4000-8000-%'),
    'ledger', (select count(*) from public.customer_ledger where customer_id = pg_temp.c1()),
    'movements', (select count(*) from public.sales_movements where shop_id = pg_temp.s1() and invoice_id::text like 'a8000000-0000-4000-8000-%')) $$;
create function pg_temp.count_fixes() returns int language sql as $$
  select count(*)::int from public.invoice_piece_corrections where invoice_id::text like 'a8000000-0000-4000-8000-%' $$;

-- Fixtures (as the database owner) ---------------------------------------------------------------------------------
-- P1 10 ordered, 4 delivered | L legacy | V tracked, voided below | S2 shop 2 | P5 5 ordered, none delivered
insert into public.customers(id, shop_id, public_id, name) values (pg_temp.c1(), pg_temp.s1(), 'CUS-OC-1', 'Ordered correction customer');
insert into public.invoices(id, shop_id, customer_id, invoice_id, total_amount_dirham, business_date, delivered, ordered_pieces, created_by) values
  (pg_temp.inv(1), pg_temp.s1(), pg_temp.c1(), 'OC-P1', 10000, current_date, false, 10, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(2), pg_temp.s1(), pg_temp.c1(), 'OC-L', 3000, current_date, true, null, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(3), pg_temp.s1(), pg_temp.c1(), 'OC-V', 5000, current_date, false, 3, '10000000-0000-4000-8000-000000000102'),
  (pg_temp.inv(4), pg_temp.s2(), null, 'OC-S2', 2000, current_date, false, 5, '10000000-0000-4000-8000-000000000103'),
  (pg_temp.inv(5), pg_temp.s1(), pg_temp.c1(), 'OC-P5', 4000, current_date, false, 5, '10000000-0000-4000-8000-000000000102');
insert into public.invoice_number_registry(shop_id, invoice_number, canonical_invoice_id) select shop_id, invoice_id, id from public.invoices where invoice_id like 'OC-%';
insert into public.invoice_deliveries(id, shop_id, invoice_id, pieces, business_date, created_by, idempotency_key, fingerprint) values
  (pg_temp.del(1), pg_temp.s1(), pg_temp.inv(1), 4, current_date, '10000000-0000-4000-8000-000000000102', 'oc-fix-1', 'x');
create temp table before_fix as select pg_temp.money() m;
grant select on before_fix to public;

-- 1. Catalog and privileges ---------------------------------------------------------------------------------------
select has_table('public', 'invoice_piece_corrections', 'correction events table exists');
select has_function('public', 'correct_invoice_ordered_pieces', array['jsonb'], 'correction RPC exists');
select ok(not has_function_privilege('anon', 'public.correct_invoice_ordered_pieces(jsonb)', 'EXECUTE'), 'anon cannot execute the correction RPC');
select ok(has_function_privilege('authenticated', 'public.correct_invoice_ordered_pieces(jsonb)', 'EXECUTE'), 'authenticated can execute the correction RPC');
select ok(not has_function_privilege('authenticated', 'private.effective_ordered_pieces(uuid,uuid)', 'EXECUTE'), 'the effective-ordered helper is not callable through the Data API');
select ok(not has_table_privilege('authenticated', 'public.invoice_piece_corrections', 'INSERT') and not has_table_privilege('authenticated', 'public.invoice_piece_corrections', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.invoice_piece_corrections', 'DELETE'), 'authenticated cannot write correction events directly');
select ok((select relrowsecurity from pg_class where oid = 'public.invoice_piece_corrections'::regclass), 'correction events have RLS');
select is(pg_temp.totals(1), '10|4|6|partial|10', 'P1 starts 10 ordered, 4 delivered');

-- 2. Authorization ------------------------------------------------------------------------------------------------
set local role anon;
select throws_ok($$select pg_temp.fix(1, 10, 12, 'Customer added two pieces', 'anon-1')$$, '42501', null, 'anon cannot correct');
reset role;
set local role authenticated;
select pg_temp.act('staff');
select throws_ok($$select pg_temp.fix(1, 10, 12, 'Customer added two pieces', 'st-1')$$, '42501', 'INSUFFICIENT_ROLE', 'staff cannot correct ordered pieces');
select pg_temp.act('staff2');
select throws_ok($$select pg_temp.fix(1, 10, 12, 'Customer added two pieces', 's2-1')$$, '42501', 'UNAUTHORIZED_SHOP', 'a user of another shop gets UNAUTHORIZED_SHOP');
select pg_temp.act('manager');
select throws_ok($$select pg_temp.fix(4, 5, 6, 'Customer added one piece', 'm-s2', pg_temp.s2())$$, '42501', 'UNAUTHORIZED_SHOP', 'a manager cannot correct in an unassigned shop');
select throws_ok($$select pg_temp.fix(4, 5, 6, 'Customer added one piece', 'm-wrong-shop')$$, 'P0001', 'INVOICE_NOT_FOUND', 'an invoice of another shop is not found in the requested shop');

-- 3. Validation ---------------------------------------------------------------------------------------------------
select throws_ok($$select public.correct_invoice_ordered_pieces(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(1), 'expected_ordered_pieces', 10, 'ordered_pieces', 12, 'idempotency_key', 'v-miss'))$$, 'P0001', 'INVALID_REQUEST', 'a missing reason is blocked');
select throws_ok($$select pg_temp.fix(1, 10, 12, E' \t\n ', 'v-blank')$$, 'P0001', 'REASON_REQUIRED', 'a blank reason is blocked');
select throws_ok($$select pg_temp.fix(1, 10, 12, 'too short', 'v-short')$$, 'P0001', 'REASON_TOO_SHORT', 'a reason under 10 characters is blocked');
select throws_ok($$select pg_temp.fix(1, 10, 12, repeat('x', 2001), 'v-long')$$, 'P0001', 'INVALID_REQUEST', 'a reason over 2000 characters is blocked');
select throws_ok($$select pg_temp.fix(1, 10, 0, 'Customer cancelled everything', 'v-zero')$$, 'P0001', 'PIECES_INVALID', 'zero pieces is blocked');
select throws_ok($$select pg_temp.fix(1, 10, -2, 'Customer cancelled everything', 'v-neg')$$, 'P0001', 'PIECES_INVALID', 'negative pieces are blocked');
select throws_ok($$select public.correct_invoice_ordered_pieces(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(1), 'expected_ordered_pieces', 10, 'ordered_pieces', 11.5, 'reason', 'Customer added more pieces', 'idempotency_key', 'v-frac'))$$, 'P0001', 'INVALID_REQUEST', 'fractional pieces are blocked');
select throws_ok($$select public.correct_invoice_ordered_pieces(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(1), 'expected_ordered_pieces', 10, 'ordered_pieces', '12', 'reason', 'Customer added more pieces', 'idempotency_key', 'v-text'))$$, 'P0001', 'INVALID_REQUEST', 'pieces as text are blocked');
select throws_ok($$select public.correct_invoice_ordered_pieces(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(1), 'expected_ordered_pieces', 10, 'ordered_pieces', 12, 'reason', 'Customer added more pieces', 'idempotency_key', 'v-date', 'business_date', current_date - 1))$$, 'P0001', 'INVALID_REQUEST', 'the caller cannot choose the date');
select throws_ok($$select pg_temp.fix(2, 1, 2, 'Customer added more pieces', 'v-legacy')$$, 'P0001', 'LEGACY_INVOICE', 'legacy invoices cannot use the workflow');
select throws_ok($$select pg_temp.fix(1, 9, 12, 'Customer added more pieces', 'v-stale')$$, 'P0001', 'STALE_ORDERED_PIECES', 'a command based on a stale quantity is refused');
select throws_ok($$select pg_temp.fix(1, 10, 10, 'Customer confirmed the same', 'v-same')$$, 'P0001', 'NO_CHANGE', 'a correction must change the quantity');
select throws_ok($$select pg_temp.fix(1, 10, 3, 'Customer reduced the order', 'v-below')$$, 'P0001', 'BELOW_DELIVERED', 'the quantity cannot go below the 4 net delivered pieces');
select is(pg_temp.count_fixes(), 0, 'rejected attempts write nothing');

-- 4. Increase -----------------------------------------------------------------------------------------------------
select lives_ok($$select set_config('oc.first', pg_temp.fix(1, 10, 12, E'  Customer added two pieces \n', 'p1-a')::text, true)$$, 'manager increases P1 from 10 to 12');
select is((current_setting('oc.first')::jsonb ->> 'ordered_before') || '>' || (current_setting('oc.first')::jsonb ->> 'ordered_after'), '10>12', 'the result reports before and after');
select is((select concat_ws('|', ordered_before, ordered_after, reason, business_date, created_by, recorded_at is not null) from public.invoice_piece_corrections where invoice_id = pg_temp.inv(1)),
  concat_ws('|', 10, 12, 'Customer added two pieces', current_date, '10000000-0000-4000-8000-000000000104', true), 'the event keeps before/after, trimmed reason, today, actor and recorded time');
select is((select ordered_pieces from public.invoices where id = pg_temp.inv(1)), 10, 'the original ordered quantity is preserved on the invoice');
select is(pg_temp.totals(1), '12|4|8|partial|10', 'totals use the effective ordered quantity: 12 - 4 = 8, original kept as 10');
select is(pg_temp.eff(1), 't|12|4|partial', 'effective_invoices reads the effective ordered quantity');
select is((select count(*)::int from public.audit_events where action = 'delivery.correct_ordered' and entity_id = pg_temp.inv(1)::text and reason = 'Customer added two pieces'
  and metadata ->> 'ordered_before' = '10' and metadata ->> 'ordered_after' = '12' and metadata ->> 'delivered' = '4'), 1, 'one audit event with reason and before/after');

-- 5. Idempotency and stale updates --------------------------------------------------------------------------------
select is(pg_temp.fix(1, 10, 12, E'  Customer added two pieces \n', 'p1-a'), current_setting('oc.first')::jsonb, 'an exact retry returns the original result');
select is(pg_temp.count_fixes(), 1, 'the retry wrote nothing');
select throws_ok($$select pg_temp.fix(1, 10, 13, 'Customer added three pieces', 'p1-a')$$, 'P0001', 'IDEMPOTENCY_CONFLICT', 'same key with another command conflicts');
select pg_temp.act('owner');
select throws_ok($$select pg_temp.fix(1, 10, 11, 'Customer added one piece', 'p1-stale')$$, 'P0001', 'STALE_ORDERED_PIECES', 'a second editor still on 10 is refused after the change to 12');

-- 6. Decrease down to the delivered count -------------------------------------------------------------------------
select lives_ok($$select pg_temp.fix(1, 12, 4, 'Customer cancelled the rest of the order', 'p1-b')$$, 'owner decreases P1 from 12 to 4');
select is(pg_temp.totals(1), '4|4|0|full|10', 'the invoice is now fully delivered');
select is(pg_temp.eff(1), 't|4|4|full', 'effective_invoices reads it as full');
select is((select string_agg(ordered_before || '>' || ordered_after, ',' order by seq) from public.invoice_piece_corrections where invoice_id = pg_temp.inv(1)), '10>12,12>4', 'the history keeps both corrections in order');
select pg_temp.act('staff');
select throws_ok($$select pg_temp.deliver(1, 1, 'p1-over')$$, 'P0001', 'OVER_DELIVERY', 'deliveries are checked against the effective ordered quantity');

-- 7. Deliveries and reversals around a correction -----------------------------------------------------------------
select pg_temp.act('manager');
select lives_ok($$select pg_temp.fix(5, 5, 2, 'Customer only wants two pieces', 'p5-a')$$, 'P5 decreased from 5 to 2 before any delivery');
select pg_temp.act('staff');
select lives_ok($$select pg_temp.deliver(5, 2, 'p5-d1')$$, 'staff delivers the 2 effective pieces');
select is(pg_temp.totals(5), '2|2|0|full|5', 'P5 is full against the effective quantity');
select pg_temp.act('manager');
select lives_ok($$select public.reverse_invoice_delivery(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(5),
  'delivery_id', (select id from public.invoice_deliveries where idempotency_key = 'p5-d1'), 'reason', 'Delivered to the wrong address', 'idempotency_key', 'p5-r1'))$$, 'the delivery is reversed');
select is(pg_temp.totals(5), '2|0|2|none|5', 'remaining follows the effective quantity after a reversal');
select lives_ok($$select pg_temp.fix(5, 2, 6, 'Customer ordered more again', 'p5-b')$$, 'P5 increased back above the original');
select is(pg_temp.totals(5), '6|0|6|none|5', 'P5 now 6 ordered');

-- 8. Table guards (as the database owner) -------------------------------------------------------------------------
reset role;
select throws_ok($$update public.invoice_piece_corrections set ordered_after = 99 where invoice_id = pg_temp.inv(1)$$, null, null, 'correction events cannot be updated');
select throws_ok($$delete from public.invoice_piece_corrections where invoice_id = pg_temp.inv(1)$$, null, null, 'correction events cannot be deleted');
select throws_ok($$insert into public.invoice_piece_corrections(shop_id, invoice_id, ordered_before, ordered_after, reason, business_date, created_by, idempotency_key, fingerprint)
  values (pg_temp.s1(), pg_temp.inv(5), 6, 6, 'Same quantity attempt', current_date, '10000000-0000-4000-8000-000000000101', 'g-same', 'x')$$, '23514', null, 'a no-op correction is refused by the table');
select throws_ok($$insert into public.invoice_piece_corrections(shop_id, invoice_id, ordered_before, ordered_after, reason, business_date, created_by, idempotency_key, fingerprint)
  values (pg_temp.s1(), pg_temp.inv(5), 6, 7, null, current_date, '10000000-0000-4000-8000-000000000101', 'g-noreason', 'x')$$, '23502', null, 'a correction without a reason is refused by the table');

-- 9. Money, void, inactive shop, closed date ----------------------------------------------------------------------
set local role authenticated;
select pg_temp.act('manager');
select is(pg_temp.money(), (select m from before_fix), 'invoice money, customer balance, payments, corrections, ledger and sales movements are unchanged');
select lives_ok($$select public.void_invoice(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(3), 'reason', 'Customer cancelled the order', 'idempotency_key', 'oc-void-3'))$$, 'OC-V voided');
select throws_ok($$select pg_temp.fix(3, 3, 4, 'Customer added one piece', 'v-void')$$, 'P0001', 'INVOICE_VOID', 'void invoices cannot be corrected');
select lives_ok($$select public.close_business_date(jsonb_build_object('shop_id', pg_temp.s1(), 'business_date', current_date::text))$$, 'today closed');
select throws_ok($$select pg_temp.fix(5, 6, 7, 'Customer added one piece', 'cl-5')$$, 'P0001', 'CLOSED_DATE', 'no correction while today is closed');
select is(pg_temp.fix(1, 10, 12, E'  Customer added two pieces \n', 'p1-a'), current_setting('oc.first')::jsonb, 'an exact retry still returns its result after today closes');
reset role;
update public.shops set is_active = false where id = pg_temp.s1();
set local role authenticated;
select throws_ok($$select pg_temp.fix(5, 6, 7, 'Customer added one piece', 'in-5')$$, null, null, 'an inactive shop cannot correct');
select is(pg_temp.count_fixes(), 4, 'exactly four corrections were written by this file');

select * from finish();
rollback;
