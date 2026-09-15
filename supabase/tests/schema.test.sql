begin;

create extension if not exists pgtap with schema extensions;

select plan(99);

create function pg_temp.query_returns_true(query text)
returns boolean
language plpgsql
as $$
declare
  query_result boolean;
begin
  execute query into query_result;
  return coalesce(query_result, false);
exception
  when undefined_table or undefined_column then
    return false;
end;
$$;

select has_table('public', 'shops', 'shops table exists');
select has_table('public', 'profiles', 'profiles table exists');
select has_table('public', 'user_shop_assignments', 'user_shop_assignments table exists');
select has_table('public', 'customers', 'customers table exists');
select has_table('public', 'batches', 'batches table exists');
select has_table('public', 'invoices', 'invoices table exists');
select has_table('public', 'payments', 'payments table exists');
select has_table('public', 'customer_credits', 'customer_credits table exists');
select has_table('public', 'expenses', 'expenses table exists');
select has_table('public', 'attachments', 'attachments table exists');
select has_table('public', 'corrections', 'corrections table exists');
select has_table('public', 'daily_closes', 'daily_closes table exists');
select has_table('public', 'audit_events', 'audit_events table exists');

select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'invoices'
      and indexname = 'invoices_shop_invoice_id_uq'
      and indexdef like '%(shop_id, invoice_id)%'
  ),
  'invoice identity has the explicit unique (shop_id, invoice_id) index'
);

select col_type_is('public', 'invoices', 'invoice_id', 'text', 'invoice IDs remain user-entered text');
select col_type_is('public', 'invoices', 'total_amount_dirham', 'bigint', 'invoice totals use bigint dirhams');
select col_type_is('public', 'payments', 'amount_dirham', 'bigint', 'payment amounts use bigint dirhams');
select col_type_is('public', 'customer_credits', 'amount_dirham', 'bigint', 'customer-credit amounts use bigint dirhams');
select col_type_is('public', 'expenses', 'amount_dirham', 'bigint', 'expense amounts use bigint dirhams');
select col_type_is('public', 'corrections', 'amount_delta_dirham', 'bigint', 'correction deltas use bigint dirhams');

select ok(
  exists (
    select 1 from pg_constraint
    where conname = 'invoices_total_amount_nonnegative'
      and conrelid = to_regclass('public.invoices')
  ),
  'invoice totals have a named non-negative constraint'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conname = 'payments_amount_nonnegative'
      and conrelid = to_regclass('public.payments')
  ),
  'payment amounts have a named non-negative constraint'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conname = 'customer_credits_amount_nonnegative'
      and conrelid = to_regclass('public.customer_credits')
  ),
  'customer-credit amounts have a named non-negative constraint'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conname = 'expenses_amount_nonnegative'
      and conrelid = to_regclass('public.expenses')
  ),
  'expense amounts have a named non-negative constraint'
);
select ok(
  to_regclass('public.corrections') is not null
  and not exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('public.corrections')
      and pg_get_constraintdef(oid) ilike '%amount_delta_dirham%>= 0%'
  ),
  'correction amount deltas are signed'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'customers_public_id_uq'
      and conrelid = to_regclass('public.customers')
      and contype = 'u'
  ),
  'customer public IDs are unique'
);
select ok(
  (select column_default like '%customer_public_id_seq%'
   from information_schema.columns
   where table_schema = 'public' and table_name = 'customers' and column_name = 'public_id'),
  'customer public IDs are sequence generated'
);
select ok(
  (select column_default is not null
   from information_schema.columns
   where table_schema = 'public' and table_name = 'invoices' and column_name = 'recorded_at'),
  'invoice recorded_at is server generated'
);
select ok(
  (select data_type = 'timestamp with time zone' and column_default is not null
   from information_schema.columns
   where table_schema = 'public' and table_name = 'audit_events' and column_name = 'recorded_at'),
  'audit-event recorded_at is server-generated timestamptz'
);

