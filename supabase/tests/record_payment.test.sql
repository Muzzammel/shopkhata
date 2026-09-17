begin;

create extension if not exists pgtap with schema extensions;

select plan(33);

-- Fixtures ---------------------------------------------------------------
-- Shop 1: owner sub 101, staff1 sub 102. Shop 2: staff2 sub 103.

insert into public.batches (id, shop_id, business_date, created_by)
values
  ('b1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', current_date, '10000000-0000-4000-8000-000000000101'),
  ('b1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', current_date, '10000000-0000-4000-8000-000000000101');

-- invoice1: shop 1, total 1000, used for the happy-path/replay/overpayment flow.
-- invoice2: shop 2, used to prove cross-shop invoice injection is rejected.
-- invoice3: shop 1, used for the closed-date rejection.
-- invoice4: shop 1, used for the backdate role-gating flow.
-- invoice5: shop 1, used for the corrections-aware effective-due flow.
insert into public.invoices (
  id, shop_id, batch_id, invoice_id, invoice_type, quantity, total_amount_dirham, business_date, created_by
) values
  ('a1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'RP-0001', 'advance', 1, 1000, current_date, '10000000-0000-4000-8000-000000000101'),
  ('a1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002', 'RP-0002', 'advance', 1, 1000, current_date, '10000000-0000-4000-8000-000000000101'),
  ('a1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'RP-0003', 'advance', 1, 1000, current_date, '10000000-0000-4000-8000-000000000101'),
  ('a1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'RP-0004', 'advance', 1, 1000, current_date, '10000000-0000-4000-8000-000000000101'),
  ('a1000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'RP-0005', 'advance', 1, 1000, current_date, '10000000-0000-4000-8000-000000000101');

-- 1. Authorization boundary ------------------------------------------------

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok(
  $$select public.record_payment('{}'::jsonb)$$,
  '42501', null,
  'anon has no EXECUTE grant on record_payment'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000001',
    'amount_dirham', 100, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-missing-actor'
  ))$$,
  '28000', null,
  'an authenticated call with no resolvable actor is rejected'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000103"}';
select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000001',
    'amount_dirham', 100, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-wrong-shop'
  ))$$,
  '42501', null,
  'a call targeting an unassigned shop is rejected'
);
reset role;

-- 2. Malformed command shapes ----------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';

select throws_ok(
  $$select public.record_payment('"just a string"'::jsonb)$$,
  'P0001', 'PAYMENT_VALIDATION_FAILED',
  'a non-object command is rejected'
);
select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000001',
    'amount_dirham', 100, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-unsupported-key',
    'bogus_field', 'nope'
  ))$$,
  'P0001', 'PAYMENT_VALIDATION_FAILED',
  'an unsupported top-level field is rejected'
);
select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000001',
    'amount_dirham', 100, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 12345
  ))$$,
  'P0001', 'PAYMENT_VALIDATION_FAILED',
  'a non-string idempotency_key is rejected'
);
select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', 'not-a-uuid',
    'invoice_id', 'a1000000-0000-4000-8000-000000000001',
    'amount_dirham', 100, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-bad-shop-id'
  ))$$,
  'P0001', 'PAYMENT_VALIDATION_FAILED',
  'a non-UUID shop_id is rejected'
);
select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'not-a-uuid',
    'amount_dirham', 100, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-bad-invoice-id'
  ))$$,
  'P0001', 'PAYMENT_VALIDATION_FAILED',
  'a non-UUID invoice_id is rejected'
);
select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000001',
    'amount_dirham', 0, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-zero-amount'
  ))$$,
  'P0001', 'PAYMENT_VALIDATION_FAILED',
  'a non-positive amount_dirham is rejected'
);
select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000001',
    'amount_dirham', 12.5, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-fractional-amount'
  ))$$,
  'P0001', 'PAYMENT_VALIDATION_FAILED',
  'a non-integer amount_dirham is rejected'
);
select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000001',
    'amount_dirham', 100, 'payment_method', true,
    'business_date', current_date::text, 'idempotency_key', 'k-bad-method-type'
  ))$$,
  'P0001', 'PAYMENT_VALIDATION_FAILED',
  'a non-string payment_method is rejected'
);
select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000001',
    'amount_dirham', 100, 'payment_method', 'card',
    'business_date', current_date::text, 'idempotency_key', 'k-bad-method-value'
  ))$$,
  'P0001', 'PAYMENT_VALIDATION_FAILED',
  'a payment_method other than cash is rejected'
);
select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000001',
    'amount_dirham', 100, 'payment_method', 'cash',
    'business_date', 'not-a-date', 'idempotency_key', 'k-bad-date-format'
  ))$$,
  'P0001', 'PAYMENT_VALIDATION_FAILED',
  'a malformed business_date is rejected'
);
select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000001',
    'amount_dirham', 100, 'payment_method', 'cash',
    'business_date', (current_date + 1)::text, 'idempotency_key', 'k-future-date'
  ))$$,
  'P0001', 'PAYMENT_VALIDATION_FAILED',
  'a future business_date is rejected'
);

-- 3. Invoice existence and cross-shop injection ----------------------------

select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', '99999999-9999-4999-8999-999999999999',
    'amount_dirham', 100, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-no-such-invoice'
  ))$$,
  'P0001', 'PAYMENT_VALIDATION_FAILED',
  'a nonexistent invoice_id in the actor''s own shop is rejected'
);
select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000002',
    'amount_dirham', 100, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'k-cross-shop-invoice'
  ))$$,
  'P0001', 'PAYMENT_VALIDATION_FAILED',
  'an invoice belonging to another shop cannot be targeted by injecting its id'
);

-- 4. Happy path: a partial payment against a due invoice --------------------

