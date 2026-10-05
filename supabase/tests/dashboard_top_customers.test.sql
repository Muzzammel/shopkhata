begin;
set local timezone = 'Asia/Qatar';
create extension if not exists pgtap with schema extensions;
select plan(18);

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
create function pg_temp.row(number text, total bigint, received bigint, customer uuid default null) returns jsonb language sql as $$
  select jsonb_build_object('row_id', number, 'invoice_number', number, 'total_dirham', total, 'received_dirham', received, 'payment_method', 'cash',
    'delivered', true, 'customer', case when customer is null then null else jsonb_build_object('type', 'existing', 'customer_id', customer) end) $$;
create function pg_temp.batch(key text, d date, rows jsonb, shop uuid default pg_temp.s1()) returns jsonb language sql as $$
  select pg_temp.cmd(jsonb_build_object('business_date', d::text, 'idempotency_key', key, 'rows', rows), shop) $$;
create function pg_temp.correction_decision(request_key text, key text) returns jsonb language sql as $$
  select pg_temp.cmd(jsonb_build_object('request_id', (select id from public.correction_requests where shop_id = pg_temp.s1() and idempotency_key = request_key),
    'expected_revision', 0, 'decision', 'approved', 'reason', null, 'idempotency_key', key)) $$;

-- Fixed customer ids so tie-break ordering is assertable. CC < CD so an
-- exact sales tie between them must resolve CC first.
create function pg_temp.ca() returns uuid language sql immutable as $$ select 'c6000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.cb() returns uuid language sql immutable as $$ select 'c6000000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.cc() returns uuid language sql immutable as $$ select 'c6000000-0000-4000-8000-000000000003'::uuid $$;
create function pg_temp.cd() returns uuid language sql immutable as $$ select 'c6000000-0000-4000-8000-000000000004'::uuid $$;
create function pg_temp.ce() returns uuid language sql immutable as $$ select 'c6000000-0000-4000-8000-000000000005'::uuid $$;

insert into public.customers(id, shop_id, name, mobile, created_by) values
  (pg_temp.ca(), pg_temp.s1(), 'TC6 Alice', '55560001', '10000000-0000-4000-8000-000000000102'),
  (pg_temp.cb(), pg_temp.s1(), 'TC6 Bob', '55560002', '10000000-0000-4000-8000-000000000102'),
  (pg_temp.cc(), pg_temp.s1(), 'TC6 Cara', '55560003', '10000000-0000-4000-8000-000000000102'),
  (pg_temp.cd(), pg_temp.s1(), 'TC6 Dee', '55560004', '10000000-0000-4000-8000-000000000102'),
  (pg_temp.ce(), pg_temp.s2(), 'TC6 Eve', '55560005', '10000000-0000-4000-8000-000000000103');

-- 1. Schema ------------------------------------------------------------------
select has_function('public', 'report_top_customers_by_sales', array['uuid','date','date','int4'], 'top-customers-by-sales RPC exists');
select has_function('public', 'report_top_customers_by_payments', array['uuid','date','date','int4'], 'top-customers-by-payments RPC exists');
select ok(not has_function_privilege('anon', 'public.report_top_customers_by_sales(uuid,date,date,int4)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.report_top_customers_by_payments(uuid,date,date,int4)', 'EXECUTE'), 'anon cannot execute either RPC');

set local role authenticated;
select pg_temp.act('staff');

-- 2. Build a period with more distinct customers than a naive small cap, an
-- anonymous invoice, an out-of-window invoice, and a corrected invoice -------
select public.submit_batch(pg_temp.batch('tc6-batch-1', current_date, jsonb_build_array(
  pg_temp.row('TC6-A1', 1000, 600, pg_temp.ca()),
  pg_temp.row('TC6-B1', 700, 0, pg_temp.cb()),
  pg_temp.row('TC6-C1', 400, 400, pg_temp.cc()),
  pg_temp.row('TC6-D1', 400, 0, pg_temp.cd()),
  pg_temp.row('TC6-ANON', 99999, 99999, null))));