select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'daily_closes'
      and column_name = 'event_sequence'
      and is_identity = 'YES'
      and identity_generation = 'ALWAYS'
  ),
  'daily_closes event_sequence is generated always as identity'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'daily_closes_event_sequence_uq'
      and conrelid = to_regclass('public.daily_closes')
      and contype = 'u'
  ),
  'daily_closes has named unique constraint daily_closes_event_sequence_uq'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'daily_closes_event_type_check'
      and conrelid = to_regclass('public.daily_closes')
      and contype = 'c'
  ),
  'daily_closes has named check constraint daily_closes_event_type_check'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'daily_closes_event_reason_check'
      and conrelid = to_regclass('public.daily_closes')
      and contype = 'c'
  ),
  'daily_closes has named check constraint daily_closes_event_reason_check'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'batches_shop_id_id_uq'
      and conrelid = to_regclass('public.batches')
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (shop_id, id)'
  ),
  'batches has named candidate key batches_shop_id_id_uq on (shop_id, id)'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'customers_shop_id_id_uq'
      and conrelid = to_regclass('public.customers')
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (shop_id, id)'
  ),
  'customers has named candidate key customers_shop_id_id_uq on (shop_id, id)'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'invoices_shop_id_id_uq'
      and conrelid = to_regclass('public.invoices')
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (shop_id, id)'
  ),
  'invoices has named candidate key invoices_shop_id_id_uq on (shop_id, id)'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'payments_shop_id_id_uq'
      and conrelid = to_regclass('public.payments')
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (shop_id, id)'
  ),
  'payments has named candidate key payments_shop_id_id_uq on (shop_id, id)'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'invoices_shop_id_batch_id_fkey'
      and conrelid = to_regclass('public.invoices')
      and confrelid = to_regclass('public.batches')
      and contype = 'f'
      and confdeltype = 'r'
      and pg_get_constraintdef(oid) = 'FOREIGN KEY (shop_id, batch_id) REFERENCES batches(shop_id, id) ON DELETE RESTRICT'
  ),
  'invoices has composite foreign key invoices_shop_id_batch_id_fkey referencing batches(shop_id, id) ON DELETE RESTRICT'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'invoices_shop_id_customer_id_fkey'
      and conrelid = to_regclass('public.invoices')
      and confrelid = to_regclass('public.customers')
      and contype = 'f'
      and confdeltype = 'r'
      and pg_get_constraintdef(oid) = 'FOREIGN KEY (shop_id, customer_id) REFERENCES customers(shop_id, id) ON DELETE RESTRICT'
  ),
  'invoices has composite foreign key invoices_shop_id_customer_id_fkey referencing customers(shop_id, id) ON DELETE RESTRICT'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'payments_shop_id_batch_id_fkey'
      and conrelid = to_regclass('public.payments')
      and confrelid = to_regclass('public.batches')
      and contype = 'f'
      and confdeltype = 'r'
      and pg_get_constraintdef(oid) = 'FOREIGN KEY (shop_id, batch_id) REFERENCES batches(shop_id, id) ON DELETE RESTRICT'
  ),
  'payments has composite foreign key payments_shop_id_batch_id_fkey referencing batches(shop_id, id) ON DELETE RESTRICT'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'payments_shop_id_invoice_id_fkey'
      and conrelid = to_regclass('public.payments')
      and confrelid = to_regclass('public.invoices')
      and contype = 'f'
      and confdeltype = 'r'
      and pg_get_constraintdef(oid) = 'FOREIGN KEY (shop_id, invoice_id) REFERENCES invoices(shop_id, id) ON DELETE RESTRICT'
  ),
  'payments has composite foreign key payments_shop_id_invoice_id_fkey referencing invoices(shop_id, id) ON DELETE RESTRICT'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'customer_credits_shop_id_customer_id_fkey'
      and conrelid = to_regclass('public.customer_credits')
      and confrelid = to_regclass('public.customers')
      and contype = 'f'
      and confdeltype = 'r'
      and pg_get_constraintdef(oid) = 'FOREIGN KEY (shop_id, customer_id) REFERENCES customers(shop_id, id) ON DELETE RESTRICT'
  ),
  'customer_credits has composite foreign key customer_credits_shop_id_customer_id_fkey referencing customers(shop_id, id) ON DELETE RESTRICT'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'customer_credits_shop_id_invoice_id_fkey'
      and conrelid = to_regclass('public.customer_credits')
      and confrelid = to_regclass('public.invoices')
      and contype = 'f'
      and confdeltype = 'r'
      and pg_get_constraintdef(oid) = 'FOREIGN KEY (shop_id, invoice_id) REFERENCES invoices(shop_id, id) ON DELETE RESTRICT'
  ),
  'customer_credits has composite foreign key customer_credits_shop_id_invoice_id_fkey referencing invoices(shop_id, id) ON DELETE RESTRICT'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'attachments_shop_id_batch_id_fkey'
      and conrelid = to_regclass('public.attachments')
      and confrelid = to_regclass('public.batches')
      and contype = 'f'
      and confdeltype = 'r'
      and pg_get_constraintdef(oid) = 'FOREIGN KEY (shop_id, batch_id) REFERENCES batches(shop_id, id) ON DELETE RESTRICT'
  ),
  'attachments has composite foreign key attachments_shop_id_batch_id_fkey referencing batches(shop_id, id) ON DELETE RESTRICT'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'attachments_shop_id_invoice_id_fkey'
      and conrelid = to_regclass('public.attachments')
      and confrelid = to_regclass('public.invoices')
      and contype = 'f'
      and confdeltype = 'r'
      and pg_get_constraintdef(oid) = 'FOREIGN KEY (shop_id, invoice_id) REFERENCES invoices(shop_id, id) ON DELETE RESTRICT'
  ),
  'attachments has composite foreign key attachments_shop_id_invoice_id_fkey referencing invoices(shop_id, id) ON DELETE RESTRICT'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'corrections_shop_id_invoice_id_fkey'
      and conrelid = to_regclass('public.corrections')
      and confrelid = to_regclass('public.invoices')
      and contype = 'f'
      and confdeltype = 'r'
      and pg_get_constraintdef(oid) = 'FOREIGN KEY (shop_id, invoice_id) REFERENCES invoices(shop_id, id) ON DELETE RESTRICT'
  ),
  'corrections has composite foreign key corrections_shop_id_invoice_id_fkey referencing invoices(shop_id, id) ON DELETE RESTRICT'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'corrections_shop_id_payment_id_fkey'
      and conrelid = to_regclass('public.corrections')
      and confrelid = to_regclass('public.payments')
      and contype = 'f'
      and confdeltype = 'r'
      and pg_get_constraintdef(oid) = 'FOREIGN KEY (shop_id, payment_id) REFERENCES payments(shop_id, id) ON DELETE RESTRICT'
  ),
  'corrections has composite foreign key corrections_shop_id_payment_id_fkey referencing payments(shop_id, id) ON DELETE RESTRICT'
);

