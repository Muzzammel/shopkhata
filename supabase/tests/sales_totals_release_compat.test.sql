begin;
set local timezone = 'Asia/Qatar';
create extension if not exists pgtap with schema extensions;
select no_plan();

-- OPS-01B release compatibility (20261103203806). report_sales_totals must serve BOTH the pre-OPS-01B application
-- (e4f4cfe: reads effective_total_dirham) and the OPS-01B application (reads gross/corrections/net). The legacy field is an
-- alias of business-date net sales, so a void on D3 of a D1 invoice never rewrites D1, for either application.

create function pg_temp.s1() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.owner() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-000000000101'::uuid $$;
create function pg_temp.inv() returns uuid language sql immutable as $$ select 'a8100000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.t(f date, t date) returns jsonb language sql as $$
  select to_jsonb(x) from public.report_sales_totals(pg_temp.s1(), f, t) x $$;
create function pg_temp.legacy(f date, t date) returns bigint language sql as $$ select (pg_temp.t(f, t) ->> 'effective_total_dirham')::bigint $$;

-- 1. Catalog and security ---------------------------------------------------------------------------------------
select ok(pg_temp.t(current_date, current_date) ?& array['invoice_count', 'effective_total_dirham', 'effective_paid_dirham', 'credit_applied_dirham',
  'effective_due_dirham', 'delivered_count', 'undelivered_count'], 'the full e4f4cfe contract (7 fields) is returned');
select ok(pg_temp.t(current_date, current_date) ?& array['gross_sales_dirham', 'sales_corrections_dirham', 'net_sales_dirham'], 'the OPS-01B movement fields are returned');
select is((select count(*)::int from jsonb_object_keys(pg_temp.t(current_date, current_date))), 11, 'exactly 11 output fields');
select ok(has_function_privilege('authenticated', 'public.report_sales_totals(uuid,date,date)', 'execute'), 'authenticated can execute');
select ok(not has_function_privilege('anon', 'public.report_sales_totals(uuid,date,date)', 'execute'), 'anon cannot execute');
select ok(not exists(select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = 'public.report_sales_totals(uuid,date,date)'::regprocedure and a.grantee = 0), 'PUBLIC has no grant');
select is((select array[prosecdef::text, provolatile::text, array_to_string(proconfig, ',')] from pg_proc where oid = 'public.report_sales_totals(uuid,date,date)'::regprocedure),
  array['false', 's', 'search_path=""'], 'still security invoker, stable, empty search_path');

-- 2. Accounting: invoice +100 on D1, void -100 today (D3) -------------------------------------------------------
create temp table before_void as select pg_temp.t(current_date - 2, current_date - 2) d1, pg_temp.t(current_date, current_date) d3, pg_temp.t(current_date - 2, current_date) r;
insert into public.invoices(id, shop_id, invoice_id, total_amount_dirham, business_date, delivered, created_by)
  values (pg_temp.inv(), pg_temp.s1(), 'COMPAT-1', 10000, current_date - 2, true, pg_temp.owner());
insert into public.invoice_number_registry(shop_id, invoice_number, canonical_invoice_id) values (pg_temp.s1(), 'COMPAT-1', pg_temp.inv());
create temp table after_sale as select pg_temp.t(current_date - 2, current_date - 2) d1, pg_temp.t(current_date, current_date) d3, pg_temp.t(current_date - 2, current_date) r;
grant select on before_void, after_sale to public;

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', pg_temp.owner())::text, true);
select lives_ok($$select public.void_invoice(jsonb_build_object('shop_id', pg_temp.s1(), 'invoice_id', pg_temp.inv(), 'reason', 'Compat test void', 'idempotency_key', 'compat-1'))$$, 'void the D1 invoice today');

select is(pg_temp.legacy(current_date - 2, current_date - 2) - (select (d1 ->> 'effective_total_dirham')::bigint from before_void), 10000::bigint, 'legacy field: D1 keeps +100 after the void');
select is(pg_temp.legacy(current_date, current_date) - (select (d3 ->> 'effective_total_dirham')::bigint from before_void), -10000::bigint, 'legacy field: today shows -100');
select is(pg_temp.legacy(current_date - 2, current_date), (select (r ->> 'effective_total_dirham')::bigint from before_void), 'legacy field: range D1..today nets the invoice to 0');
select is((pg_temp.t(current_date - 2, current_date - 2) ->> 'gross_sales_dirham')::bigint - (select (d1 ->> 'gross_sales_dirham')::bigint from before_void), 10000::bigint, 'new fields: D1 gross keeps +100');
select is((pg_temp.t(current_date, current_date) ->> 'sales_corrections_dirham')::bigint - (select (d3 ->> 'sales_corrections_dirham')::bigint from before_void), -10000::bigint, 'new fields: today corrections -100');
select is(pg_temp.t(current_date - 2, current_date - 2) - array['effective_paid_dirham', 'credit_applied_dirham', 'effective_due_dirham', 'delivered_count', 'undelivered_count'],
  (select d1 - array['effective_paid_dirham', 'credit_applied_dirham', 'effective_due_dirham', 'delivered_count', 'undelivered_count'] from after_sale), 'D1 sales (legacy and new) identical before and after the void');
select is((select array[effective_total_dirham, is_void::int] from public.effective_invoices where canonical_invoice_id = pg_temp.inv()), array[0, 1]::bigint[], 'current invoice state: VOID, total 0');

-- 3. The alias always equals net, and net equals Daily Close, for several windows -------------------------------
select is((select count(*)::int from generate_series(current_date - 7, current_date, '1 day') f(d)
  where (pg_temp.t(f.d::date, current_date) ->> 'effective_total_dirham') is distinct from (pg_temp.t(f.d::date, current_date) ->> 'net_sales_dirham')), 0, 'effective_total_dirham = net_sales_dirham on every window');
select is(pg_temp.legacy(current_date - 2, current_date),
  (select sum(gross_invoice_dirham + invoice_corrections_dirham)::bigint from public.report_daily_summary(pg_temp.s1(), current_date - 2, current_date)), 'legacy field reconciles with Daily Close');

-- 4. Shop filtering: shop 2 staff sees nothing of shop 1 through either field -----------------------------------
select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', '10000000-0000-4000-8000-000000000103')::text, true);
select is(pg_temp.t(current_date - 2, current_date) ->> 'invoice_count', '0', 'shop 2 staff: no shop 1 invoices');
select is(pg_temp.legacy(current_date - 2, current_date - 2), 0::bigint, 'shop 2 staff: legacy field is 0 for shop 1');

select * from finish();
rollback;
