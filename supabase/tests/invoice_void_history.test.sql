begin;
-- current_date below must be the Qatar operating date the RPCs enforce.
set local timezone = 'Asia/Qatar';
create extension if not exists pgtap with schema extensions;
select no_plan();

-- OPS-01B slice 1 remediation (20261103190000). Owner ruling: historical business-date reporting is immutable.
-- D1 = current_date - 2 ("1 Nov"), the void is dated today ("3 Nov"). Plus the review-gap cases, the shop/invoice-scoped
-- void correction FK (m2), the dual-target post-void guard (m3) and the dropped dormant snapshot RPC (O).

create function pg_temp.act(who text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', case who
    when 'owner' then '10000000-0000-4000-8000-000000000101' when 'manager' then '10000000-0000-4000-8000-000000000104' end)::text, true)
$$;
create function pg_temp.s1() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.s2() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.owner() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000101'::uuid $$;
create function pg_temp.inv(n int) returns uuid language sql immutable as $$ select ('a8000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.cus() returns uuid language sql immutable as $$ select 'c8000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.void(n int) returns jsonb language sql as $$
  select public.void_invoice(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(n), 'reason', 'Customer cancelled the order', 'idempotency_key', 'hist-' || n)) $$;
create function pg_temp.sales(f date, t date) returns jsonb language sql as $$
  select to_jsonb(x) from public.report_sales_totals(pg_temp.s1(), f, t) x $$;
create function pg_temp.day(d date) returns jsonb language sql as $$
  select coalesce((select to_jsonb(x) from public.report_daily_summary(pg_temp.s1(), d, d) x), '{}'::jsonb) $$;
-- Only the movement half of the sales totals: the current-state half (paid/due) legitimately follows the invoice.
create function pg_temp.moves(f date, t date) returns jsonb language sql as $$
  select pg_temp.sales(f, t) - array['effective_paid_dirham', 'credit_applied_dirham', 'effective_due_dirham', 'delivered_count', 'undelivered_count', 'partially_delivered_count'] $$;

-- Fixtures (as the database owner). An isolated history window far from the seed and other test files: nothing else is
-- dated D1 or D2 in shop 1 here except these rows, so every figure below is exact.
insert into public.customers(id, shop_id, public_id, name) values (pg_temp.cus(), pg_temp.s1(), 'CUS-HIST-1', 'History customer');
insert into public.invoices(id, shop_id, customer_id, invoice_id, total_amount_dirham, business_date, delivered, created_by) values
  (pg_temp.inv(1), pg_temp.s1(), pg_temp.cus(), 'HIST-1', 10000, current_date - 2, true, pg_temp.owner()),   -- CASE 1
  (pg_temp.inv(2), pg_temp.s1(), pg_temp.cus(), 'HIST-2', 10000, current_date - 2, true, pg_temp.owner()),   -- prior +/- corrections
  (pg_temp.inv(3), pg_temp.s1(), pg_temp.cus(), 'HIST-3', 6000, current_date - 2, true, pg_temp.owner()),    -- payment corrected to 0
  (pg_temp.inv(4), pg_temp.s1(), null, 'HIST-4', 4000, current_date - 2, false, pg_temp.owner()),            -- already zero
  (pg_temp.inv(5), pg_temp.s1(), null, 'HIST-5', 3000, current_date - 2, false, pg_temp.owner()),            -- stays open (m3 target)
  (pg_temp.inv(6), pg_temp.s2(), null, 'HIST-6', 2000, current_date - 2, false, pg_temp.owner());            -- other shop (m2)
insert into public.invoice_number_registry(shop_id, invoice_number, canonical_invoice_id) select shop_id, invoice_id, id from public.invoices where invoice_id like 'HIST-%';
insert into public.corrections(shop_id, invoice_id, amount_delta_dirham, reason, business_date, created_by, approved_by) values
  (pg_temp.s1(), pg_temp.inv(2), 2500, 'price raised', current_date - 1, pg_temp.owner(), pg_temp.owner()),
  (pg_temp.s1(), pg_temp.inv(2), -1000, 'discount', current_date - 1, pg_temp.owner(), pg_temp.owner()),
  (pg_temp.s1(), pg_temp.inv(4), -4000, 'nothing was sold', current_date - 1, pg_temp.owner(), pg_temp.owner()),
  (pg_temp.s2(), pg_temp.inv(6), -500, 'other shop discount', current_date - 1, pg_temp.owner(), pg_temp.owner());
