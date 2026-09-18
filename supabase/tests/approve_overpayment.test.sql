begin;

create extension if not exists pgtap with schema extensions;

select plan(36);

-- Fixtures ---------------------------------------------------------------
-- Shop 1: owner sub 101, staff1 sub 102, manager sub 104. Shop 2: staff2 sub 103.

insert into public.batches (id, shop_id, business_date, created_by)
values
  ('f1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', current_date, '10000000-0000-4000-8000-000000000101'),
  ('f1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', current_date, '10000000-0000-4000-8000-000000000101');

insert into public.customers (id, shop_id, public_id, created_by)
values
  ('71000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'CUS-AOP-1', '10000000-0000-4000-8000-000000000101'),
  ('71000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'CUS-AOP-2', '10000000-0000-4000-8000-000000000101');

-- invoice1: shop 1, no customer -- proves INVOICE_HAS_NO_CUSTOMER.
-- invoice2: shop 1, customer attached -- proves NOT_AN_OVERPAYMENT.
-- invoice3: shop 1, customer attached -- manager happy-path overpayment.
-- invoice4: shop 1, customer attached -- owner happy-path overpayment.
-- invoice5: shop 1, customer attached -- closed-date rejection.
-- invoice6: shop 1, customer attached -- backdate role-gating.
-- invoice7: shop 1, customer attached -- idempotent replay/conflict.
-- invoice8: shop 1, customer attached -- staff rejection (valid overpayment, wrong role).
-- invoice9: shop 2, customer attached -- cross-shop invoice injection.
insert into public.invoices (
  id, shop_id, batch_id, customer_id, invoice_id, invoice_type, quantity, total_amount_dirham, business_date, created_by
) values
  ('e1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', null, 'AOP-0001', 'advance', 1, 1000, current_date, '10000000-0000-4000-8000-000000000101'),
  ('e1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'AOP-0002', 'advance', 1, 1000, current_date, '10000000-0000-4000-8000-000000000101'),
  ('e1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'AOP-0003', 'advance', 1, 1000, current_date, '10000000-0000-4000-8000-000000000101'),
  ('e1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'AOP-0004', 'advance', 1, 1000, current_date, '10000000-0000-4000-8000-000000000101'),
  ('e1000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'AOP-0005', 'advance', 1, 1000, current_date, '10000000-0000-4000-8000-000000000101'),
  ('e1000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'AOP-0006', 'advance', 1, 1000, current_date, '10000000-0000-4000-8000-000000000101'),
  ('e1000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'AOP-0007', 'advance', 1, 1000, current_date, '10000000-0000-4000-8000-000000000101'),
  ('e1000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'AOP-0008', 'advance', 1, 1000, current_date, '10000000-0000-4000-8000-000000000101'),
  ('e1000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000002', 'AOP-0009', 'advance', 1, 1000, current_date, '10000000-0000-4000-8000-000000000101');

-- 1. Authorization boundary ------------------------------------------------

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok(
  $$select public.approve_overpayment('{}'::jsonb)$$,
  '42501', null,
  'anon has no EXECUTE grant on approve_overpayment'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000003',
    'amount_dirham', 1200, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-missing-actor', 'reason', 'r'
  ))$$,
  '28000', null,
  'an authenticated call with no resolvable actor is rejected'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000103"}';
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000003',
    'amount_dirham', 1200, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-wrong-shop', 'reason', 'r'
  ))$$,
  '42501', null,
  'a call targeting an unassigned shop is rejected'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000008',
    'amount_dirham', 1200, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-staff-reject', 'reason', 'customer overpaid'
  ))$$,
  '42501', null,
  'staff cannot call approve_overpayment even for a genuine overpayment'
);
reset role;

-- 2. Malformed command shapes ----------------------------------------------
-- (staff1 is used here because shape validation runs before the role gate,
-- exactly mirroring record_payment's own validation ordering.)

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';

select throws_ok(
  $$select public.approve_overpayment('"just a string"'::jsonb)$$,
  'P0001', 'OVERPAYMENT_VALIDATION_FAILED',
  'a non-object command is rejected'
);
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000002',
    'amount_dirham', 1200, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-unsupported-key', 'reason', 'r',
    'bogus_field', 'nope'
  ))$$,
  'P0001', 'OVERPAYMENT_VALIDATION_FAILED',
  'an unsupported top-level field is rejected'
);
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000002',
    'amount_dirham', 1200, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 12345, 'reason', 'r'
  ))$$,
  'P0001', 'OVERPAYMENT_VALIDATION_FAILED',
  'a non-string idempotency_key is rejected'
);
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', 'not-a-uuid',
    'invoice_id', 'e1000000-0000-4000-8000-000000000002',
    'amount_dirham', 1200, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-bad-shop-id', 'reason', 'r'
  ))$$,
  'P0001', 'OVERPAYMENT_VALIDATION_FAILED',
  'a non-UUID shop_id is rejected'
);
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'not-a-uuid',
    'amount_dirham', 1200, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-bad-invoice-id', 'reason', 'r'
  ))$$,
  'P0001', 'OVERPAYMENT_VALIDATION_FAILED',
  'a non-UUID invoice_id is rejected'
);
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000002',
    'amount_dirham', 0, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-zero-amount', 'reason', 'r'
  ))$$,
  'P0001', 'OVERPAYMENT_VALIDATION_FAILED',
  'a non-positive amount_dirham is rejected'
);
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000002',
    'amount_dirham', 12.5, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-fractional-amount', 'reason', 'r'
  ))$$,
  'P0001', 'OVERPAYMENT_VALIDATION_FAILED',
  'a non-integer amount_dirham is rejected'
);
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000002',
    'amount_dirham', 1200, 'payment_method', true,
    'business_date', current_date::text, 'idempotency_key', 'k-bad-method-type', 'reason', 'r'
  ))$$,
  'P0001', 'OVERPAYMENT_VALIDATION_FAILED',
  'a non-string payment_method is rejected'
);
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000002',
    'amount_dirham', 1200, 'payment_method', 'card',
    'business_date', current_date::text, 'idempotency_key', 'k-bad-method-value', 'reason', 'r'
  ))$$,
  'P0001', 'OVERPAYMENT_VALIDATION_FAILED',
  'a payment_method other than cash is rejected'
);
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000002',
    'amount_dirham', 1200, 'payment_method', 'cash',
    'business_date', 'not-a-date', 'idempotency_key', 'k-bad-date-format', 'reason', 'r'
  ))$$,
  'P0001', 'OVERPAYMENT_VALIDATION_FAILED',
  'a malformed business_date is rejected'
);
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000002',
    'amount_dirham', 1200, 'payment_method', 'cash',
    'business_date', (current_date + 1)::text, 'idempotency_key', 'k-future-date', 'reason', 'r'
  ))$$,
  'P0001', 'OVERPAYMENT_VALIDATION_FAILED',
  'a future business_date is rejected'
);
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000002',
    'amount_dirham', 1200, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-blank-reason', 'reason', '   '
  ))$$,
  'P0001', 'OVERPAYMENT_VALIDATION_FAILED',
  'a blank reason is rejected'
);

