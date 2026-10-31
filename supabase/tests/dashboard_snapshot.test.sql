begin;
set local timezone = 'Asia/Qatar';
create extension if not exists pgtap with schema extensions;
select plan(40);

-- Helpers -------------------------------------------------------------------
create function pg_temp.act(who text) returns void language sql as $$
  select set_config('request.jwt.claims', case who when 'none' then '' else jsonb_build_object('role', 'authenticated', 'sub', case who
    when 'owner' then '10000000-0000-4000-8000-000000000101' when 'staff' then '10000000-0000-4000-8000-000000000102'
    when 'staff2' then '10000000-0000-4000-8000-000000000103' when 'manager' then '10000000-0000-4000-8000-000000000104'
    when 'unassigned' then 'd4000000-0000-4000-8000-000000000201' when 'inactive' then 'd4000000-0000-4000-8000-000000000202' end)::text end, true)
$$;
-- Two shops of this test only, so rows already in the database never reach the figures below.
create function pg_temp.s1() returns uuid language sql immutable as $$ select 'd4000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.s2() returns uuid language sql immutable as $$ select 'd4000000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.id(label text) returns uuid language sql immutable as $$ select md5('perf04d-' || label)::uuid $$;
create function pg_temp.snap(s uuid, f date, t date, comps uuid[] default '{}') returns jsonb language sql as $$
  select public.report_dashboard_snapshot(s, f, t, comps) $$;

-- The same document rebuilt from the reads the Dashboard made before PERF-04D, run under the caller's RLS:
-- report_sales_totals, the three effective_invoices counts, report_customer_due_totals, report_payment_totals,
-- report_expense_totals, report_daily_summary, report_top_customers_by_*, customer_financial_balances (+ customers),
-- effective_expenses and daily_closes (+ profiles). Two deliberate differences, both representation only:
-- report_*_totals return a zero grand-total row for an empty range (dropped here: entry/expense_count > 0), and the
-- three balance/expense lists that had no tie-breaker get the snapshot's id tie-break.
create function pg_temp.old_shop(s uuid, f date, t date) returns jsonb language sql as $$
  select jsonb_build_object('shop_id', s,
    'sales', (select jsonb_build_object('invoice_count', x.invoice_count, 'effective_total_dirham', x.effective_total_dirham,
        'effective_due_dirham', x.effective_due_dirham, 'delivered_count', x.delivered_count, 'undelivered_count', x.undelivered_count,
        'fully_paid_count', (select count(*) from public.effective_invoices e where e.shop_id = s and e.business_date between f and t and e.effective_due_dirham <= 0),
        'with_due_count', (select count(*) from public.effective_invoices e where e.shop_id = s and e.business_date between f and t and e.effective_due_dirham > 0),
        'anonymous_count', (select count(*) from public.effective_invoices e where e.shop_id = s and e.business_date between f and t and e.effective_customer_id is null))
      from public.report_sales_totals(s, f, t) x),
    'due', (select jsonb_build_object('customers_with_due', d.customers_with_due, 'outstanding_due_dirham', d.outstanding_due_dirham,
        'available_credit_dirham', d.available_credit_dirham) from public.report_customer_due_totals(s) d),
    'payment_totals', (select coalesce(jsonb_agg(to_jsonb(r) order by r.source nulls last, r.method nulls last), '[]')
      from public.report_payment_totals(s, f, t) r where r.entry_count > 0),
    'expense_totals', (select coalesce(jsonb_agg(to_jsonb(r) order by r.category nulls last), '[]')
      from public.report_expense_totals(s, f, t) r where r.expense_count > 0))
