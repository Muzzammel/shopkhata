begin;
set local timezone = 'Asia/Qatar';
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Partial delivery, step 4 (20261112100000): reports read none | partial | full; legacy invoices keep yes/no.
-- Fixtures sit on one past date (D) in shop 1; report figures are compared as deltas, so seed rows cannot interfere.

create function pg_temp.act(who text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', case who
    when 'staff' then '10000000-0000-4000-8000-000000000102' when 'staff2' then '10000000-0000-4000-8000-000000000103' end)::text, true)
$$;
create function pg_temp.s1() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.d() returns date language sql stable as $$ select current_date - 50 $$;
create function pg_temp.inv(n int) returns uuid language sql immutable as $$ select ('a8400000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.row(n int) returns text language sql as $$
  select concat_ws('|', coalesce(ordered_pieces::text, '-'), coalesce(delivered_pieces::text, '-'), delivery_status, effective_delivered)
  from public.effective_invoices where canonical_invoice_id = pg_temp.inv(n) $$;
create function pg_temp.totals() returns jsonb language sql as $$
  select to_jsonb(t) from public.report_sales_totals(pg_temp.s1(), pg_temp.d(), pg_temp.d()) t $$;
create temp table base as select pg_temp.totals() b;
grant select on base to authenticated;
create function pg_temp.delta(k text) returns bigint language sql as $$
  select (pg_temp.totals() ->> k)::bigint - (select (b ->> k)::bigint from base) $$;


-- 1: tracked, 0 of 100 | 2: tracked, 60 of 100 | 3: tracked, 60 + 40 of 100 | 4: legacy delivered | 5: legacy not delivered
insert into public.customers(id, shop_id, public_id, name) values ('c8400000-0000-4000-8000-000000000001', pg_temp.s1(), 'CUS-PDR-1', 'Reporting customer');
insert into public.invoices(id, shop_id, customer_id, invoice_id, total_amount_dirham, business_date, delivered, ordered_pieces, created_by)
select pg_temp.inv(n), pg_temp.s1(), 'c8400000-0000-4000-8000-000000000001', 'PDR-' || n, 10000, pg_temp.d(), n = 4, case when n <= 3 then 100 end,
  '10000000-0000-4000-8000-000000000102' from generate_series(1, 5) n;
insert into public.invoice_number_registry(shop_id, invoice_number, canonical_invoice_id) select shop_id, invoice_id, id from public.invoices where invoice_id like 'PDR-%';
insert into public.invoice_deliveries(shop_id, invoice_id, pieces, business_date, created_by, idempotency_key, fingerprint) values
  (pg_temp.s1(), pg_temp.inv(2), 60, pg_temp.d(), '10000000-0000-4000-8000-000000000102', 'pdr-2a', 'x'),
  (pg_temp.s1(), pg_temp.inv(3), 60, pg_temp.d(), '10000000-0000-4000-8000-000000000102', 'pdr-3a', 'x'),
  (pg_temp.s1(), pg_temp.inv(3), 40, pg_temp.d(), '10000000-0000-4000-8000-000000000102', 'pdr-3b', 'x');

-- 1. Per-invoice state (as shop 1 staff, through RLS) ---------------------------------------------------------------
select pg_temp.act('staff');
set local role authenticated;
select is(pg_temp.row(1), '100|0|none|f', 'tracked 0 of 100: none');
select is(pg_temp.row(2), '100|60|partial|t', 'tracked 60 of 100: partial (effective_delivered keeps its "any piece" meaning)');
select is(pg_temp.row(3), '100|100|full|t', 'tracked 60 + 40 of 100: full');
select is(pg_temp.row(4), '-|-|full|t', 'legacy delivered: full, no invented piece counts');
select is(pg_temp.row(5), '-|-|none|f', 'legacy not delivered: none, no invented piece counts');
select is((select count(*)::int from public.effective_invoices e join public.invoice_delivery_totals t on t.canonical_invoice_id = e.canonical_invoice_id
  where e.canonical_invoice_id in (pg_temp.inv(1), pg_temp.inv(2), pg_temp.inv(3)) and (t.delivered_pieces, t.delivery_status) = (e.delivered_pieces, e.delivery_status)), 3,
  'tracked rows agree with invoice_delivery_totals');
select is((select array_agg(effective_due_dirham order by canonical_invoice_id) from public.effective_invoices where canonical_invoice_id in (pg_temp.inv(1), pg_temp.inv(2), pg_temp.inv(3))),
  array[10000, 10000, 10000]::bigint[], 'deliveries never change money: every tracked invoice still owes its full total');

-- 2. Sales totals --------------------------------------------------------------------------------------------------
select is(pg_temp.delta('invoice_count'), 5::bigint, 'five invoices on D');
select is(pg_temp.delta('delivered_count'), 2::bigint, 'delivered = tracked full + legacy delivered (partial NOT counted)');
select is(pg_temp.delta('partially_delivered_count'), 1::bigint, 'partially delivered = the 60 of 100 invoice');
select is(pg_temp.delta('undelivered_count'), 2::bigint, 'not delivered = tracked none + legacy not delivered');
select is((select (t ->> 'delivered_count')::bigint + (t ->> 'partially_delivered_count')::bigint + (t ->> 'undelivered_count')::bigint - (t ->> 'invoice_count')::bigint
  from pg_temp.totals() t), 0::bigint, 'the three delivery states partition the invoice count');
select is(pg_temp.delta('effective_due_dirham'), 50000::bigint, 'due is independent of delivery state');
select is(pg_temp.delta('gross_sales_dirham'), 50000::bigint, 'gross sales unchanged by deliveries');

-- 3. Shop access ---------------------------------------------------------------------------------------------------
select pg_temp.act('staff2');
select is((select count(*)::int from public.effective_invoices where canonical_invoice_id in (select pg_temp.inv(n) from generate_series(1, 5) n)), 0,
  'shop 2 staff cannot see shop 1 delivery states');
select is((pg_temp.totals() ->> 'partially_delivered_count')::bigint, 0::bigint, 'shop 2 staff: shop 1 report counts nothing');
reset role;

select * from finish();
rollback;