-- 3. Invoice existence, customer requirement, and overpayment requirement ---
-- (these test invoice/customer/amount logic, not the role gate, so they run
-- as manager -- an actor already authorized to call this RPC at all.)

reset role;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000104"}';

select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', '99999999-9999-4999-8999-999999999999',
    'amount_dirham', 1200, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-no-such-invoice', 'reason', 'r'
  ))$$,
  'P0001', 'OVERPAYMENT_VALIDATION_FAILED',
  'a nonexistent invoice_id in the actor''s own shop is rejected'
);
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000009',
    'amount_dirham', 1200, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-cross-shop-invoice', 'reason', 'r'
  ))$$,
  'P0001', 'OVERPAYMENT_VALIDATION_FAILED',
  'an invoice belonging to another shop cannot be targeted by injecting its id'
);
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000001',
    'amount_dirham', 1200, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-no-customer', 'reason', 'r'
  ))$$,
  'P0001', 'OVERPAYMENT_VALIDATION_FAILED',
  'an invoice with no customer attached is rejected'
);
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000002',
    'amount_dirham', 500, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-not-overpay', 'reason', 'r'
  ))$$,
  'P0001', 'OVERPAYMENT_VALIDATION_FAILED',
  'an amount that does not exceed effective due is rejected'
);
reset role;

-- 4. Happy path: manager approves a genuine overpayment ---------------------

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000104"}';

create temp table aop_happy as
select public.approve_overpayment(jsonb_build_object(
  'shop_id', '10000000-0000-4000-8000-000000000001',
  'invoice_id', 'e1000000-0000-4000-8000-000000000003',
  'amount_dirham', 1200, 'payment_method', 'cash',
  'business_date', current_date::text, 'idempotency_key', 'aop-happy-1', 'reason', 'customer paid extra, keep on account'
)) as result;