$$;
create function pg_temp.old_snap(s uuid, f date, t date, comps uuid[] default '{}') returns jsonb language sql as $$
  select jsonb_build_object(
    'shops', (select jsonb_agg(pg_temp.old_shop(x.id, f, t) order by x.ord) from (
        select s id, 0::bigint ord union all select c, o from unnest(comps) with ordinality u(c, o) where c <> s
      ) x where exists (select 1 from public.shops where id = x.id)),
    'daily', (select coalesce(jsonb_agg(to_jsonb(d) order by d.business_date), '[]') from public.report_daily_summary(s, f, t) d),
    'largest_dues', (select coalesce(jsonb_agg(to_jsonb(x) order by x.outstanding_due_dirham desc, x.customer_id), '[]') from (
        select b.customer_id, c.public_id, c.name, c.mobile, b.outstanding_due_dirham, b.available_credit_dirham, b.invoice_count, b.last_activity_date
        from public.customer_financial_balances b join public.customers c on c.shop_id = b.shop_id and c.id = b.customer_id
        where b.shop_id = s and (b.outstanding_due_dirham > 0 or b.available_credit_dirham > 0) order by b.outstanding_due_dirham desc, b.customer_id limit 5) x),
    'credit_customers', (select coalesce(jsonb_agg(to_jsonb(x) order by x.available_credit_dirham desc, x.customer_id), '[]') from (
        select b.customer_id, c.public_id, c.name, b.available_credit_dirham
        from public.customer_financial_balances b join public.customers c on c.shop_id = b.shop_id and c.id = b.customer_id
        where b.shop_id = s and b.available_credit_dirham > 0 order by b.available_credit_dirham desc, b.customer_id limit 5) x),
    'recently_active', (select coalesce(jsonb_agg(to_jsonb(x) order by x.last_activity_date desc, x.customer_id), '[]') from (
        select b.customer_id, c.public_id, c.name, b.last_activity_date
        from public.customer_financial_balances b join public.customers c on c.shop_id = b.shop_id and c.id = b.customer_id
        where b.shop_id = s and b.last_activity_date is not null order by b.last_activity_date desc, b.customer_id limit 5) x),
    'top_by_sales', (select coalesce(jsonb_agg(to_jsonb(r) order by r.amount_dirham desc, r.customer_id), '[]') from public.report_top_customers_by_sales(s, f, t, 5) r),
    'top_by_payments', (select coalesce(jsonb_agg(to_jsonb(r) order by r.amount_dirham desc, r.customer_id), '[]') from public.report_top_customers_by_payments(s, f, t, 5) r),
    'recent_expenses', (select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at desc, x.id), '[]') from (
        select x.id, x.business_date, x.recorded_at, x.category, x.description, x.amount_dirham
        from public.effective_expenses x where x.shop_id = s order by x.recorded_at desc, x.id limit 8) x),
    'largest_expenses', (select coalesce(jsonb_agg(to_jsonb(x) order by x.amount_dirham desc, x.id), '[]') from (
        select x.id, x.business_date, x.recorded_at, x.category, x.description, x.amount_dirham
        from public.effective_expenses x where x.shop_id = s and x.business_date between f and t order by x.amount_dirham desc, x.id limit 5) x),
    'closes', (select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at desc, x.event_sequence desc), '[]') from (
        select d.event_sequence, d.event_type, d.actor_id, d.recorded_at, d.reason, d.note, d.business_date, p.display_name actor_name
        from (select * from public.daily_closes d where d.shop_id = s order by d.recorded_at desc, d.event_sequence desc limit 10) d
        left join public.profiles p on p.id = d.actor_id) x))
$$;