insert into public.payments(id, shop_id, invoice_id, amount_dirham, business_date) values
  ('b8000000-0000-4000-8000-000000000003', pg_temp.s1(), pg_temp.inv(3), 6000, current_date - 2),
  ('b8000000-0000-4000-8000-000000000005', pg_temp.s1(), pg_temp.inv(5), 1000, current_date - 2);
insert into public.corrections(shop_id, payment_id, amount_delta_dirham, reason, business_date, created_by, approved_by) values
  (pg_temp.s1(), 'b8000000-0000-4000-8000-000000000003', -6000, 'payment entered on the wrong invoice', current_date - 1, pg_temp.owner(), pg_temp.owner());

-- 0. Catalog -------------------------------------------------------------------------------------------------
select has_view('public', 'sales_movements', 'business-date sales movement view exists');
select ok((select 'security_invoker=true' = any(reloptions) from pg_class where oid = 'public.sales_movements'::regclass), 'sales_movements is security_invoker');
select ok(not has_table_privilege('anon', 'public.sales_movements', 'SELECT'), 'anon cannot read sales_movements');
select hasnt_function('public', 'report_dashboard_snapshot', array['uuid', 'date', 'date', 'uuid[]'], 'O: the dormant snapshot RPC that counted voids as paid is dropped');

-- Snapshot of history before any void. D1 is then CLOSED: a void must leave a closed day exactly as it was.
create temp table before_void as select pg_temp.day(current_date - 2) d1, pg_temp.day(current_date - 1) d2, pg_temp.moves(current_date - 2, current_date - 2) s1, pg_temp.moves(current_date - 1, current_date - 1) s2,
  pg_temp.day(current_date) d0, pg_temp.sales(current_date, current_date) t0; -- today may already hold other rows: assert deltas
grant select on before_void to public;
insert into public.daily_closes(shop_id, business_date, event_type, actor_id) values (pg_temp.s1(), current_date - 2, 'closed', pg_temp.owner());

set local role authenticated;
select pg_temp.act('owner');

-- CASE 1: 100 on D1, void today ---------------------------------------------------------------------------------
select lives_ok($$select pg_temp.void(1)$$, 'CASE 1: invoice from D1 voided today');
select is((select amount_dirham from public.sales_movements where invoice_id = pg_temp.inv(1) and movement_type = 'sale'), 10000::bigint, 'CASE 1: sale movement keeps QAR 100 on D1');
select results_eq($$select business_date, movement_type, amount_dirham from public.sales_movements where invoice_id = pg_temp.inv(1) order by business_date$$,
  $$values (current_date - 2, 'sale'::text, 10000::bigint), (current_date, 'invoice_void'::text, -10000::bigint)$$, 'CASE 1: movements are +100 on D1 and -100 (invoice_void) today');
select is(pg_temp.moves(current_date - 2, current_date - 2), (select s1 from before_void), 'CASE 1: Sales report for D1 is unchanged by the void (gross, corrections, net)');
select is((pg_temp.sales(current_date - 2, current_date - 2) ->> 'gross_sales_dirham')::bigint, 33000::bigint, 'CASE 1: D1 gross sales still include the voided invoice''s QAR 100');
select is(pg_temp.day(current_date - 2), (select d1 from before_void), 'CASE 1: Daily Close summary for D1 is byte-for-byte unchanged');
select is(coalesce((pg_temp.day(current_date) ->> 'invoice_corrections_dirham')::bigint, 0) - coalesce((select (d0 ->> 'invoice_corrections_dirham')::bigint from before_void), 0), -10000::bigint, 'CASE 1: Daily Close today shows the -100 invoice correction');
select is(coalesce((pg_temp.sales(current_date, current_date) ->> 'sales_corrections_dirham')::bigint, 0) - coalesce((select (t0 ->> 'sales_corrections_dirham')::bigint from before_void), 0), -10000::bigint, 'CASE 1: Sales report today shows the -100 correction');
select is((select sum(amount_dirham)::bigint from public.sales_movements where invoice_id = pg_temp.inv(1) and business_date between current_date - 2 and current_date), 0::bigint, 'CASE 1: range D1..today nets to 0 for the invoice');
select is((select array[original_total_dirham, effective_total_dirham, effective_due_dirham] from public.effective_invoices where canonical_invoice_id = pg_temp.inv(1)), array[10000, 0, 0]::bigint[], 'CASE 1: current state: original 100 kept, effective total and due 0');
select ok((select is_void from public.effective_invoices where canonical_invoice_id = pg_temp.inv(1)), 'CASE 1: current state: VOID');
select results_eq($$select business_date, entry_type, debit_dirham, credit_dirham from public.customer_ledger where invoice_id = pg_temp.inv(1) order by business_date$$,
  $$values (current_date - 2, 'invoice'::text, 10000::bigint, 0::bigint), (current_date, 'invoice_void'::text, 0::bigint, 10000::bigint)$$, 'CASE 1: ledger explains both events chronologically');
