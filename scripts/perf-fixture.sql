-- ShopKhata performance fixture: roughly one year of trading for two small shops.
--
-- NOT PRODUCTION DATA. Every row is generated (customers "Perf Customer …", invoices
-- "PERF-…", accounts "perf-user-N@shopkhata.local" that cannot sign in). It is loaded
-- only by `pnpm perf:check`, into a freshly reset LOCAL database, and refuses to run
-- anywhere else. Deterministic: the same day produces the same rows and IDs.
\set ON_ERROR_STOP on
begin;
set local timezone = 'Asia/Qatar';

do $$ begin
  if (select count(*) from auth.users where email in ('owner@shopkhata.local', 'staff1@shopkhata.local', 'staff2@shopkhata.local', 'manager@shopkhata.local')) <> 4 then
    raise exception 'PERF_FIXTURE_REFUSED: the local seed accounts are missing. This is not a local development database.';
  end if;
  if exists (select 1 from public.invoices) or exists (select 1 from public.customers) then
    raise exception 'PERF_FIXTURE_REFUSED: the database already holds records. Reset the local database first.';
  end if;
end $$;

-- Staff: the four seeded accounts plus eight generated ones (no password, so no sign-in).
insert into auth.users(id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, confirmation_token, recovery_token, email_change, email_change_token_new, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select ('a0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'perf-user-' || n || '@shopkhata.local', '', now(), '', '', '', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()
from generate_series(1, 8) n;
insert into public.profiles(id, email, display_name, role, is_active)
select ('a0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'perf-user-' || n || '@shopkhata.local', 'Perf ' || case when n in (4, 8) then 'Manager ' else 'Staff ' end || n,
  case when n in (4, 8) then 'manager' else 'staff' end, true
from generate_series(1, 8) n;
insert into public.user_shop_assignments(user_id, shop_id)
select ('a0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ('10000000-0000-4000-8000-00000000000' || case when n <= 4 then 1 else 2 end)::uuid
from generate_series(1, 8) n;

create temp table perf_shop on commit drop as
select * from (values
  ('10000000-0000-4000-8000-000000000001'::uuid, 1, 40, 2000, '10000000-0000-4000-8000-000000000104'::uuid,
    array['10000000-0000-4000-8000-000000000102', '10000000-0000-4000-8000-000000000104', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000004']::uuid[]),
  ('10000000-0000-4000-8000-000000000002'::uuid, 2, 20, 1000, 'a0000000-0000-4000-8000-000000000008'::uuid,
    array['10000000-0000-4000-8000-000000000103', 'a0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000008']::uuid[])
) s(shop_id, shop_no, per_day, customer_count, manager, staff);

insert into public.customers(id, shop_id, name, mobile, created_by, created_at)
select md5('perf-cust-' || s.shop_no || '-' || c)::uuid, s.shop_id, 'Perf Customer ' || s.shop_no || '-' || lpad(c::text, 4, '0'), '5' || s.shop_no || lpad(c::text, 6, '0'), s.staff[1], now() - interval '366 days'
from perf_shop s, generate_series(1, s.customer_count) c;

-- One row per invoice, with the money that will be recorded against it, so no generated
-- payment can exceed its invoice. Customer 1 of each shop buys every day (the busiest ledger).
create temp table perf_inv on commit drop as
select md5('perf-inv-' || s.shop_no || '-' || d || '-' || n)::uuid id, s.shop_id, s.shop_no, d, n, s.manager,
  current_date - d business_date,
  md5('perf-bat-' || s.shop_no || '-' || d || '-' || ((n - 1) / 10))::uuid batch_id,
  'PERF-' || s.shop_no || '-' || to_char(current_date - d, 'YYMMDD') || '-' || lpad(n::text, 3, '0') number,
  (1000 + ((d * 31 + n * 17) % 400) * 500)::bigint total,
  case when n = 1 then md5('perf-cust-' || s.shop_no || '-1')::uuid
       when (d * 13 + n * 7) % 20 < 13 then md5('perf-cust-' || s.shop_no || '-' || (1 + (n * n * 31 + d * 7) % s.customer_count))::uuid end customer_id,
  s.staff[1 + (d + n) % array_length(s.staff, 1)] created_by,
  least(((current_date - d) + time '08:00' + n * interval '9 minutes')::timestamptz, now() - n * interval '1 second') recorded_at,
  0::bigint initial, 0::bigint followup, 0::bigint custpay, false delivered
from perf_shop s, generate_series(0, 365) d, generate_series(1, s.per_day) n;
update perf_inv set initial = case when (d * 7 + n * 3) % 10 < 4 then total when (d * 7 + n * 3) % 10 < 7 then (total * 2 / 5 / 50) * 50 else 0 end;
update perf_inv set followup = case when initial < total and d >= 3 and (d + n) % 4 = 0 then ((total - initial) / 2 / 50) * 50 else 0 end,
  delivered = (customer_id is not null and (d + n) % 3 <> 0) or (initial = total and (d + n) % 2 = 0);
update perf_inv set custpay = total - initial - followup where customer_id is not null and d >= 35 and (d * 3 + n) % 61 = 0 and total - initial - followup > 0;

insert into public.batches(id, shop_id, business_date, is_backdated, created_by, recorded_at)
select distinct on (batch_id) batch_id, shop_id, business_date, false, created_by, recorded_at from perf_inv order by batch_id, n;
insert into public.invoices(id, shop_id, batch_id, customer_id, invoice_id, total_amount_dirham, business_date, recorded_at, created_by, delivered)
select id, shop_id, batch_id, customer_id, number, total, business_date, recorded_at, created_by, delivered from perf_inv;
insert into public.invoice_number_registry(shop_id, invoice_number, canonical_invoice_id) select shop_id, number, id from perf_inv;

-- Payments: at entry, a follow-up two days later, and customer-level payments a month later.
insert into public.payments(id, shop_id, batch_id, invoice_id, amount_dirham, business_date, payment_method, recorded_at, created_by)
select md5('perf-pay-i-' || id)::uuid, shop_id, batch_id, id, initial, business_date, 'cash', recorded_at, created_by from perf_inv where initial > 0;
insert into public.payments(id, shop_id, invoice_id, amount_dirham, business_date, payment_method, recorded_at, created_by)
select md5('perf-pay-f-' || id)::uuid, shop_id, id, followup, business_date + 2, 'cash', recorded_at + interval '2 days', created_by from perf_inv where followup > 0;
insert into public.customer_payment_batches(id, shop_id, customer_id, amount_dirham, business_date, idempotency_key, fingerprint, idempotency_result, created_by, recorded_at)
select md5('perf-cpb-' || id)::uuid, shop_id, customer_id, custpay, business_date + 30, 'perf-cpb-' || id, 'perf', '{}', created_by, recorded_at + interval '30 days' from perf_inv where custpay > 0;
insert into public.payments(id, shop_id, invoice_id, amount_dirham, business_date, payment_method, recorded_at, created_by, customer_payment_batch_id)
select md5('perf-pay-c-' || id)::uuid, shop_id, id, custpay, business_date + 30, 'cash', recorded_at + interval '30 days', created_by, md5('perf-cpb-' || id)::uuid from perf_inv where custpay > 0;

-- Approved corrections: of the invoice total, and of a follow-up payment.
create temp table perf_fix on commit drop as
select id, shop_id, manager, created_by, business_date, recorded_at, null::uuid payment_id, 500::bigint delta from perf_inv where d >= 1 and customer_id is not null and (d * 11 + n) % 67 = 0
union all
select id, shop_id, manager, created_by, business_date + 2, recorded_at + interval '2 days', md5('perf-pay-f-' || id)::uuid, -100 from perf_inv where followup > 100 and (d + n) % 97 = 0;
insert into public.correction_requests(id, shop_id, invoice_id, payment_id, amount_delta_dirham, reason, requested_by, requested_at, idempotency_key, fingerprint)
select md5('perf-cr-' || id || coalesce(payment_id::text, ''))::uuid, shop_id, id, payment_id, delta, 'Perf: amount corrected', created_by, recorded_at + interval '1 hour', 'perf-cr-' || id || coalesce(payment_id::text, ''), 'perf' from perf_fix;
insert into public.correction_decisions(id, shop_id, request_id, invoice_id, decision, expected_revision, decided_by, decided_at, idempotency_key, fingerprint)
select md5('perf-cd-' || id || coalesce(payment_id::text, ''))::uuid, shop_id, md5('perf-cr-' || id || coalesce(payment_id::text, ''))::uuid, id, 'approved', 0, manager, recorded_at + interval '2 hours', 'perf-cd-' || id || coalesce(payment_id::text, ''), 'perf' from perf_fix;
insert into public.corrections(id, shop_id, invoice_id, payment_id, amount_delta_dirham, reason, business_date, recorded_at, created_by, approved_by, request_id)
select md5('perf-co-' || id || coalesce(payment_id::text, ''))::uuid, shop_id, case when payment_id is null then id end, payment_id, delta, 'Perf: amount corrected', business_date, recorded_at + interval '2 hours', created_by, manager,
  md5('perf-cr-' || id || coalesce(payment_id::text, ''))::uuid from perf_fix;

-- Approved replacements: the invoice number changes and both numbers stay reserved.
insert into public.replacement_requests(id, shop_id, invoice_id, expected_revision, invoice_number, customer_id, delivered, reason, requested_by, requested_at, idempotency_key, fingerprint)
select md5('perf-rr-' || id)::uuid, shop_id, id, 0, 'PERF-R-' || shop_no || '-' || d || '-' || n, customer_id, delivered, 'Perf: number typo', created_by, recorded_at + interval '1 hour', 'perf-rr-' || id, 'perf' from perf_inv where (d * 5 + n) % 211 = 0;
insert into public.replacement_decisions(id, shop_id, request_id, invoice_id, decision, expected_revision, revision, decided_by, decided_at, idempotency_key, fingerprint)
select md5('perf-rd-' || id)::uuid, shop_id, md5('perf-rr-' || id)::uuid, id, 'approved', 0, 1, manager, recorded_at + interval '2 hours', 'perf-rd-' || id, 'perf' from perf_inv where (d * 5 + n) % 211 = 0;
insert into public.invoice_number_registry(shop_id, invoice_number, canonical_invoice_id)
select shop_id, 'PERF-R-' || shop_no || '-' || d || '-' || n, id from perf_inv where (d * 5 + n) % 211 = 0;

-- Customer credit from approved overpayments; some of it applied to another due invoice of the same customer.
insert into public.customer_credits(id, shop_id, customer_id, invoice_id, amount_dirham, business_date, reason, recorded_at, created_by, approved_by, approved_at)
select md5('perf-cc-' || id)::uuid, shop_id, customer_id, id, 2000, business_date, 'Perf: overpayment kept as credit', recorded_at, created_by, manager, recorded_at
from perf_inv where customer_id is not null and initial = total and (d + n * 3) % 149 = 0;
create temp table perf_app on commit drop as
select distinct on (target) * from (
  select distinct on (c.id) c.id credit_invoice, t.id target, c.shop_id, c.customer_id, c.created_by, greatest(c.business_date, t.business_date) business_date
  from perf_inv c join perf_inv t on t.shop_id = c.shop_id and t.customer_id = c.customer_id and t.id <> c.id and t.custpay = 0 and t.total - t.initial - t.followup >= 1000
  where c.customer_id is not null and c.initial = c.total and (c.d + c.n * 3) % 149 = 0 order by c.id, t.id
) pairs order by target, credit_invoice;
insert into public.credit_application_batches(id, shop_id, customer_id, amount_dirham, business_date, idempotency_key, fingerprint, idempotency_result, created_by, recorded_at)
select md5('perf-cab-' || credit_invoice)::uuid, shop_id, customer_id, 1000, business_date, 'perf-cab-' || credit_invoice, 'perf', '{}', created_by, (business_date + time '18:00')::timestamptz from perf_app;
insert into public.credit_applications(shop_id, customer_id, batch_id, credit_id, invoice_id, amount_dirham, business_date, recorded_at, created_by)
select shop_id, customer_id, md5('perf-cab-' || credit_invoice)::uuid, md5('perf-cc-' || credit_invoice)::uuid, target, 1000, business_date, (business_date + time '18:00')::timestamptz, created_by from perf_app;

-- Expenses, six a day per shop, with some approved corrections.
create temp table perf_exp on commit drop as
select md5('perf-exp-' || s.shop_no || '-' || d || '-' || n)::uuid id, s.shop_id, s.manager, d, n, current_date - d business_date,
  (500 + ((d * 17 + n * 29) % 200) * 100)::bigint amount, (array['rent', 'utilities', 'supplies', 'transport', 'maintenance', 'other'])[1 + (d + n) % 6] category,
  s.staff[1 + (d + n) % array_length(s.staff, 1)] created_by,
  least(((current_date - d) + time '17:00' + n * interval '5 minutes')::timestamptz, now() - n * interval '1 second') recorded_at
from perf_shop s, generate_series(0, 365) d, generate_series(1, 6) n;
insert into public.expenses(id, shop_id, description, amount_dirham, business_date, recorded_at, created_by, category)
select id, shop_id, 'Perf expense ' || d || '-' || n, amount, business_date, recorded_at, created_by, category from perf_exp;
insert into public.expense_correction_requests(id, shop_id, expense_id, amount_dirham, category, description, reason, requested_by, requested_at, idempotency_key, fingerprint)
select md5('perf-er-' || id)::uuid, shop_id, id, amount + 500, category, 'Perf expense ' || d || '-' || n || ' (corrected)', 'Perf: receipt total', created_by, recorded_at + interval '10 minutes', 'perf-er-' || id, 'perf' from perf_exp where (d + n) % 50 = 0;
insert into public.expense_correction_decisions(id, shop_id, request_id, expense_id, decision, decided_by, decided_at, idempotency_key, fingerprint)
select md5('perf-ed-' || id)::uuid, shop_id, md5('perf-er-' || id)::uuid, id, 'approved', manager, recorded_at + interval '20 minutes', 'perf-ed-' || id, 'perf' from perf_exp where (d + n) % 50 = 0;

-- Audit trail and daily closes. Closes go last: a closed date accepts no further rows.
insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, recorded_at)
select distinct on (batch_id) shop_id, created_by, 'submit_batch', 'batch', batch_id::text, recorded_at from perf_inv order by batch_id, n;
insert into public.daily_closes(shop_id, business_date, event_type, actor_id, recorded_at)
select s.shop_id, current_date - d, 'closed', s.manager, ((current_date - d) + time '21:00')::timestamptz from perf_shop s, generate_series(365, 3, -1) d order by d desc, s.shop_no;
insert into public.daily_closes(shop_id, business_date, event_type, actor_id, recorded_at, reason)
select s.shop_id, current_date - d, 'reopened', s.manager, ((current_date - d) + time '21:30')::timestamptz, 'Perf: late delivery recorded' from perf_shop s, generate_series(365, 3, -1) d where d % 45 = 0 order by d desc, s.shop_no;
insert into public.daily_closes(shop_id, business_date, event_type, actor_id, recorded_at)
select s.shop_id, current_date - d, 'closed', s.manager, ((current_date - d) + time '22:00')::timestamptz from perf_shop s, generate_series(365, 3, -1) d where d % 45 = 0 order by d desc, s.shop_no;
insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, reason, recorded_at)
select shop_id, actor_id, case event_type when 'closed' then 'date.close' else 'date.reopen' end, 'business_date', business_date::text, reason, recorded_at from public.daily_closes;

commit;
analyze;