-- Fixture (direct inserts, append-only and closed-date triggers off for this rolled-back transaction) ----------------------
-- Shop 1: fully paid, partly paid (bank), no-customer, corrected (+ an unapproved correction), replaced to another
-- (nameless) customer, payment-corrected, credit-applied, old (outside the year) invoices; overpayment credit kept
-- (bank) and a pending credit; expenses with an amount tie and an approved correction; a closed / reopened / closed
-- history. Shop 2: one partly paid invoice, one expense.
insert into auth.users(id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, confirmation_token, recovery_token, email_change, email_change_token_new, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', email, '', now(), '', '', '', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()
from (values ('d4000000-0000-4000-8000-000000000201'::uuid, 'p4d-unassigned@shopkhata.local'), ('d4000000-0000-4000-8000-000000000202'::uuid, 'p4d-inactive@shopkhata.local')) v(id, email);
insert into public.profiles(id, email, display_name, role, is_active) values
  ('d4000000-0000-4000-8000-000000000201', 'p4d-unassigned@shopkhata.local', 'P4D Unassigned', 'staff', true),
  ('d4000000-0000-4000-8000-000000000202', 'p4d-inactive@shopkhata.local', 'P4D Inactive', 'staff', false);
insert into public.shops(id, name) values (pg_temp.s1(), 'P4D Shop 1'), (pg_temp.s2(), 'P4D Shop 2');
-- Staff and manager of shop 1, staff 2 of shop 2 (as in the seed), the inactive account of shop 1; the owner reads every shop.
insert into public.user_shop_assignments(user_id, shop_id) values
  ('10000000-0000-4000-8000-000000000102', pg_temp.s1()), ('10000000-0000-4000-8000-000000000104', pg_temp.s1()),
  ('10000000-0000-4000-8000-000000000103', pg_temp.s2()), ('d4000000-0000-4000-8000-000000000202', pg_temp.s1());

do $$ declare t text; begin
  foreach t in array array['batches','invoices','payments','corrections','customer_credits','credit_applications','credit_application_batches',
    'replacement_requests','replacement_decisions','expenses','expense_correction_requests','expense_correction_decisions','daily_closes'] loop
    execute format('alter table public.%I disable trigger user', t);
  end loop;
end $$;

insert into public.customers(id, shop_id, name, mobile, created_by) values
  (pg_temp.id('A'), pg_temp.s1(), 'P4D Alice', '55570001', null), (pg_temp.id('B'), pg_temp.s1(), 'P4D Bob', '55570002', null),
  (pg_temp.id('C'), pg_temp.s1(), 'P4D Cara', null, null), (pg_temp.id('D'), pg_temp.s1(), null, '55570004', null),
  (pg_temp.id('E'), pg_temp.s2(), 'P4D Eve', '55570005', null);
insert into public.batches(id, shop_id, business_date, is_backdated, created_by, recorded_at)
values (pg_temp.id('b1'), pg_temp.s1(), current_date, false, '10000000-0000-4000-8000-000000000102', now() - interval '3 hours');
insert into public.invoices(id, shop_id, batch_id, customer_id, invoice_id, total_amount_dirham, business_date, recorded_at, created_by, delivered) values
  (pg_temp.id('i1'), pg_temp.s1(), pg_temp.id('b1'), pg_temp.id('A'), 'P4D-1', 1000, current_date, now() - interval '3 hours', null, true),
  (pg_temp.id('i2'), pg_temp.s1(), pg_temp.id('b1'), pg_temp.id('B'), 'P4D-2', 800, current_date, now() - interval '3 hours', null, true),
  (pg_temp.id('i3'), pg_temp.s1(), pg_temp.id('b1'), null, 'P4D-3', 500, current_date, now() - interval '3 hours', null, false),
  (pg_temp.id('i4'), pg_temp.s1(), null, pg_temp.id('C'), 'P4D-4', 700, current_date - 3, now() - interval '3 days', null, true),
  (pg_temp.id('i5'), pg_temp.s1(), null, pg_temp.id('A'), 'P4D-5', 400, current_date - 40, now() - interval '40 days', null, false),
  (pg_temp.id('i6'), pg_temp.s1(), null, pg_temp.id('B'), 'P4D-6', 600, current_date, now() - interval '2 hours', null, true),
  (pg_temp.id('i7'), pg_temp.s1(), null, pg_temp.id('C'), 'P4D-7', 300, current_date, now() - interval '2 hours', null, true),
  (pg_temp.id('i8'), pg_temp.s1(), null, pg_temp.id('D'), 'P4D-8', 250, current_date - 400, now() - interval '400 days', null, true),
  (pg_temp.id('i9'), pg_temp.s2(), null, pg_temp.id('E'), 'P4D-9', 900, current_date, now() - interval '1 hour', null, true);
insert into public.payments(id, shop_id, batch_id, invoice_id, amount_dirham, business_date, payment_method, recorded_at, created_by) values
  (pg_temp.id('p1'), pg_temp.s1(), pg_temp.id('b1'), pg_temp.id('i1'), 1000, current_date, 'cash', now() - interval '3 hours', null),
  (pg_temp.id('p2'), pg_temp.s1(), pg_temp.id('b1'), pg_temp.id('i2'), 300, current_date, 'bank', now() - interval '3 hours', null),
  (pg_temp.id('p6'), pg_temp.s1(), null, pg_temp.id('i6'), 600, current_date, 'bank', now() - interval '2 hours', null),
  (pg_temp.id('p5'), pg_temp.s1(), null, pg_temp.id('i5'), 100, current_date - 2, 'cash', now() - interval '2 days', null),
  (pg_temp.id('p9'), pg_temp.s2(), null, pg_temp.id('i9'), 100, current_date, 'cash', now() - interval '1 hour', null);
insert into public.corrections(id, shop_id, invoice_id, payment_id, amount_delta_dirham, reason, business_date, recorded_at, created_by, approved_by) values
  (pg_temp.id('c4'), pg_temp.s1(), pg_temp.id('i4'), null, 100, 'p4d', current_date - 1, now() - interval '1 day', null, '10000000-0000-4000-8000-000000000104'),
  (pg_temp.id('c4x'), pg_temp.s1(), pg_temp.id('i4'), null, 999, 'p4d unapproved', current_date - 1, now() - interval '1 day', null, null),
  (pg_temp.id('c6'), pg_temp.s1(), null, pg_temp.id('p6'), -50, 'p4d', current_date, now() - interval '1 hour', null, '10000000-0000-4000-8000-000000000104');
insert into public.replacement_requests(id, shop_id, invoice_id, expected_revision, invoice_number, customer_id, delivered, reason, requested_by, requested_at, idempotency_key, fingerprint)
values (pg_temp.id('r5'), pg_temp.s1(), pg_temp.id('i5'), 0, 'P4D-5R', pg_temp.id('D'), true, 'p4d', '10000000-0000-4000-8000-000000000102', now() - interval '1 day', 'p4d-r5', 'p4d');
insert into public.replacement_decisions(id, shop_id, request_id, invoice_id, decision, expected_revision, revision, decided_by, decided_at, idempotency_key, fingerprint)
values (pg_temp.id('rd5'), pg_temp.s1(), pg_temp.id('r5'), pg_temp.id('i5'), 'approved', 0, 1, '10000000-0000-4000-8000-000000000104', now() - interval '1 day', 'p4d-rd5', 'p4d');
insert into public.customer_credits(id, shop_id, customer_id, invoice_id, amount_dirham, business_date, reason, recorded_at, created_by, approved_by, approved_at, payment_method) values
  (pg_temp.id('cc1'), pg_temp.s1(), pg_temp.id('C'), pg_temp.id('i4'), 450, current_date - 1, 'p4d', now() - interval '1 day', null, '10000000-0000-4000-8000-000000000104', now() - interval '1 day', 'bank'),
  (pg_temp.id('cc2'), pg_temp.s1(), pg_temp.id('B'), null, 999, current_date, 'p4d pending', now(), null, null, null, 'cash');
insert into public.credit_application_batches(id, shop_id, customer_id, amount_dirham, business_date, idempotency_key, fingerprint, idempotency_result, created_by, recorded_at)
values (pg_temp.id('cab'), pg_temp.s1(), pg_temp.id('C'), 200, current_date, 'p4d-cab', 'p4d', '{}', '10000000-0000-4000-8000-000000000104', now() - interval '30 minutes');
insert into public.credit_applications(shop_id, customer_id, batch_id, credit_id, invoice_id, amount_dirham, business_date, recorded_at, created_by)
values (pg_temp.s1(), pg_temp.id('C'), pg_temp.id('cab'), pg_temp.id('cc1'), pg_temp.id('i7'), 200, current_date, now() - interval '30 minutes', '10000000-0000-4000-8000-000000000104');
insert into public.expenses(id, shop_id, description, amount_dirham, business_date, recorded_at, created_by, category) values
  (pg_temp.id('e1'), pg_temp.s1(), 'P4D rent a', 500, current_date, now() - interval '50 minutes', null, 'rent'),
  (pg_temp.id('e2'), pg_temp.s1(), 'P4D rent b', 500, current_date, now() - interval '40 minutes', null, 'rent'),
  (pg_temp.id('e3'), pg_temp.s1(), 'P4D supplies', 200, current_date - 2, now() - interval '2 days', null, 'supplies'),
  (pg_temp.id('e4'), pg_temp.s1(), 'P4D old', 50, current_date - 100, now() - interval '100 days', null, 'other'),
  (pg_temp.id('e5'), pg_temp.s2(), 'P4D shop 2', 300, current_date, now() - interval '20 minutes', null, 'utilities');
insert into public.expense_correction_requests(id, shop_id, expense_id, amount_dirham, category, description, reason, requested_by, requested_at, idempotency_key, fingerprint)
values (pg_temp.id('er3'), pg_temp.s1(), pg_temp.id('e3'), 900, 'other', 'P4D supplies (corrected)', 'p4d', '10000000-0000-4000-8000-000000000102', now() - interval '1 day', 'p4d-er3', 'p4d');
insert into public.expense_correction_decisions(id, shop_id, request_id, expense_id, decision, decided_by, decided_at, idempotency_key, fingerprint)
values (pg_temp.id('ed3'), pg_temp.s1(), pg_temp.id('er3'), pg_temp.id('e3'), 'approved', '10000000-0000-4000-8000-000000000104', now() - interval '1 day', 'p4d-ed3', 'p4d');
insert into public.daily_closes(shop_id, business_date, event_type, actor_id, recorded_at, reason) values
  (pg_temp.s1(), current_date - 1, 'closed', '10000000-0000-4000-8000-000000000104', now() - interval '20 hours', null),
  (pg_temp.s1(), current_date - 1, 'reopened', '10000000-0000-4000-8000-000000000101', now() - interval '19 hours', 'late delivery'),
  (pg_temp.s1(), current_date - 1, 'closed', null, now() - interval '18 hours', null),
  (pg_temp.s1(), current_date, 'closed', '10000000-0000-4000-8000-000000000102', now() - interval '10 minutes', null);

-- Triggers stay off until the final rollback restores them (re-enabling here would trip the deferred FK events).

-- 1. Contract and security properties --------------------------------------------------------------------------
select has_function('public', 'report_dashboard_snapshot', array['uuid', 'date', 'date', 'uuid[]'], 'snapshot RPC exists');
select is((select p.prosecdef from pg_proc p where p.oid = 'public.report_dashboard_snapshot(uuid,date,date,uuid[])'::regprocedure), false, 'SECURITY INVOKER');
select is((select p.provolatile from pg_proc p where p.oid = 'public.report_dashboard_snapshot(uuid,date,date,uuid[])'::regprocedure), 's', 'STABLE');
select ok((select 'search_path=""' = any(p.proconfig) from pg_proc p where p.oid = 'public.report_dashboard_snapshot(uuid,date,date,uuid[])'::regprocedure), 'empty search_path');
select ok(not has_function_privilege('anon', 'public.report_dashboard_snapshot(uuid,date,date,uuid[])', 'EXECUTE'), 'anon cannot execute');
select ok(has_function_privilege('authenticated', 'public.report_dashboard_snapshot(uuid,date,date,uuid[])', 'EXECUTE'), 'authenticated can execute');
select ok(not exists (select 1 from information_schema.routine_privileges where specific_name like 'report_dashboard_snapshot%' and grantee = 'PUBLIC'), 'PUBLIC has no EXECUTE');
select ok((select p.prosrc !~* '\mexecute\M' from pg_proc p where p.oid = 'public.report_dashboard_snapshot(uuid,date,date,uuid[])'::regprocedure), 'no dynamic SQL');

set local role authenticated;

-- 2. Equality with the pre-PERF-04D reads, per role, shop and range ------------------------------------------------
select pg_temp.act('owner');
select is(pg_temp.snap(pg_temp.s1(), current_date, current_date, array[pg_temp.s2()]), pg_temp.old_snap(pg_temp.s1(), current_date, current_date, array[pg_temp.s2()]), 'owner, shop 1 + comparison, Today');
select is(pg_temp.snap(pg_temp.s1(), current_date - 6, current_date, array[pg_temp.s2()]), pg_temp.old_snap(pg_temp.s1(), current_date - 6, current_date, array[pg_temp.s2()]), 'owner, shop 1 + comparison, 7 days');
select is(pg_temp.snap(pg_temp.s1(), current_date - 29, current_date, array[pg_temp.s2()]), pg_temp.old_snap(pg_temp.s1(), current_date - 29, current_date, array[pg_temp.s2()]), 'owner, shop 1 + comparison, 30 days');
select is(pg_temp.snap(pg_temp.s1(), current_date - 364, current_date, array[pg_temp.s2()]), pg_temp.old_snap(pg_temp.s1(), current_date - 364, current_date, array[pg_temp.s2()]), 'owner, shop 1 + comparison, Year');
select is(pg_temp.snap(pg_temp.s1(), current_date - 366, current_date, array[pg_temp.s2()]), pg_temp.old_snap(pg_temp.s1(), current_date - 366, current_date, array[pg_temp.s2()]), 'owner, shop 1, widest allowed range (366 days)');
select is(pg_temp.snap(pg_temp.s1(), current_date - 2, current_date - 2), pg_temp.old_snap(pg_temp.s1(), current_date - 2, current_date - 2), 'owner, shop 1, one past day, no comparison');
select is(pg_temp.snap(pg_temp.s2(), current_date, current_date, array[pg_temp.s1()]), pg_temp.old_snap(pg_temp.s2(), current_date, current_date, array[pg_temp.s1()]), 'owner, shop 2 + comparison, Today');
select is(pg_temp.snap(pg_temp.s2(), current_date - 364, current_date, array[pg_temp.s1()]), pg_temp.old_snap(pg_temp.s2(), current_date - 364, current_date, array[pg_temp.s1()]), 'owner, shop 2 + comparison, Year');
select pg_temp.act('manager');
select is(pg_temp.snap(pg_temp.s1(), current_date, current_date), pg_temp.old_snap(pg_temp.s1(), current_date, current_date), 'manager, shop 1, Today');
select is(pg_temp.snap(pg_temp.s1(), current_date - 364, current_date), pg_temp.old_snap(pg_temp.s1(), current_date - 364, current_date), 'manager, shop 1, Year');
select pg_temp.act('staff');
select is(pg_temp.snap(pg_temp.s1(), current_date, current_date), pg_temp.old_snap(pg_temp.s1(), current_date, current_date), 'staff, shop 1, Today');
select is(pg_temp.snap(pg_temp.s1(), current_date - 29, current_date), pg_temp.old_snap(pg_temp.s1(), current_date - 29, current_date), 'staff, shop 1, 30 days');
select pg_temp.act('staff2');
select is(pg_temp.snap(pg_temp.s2(), current_date, current_date), pg_temp.old_snap(pg_temp.s2(), current_date, current_date), 'staff 2, shop 2, Today');
select is(pg_temp.snap(pg_temp.s2(), current_date - 364, current_date), pg_temp.old_snap(pg_temp.s2(), current_date - 364, current_date), 'staff 2, shop 2, Year');

-- 3. The fixture's own figures (hand-computed), so the equality above is not vacuous -------------------------------
select pg_temp.act('owner');
select is(pg_temp.snap(pg_temp.s1(), current_date, current_date) #> '{shops,0,sales}',
  '{"invoice_count": 5, "effective_total_dirham": 3200, "effective_due_dirham": 1150, "delivered_count": 4, "undelivered_count": 1,
    "fully_paid_count": 1, "with_due_count": 4, "anonymous_count": 1}'::jsonb,
  'Today sales 1000+800+500+600+300; due 0+500+500+50+100 (payment correction -50, credit applied 200)');
