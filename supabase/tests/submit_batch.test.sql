begin;

create extension if not exists pgtap with schema extensions;
set local timezone = 'Asia/Qatar';

select plan(88);

-- Fixtures: a shop-1 existing customer, reused across several assertions.
insert into public.customers (id, shop_id, name)
values ('c9000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Submit-Batch Fixture Customer');

-- 1. Authorization boundary --------------------------------------------------

-- anon cannot even invoke the function (no EXECUTE grant — Postgres denies before the function body runs).
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok(
  $$select public.submit_batch('{"shop_id":"10000000-0000-4000-8000-000000000001","business_date":"2026-09-16","idempotency_key":"k1a","rows":[]}'::jsonb)$$,
  '42501', null,
  'anon has no EXECUTE grant on submit_batch'
);
reset role;

-- An authenticated call with no resolvable actor (missing/invalid sub claim) is rejected in-function.
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok(
  $$select public.submit_batch('{"shop_id":"10000000-0000-4000-8000-000000000001","business_date":"2026-09-16","idempotency_key":"k1b","rows":[]}'::jsonb)$$,
  '28000', null,
  'an authenticated call with no resolvable actor is rejected'
);
reset role;

-- Wrong-shop call rejected (Shop 1 staff targeting Shop 2).
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select throws_ok(
  $$select public.submit_batch('{"shop_id":"10000000-0000-4000-8000-000000000002","business_date":"2026-09-16","idempotency_key":"k2","rows":[]}'::jsonb)$$,
  '42501', null,
  'a call targeting an unassigned shop is rejected'
);
reset role;

-- 2. Malformed raw JSON shape is rejected structurally, never as a raw cast/type error ----

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select throws_ok(
  $$select public.submit_batch('"just a string"'::jsonb)$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-object command is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k-rows-absent'
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a command with no rows key is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k-rows-non-array',
    'rows', 'oops'
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-array rows field is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k-unsupported-key',
    'bogus_field', 'nope',
    'rows', jsonb_build_array()
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'an unsupported top-level field is rejected'
);
reset role;

-- 3. A well-formed single-row batch succeeds and is linked to its batch. ----

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select lives_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k3',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-0001',
      'total_dirham', 10000, 'received_dirham', 4000, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'a well-formed batch with one advance-with-partial-payment row succeeds'
);
select is(
  (select count(*)::int from public.invoices i join public.batches b on b.id = i.batch_id
   where i.invoice_id = 'SB-0001' and b.shop_id = '10000000-0000-4000-8000-000000000001'),
  1,
  'the successful batch created exactly one linked invoice'
);
select is(
  (select count(*)::int from public.invoice_number_registry
   where shop_id = '10000000-0000-4000-8000-000000000001' and normalized_invoice_number = 'sb-0001'),
  1,
  'the successful invoice reserved exactly one registry entry'
);
select is(
  (select amount_dirham from public.payments p
   join public.invoices i on i.id = p.invoice_id
   where i.invoice_id = 'SB-0001'),
  4000::bigint,
  'the initial payment amount matches received_dirham'
);

-- 4. Exact replay returns the original result with no new writes. ----

select is(
  (select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k3',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-0001',
      'total_dirham', 10000, 'received_dirham', 4000, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  )) ->> 'batch_id'),
  (select b.id::text from public.batches b where b.idempotency_key = 'k3'),
  'replaying the identical batch under the same key returns the original batch id'
);
select is(
  (select count(*)::int from public.invoices where invoice_id = 'SB-0001'),
  1,
  'replaying the identical batch does not create a second invoice'
);

-- 5. Same key, different fingerprint: explicit conflict, no write. ----

select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k3',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-0001-CHANGED',
      'total_dirham', 10000, 'received_dirham', 4000, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'P0001', 'IDEMPOTENCY_CONFLICT',
  'reusing a key with a changed fingerprint is rejected'
);

-- Casing alone is a content change too: the fingerprint preserves display
-- casing (design decision 2), so reusing the same key with only the
-- invoice-number casing changed must also conflict, not silently replay.
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k3',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'sb-0001',
      'total_dirham', 10000, 'received_dirham', 4000, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'P0001', 'IDEMPOTENCY_CONFLICT',
  'reusing a key with only the invoice-number casing changed is a conflict, not a silent replay'
);