select is((select sum(debit_dirham - credit_dirham)::bigint from public.customer_ledger where invoice_id = pg_temp.inv(1)), 0::bigint, 'CASE 1: customer balance contribution nets to 0');

-- Range reconciliation: the sales report equals Daily Close for any range, and net equals the current economic result.
select is((select array[(s ->> 'gross_sales_dirham')::bigint, (s ->> 'sales_corrections_dirham')::bigint] from (select pg_temp.sales(current_date - 2, current_date) s) x),
  (select array[sum(gross_invoice_dirham)::bigint, sum(invoice_corrections_dirham)::bigint] from public.report_daily_summary(pg_temp.s1(), current_date - 2, current_date)), 'range: sales gross/corrections equal the summed Daily Close figures');
select is((select sum(amount_dirham)::bigint from public.sales_movements where shop_id = pg_temp.s1() and invoice_id in (select id from public.invoices where invoice_id like 'HIST-%') and business_date between current_date - 2 and current_date),
  (select sum(effective_total_dirham)::bigint from public.effective_invoices where shop_id = pg_temp.s1() and original_invoice_number like 'HIST-%'), 'range: movements over D1..today sum to the current effective totals');

-- GAP 1: prior +25 / -10 corrections, then void reverses the effective 115 ---------------------------------------
select lives_ok($$select pg_temp.void(2)$$, 'GAP 1: invoice with prior positive and negative corrections voided');
select is((select amount_delta_dirham from public.corrections c join public.invoice_voids v on v.correction_id = c.id where v.invoice_id = pg_temp.inv(2)), -11500::bigint, 'GAP 1: the void reverses the effective total (100 + 25 - 10), not the original');
select results_eq($$select business_date, movement_type, amount_dirham from public.sales_movements where invoice_id = pg_temp.inv(2) order by business_date, amount_dirham$$,
  $$values (current_date - 2, 'sale'::text, 10000::bigint), (current_date - 1, 'invoice_correction'::text, -1000::bigint), (current_date - 1, 'invoice_correction'::text, 2500::bigint), (current_date, 'invoice_void'::text, -11500::bigint)$$,
  'GAP 1: each correction stays on its own date; only the void is labelled invoice_void');
select is(pg_temp.moves(current_date - 1, current_date - 1), (select s2 from before_void), 'GAP 1: the day of the earlier corrections is not rewritten');
select is((select sum(debit_dirham - credit_dirham)::bigint from public.customer_ledger where invoice_id = pg_temp.inv(2)), 0::bigint, 'GAP 1: ledger nets to 0');

-- GAP 2: payment corrected fully to zero, then void ------------------------------------------------------------
select is((select effective_paid_dirham from public.effective_invoices where canonical_invoice_id = pg_temp.inv(3)), 0::bigint, 'GAP 2: effective paid is 0 after the payment correction');
select lives_ok($$select pg_temp.void(3)$$, 'GAP 2: void allowed once the payment is corrected to 0');
select is((select array[effective_total_dirham, effective_paid_dirham, effective_due_dirham] from public.effective_invoices where canonical_invoice_id = pg_temp.inv(3)), array[0, 0, 0]::bigint[], 'GAP 2: total, paid and due all 0');
select is((select available_credit_dirham from public.customer_financial_balances where customer_id = pg_temp.cus()), 0::bigint, 'GAP 2: no silent customer credit');
select is((select sum(debit_dirham - credit_dirham)::bigint from public.customer_ledger where invoice_id = pg_temp.inv(3)), 0::bigint, 'GAP 2: ledger (invoice, payment, payment correction, void) nets to 0');
select is((pg_temp.day(current_date - 2) ->> 'followup_payments_dirham')::bigint, (select d1 ->> 'followup_payments_dirham' from before_void)::bigint, 'GAP 2: the payment stays on its own day');
select is((select outstanding_due_dirham from public.customer_financial_balances where customer_id = pg_temp.cus()), 0::bigint, 'customer balance after CASE 1 + GAP 1 + GAP 2 voids nets to 0');