select pg_temp.act('owner');
select public.submit_batch(pg_temp.cmd(jsonb_build_object('business_date', (current_date - 20)::text, 'idempotency_key', 'tc6-batch-old',
  'is_backdated', true, 'backdated_reason', 'test backfill', 'rows', jsonb_build_array(pg_temp.row('TC6-OLD', 5000, 5000, pg_temp.ca())))));
select pg_temp.act('staff');
select public.record_payment(pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('TC6-B1'), 'amount_dirham', 700, 'payment_method', 'cash', 'business_date', current_date::text, 'idempotency_key', 'tc6-pay-b1')));
select public.record_payment(pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('TC6-D1'), 'amount_dirham', 100, 'payment_method', 'cash', 'business_date', current_date::text, 'idempotency_key', 'tc6-pay-d1')));
select public.request_invoice_correction(pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('TC6-A1'), 'payment_id', null, 'amount_delta_dirham', -200, 'reason', 'price agreed lower', 'idempotency_key', 'tc6-corr-a1')));
select public.request_invoice_correction(pg_temp.cmd(jsonb_build_object('invoice_id', pg_temp.inv('TC6-B1'), 'payment_id', (select id from public.payments where shop_id = pg_temp.s1() and idempotency_key = 'tc6-pay-b1'), 'amount_delta_dirham', -50, 'reason', 'counted cash again', 'idempotency_key', 'tc6-corr-b1')));
select pg_temp.act('manager');
select public.decide_invoice_correction(pg_temp.correction_decision('tc6-corr-a1', 'tc6-corr-dec-a1'));
select public.decide_invoice_correction(pg_temp.correction_decision('tc6-corr-b1', 'tc6-corr-dec-b1'));
select pg_temp.act('staff');