select col_not_null('public', 'shops', 'name', 'shop name is required');
select col_not_null('public', 'profiles', 'role', 'profile role is required');
select col_not_null('public', 'customers', 'public_id', 'customer public ID is required');
select col_not_null('public', 'batches', 'shop_id', 'batch shop is required');
select col_not_null('public', 'batches', 'business_date', 'batch business date is required');
select col_not_null('public', 'invoices', 'shop_id', 'invoice shop is required');
select col_not_null('public', 'invoices', 'invoice_id', 'invoice user ID is required');
select col_not_null('public', 'invoices', 'business_date', 'invoice business date is required');
select col_not_null('public', 'payments', 'invoice_id', 'payment invoice is required');
select col_not_null('public', 'payments', 'business_date', 'payment business date is required');
select col_not_null('public', 'expenses', 'description', 'expense description is required');
select col_not_null('public', 'corrections', 'reason', 'correction reason is required');
select col_not_null('public', 'audit_events', 'action', 'audit action is required');

select has_fk('public', 'profiles', 'profiles reference authenticated users');
select has_fk('public', 'user_shop_assignments', 'assignments have foreign keys');
select has_fk('public', 'customers', 'customers reference their shop');
select has_fk('public', 'batches', 'batches have required foreign keys');
select has_fk('public', 'invoices', 'invoices have required foreign keys');
select has_fk('public', 'payments', 'payments have required foreign keys');
select has_fk('public', 'customer_credits', 'customer credits have required foreign keys');
select has_fk('public', 'expenses', 'expenses have required foreign keys');
select has_fk('public', 'attachments', 'attachments have required foreign keys');
select has_fk('public', 'corrections', 'corrections have required foreign keys');
select has_fk('public', 'daily_closes', 'daily closes have required foreign keys');
select has_fk('public', 'audit_events', 'audit events reference actors and shops');