-- GAP 3: already-zero invoice ------------------------------------------------------------------------------------
select lives_ok($$select pg_temp.void(4)$$, 'GAP 3: an invoice already corrected to 0 can be voided');
select is((select correction_id from public.invoice_voids where invoice_id = pg_temp.inv(4)), null, 'GAP 3: no zero-amount correction is written');
select is((select count(*)::int from public.sales_movements where invoice_id = pg_temp.inv(4) and movement_type = 'invoice_void'), 0, 'GAP 3: no void movement, so no reporting change');
select ok((select is_void from public.effective_invoices where canonical_invoice_id = pg_temp.inv(4)), 'GAP 3: it is still marked VOID');

-- Top customers: a movement ranking; the D1 window still credits the customer with the sales made then.
select is((select amount_dirham from public.report_top_customers_by_sales(pg_temp.s1(), current_date - 2, current_date - 2, 5) where customer_id = pg_temp.cus()), 26000::bigint, 'top customers on D1 keep the original sales');
select is((select count(*)::int from public.report_top_customers_by_sales(pg_temp.s1(), current_date - 2, current_date, 5) where customer_id = pg_temp.cus()), 0, 'over D1..today the voided sales net to 0 and the customer drops out');

-- m2: the void marker's correction must be of the same shop and the same invoice ----------------------------------
reset role;
select throws_ok($$insert into public.invoice_voids(shop_id, invoice_id, correction_id, reason, actor_user_id, business_date, idempotency_key, fingerprint)
  values (pg_temp.s1(), pg_temp.inv(5), (select id from public.corrections where invoice_id = pg_temp.inv(2) and amount_delta_dirham = 2500), 'pointing at another invoice', pg_temp.owner(), current_date, 'm2-a', 'x')$$,
  '23503', null, 'm2: a void cannot reference another invoice''s correction');
select throws_ok($$insert into public.invoice_voids(shop_id, invoice_id, correction_id, reason, actor_user_id, business_date, idempotency_key, fingerprint)
  values (pg_temp.s1(), pg_temp.inv(5), (select id from public.corrections where invoice_id = pg_temp.inv(6)), 'pointing at another shop', pg_temp.owner(), current_date, 'm2-b', 'x')$$,
  '23503', null, 'm2: a void cannot reference another shop''s correction');
select ok(exists(select 1 from pg_constraint where conname = 'invoice_voids_correction_fkey' and conrelid = 'public.invoice_voids'::regclass
  and pg_get_constraintdef(oid) = 'FOREIGN KEY (shop_id, invoice_id, correction_id) REFERENCES corrections(shop_id, invoice_id, id) ON DELETE RESTRICT'), 'm2: composite shop/invoice/correction FK');
select ok(not exists(select 1 from pg_constraint where conname = 'invoice_voids_correction_id_fkey'), 'm2: the single-column FK is gone');

-- m3: a row naming two invoices is checked against both ----------------------------------------------------------
select throws_ok($$insert into public.corrections(shop_id, invoice_id, payment_id, amount_delta_dirham, reason, business_date, approved_by)
  values (pg_temp.s1(), pg_temp.inv(5), 'b8000000-0000-4000-8000-000000000003', 100, 'open invoice, voided payment', current_date, pg_temp.owner())$$,
  'P0001', 'INVOICE_VOID', 'm3: non-void invoice_id + payment of a void invoice is refused');
select throws_ok($$insert into public.corrections(shop_id, invoice_id, payment_id, amount_delta_dirham, reason, business_date, approved_by)
  values (pg_temp.s1(), pg_temp.inv(1), 'b8000000-0000-4000-8000-000000000005', 100, 'void invoice, open payment', current_date, pg_temp.owner())$$,
  'P0001', 'INVOICE_VOID', 'm3: void invoice_id + payment of an open invoice is refused');
select lives_ok($$insert into public.corrections(shop_id, invoice_id, payment_id, amount_delta_dirham, reason, business_date, approved_by)
  values (pg_temp.s1(), pg_temp.inv(5), 'b8000000-0000-4000-8000-000000000005', 100, 'both targets open', current_date, pg_temp.owner())$$, 'm3: both targets open is still allowed');

-- Shop isolation of the movement view.
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', '10000000-0000-4000-8000-000000000103')::text, true);
select is((select count(*)::int from public.sales_movements where shop_id = pg_temp.s1()), 0, 'shop 2 staff sees no shop 1 movements');

select * from finish();
rollback;