-- 3. Sales ranking: effective (corrected) totals, anonymous excluded, deterministic ties ---
-- Value correctness (order forced by the test query, independent of the RPC's own ordering):
select is(
  (select array_agg(jsonb_build_object('customer_id', customer_id, 'amount_dirham', amount_dirham) order by amount_dirham desc, customer_id)
   from public.report_top_customers_by_sales(pg_temp.s1(), current_date - 10, current_date, 5)),
  array[
    jsonb_build_object('customer_id', pg_temp.ca(), 'amount_dirham', 800),
    jsonb_build_object('customer_id', pg_temp.cb(), 'amount_dirham', 700),
    jsonb_build_object('customer_id', pg_temp.cc(), 'amount_dirham', 400),
    jsonb_build_object('customer_id', pg_temp.cd(), 'amount_dirham', 400)
  ],
  'sales ranking aggregates effective totals per customer, excludes the anonymous invoice, and has no extra/missing rows'
);
-- Row order as the RPC itself returns it (no ORDER BY added by the test): the
-- Cara/Dee sales tie (both 400) must resolve to the lower customer id first.
select is(
  (select array_agg(customer_id) from public.report_top_customers_by_sales(pg_temp.s1(), current_date - 10, current_date, 5)),
  array[pg_temp.ca(), pg_temp.cb(), pg_temp.cc(), pg_temp.cd()],
  'the RPC''s own row order is deterministic and breaks the sales tie by customer id'
);
select is((select name from public.report_top_customers_by_sales(pg_temp.s1(), current_date - 10, current_date, 5) where customer_id = pg_temp.ca()), 'TC6 Alice', 'the ranked row carries the customer name');
select is((select count(*)::int from public.report_top_customers_by_sales(pg_temp.s1(), current_date - 10, current_date, 2)), 2, 'p_limit bounds the number of rows returned');
select is(
  (select amount_dirham from public.report_top_customers_by_sales(pg_temp.s1(), current_date - 10, current_date, 5) where customer_id = pg_temp.ca()),
  (select effective_total_dirham from public.effective_invoices where shop_id = pg_temp.s1() and original_invoice_number = 'TC6-A1'),
  'the ranked sales amount matches the effective_invoices projection used elsewhere on the dashboard'
);

-- 4. Payments ranking: independent of the sales order, corrected amounts, anonymous excluded ---
select is(
  (select array_agg(jsonb_build_object('customer_id', customer_id, 'amount_dirham', amount_dirham) order by amount_dirham desc, customer_id)
   from public.report_top_customers_by_payments(pg_temp.s1(), current_date - 10, current_date, 5)),
  array[
    jsonb_build_object('customer_id', pg_temp.cb(), 'amount_dirham', 650),
    jsonb_build_object('customer_id', pg_temp.ca(), 'amount_dirham', 600),
    jsonb_build_object('customer_id', pg_temp.cc(), 'amount_dirham', 400),
    jsonb_build_object('customer_id', pg_temp.cd(), 'amount_dirham', 100)
  ],
  'payments ranking is its own aggregation (different order from sales: Bob now ranks above Alice), reflects the approved payment correction, and excludes the anonymous invoice'
);
select is(
  (select array_agg(customer_id) from public.report_top_customers_by_payments(pg_temp.s1(), current_date - 10, current_date, 5)),
  array[pg_temp.cb(), pg_temp.ca(), pg_temp.cc(), pg_temp.cd()],
  'the RPC''s own row order for payments ranks Bob above Alice, unlike the sales ranking'
);

-- 5. Date range filtering ----------------------------------------------------
select is((select count(*)::int from public.report_top_customers_by_sales(pg_temp.s1(), current_date - 10, current_date, 5) where customer_id = pg_temp.ca() and amount_dirham = 5000), 0, 'the out-of-window invoice is not folded into the in-window total');
select is(
  (select array_agg(jsonb_build_object('customer_id', customer_id, 'amount_dirham', amount_dirham))
   from public.report_top_customers_by_sales(pg_temp.s1(), current_date - 25, current_date - 15, 5)),
  array[jsonb_build_object('customer_id', pg_temp.ca(), 'amount_dirham', 5000)],
  'a window covering only the earlier date reports only the earlier invoice'
);
select is((select count(*)::int from public.report_top_customers_by_payments(pg_temp.s1(), current_date - 25, current_date - 15, 5)), 1, 'date filtering applies identically to the payments ranking');

-- 6. No unauthorized cross-shop aggregation ----------------------------------
select is((select count(*)::int from public.report_top_customers_by_sales(pg_temp.s2(), current_date - 10, current_date, 5)), 0, 'staff assigned only to shop 1 sees nothing when passing shop 2''s id');
select is((select count(*)::int from public.report_top_customers_by_payments(pg_temp.s2(), current_date - 10, current_date, 5)), 0, 'the same isolation holds for the payments ranking');
select pg_temp.act('staff2');
select is((select count(*)::int from public.report_top_customers_by_sales(pg_temp.s1(), current_date - 10, current_date, 5)), 0, 'staff assigned only to shop 2 sees nothing when passing shop 1''s id');

-- Shop 2 genuinely has data; an authorized actor sees it, confirming the
-- isolation above is RLS, not an empty shop.
select public.submit_batch(pg_temp.batch('tc6-batch-shop2', current_date, jsonb_build_array(pg_temp.row('TC6-E1', 300, 300, pg_temp.ce())), pg_temp.s2()));
select is(
  (select array_agg(jsonb_build_object('customer_id', customer_id, 'amount_dirham', amount_dirham))
   from public.report_top_customers_by_sales(pg_temp.s2(), current_date - 10, current_date, 5)),
  array[jsonb_build_object('customer_id', pg_temp.ce(), 'amount_dirham', 300)],
  'staff assigned to shop 2 sees shop 2''s own ranking'
);
select pg_temp.act('owner');
select is((select count(*)::int from public.report_top_customers_by_sales(pg_temp.s2(), current_date - 10, current_date, 5)), 1, 'the owner, who holds both shops, also sees shop 2''s ranking');

reset role;

select * from finish();
rollback;