create temp table rp_happy as
select public.record_payment(jsonb_build_object(
  'shop_id', '10000000-0000-4000-8000-000000000001',
  'invoice_id', 'a1000000-0000-4000-8000-000000000001',
  'amount_dirham', 400, 'payment_method', 'cash',
  'business_date', current_date::text, 'idempotency_key', 'rp-happy-1'
)) as result;

select ok(
  (select (result ->> 'ok')::boolean from rp_happy),
  'a well-formed partial payment succeeds'
);
select is(
  (select result ->> 'effective_paid' from rp_happy),
  '400',
  'the returned effective_paid reflects the new payment'
);
select is(
  (select result ->> 'effective_due' from rp_happy),
  '600',
  'the returned effective_due reflects the remaining balance'
);
select is(
  (select count(*)::int from public.payments where invoice_id = 'a1000000-0000-4000-8000-000000000001'),
  1,
  'exactly one payment row was created for the invoice'
);
select is(
  (select count(*)::int from public.audit_events
   where entity_type = 'payment' and action = 'record_payment'
     and shop_id = '10000000-0000-4000-8000-000000000001'),
  1,
  'a record_payment audit event was recorded'
);

-- 5. A second partial payment brings the invoice to fully paid --------------

create temp table rp_full as
select public.record_payment(jsonb_build_object(
  'shop_id', '10000000-0000-4000-8000-000000000001',
  'invoice_id', 'a1000000-0000-4000-8000-000000000001',
  'amount_dirham', 600, 'payment_method', 'cash',
  'business_date', current_date::text, 'idempotency_key', 'rp-happy-2'
)) as result;

select ok(
  (select (result ->> 'ok')::boolean from rp_full),
  'the second partial payment succeeds'
);
select is(
  (select result ->> 'effective_due' from rp_full),
  '0',
  'the invoice reaches effective_due = 0 once fully paid'
);

-- 6. Overpayment is rejected once the invoice is fully paid ------------------

select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000001',
    'amount_dirham', 1, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'rp-overpay-1'
  ))$$,
  'P0001', 'PAYMENT_VALIDATION_FAILED',
  'a payment that would exceed the amount due is rejected'
);

-- 7. Idempotent replay --------------------------------------------------

create temp table rp_replay as
select public.record_payment(jsonb_build_object(
  'shop_id', '10000000-0000-4000-8000-000000000001',
  'invoice_id', 'a1000000-0000-4000-8000-000000000001',
  'amount_dirham', 400, 'payment_method', 'cash',
  'business_date', current_date::text, 'idempotency_key', 'rp-happy-1'
)) as result;

select is(
  (select result ->> 'payment_id' from rp_replay),
  (select result ->> 'payment_id' from rp_happy),
  'an exact replay of the same command returns the original payment_id'
);
select is(
  (select count(*)::int from public.payments where idempotency_key = 'rp-happy-1'),
  1,
  'an exact replay does not create a second payment row'
);

select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000001',
    'amount_dirham', 401, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'rp-happy-1'
  ))$$,
  'P0001', 'IDEMPOTENCY_CONFLICT',
  'reusing an idempotency key with a different fingerprint is rejected'
);
select is(
  (select count(*)::int from public.payments where idempotency_key = 'rp-happy-1'),
  1,
  'a conflicting reuse of an idempotency key does not create a new row'
);
reset role;

-- 8. Closed-date rejection ------------------------------------------------

insert into public.daily_closes (shop_id, business_date, event_type, actor_id)
values ('10000000-0000-4000-8000-000000000001', current_date - 2, 'closed', '10000000-0000-4000-8000-000000000101');

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000003',
    'amount_dirham', 100, 'payment_method', 'cash',
    'business_date', (current_date - 2)::text, 'idempotency_key', 'rp-closed-1'
  ))$$,
  'P0001', 'CLOSED_DATE',
  'the owner is rejected against a closed historical date'
);
reset role;

-- 9. Backdated payment: staff rejected, owner accepted ----------------------

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000004',
    'amount_dirham', 100, 'payment_method', 'cash',
    'business_date', (current_date - 1)::text, 'idempotency_key', 'rp-backdate-staff'
  ))$$,
  '42501', null,
  'a backdated payment submitted by non-owner staff is rejected'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select lives_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000004',
    'amount_dirham', 100, 'payment_method', 'cash',
    'business_date', (current_date - 1)::text, 'idempotency_key', 'rp-backdate-owner'
  ))$$,
  'a backdated payment submitted by the owner succeeds'
);
reset role;

-- 10. Approved corrections change effective_due; unapproved ones do not -----

insert into public.corrections (shop_id, invoice_id, amount_delta_dirham, reason, business_date, created_by, approved_by)
values (
  '10000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000005', -500,
  'pending review, not yet approved', current_date, '10000000-0000-4000-8000-000000000101', null
);

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select lives_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000005',
    'amount_dirham', 800, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'rp-correction-1'
  ))$$,
  'an unapproved correction is ignored, so the payment succeeds against the un-adjusted total'
);
reset role;

insert into public.corrections (shop_id, invoice_id, amount_delta_dirham, reason, business_date, created_by, approved_by)
values (
  '10000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000005', -100,
  'approved billing correction', current_date, '10000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000101'
);

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select throws_ok(
  $$select public.record_payment(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'invoice_id', 'a1000000-0000-4000-8000-000000000005',
    'amount_dirham', 150, 'payment_method', 'cash',
    'business_date', current_date::text, 'idempotency_key', 'rp-correction-2'
  ))$$,
  'P0001', 'PAYMENT_VALIDATION_FAILED',
  'an approved correction lowers effective_due, so a payment that now overpays is rejected'
);
reset role;

select * from finish();
rollback;