select ok(
  pg_temp.query_returns_true(
    $$select array_agg(name order by name) = array['Shop 1'::text, 'Shop 2'::text]
      from public.shops$$
  ),
  'reset seeds exactly Shop 1 and Shop 2'
);
select ok(
  pg_temp.query_returns_true(
    $$select array_agg(display_name order by display_name) = array[
        'Local Owner'::text,
        'Local Shop 1 Staff'::text,
        'Local Shop 2 Staff'::text
      ]
      from public.profiles$$
  ),
  'reset seeds deterministic local test profiles'
);
select ok(
  pg_temp.query_returns_true(
    $$select count(*) > 0
        and count(*) filter (where email not like '%@shopkhata.local') = 0
      from public.profiles$$
  ),
  'seeded profiles use local-only identities'
);

select lives_ok(
  $$
  insert into public.batches (id, shop_id, business_date, created_by, idempotency_key)
  values
    ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', current_date, '10000000-0000-4000-8000-000000000101', 'schema-test-shop-1'),
    ('10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', current_date, '10000000-0000-4000-8000-000000000101', 'schema-test-shop-2');
  insert into public.invoices (
    id, shop_id, batch_id, invoice_id, invoice_type, quantity,
    total_amount_dirham, business_date, created_by
  ) values
    ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'SAME-ID', 'advance', 1, 1000, current_date, '10000000-0000-4000-8000-000000000101'),
    ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'SAME-ID', 'advance', 1, 1000, current_date, '10000000-0000-4000-8000-000000000101');
  $$,
  'the same invoice ID is accepted in different shops'
);

select throws_ok(
  $$
  insert into public.invoices (
    shop_id, batch_id, invoice_id, invoice_type, quantity,
    total_amount_dirham, business_date, created_by
  ) values (
    '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
    'SAME-ID', 'advance', 1, 1000, current_date,
    '10000000-0000-4000-8000-000000000101'
  );
  $$,
  '23505',
  null,
  'a duplicate invoice ID in the same shop is rejected'
);

select lives_ok(
  $$
  do $test$
  declare
    first_id text;
    second_id text;
  begin
    insert into public.customers (shop_id, created_by)
    values ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000101')
    returning public_id into first_id;

    insert into public.customers (shop_id, created_by)
    values ('10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000101')
    returning public_id into second_id;

    if first_id !~ '^CUS-[0-9]{5,}$' or second_id !~ '^CUS-[0-9]{5,}$' or first_id = second_id then
      raise exception 'customer IDs were not unique CUS-00001-form values';
    end if;
  end
  $test$;
  $$,
  'customer public IDs are generated uniquely in CUS-00001 form'
);

select lives_ok(
  $$
  insert into public.corrections (
    shop_id, invoice_id, amount_delta_dirham, reason,
    business_date, created_by, approved_by
  ) values (
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    -100, 'schema test signed correction', current_date,
    '10000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000101'
  );
  $$,
  'signed negative correction deltas are accepted'
);

select throws_ok(
  $$
  insert into public.payments (
    shop_id, invoice_id, amount_dirham, business_date, created_by
  ) values (
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    -1, current_date, '10000000-0000-4000-8000-000000000101'
  );
  $$,
  '23514',
  null,
  'ordinary financial amounts reject negative values'
);