-- 6. Total-not-greater-than-zero row rejected; nothing written. ----

select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k6',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-BAD-TOTAL',
      'total_dirham', 0, 'received_dirham', 0, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a total-not-greater-than-zero row is rejected'
);
select is(
  (select count(*)::int from public.invoices where invoice_id = 'SB-BAD-TOTAL'),
  0,
  'the rejected batch created no invoice'
);
select is(
  (select count(*)::int from public.batches where idempotency_key = 'k6'),
  0,
  'the rejected batch created no batch row'
);

-- 7. Non-cash payment method with received > 0 is rejected by the RPC directly. ----

select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k7',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-BAD-METHOD',
      'total_dirham', 5000, 'received_dirham', 5000, 'payment_method', 'card',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-cash payment method with a positive received amount is rejected by the RPC'
);

-- 8. Delivered row with due and no customer is rejected. ----

select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k8',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-BAD-CUSTOMER',
      'total_dirham', 5000, 'received_dirham', 1000, 'payment_method', 'cash',
      'delivered', true, 'customer', null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a delivered row with due and no customer is rejected'
);

-- 9. Quick-add with both name and mobile blank is rejected. ----

select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k9',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-BLANK-QUICKADD',
      'total_dirham', 5000, 'received_dirham', 0, 'payment_method', 'cash',
      'delivered', false, 'customer', jsonb_build_object('type', 'quick_add', 'name', '   ', 'mobile', null)
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a quick-add customer with both name and mobile blank is rejected'
);

-- 10. Cross-shop customer injection rejected. ----

select throws_ok(
  format(
    $$select public.submit_batch(jsonb_build_object(
      'shop_id', '10000000-0000-4000-8000-000000000001',
      'business_date', current_date::text,
      'idempotency_key', 'k10',
      'rows', jsonb_build_array(jsonb_build_object(
        'row_id', 'r1', 'invoice_number', 'SB-CROSS-CUSTOMER',
        'total_dirham', 5000, 'received_dirham', 0, 'payment_method', 'cash',
        'delivered', false, 'customer', jsonb_build_object('type', 'existing', 'customer_id', %L)
      ))
    ))$$,
    (select id::text from public.customers where shop_id = '10000000-0000-4000-8000-000000000002' limit 1)
  ),
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a row referencing a customer from another shop is rejected'
);

-- 11. Same-shop duplicate invoice number (against the registry, not just invoices) is rejected. ----

select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k11',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-0001',
      'total_dirham', 100, 'received_dirham', 0, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'resubmitting an already-registered invoice number under a new key is rejected'
);

-- Case-variant of an already-registered number is rejected the same way.
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k11-case',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'sb-0001',
      'total_dirham', 100, 'received_dirham', 0, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a case-variant of an already-registered invoice number is rejected'
);
reset role;

-- 12. Same invoice number accepted across two different shops, for an actor with access to both. ----

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select lives_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000002',
    'business_date', current_date::text,
    'idempotency_key', 'k12',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-0001',
      'total_dirham', 100, 'received_dirham', 0, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'the same invoice number is accepted in a different shop for an actor with access to both'
);
reset role;

-- 13. Closed-date rejection: owner, valid backdate fields, a closed historical date. ----

insert into public.daily_closes (shop_id, business_date, event_type, actor_id)
values ('10000000-0000-4000-8000-000000000001', current_date - 2, 'closed', '10000000-0000-4000-8000-000000000101');
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', (current_date - 2)::text,
    'is_backdated', true,
    'backdated_reason', 'late entry on a closed date',
    'idempotency_key', 'k13',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-CLOSED-DATE',
      'total_dirham', 100, 'received_dirham', 0, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'P0001', 'CLOSED_DATE',
  'the owner is still rejected against a closed historical date even with valid backdate fields'
);
reset role;
select is((select count(*)::int from public.batches where idempotency_key = 'k13'), 0,
  'closed-date rejection creates no batch');