select is(pg_temp.snap(pg_temp.s1(), current_date, current_date) #> '{shops,0,due}',
  '{"customers_with_due": 3, "outstanding_due_dirham": 2000, "available_credit_dirham": 250}'::jsonb,
  'current balances: A 0, B 500+50, C 800+100 (unapproved correction ignored), D 300+250 (replaced invoice), credit C 450-200; no-customer invoice and pending credit excluded');
select is((select jsonb_agg(x ->> 'customer_id' order by ord) from jsonb_array_elements(pg_temp.snap(pg_temp.s1(), current_date - 364, current_date) -> 'top_by_sales') with ordinality t(x, ord)),
  jsonb_build_array(pg_temp.id('B'), pg_temp.id('C'), pg_temp.id('A'), pg_temp.id('D')), 'Year top sales: B 800+600, C 700+100+300, A 1000, D 400 (the replaced invoice); the invoice older than a year is out');
select is(pg_temp.snap(pg_temp.s1(), current_date, current_date) -> 'largest_expenses' -> 0 ->> 'id', least(pg_temp.id('e1'), pg_temp.id('e2'))::text, 'equal largest expenses break ties on id');
select is(pg_temp.snap(pg_temp.s1(), current_date - 6, current_date) -> 'largest_expenses' -> 0 ->> 'amount_dirham', '900', 'an approved expense correction replaces the amount');