insert into public.customers (id, shop_id, public_id, created_by)
values
  (
    '31000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'CUS-TENANT-1',
    '10000000-0000-4000-8000-000000000101'
  ),
  (
    '31000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    'CUS-TENANT-2',
    '10000000-0000-4000-8000-000000000101'
  );

insert into public.payments (
  id, shop_id, batch_id, invoice_id, amount_dirham, business_date, created_by
)
values (
  '51000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000002',
  100,
  current_date,
  '10000000-0000-4000-8000-000000000101'
);

select throws_ok(
  $$
  insert into public.invoices (
    id, shop_id, batch_id, invoice_id, total_amount_dirham, business_date
  ) values (
    '41000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'CROSS-SHOP-BATCH', 100, current_date
  );
  $$,
  '23503',
  null,
  'an invoice cannot reference a batch from another shop'
);

select throws_ok(
  $$
  insert into public.invoices (
    id, shop_id, batch_id, customer_id, invoice_id,
    total_amount_dirham, business_date
  ) values (
    '41000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000002',
    'CROSS-SHOP-CUSTOMER', 100, current_date
  );
  $$,
  '23503',
  null,
  'an invoice cannot reference a customer from another shop'
);

select throws_ok(
  $$
  insert into public.payments (
    id, shop_id, batch_id, invoice_id, amount_dirham, business_date
  ) values (
    '51000000-0000-4000-8000-000000000011',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001',
    100, current_date
  );
  $$,
  '23503',
  null,
  'a payment cannot reference a batch from another shop'
);

select throws_ok(
  $$
  insert into public.payments (
    id, shop_id, batch_id, invoice_id, amount_dirham, business_date
  ) values (
    '51000000-0000-4000-8000-000000000012',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    100, current_date
  );
  $$,
  '23503',
  null,
  'a payment cannot reference an invoice from another shop'
);

select throws_ok(
  $$
  insert into public.customer_credits (
    id, shop_id, customer_id, amount_dirham, business_date
  ) values (
    '61000000-0000-4000-8000-000000000011',
    '10000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000002',
    100, current_date
  );
  $$,
  '23503',
  null,
  'a customer credit cannot reference a customer from another shop'
);

select throws_ok(
  $$
  insert into public.customer_credits (
    id, shop_id, customer_id, invoice_id, amount_dirham, business_date
  ) values (
    '61000000-0000-4000-8000-000000000012',
    '10000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    100, current_date
  );
  $$,
  '23503',
  null,
  'a customer credit cannot reference an invoice from another shop'
);

select throws_ok(
  $$
  insert into public.attachments (
    id, shop_id, batch_id, file_path, file_name
  ) values (
    '81000000-0000-4000-8000-000000000011',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'tenant-test/cross-batch', 'cross-batch.txt'
  );
  $$,
  '23503',
  null,
  'an attachment cannot reference a batch from another shop'
);

select throws_ok(
  $$
  insert into public.attachments (
    id, shop_id, invoice_id, file_path, file_name
  ) values (
    '81000000-0000-4000-8000-000000000012',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    'tenant-test/cross-invoice', 'cross-invoice.txt'
  );
  $$,
  '23503',
  null,
  'an attachment cannot reference an invoice from another shop'
);

select throws_ok(
  $$
  insert into public.corrections (
    id, shop_id, invoice_id, amount_delta_dirham, reason, business_date
  ) values (
    '91000000-0000-4000-8000-000000000011',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    10, 'cross-shop invoice probe', current_date
  );
  $$,
  '23503',
  null,
  'a correction cannot reference an invoice from another shop'
);

select throws_ok(
  $$
  insert into public.corrections (
    id, shop_id, payment_id, amount_delta_dirham, reason, business_date
  ) values (
    '91000000-0000-4000-8000-000000000012',
    '10000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000002',
    10, 'cross-shop payment probe', current_date
  );
  $$,
  '23503',
  null,
  'a correction cannot reference a payment from another shop'
);