-- 14. Backdated batch: non-owner rejected, owner accepted. ----

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', (current_date - 1)::text,
    'is_backdated', true,
    'backdated_reason', 'late entry',
    'idempotency_key', 'k14a',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-BACKDATE-STAFF',
      'total_dirham', 100, 'received_dirham', 0, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  '42501', null,
  'a backdated batch submitted by non-owner staff is rejected'
);
reset role;
select is((select count(*)::int from public.batches where idempotency_key = 'k14a'), 0,
  'staff backdate rejection creates no batch');
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select lives_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', (current_date - 1)::text,
    'is_backdated', true,
    'backdated_reason', '  late entry  ',
    'idempotency_key', 'k14b',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-BACKDATE-OWNER',
      'total_dirham', 100, 'received_dirham', 0, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'a backdated batch submitted by the owner succeeds'
);
reset role;
select is((select business_date from public.batches where idempotency_key = 'k14b'), current_date - 1,
  'owner batch persists the selected business date');
select is((select is_backdated from public.batches where idempotency_key = 'k14b'), true,
  'owner batch persists the backdated flag');
select is((select backdated_reason from public.batches where idempotency_key = 'k14b'), 'late entry',
  'owner batch persists its normalized backdate reason');

-- 15. Canonical fingerprint: changes with content, stable across replay, stable across casing. ----

select isnt(
  private.canonical_batch_command('10000000-0000-4000-8000-000000000001', current_date, false, null,
    jsonb_build_array(jsonb_build_object('row_id','r1','invoice_number','A','total_dirham',100,'received_dirham',0))),
  private.canonical_batch_command('10000000-0000-4000-8000-000000000001', current_date, false, null,
    jsonb_build_array(jsonb_build_object('row_id','r1','invoice_number','B','total_dirham',100,'received_dirham',0))),
  'the canonical command changes when a row''s invoice number changes'
);
select is(
  private.canonical_batch_command('10000000-0000-4000-8000-000000000001', current_date, false, null,
    jsonb_build_array(jsonb_build_object('row_id','r1','invoice_number','A','total_dirham',100,'received_dirham',0))),
  private.canonical_batch_command('10000000-0000-4000-8000-000000000001', current_date, false, null,
    jsonb_build_array(jsonb_build_object('row_id','r1','invoice_number','A','total_dirham',100,'received_dirham',0))),
  'the canonical command is stable across an exact semantic replay'
);
select isnt(
  private.canonical_batch_command('10000000-0000-4000-8000-000000000001', current_date, false, null,
    jsonb_build_array(jsonb_build_object('row_id','r1','invoice_number','ABC-1','total_dirham',100,'received_dirham',0))),
  private.canonical_batch_command('10000000-0000-4000-8000-000000000001', current_date, false, null,
    jsonb_build_array(jsonb_build_object('row_id','r1','invoice_number','abc-1','total_dirham',100,'received_dirham',0))),
  'the canonical command preserves invoice-number display casing, so a retry differing only by casing fingerprints differently'
);
select is(
  private.canonical_batch_command('10000000-0000-4000-8000-000000000001', current_date, false, null,
    jsonb_build_array(jsonb_build_object('row_id','r1','invoice_number','A','total_dirham',100,'received_dirham',0,'payment_method','cash'))),
  private.canonical_batch_command('10000000-0000-4000-8000-000000000001', current_date, false, null,
    jsonb_build_array(jsonb_build_object('row_id','r1','invoice_number','A','total_dirham',100,'received_dirham',0,'payment_method',null))),
  'when received_dirham is zero, differing payment_method representations do not change the canonical command'
);