-- 4. Shop isolation and fail-closed behaviour ----------------------------------------------------------------------
select pg_temp.act('staff');
select is(jsonb_array_length(pg_temp.snap(pg_temp.s1(), current_date, current_date, array[pg_temp.s2()]) -> 'shops'), 1, 'staff: an unassigned comparison shop is left out, not reported');
select throws_ok($$ select pg_temp.snap(pg_temp.s2(), current_date, current_date) $$, '42501', 'UNAUTHORIZED_SHOP', 'staff: another shop is refused');
select pg_temp.act('manager');
select throws_ok($$ select pg_temp.snap(pg_temp.s2(), current_date, current_date) $$, '42501', 'UNAUTHORIZED_SHOP', 'manager: an unassigned shop is refused');
select pg_temp.act('unassigned');
select throws_ok($$ select pg_temp.snap(pg_temp.s1(), current_date, current_date) $$, '42501', 'UNAUTHORIZED_SHOP', 'an active account with no assignment is refused');
select pg_temp.act('inactive');
select throws_ok($$ select pg_temp.snap(pg_temp.s1(), current_date, current_date) $$, '28000', 'AUTHENTICATION_REQUIRED', 'an inactive account is refused');
select pg_temp.act('none');
select throws_ok($$ select pg_temp.snap(pg_temp.s1(), current_date, current_date) $$, '28000', 'AUTHENTICATION_REQUIRED', 'no session is refused');
select pg_temp.act('owner');
select throws_ok($$ select pg_temp.snap(pg_temp.id('no-such-shop'), current_date, current_date) $$, '42501', 'UNAUTHORIZED_SHOP', 'owner: an unknown shop is refused');
select throws_ok($$ select pg_temp.snap(null, current_date, current_date) $$, '42501', 'UNAUTHORIZED_SHOP', 'a missing shop is refused');
select throws_ok($$ select pg_temp.snap(pg_temp.s1(), current_date, current_date - 1) $$, 'P0001', 'INVALID_DATE', 'start after end is refused');
select throws_ok($$ select pg_temp.snap(pg_temp.s1(), current_date - 367, current_date) $$, 'P0001', 'INVALID_DATE', 'a range over 366 days is refused');
select throws_ok($$ select pg_temp.snap(pg_temp.s1(), null, current_date) $$, 'P0001', 'INVALID_DATE', 'a missing date is refused');
select lives_ok($$ select public.report_dashboard_snapshot(pg_temp.s1(), current_date, current_date, null) $$, 'a null comparison list means none');
reset role;
set local role anon;
select throws_ok($$ select public.report_dashboard_snapshot('10000000-0000-4000-8000-000000000001', current_date, current_date) $$, '42501', null, 'anon has no EXECUTE');

select * from finish();
rollback;