select lives_ok(
  $$
  insert into public.daily_closes (
    id, shop_id, business_date, event_type, actor_id, reason
  ) values
    (
      'd1000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      current_date, 'closed', '10000000-0000-4000-8000-000000000101', null
    ),
    (
      'd1000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001',
      current_date, 'reopened', '10000000-0000-4000-8000-000000000101',
      'late entry approved for schema test'
    ),
    (
      'd1000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000001',
      current_date, 'closed', '10000000-0000-4000-8000-000000000101', null
    );
  $$,
  'close, reopen with reason, and close again are immutable events'
);

select is(
  (
    select count(*)
    from public.daily_closes
    where id in (
      'd1000000-0000-4000-8000-000000000001',
      'd1000000-0000-4000-8000-000000000002',
      'd1000000-0000-4000-8000-000000000003'
    )
  ),
  3::bigint,
  'the daily-close lifecycle preserves all three events'
);

select ok(
  pg_temp.query_returns_true(
    $$select count(*) = 3
        and count(distinct event_sequence) = 3
        and (array_agg(event_type order by event_sequence desc))[1] = 'closed'
      from public.daily_closes
      where id in (
        'd1000000-0000-4000-8000-000000000001',
        'd1000000-0000-4000-8000-000000000002',
        'd1000000-0000-4000-8000-000000000003'
      )$$
  ),
  'daily-close event sequence deterministically identifies the latest event'
);

select throws_ok(
  $$
  insert into public.daily_closes (
    id, shop_id, business_date, event_type, actor_id, reason
  ) values (
    'd1000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000001',
    current_date, 'reopened', '10000000-0000-4000-8000-000000000101', '   '
  );
  $$,
  '23514',
  null,
  'a reopen event requires a non-blank reason'
);

select throws_ok(
  $$
  insert into public.daily_closes (
    id, shop_id, business_date, event_type, actor_id
  ) values (
    'd1000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000001',
    current_date, 'invalid-event', '10000000-0000-4000-8000-000000000101'
  );
  $$,
  '23514',
  null,
  'daily-close events accept only closed or reopened types'
);

select throws_ok(
  $$
  insert into public.daily_closes (
    id, shop_id, business_date, event_type, actor_id, reason
  ) values (
    'd1000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000001',
    current_date, 'reopened', '10000000-0000-4000-8000-000000000101', null
  );
  $$,
  '23514',
  null,
  'a reopen event requires a non-null reason'
);

select throws_ok(
  $$
  insert into public.daily_closes (
    id, shop_id, business_date, event_type, actor_id, reason
  ) values (
    'd1000000-0000-4000-8000-000000000007',
    '10000000-0000-4000-8000-000000000001',
    current_date, 'closed', '10000000-0000-4000-8000-000000000101',
    'a close event should not carry a reason'
  );
  $$,
  '23514',
  null,
  'a close event rejects a non-null reason'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'batches', 'invoices', 'payments', 'customer_credits', 'expenses',
      'corrections', 'daily_closes', 'audit_events'
    ]) as protected(table_name)
    cross join unnest(array['anon', 'authenticated']) as app(role_name)
    where to_regclass(format('public.%I', protected.table_name)) is null
       or has_table_privilege(
            app.role_name,
            to_regclass(format('public.%I', protected.table_name)),
            'UPDATE'
          )
       or has_table_privilege(
            app.role_name,
            to_regclass(format('public.%I', protected.table_name)),
            'DELETE'
          )
  ),
  'application roles have no UPDATE or DELETE privilege on financial events'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'batches', 'invoices', 'payments', 'customer_credits', 'expenses',
      'corrections', 'daily_closes', 'audit_events'
    ]) as protected(table_name)
    where not exists (
      select 1
      from pg_trigger
      where tgrelid = to_regclass(format('public.%I', protected.table_name))
        and tgname = protected.table_name || '_append_only'
        and not tgisinternal
    )
  ),
  'financial event tables have append-only triggers'
);

select * from finish();
rollback;