select ok(
  (select (result ->> 'ok')::boolean from aop_happy),
  'a manager''s well-formed overpayment succeeds'
);
select is(
  (select result ->> 'applied_amount' from aop_happy),
  '1000',
  'applied_amount is capped at the effective due'
);
select is(
  (select result ->> 'credit_amount' from aop_happy),
  '200',
  'credit_amount is exactly the excess over due'
);
select is(
  (select result ->> 'effective_due' from aop_happy),
  '0',
  'the invoice is left fully paid'
);
select is(
  (select amount_dirham from public.payments where id = (select (result ->> 'payment_id')::uuid from aop_happy)),
  1000::bigint,
  'the payments row records only the applied amount, never the full cash tendered'
);
select ok(
  exists (
    select 1 from public.customer_credits
    where id = (select (result ->> 'credit_id')::uuid from aop_happy)
      and customer_id = '71000000-0000-4000-8000-000000000001'
      and amount_dirham = 200
      and reason = 'customer paid extra, keep on account'
      and approved_by = '10000000-0000-4000-8000-000000000104'
      and approved_at is not null
  ),
  'the customer_credits row records the excess with reason and approval stamped'
);
reset role;

-- 5. Owner also holds override authority ------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select lives_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000004',
    'amount_dirham', 1100, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'aop-owner-1', 'reason', 'owner-approved overpayment'
  ))$$,
  'the owner may also call approve_overpayment'
);
reset role;

-- 6. Closed-date rejection ---------------------------------------------------

insert into public.daily_closes (shop_id, business_date, event_type, actor_id)
values ('10000000-0000-4000-8000-000000000001', current_date - 2, 'closed', '10000000-0000-4000-8000-000000000101');

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000005',
    'amount_dirham', 1200, 'payment_method', 'cash',
    'business_date', (current_date - 2)::text, 'idempotency_key', 'aop-closed-1', 'reason', 'r'
  ))$$,
  'P0001', 'CLOSED_DATE',
  'the owner is rejected against a closed historical date'
);
reset role;

-- 7. Backdated overpayment: manager rejected, owner accepted ----------------

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000104"}';
select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000006',
    'amount_dirham', 1200, 'payment_method', 'cash',
    'business_date', (current_date - 1)::text, 'idempotency_key', 'aop-backdate-manager', 'reason', 'r'
  ))$$,
  '42501', null,
  'a backdated overpayment submitted by a manager (not owner) is rejected'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select lives_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000006',
    'amount_dirham', 1200, 'payment_method', 'cash',
    'business_date', (current_date - 1)::text, 'idempotency_key', 'aop-backdate-owner', 'reason', 'r'
  ))$$,
  'a backdated overpayment submitted by the owner succeeds'
);
reset role;

-- 8. Idempotent replay and conflicting reuse ---------------------------------

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000104"}';

create temp table aop_first as
select public.approve_overpayment(jsonb_build_object(
  'shop_id', '10000000-0000-4000-8000-000000000001',
  'invoice_id', 'e1000000-0000-4000-8000-000000000007',
  'amount_dirham', 1200, 'payment_method', 'cash',
  'business_date', current_date::text, 'idempotency_key', 'aop-replay-1', 'reason', 'r'
)) as result;

create temp table aop_replay as
select public.approve_overpayment(jsonb_build_object(
  'shop_id', '10000000-0000-4000-8000-000000000001',
  'invoice_id', 'e1000000-0000-4000-8000-000000000007',
  'amount_dirham', 1200, 'payment_method', 'cash',
  'business_date', current_date::text, 'idempotency_key', 'aop-replay-1', 'reason', 'r'
)) as result;

select is(
  (select result ->> 'payment_id' from aop_replay),
  (select result ->> 'payment_id' from aop_first),
  'an exact replay returns the original payment_id'
);
select is(
  (select result ->> 'credit_id' from aop_replay),
  (select result ->> 'credit_id' from aop_first),
  'an exact replay returns the original credit_id'
);
select is(
  (select count(*)::int from public.payments where idempotency_key = 'aop-replay-1'),
  1,
  'an exact replay does not create a second payments row'
);
select is(
  (select count(*)::int from public.customer_credits where invoice_id = 'e1000000-0000-4000-8000-000000000007'),
  1,
  'an exact replay does not create a second customer_credits row'
);

select throws_ok(
  $$select public.approve_overpayment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'e1000000-0000-4000-8000-000000000007',
    'amount_dirham', 1150, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'aop-replay-1', 'reason', 'r'
  ))$$,
  'P0001', 'IDEMPOTENCY_CONFLICT',
  'reusing an idempotency key with a different fingerprint is rejected'
);
select is(
  (select count(*)::int from public.customer_credits where invoice_id = 'e1000000-0000-4000-8000-000000000007'),
  1,
  'a conflicting reuse does not create a new customer_credits row'
);
reset role;

select * from finish();
rollback;