-- 16. More malformed-shape and type/overflow cases, each rejected structurally. ----

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k16-row-shape',
    'rows', jsonb_build_array('just a string')
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-object row is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k16-dup-row-id',
    'rows', jsonb_build_array(
      jsonb_build_object('row_id','dup','invoice_number','SB-DUP-ROW-ID-1','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null),
      jsonb_build_object('row_id','dup','invoice_number','SB-DUP-ROW-ID-2','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null)
    )
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a duplicate row_id within one batch is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k16-case-dup',
    'rows', jsonb_build_array(
      jsonb_build_object('row_id','r1','invoice_number','CASE-DUP','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null),
      jsonb_build_object('row_id','r2','invoice_number','case-dup','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null)
    )
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a within-batch case-variant duplicate invoice number is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k16-bad-uuid',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-UUID','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,
      'customer', jsonb_build_object('type','existing','customer_id','not-a-uuid')
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a malformed customer_id UUID is rejected structurally, not as a raw cast error'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', 'not-a-date',
    'idempotency_key', 'k16-bad-date',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-DATE','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a malformed business_date is rejected structurally, not as a raw cast error'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k16-bad-bool',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-BOOL','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered','banana','customer',null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-boolean delivered value is rejected structurally, not as a raw cast error'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k16-overflow',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-OVERFLOW','total_dirham',99999999999999999999999999,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a total_dirham beyond 64-bit range is rejected structurally, not as a raw overflow error'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k16-fraction',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-FRACTION','total_dirham',100.5,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a fractional total_dirham is rejected structurally, not as a raw cast error'
);
reset role;

-- 17. A single invalid row rolls back a multi-row batch entirely (customers, invoices, payments, audit). ----

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k17',
    'rows', jsonb_build_array(
      jsonb_build_object('row_id','r1','invoice_number','SB-ROLLBACK-1','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',jsonb_build_object('type','quick_add','name','Rollback Customer','mobile',null)),
      jsonb_build_object('row_id','r2','invoice_number','SB-ROLLBACK-2','total_dirham',0,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null)
    )
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a batch with one invalid row is rejected in full'
);
select is(
  (select count(*)::int from public.invoices where invoice_id in ('SB-ROLLBACK-1','SB-ROLLBACK-2')),
  0,
  'no invoice from the rolled-back batch was persisted'
);
select is(
  (select count(*)::int from public.customers where name = 'Rollback Customer'),
  0,
  'the quick-add customer from the rolled-back batch was not persisted'
);
select is(
  (select count(*)::int from public.audit_events where entity_type = 'batch' and (metadata ->> 'idempotency_key') = 'k17'),
  0,
  'no audit event was recorded for the rolled-back batch'
);

-- 18. Existing-registry prevalidation rejects a multi-row batch entirely, before any write, ----
--     even though an earlier row's quick-add customer and initial payment were fully prepared.
--     (SB-0001 was registered by test group 3 above and is already committed, so this batch is
--     rejected by the advisory prevalidation query — not by the write-loop's unique_violation
--     catch, which this fixture never reaches, since nothing is written until prevalidation
--     passes. This test does not claim to exercise the write-loop's own unique-constraint catch;
--     that path can only be exercised by a genuine cross-session race, which the Task 5
--     integration suite covers separately with two real connections.)

select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k18',
    'rows', jsonb_build_array(
      jsonb_build_object('row_id','r1','invoice_number','SB-MIDWRITE-1','total_dirham',5000,'received_dirham',2000,'payment_method','cash','delivered',false,'customer',jsonb_build_object('type','quick_add','name','Midwrite Customer','mobile',null)),
      jsonb_build_object('row_id','r2','invoice_number','SB-0001','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null)
    )
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'existing-registry prevalidation rejects a multi-row batch in full before any write, even with an earlier row fully prepared'
);
select is(
  (select count(*)::int from public.customers where name = 'Midwrite Customer'),
  0,
  'the earlier row''s quick-add customer was not persisted'
);
select is(
  (select count(*)::int from public.invoices where invoice_id = 'SB-MIDWRITE-1'),
  0,
  'the earlier row''s invoice was not persisted'
);
select is(
  (select count(*)::int from public.payments p join public.invoices i on i.id = p.invoice_id where i.invoice_id = 'SB-MIDWRITE-1'),
  0,
  'the earlier row''s initial payment was not persisted'
);
select is(
  (select count(*)::int from public.invoice_number_registry where shop_id = '10000000-0000-4000-8000-000000000001' and normalized_invoice_number = 'sb-0001'),
  1,
  'the pre-existing registry reservation is unaffected, and no second one was created'
);
select is(
  (select count(*)::int from public.audit_events where entity_type = 'batch' and (metadata ->> 'idempotency_key') = 'k18'),
  0,
  'no audit event was recorded for the rejected batch'
);
reset role;

-- 19. Focused type-validation tests for fields tightened in this revision. ----

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 12345,
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-KEY-TYPE','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-string idempotency_key is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k19-backdated-reason-type',
    'is_backdated', false,
    'backdated_reason', 12345,
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-REASON-TYPE','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-string, non-null backdated_reason is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k19-note-type',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-NOTE-TYPE','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'note',12345,'customer',null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-string, non-null note is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k19-method-type',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-METHOD-TYPE','total_dirham',100,'received_dirham',0,'payment_method',12345,'delivered',false,'customer',null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-string, non-null payment_method is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k19-existing-extra-key',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-EXISTING-KEYS','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,
      'customer', jsonb_build_object('type','existing','customer_id','c9000000-0000-4000-8000-000000000001','name','Should Not Be Here')
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'an existing-customer reference with an extra name field is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k19-quickadd-extra-key',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-QUICKADD-KEYS','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,
      'customer', jsonb_build_object('type','quick_add','name','Extra Key Customer','customer_id','c9000000-0000-4000-8000-000000000001')
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a quick-add customer with an extra customer_id field is rejected'
);
reset role;

-- 20. Response row order preserves submission order. ----

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select is(
  (
    select array_agg(row_value ->> 'row_id' order by ord)
    from jsonb_array_elements(
      (public.submit_batch(jsonb_build_object(
        'shop_id', '10000000-0000-4000-8000-000000000001',
        'business_date', current_date::text,
        'idempotency_key', 'k20-order',
        'rows', jsonb_build_array(
          jsonb_build_object('row_id','order-r1','invoice_number','SB-ORDER-1','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null),
          jsonb_build_object('row_id','order-r2','invoice_number','SB-ORDER-2','total_dirham',200,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null)
        )
      )) -> 'rows')
    ) with ordinality as t(row_value, ord)
  ),
  array['order-r1', 'order-r2'],
  'the response rows array preserves the order rows were submitted in'
);
reset role;

-- 21. A real PostgreSQL calendar-date change must not invalidate an exact retry.
-- The two session time zones straddle midnight for every possible UTC instant.
set local timezone = 'Etc/GMT+12';
select set_config('test.midnight_date', (now() at time zone 'Asia/Qatar')::date::text, true);
select set_config('test.midnight_command', jsonb_build_object(
  'shop_id', '10000000-0000-4000-8000-000000000001',
  'business_date', current_setting('test.midnight_date'),
  'idempotency_key', 'k21-midnight-replay',
  'rows', jsonb_build_array(jsonb_build_object(
    'row_id','midnight-row','invoice_number','SB-MIDNIGHT-REPLAY',
    'total_dirham',100,'received_dirham',0,'payment_method','cash',
    'delivered',false,'customer',null
  ))
)::text, true);
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select set_config('test.midnight_receipt', public.submit_batch(current_setting('test.midnight_command')::jsonb)::text, true);
reset role;
insert into public.daily_closes (shop_id, business_date, event_type, actor_id)
values ('10000000-0000-4000-8000-000000000001', current_setting('test.midnight_date')::date, 'closed', '10000000-0000-4000-8000-000000000101');
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
set local timezone = 'Pacific/Kiritimati';
select is(
  public.submit_batch(current_setting('test.midnight_command')::jsonb)::text,
  current_setting('test.midnight_receipt'),
  'exact staff retry after PostgreSQL current_date changes and the day closes returns the stored receipt'
);
select throws_ok(
  $$select public.submit_batch(jsonb_set(current_setting('test.midnight_command')::jsonb, '{rows,0,total_dirham}', '101'::jsonb))$$,
  'P0001', 'IDEMPOTENCY_CONFLICT',
  'a changed fingerprint after the date change still conflicts'
);
select throws_ok(
  $$select public.submit_batch(jsonb_set(jsonb_set(current_setting('test.midnight_command')::jsonb, '{idempotency_key}', '"k21-new"'::jsonb), '{rows,0,invoice_number}', '"SB-MIDNIGHT-NEW"'::jsonb))$$,
  'P0001', 'CLOSED_DATE',
  'a new staff submission for the now-closed date remains forbidden'
);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000103"}';
select throws_ok(
  $$select public.submit_batch(current_setting('test.midnight_command')::jsonb)$$,
  '42501', 'UNAUTHORIZED_SHOP',
  'wrong-shop actor cannot replay the stored receipt'
);
reset role;
select is(
  (select count(*)::int from public.invoices where shop_id = '10000000-0000-4000-8000-000000000001' and invoice_id = 'SB-MIDNIGHT-REPLAY'),
  1,
  'midnight retry wrote one invoice only'
);
insert into public.daily_closes (shop_id, business_date, event_type, actor_id, reason)
values ('10000000-0000-4000-8000-000000000001', current_setting('test.midnight_date')::date,
        'reopened', '10000000-0000-4000-8000-000000000101', 'Continue this transaction test');
set local timezone = 'Asia/Qatar';

-- 22. The backdate flag participates in new fingerprints, while stored
-- pre-upgrade fingerprints remain replayable only with their original flag.
select set_config('test.flag_command', jsonb_build_object(
  'shop_id', '10000000-0000-4000-8000-000000000001',
  'business_date', current_date::text,
  'idempotency_key', 'k22-flag-fingerprint',
  'rows', jsonb_build_array(jsonb_build_object(
    'row_id','flag-row','invoice_number','SB-FLAG-FINGERPRINT',
    'total_dirham',100,'received_dirham',0,'payment_method','cash',
    'delivered',false,'customer',null
  ))
)::text, true);
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select set_config('test.flag_receipt', public.submit_batch(current_setting('test.flag_command')::jsonb)::text, true);
select throws_ok(
  $$select public.submit_batch(jsonb_set(current_setting('test.flag_command')::jsonb, '{is_backdated}', 'true'::jsonb))$$,
  'P0001', 'IDEMPOTENCY_CONFLICT',
  'changing only is_backdated cannot replay a committed batch'
);
reset role;
select set_config('test.legacy_command', jsonb_set(
  jsonb_set(current_setting('test.flag_command')::jsonb, '{idempotency_key}', '"k22-legacy"'::jsonb),
  '{rows,0,invoice_number}', '"SB-LEGACY-FINGERPRINT"'::jsonb
)::text, true);
insert into public.batches (shop_id, business_date, is_backdated, idempotency_key, fingerprint, idempotency_result)
values (
  '10000000-0000-4000-8000-000000000001', current_date, false, 'k22-legacy',
  encode(extensions.digest((private.canonical_batch_command(
    '10000000-0000-4000-8000-000000000001', current_date, false, null,
    current_setting('test.legacy_command')::jsonb -> 'rows'
  ) - 'is_backdated')::text::bytea, 'sha256'), 'hex'),
  '{"ok":true,"batch_id":"10000000-0000-4000-8000-000000000999"}'::jsonb
);
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select is(
  public.submit_batch(current_setting('test.legacy_command')::jsonb),
  '{"ok":true,"batch_id":"10000000-0000-4000-8000-000000000999"}'::jsonb,
  'a stored pre-upgrade fingerprint still returns its receipt'
);
select throws_ok(
  $$select public.submit_batch(jsonb_set(current_setting('test.legacy_command')::jsonb, '{is_backdated}', 'true'::jsonb))$$,
  'P0001', 'IDEMPOTENCY_CONFLICT',
  'a pre-upgrade fingerprint cannot replay with a changed backdate flag'
);
reset role;
select is(
  (select count(*)::int from public.invoices where invoice_id = 'SB-LEGACY-FINGERPRINT'),
  0,
  'legacy receipt replay performs no invoice write'
);

-- 23. Operational balances use approved invoice and payment corrections,
-- and the security-invoker view keeps the underlying shop RLS boundary.
insert into public.corrections (shop_id, invoice_id, amount_delta_dirham, reason, business_date, approved_by)
select i.shop_id, i.id, -1000, 'approved invoice correction', i.business_date, '10000000-0000-4000-8000-000000000101'
from public.invoices i where i.invoice_id = 'SB-0001';
insert into public.corrections (shop_id, invoice_id, amount_delta_dirham, reason, business_date)
select i.shop_id, i.id, -2000, 'pending invoice correction', i.business_date
from public.invoices i where i.invoice_id = 'SB-0001';
insert into public.corrections (shop_id, payment_id, amount_delta_dirham, reason, business_date, approved_by)
select p.shop_id, p.id, 500, 'approved payment correction', p.business_date, '10000000-0000-4000-8000-000000000101'
from public.payments p join public.invoices i on i.id = p.invoice_id where i.invoice_id = 'SB-0001';
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select is((select b.effective_total_dirham from public.invoice_effective_balances b
           join public.invoices i on i.id = b.canonical_invoice_id where i.invoice_id = 'SB-0001'),
          9000::bigint, 'approved invoice correction changes the effective total, pending correction does not');
select is((select b.effective_paid_dirham from public.invoice_effective_balances b
           join public.invoices i on i.id = b.canonical_invoice_id where i.invoice_id = 'SB-0001'),
          4500::bigint, 'approved payment correction changes the effective paid amount');
select is((select b.effective_due_dirham from public.invoice_effective_balances b
           join public.invoices i on i.id = b.canonical_invoice_id where i.invoice_id = 'SB-0001'),
          4500::bigint, 'effective due matches payment-operation arithmetic');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000103"}';
select is((select count(*)::int from public.invoice_effective_balances
           where shop_id = '10000000-0000-4000-8000-000000000001'),
          0, 'wrong-shop staff cannot read effective balances');
reset role;

-- 24. The operating date is Qatar's calendar date, independent of session timezone.
select set_config('TimeZone', case
  when (now() at time zone 'Etc/GMT+12')::date <> (now() at time zone 'Asia/Qatar')::date
    then 'Etc/GMT+12' else 'Pacific/Kiritimati' end, true);
select isnt(current_date, (now() at time zone 'Asia/Qatar')::date,
  'the session date differs from the Qatar operating date');
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select is(public.submit_batch(jsonb_build_object(
  'shop_id', '10000000-0000-4000-8000-000000000001',
  'business_date', (now() at time zone 'Asia/Qatar')::date::text,
  'idempotency_key', 'k24-qatar-date',
  'rows', jsonb_build_array(jsonb_build_object(
    'row_id','qatar-row','invoice_number','SB-QATAR-DATE',
    'total_dirham',100,'received_dirham',0,'payment_method','cash',
    'delivered',false,'customer',null
  ))
)) ->> 'ok', 'true', 'staff can submit for the Qatar date despite a different session date');
reset role;
set local timezone = 'Asia/Qatar';

-- 25. Legacy true fingerprints retain the original flag on exact replay.
select set_config('test.legacy_true_command', jsonb_build_object(
  'shop_id', '10000000-0000-4000-8000-000000000001',
  'business_date', (current_date - 1)::text,
  'is_backdated', true,
  'backdated_reason', 'Original owner backdate',
  'idempotency_key', 'k25-legacy-true',
  'rows', jsonb_build_array(jsonb_build_object(
    'row_id','legacy-true-row','invoice_number','SB-LEGACY-TRUE',
    'total_dirham',100,'received_dirham',0,'payment_method','cash',
    'delivered',false,'customer',null
  ))
)::text, true);
insert into public.batches (shop_id, business_date, is_backdated, backdated_reason, idempotency_key, fingerprint, idempotency_result)
values (
  '10000000-0000-4000-8000-000000000001', current_date - 1, true,
  'Original owner backdate', 'k25-legacy-true',
  encode(extensions.digest((private.canonical_batch_command(
    '10000000-0000-4000-8000-000000000001', current_date - 1, true, 'Original owner backdate',
    current_setting('test.legacy_true_command')::jsonb -> 'rows'
  ) - 'is_backdated')::text::bytea, 'sha256'), 'hex'),
  '{"ok":true,"batch_id":"10000000-0000-4000-8000-000000000998"}'::jsonb
);
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select is(public.submit_batch(current_setting('test.legacy_true_command')::jsonb),
  '{"ok":true,"batch_id":"10000000-0000-4000-8000-000000000998"}'::jsonb,
  'exact legacy true replay returns its stored receipt');
select throws_ok(
  $$select public.submit_batch(jsonb_set(current_setting('test.legacy_true_command')::jsonb, '{is_backdated}', 'false'::jsonb))$$,
  'P0001', 'IDEMPOTENCY_CONFLICT',
  'changing a legacy true flag to false conflicts'
);
reset role;

-- A backdated exact replay remains available after close, but only to a current owner.
select set_config('test.backdated_replay_command', jsonb_build_object(
  'shop_id', '10000000-0000-4000-8000-000000000001',
  'business_date', (current_date - 1)::text,
  'is_backdated', true,
  'backdated_reason', '  month-end catch-up  ',
  'idempotency_key', 'k26-backdated-replay',
  'rows', jsonb_build_array(jsonb_build_object(
    'row_id','backdated-replay-row','invoice_number','SB-BACKDATED-REPLAY',
    'total_dirham',100,'received_dirham',0,'payment_method','cash',
    'delivered',false,'customer',null
  ))
)::text, true);
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select set_config('test.backdated_replay_receipt', public.submit_batch(current_setting('test.backdated_replay_command')::jsonb)::text, true);
reset role;
insert into public.daily_closes (shop_id, business_date, event_type, actor_id)
values ('10000000-0000-4000-8000-000000000001', current_date - 1, 'closed', '10000000-0000-4000-8000-000000000101');
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select is(public.submit_batch(current_setting('test.backdated_replay_command')::jsonb)::text,
  current_setting('test.backdated_replay_receipt'),
  'authorized exact backdated replay survives the day closing');
reset role;
update public.profiles set role = 'staff' where id = '10000000-0000-4000-8000-000000000101';
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select throws_ok(
  $$select public.submit_batch(current_setting('test.backdated_replay_command')::jsonb)$$,
  '42501', 'INSUFFICIENT_ROLE',
  'an actor who lost owner role cannot replay a backdated command');
reset role;
update public.profiles set role = 'owner' where id = '10000000-0000-4000-8000-000000000101';

-- A changed backdate reason conflicts and leaves the original write set intact.
select set_config('test.backdated_reason_command', jsonb_build_object(
  'shop_id', '10000000-0000-4000-8000-000000000001',
  'business_date', (current_date - 3)::text,
  'is_backdated', true,
  'backdated_reason', '  month-end catch-up  ',
  'idempotency_key', 'k27-backdated-reason-fingerprint',
  'rows', jsonb_build_array(jsonb_build_object(
    'row_id','backdated-reason-row','invoice_number','SB-BACKDATED-REASON',
    'total_dirham',100,'received_dirham',0,'payment_method','cash',
    'delivered',false,'customer',null
  ))
)::text, true);
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select set_config('test.backdated_reason_receipt',
  public.submit_batch(current_setting('test.backdated_reason_command')::jsonb)::text, true);
select is(current_setting('test.backdated_reason_receipt')::jsonb ->> 'ok', 'true',
  'the initial owner submission succeeds before the reason-change retry');
select is((select count(*)::int from public.batches where shop_id = '10000000-0000-4000-8000-000000000001' and idempotency_key = 'k27-backdated-reason-fingerprint'),
  1, 'the initial owner submission commits one batch before the reason-change retry');
select throws_ok(
  $$select public.submit_batch(jsonb_set(current_setting('test.backdated_reason_command')::jsonb, '{backdated_reason}', '"corrected reason"'::jsonb))$$,
  'P0001', 'IDEMPOTENCY_CONFLICT',
  'changing only backdated_reason cannot replay a committed batch'
);
reset role;
select is((select count(*)::int from public.batches where shop_id = '10000000-0000-4000-8000-000000000001' and idempotency_key = 'k27-backdated-reason-fingerprint'),
  1, 'a changed backdate reason leaves exactly one committed batch');
select is((select count(*)::int from public.invoices where shop_id = '10000000-0000-4000-8000-000000000001' and invoice_id = 'SB-BACKDATED-REASON'),
  1, 'a changed backdate reason leaves exactly one invoice');
select is((select count(*)::int from public.invoice_number_registry where shop_id = '10000000-0000-4000-8000-000000000001' and invoice_number = 'SB-BACKDATED-REASON'),
  1, 'a changed backdate reason leaves exactly one invoice registry entry');
select is((select backdated_reason from public.batches where shop_id = '10000000-0000-4000-8000-000000000001' and idempotency_key = 'k27-backdated-reason-fingerprint'),
  'month-end catch-up', 'the original normalized backdate reason remains committed');

select * from finish();
rollback;
