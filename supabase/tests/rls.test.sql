begin;

create extension if not exists pgtap with schema extensions;

select plan(39);

create or replace function pg_temp.try_exec(command text)
returns boolean
language plpgsql
as $$
begin
  execute command;
  return true;
exception
  when others then
    return false;
end;
$$;

create or replace function pg_temp.visible_count(table_name text, target_shop uuid)
returns bigint
language plpgsql
as $$
declare
  result bigint;
begin
  execute format(
    'select count(*) from public.%I where shop_id = $1',
    table_name
  ) into result using target_shop;
  return result;
exception
  when others then
    return -1;
end;
$$;

create or replace function pg_temp.total_count(table_name text)
returns bigint
language plpgsql
as $$
declare
  result bigint;
begin
  execute format('select count(*) from public.%I', table_name) into result;
  return result;
exception
  when others then
    return -1;
end;
$$;

create or replace function pg_temp.try_financial_insert(table_name text)
returns boolean
language plpgsql
as $$
begin
  return case table_name
    when 'batches' then pg_temp.try_exec($sql$
      insert into public.batches (id, shop_id, business_date)
      values ('30000000-0000-4000-8000-000000000003',
              '10000000-0000-4000-8000-000000000001', current_date)
    $sql$)
    when 'invoices' then pg_temp.try_exec($sql$
      insert into public.invoices (
        id, shop_id, batch_id, invoice_id, total_amount_dirham, business_date
      ) values (
        '40000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001',
        'RLS-DIRECT-INSERT', 100, current_date
      )
    $sql$)
    when 'payments' then pg_temp.try_exec($sql$
      insert into public.payments (
        id, shop_id, invoice_id, amount_dirham, business_date
      ) values (
        '50000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001', 100, current_date
      )
    $sql$)
    when 'customer_credits' then pg_temp.try_exec($sql$
      insert into public.customer_credits (
        id, shop_id, customer_id, amount_dirham, business_date
      ) values (
        '60000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001', 100, current_date
      )
    $sql$)
    when 'expenses' then pg_temp.try_exec($sql$
      insert into public.expenses (
        id, shop_id, description, amount_dirham, business_date
      ) values (
        '70000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001',
        'direct RLS insert', 100, current_date
      )
    $sql$)
    when 'attachments' then pg_temp.try_exec($sql$
      insert into public.attachments (
        id, shop_id, file_path, file_name
      ) values (
        '80000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001',
        'direct/insert', 'direct.txt'
      )
    $sql$)
    when 'corrections' then pg_temp.try_exec($sql$
      insert into public.corrections (
        id, shop_id, amount_delta_dirham, reason, business_date
      ) values (
        '90000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001', 1,
        'direct RLS insert', current_date
      )
    $sql$)
    when 'daily_closes' then pg_temp.try_exec($sql$
      insert into public.daily_closes (id, shop_id, business_date)
      values ('a0000000-0000-4000-8000-000000000003',
              '10000000-0000-4000-8000-000000000001', current_date + 1)
    $sql$)
    when 'audit_events' then pg_temp.try_exec($sql$
      insert into public.audit_events (
        id, shop_id, action, entity_type
      ) values (
        'b0000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001',
        'direct.insert', 'rls_test'
      )
    $sql$)
    else false
  end;
end;
$$;

create or replace function pg_temp.try_financial_update(table_name text)
returns boolean
language plpgsql
as $$
begin
  return pg_temp.try_exec(format(
    'update public.%I set created_at = created_at where id = %L',
    table_name,
    case table_name
      when 'batches' then '30000000-0000-4000-8000-000000000001'
      when 'invoices' then '40000000-0000-4000-8000-000000000001'
      when 'payments' then '50000000-0000-4000-8000-000000000001'
      when 'customer_credits' then '60000000-0000-4000-8000-000000000001'
      when 'expenses' then '70000000-0000-4000-8000-000000000001'
      when 'attachments' then '80000000-0000-4000-8000-000000000001'
      when 'corrections' then '90000000-0000-4000-8000-000000000001'
      when 'daily_closes' then 'a0000000-0000-4000-8000-000000000001'
      when 'audit_events' then 'b0000000-0000-4000-8000-000000000001'
    end
  ));
end;
$$;

create or replace function pg_temp.try_financial_delete(table_name text)
returns boolean
language plpgsql
as $$
begin
  return pg_temp.try_exec(format(
    'delete from public.%I where id = %L',
    table_name,
    case table_name
      when 'batches' then '30000000-0000-4000-8000-000000000001'
      when 'invoices' then '40000000-0000-4000-8000-000000000001'
      when 'payments' then '50000000-0000-4000-8000-000000000001'
      when 'customer_credits' then '60000000-0000-4000-8000-000000000001'
      when 'expenses' then '70000000-0000-4000-8000-000000000001'
      when 'attachments' then '80000000-0000-4000-8000-000000000001'
      when 'corrections' then '90000000-0000-4000-8000-000000000001'
      when 'daily_closes' then 'a0000000-0000-4000-8000-000000000001'
      when 'audit_events' then 'b0000000-0000-4000-8000-000000000001'
    end
  ));
end;
$$;

do $setup$
begin
  perform pg_temp.try_exec($sql$
    insert into public.customers (id, shop_id, name)
    values
      ('20000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001', 'RLS Shop 1 Customer'),
      ('20000000-0000-4000-8000-000000000002',
       '10000000-0000-4000-8000-000000000002', 'RLS Shop 2 Customer')
    on conflict (id) do nothing
  $sql$);
  perform pg_temp.try_exec($sql$
    insert into public.batches (id, shop_id, business_date)
    values
      ('30000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001', current_date),
      ('30000000-0000-4000-8000-000000000002',
       '10000000-0000-4000-8000-000000000002', current_date)
    on conflict (id) do nothing
  $sql$);
  perform pg_temp.try_exec($sql$
    insert into public.invoices (
      id, shop_id, batch_id, invoice_id, total_amount_dirham, business_date
    ) values
      ('40000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001',
       '30000000-0000-4000-8000-000000000001', 'RLS-SHOP-1', 100, current_date),
      ('40000000-0000-4000-8000-000000000002',
       '10000000-0000-4000-8000-000000000002',
       '30000000-0000-4000-8000-000000000002', 'RLS-SHOP-2', 100, current_date)
    on conflict (id) do nothing
  $sql$);
  perform pg_temp.try_exec($sql$
    insert into public.payments (id, shop_id, invoice_id, amount_dirham, business_date)
    values
      ('50000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001',
       '40000000-0000-4000-8000-000000000001', 10, current_date),
      ('50000000-0000-4000-8000-000000000002',
       '10000000-0000-4000-8000-000000000002',
       '40000000-0000-4000-8000-000000000002', 10, current_date)
    on conflict (id) do nothing
  $sql$);
  perform pg_temp.try_exec($sql$
    insert into public.customer_credits (
      id, shop_id, customer_id, amount_dirham, business_date
    ) values
      ('60000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001',
       '20000000-0000-4000-8000-000000000001', 10, current_date),
      ('60000000-0000-4000-8000-000000000002',
       '10000000-0000-4000-8000-000000000002',
       '20000000-0000-4000-8000-000000000002', 10, current_date)
    on conflict (id) do nothing
  $sql$);
  perform pg_temp.try_exec($sql$
    insert into public.expenses (id, shop_id, description, amount_dirham, business_date)
    values
      ('70000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001', 'RLS Shop 1 Expense', 10, current_date),
      ('70000000-0000-4000-8000-000000000002',
       '10000000-0000-4000-8000-000000000002', 'RLS Shop 2 Expense', 10, current_date)
    on conflict (id) do nothing
  $sql$);
  perform pg_temp.try_exec($sql$
    insert into public.attachments (id, shop_id, file_path, file_name)
    values
      ('80000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001', 'rls/shop-1', 'shop-1.txt'),
      ('80000000-0000-4000-8000-000000000002',
       '10000000-0000-4000-8000-000000000002', 'rls/shop-2', 'shop-2.txt')
    on conflict (id) do nothing
  $sql$);
  perform pg_temp.try_exec($sql$
    insert into public.corrections (
      id, shop_id, invoice_id, amount_delta_dirham, reason, business_date
    ) values
      ('90000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001',
       '40000000-0000-4000-8000-000000000001', 1, 'RLS Shop 1 Correction', current_date),
      ('90000000-0000-4000-8000-000000000002',
       '10000000-0000-4000-8000-000000000002',
       '40000000-0000-4000-8000-000000000002', 1, 'RLS Shop 2 Correction', current_date)
    on conflict (id) do nothing
  $sql$);
  perform pg_temp.try_exec($sql$
    insert into public.daily_closes (id, shop_id, business_date)
    values
      ('a0000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001', current_date),
      ('a0000000-0000-4000-8000-000000000002',
       '10000000-0000-4000-8000-000000000002', current_date)
    on conflict (id) do nothing
  $sql$);
  perform pg_temp.try_exec($sql$
    insert into public.audit_events (id, shop_id, action, entity_type)
    values
      ('b0000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001', 'rls.shop-1', 'test'),
      ('b0000000-0000-4000-8000-000000000002',
       '10000000-0000-4000-8000-000000000002', 'rls.shop-2', 'test')
    on conflict (id) do nothing
  $sql$);
end
$setup$;

select ok(
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'shops' and c.relrowsecurity),
  'RLS is enabled on public.shops'
);
select ok(
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'profiles' and c.relrowsecurity),
  'RLS is enabled on public.profiles'
);
select ok(
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'user_shop_assignments' and c.relrowsecurity),
  'RLS is enabled on public.user_shop_assignments'
);
select ok(
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'customers' and c.relrowsecurity),
  'RLS is enabled on public.customers'
);
select ok(
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'batches' and c.relrowsecurity),
  'RLS is enabled on public.batches'
);
select ok(
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'invoices' and c.relrowsecurity),
  'RLS is enabled on public.invoices'
);
select ok(
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'payments' and c.relrowsecurity),
  'RLS is enabled on public.payments'
);
select ok(
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'customer_credits' and c.relrowsecurity),
  'RLS is enabled on public.customer_credits'
);
select ok(
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'expenses' and c.relrowsecurity),
  'RLS is enabled on public.expenses'
);
select ok(
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'attachments' and c.relrowsecurity),
  'RLS is enabled on public.attachments'
);
select ok(
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'corrections' and c.relrowsecurity),
  'RLS is enabled on public.corrections'
);
select ok(
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'daily_closes' and c.relrowsecurity),
  'RLS is enabled on public.daily_closes'
);
select ok(
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'audit_events' and c.relrowsecurity),
  'RLS is enabled on public.audit_events'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'shops', 'profiles', 'user_shop_assignments', 'customers', 'batches',
      'invoices', 'payments', 'customer_credits', 'expenses', 'attachments',
      'corrections', 'daily_closes', 'audit_events'
    ]) as required(table_name)
    where not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = required.table_name
    )
  ),
  'every exposed ShopKhata table has an explicit RLS policy'
);

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select ok(
  not exists (
    select 1
    from unnest(array[
      'shops', 'profiles', 'user_shop_assignments', 'customers', 'batches',
      'invoices', 'payments', 'customer_credits', 'expenses', 'attachments',
      'corrections', 'daily_closes', 'audit_events'
    ]) as required(table_name)
    where pg_temp.total_count(required.table_name) > 0
  ),
  'anonymous users cannot read ShopKhata business records'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select ok(
  not exists (
    select 1 from unnest(array[
      'customers', 'batches', 'invoices', 'payments', 'customer_credits',
      'expenses', 'attachments', 'corrections', 'daily_closes', 'audit_events'
    ]) as business(table_name)
    where pg_temp.visible_count(
      business.table_name, '10000000-0000-4000-8000-000000000001'
    ) <> 1
  ),
  'Shop 1 staff can read assigned Shop 1 records'
);
select ok(
  not exists (
    select 1 from unnest(array[
      'customers', 'batches', 'invoices', 'payments', 'customer_credits',
      'expenses', 'attachments', 'corrections', 'daily_closes', 'audit_events'
    ]) as business(table_name)
    where pg_temp.visible_count(
      business.table_name, '10000000-0000-4000-8000-000000000002'
    ) <> 0
  ),
  'Shop 1 staff cannot read Shop 2 records'
);

reset role;
update public.profiles
set role = 'manager'
where id = '10000000-0000-4000-8000-000000000102';
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select ok(
  not exists (
    select 1 from unnest(array[
      'customers', 'batches', 'invoices', 'payments', 'customer_credits',
      'expenses', 'attachments', 'corrections', 'daily_closes', 'audit_events'
    ]) as business(table_name)
    where pg_temp.visible_count(
      business.table_name, '10000000-0000-4000-8000-000000000001'
    ) <> 1
  ),
  'manager access is available for assigned Shop 1 records'
);
select ok(
  not exists (
    select 1 from unnest(array[
      'customers', 'batches', 'invoices', 'payments', 'customer_credits',
      'expenses', 'attachments', 'corrections', 'daily_closes', 'audit_events'
    ]) as business(table_name)
    where pg_temp.visible_count(
      business.table_name, '10000000-0000-4000-8000-000000000002'
    ) <> 0
  ),
  'manager access is denied for unassigned Shop 2 records'
);

reset role;
delete from public.user_shop_assignments
where user_id = '10000000-0000-4000-8000-000000000101';
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select ok(
  not exists (
    select 1 from unnest(array[
      'customers', 'batches', 'invoices', 'payments', 'customer_credits',
      'expenses', 'attachments', 'corrections', 'daily_closes', 'audit_events'
    ]) as business(table_name)
    where pg_temp.visible_count(
      business.table_name, '10000000-0000-4000-8000-000000000001'
    ) <> 1
  ),
  'owner can read Shop 1 without an assignment row'
);
select ok(
  not exists (
    select 1 from unnest(array[
      'customers', 'batches', 'invoices', 'payments', 'customer_credits',
      'expenses', 'attachments', 'corrections', 'daily_closes', 'audit_events'
    ]) as business(table_name)
    where pg_temp.visible_count(
      business.table_name, '10000000-0000-4000-8000-000000000002'
    ) <> 1
  ),
  'owner can read Shop 2 without an assignment row'
);

reset role;
update public.profiles
set role = 'staff', is_active = true
where id = '10000000-0000-4000-8000-000000000102';
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102","app_metadata":{"role":"owner"},"user_metadata":{"role":"owner"},"shop_ids":["10000000-0000-4000-8000-000000000002"]}';
select ok(
  pg_temp.visible_count('invoices', '10000000-0000-4000-8000-000000000001') = 1
  and pg_temp.visible_count('invoices', '10000000-0000-4000-8000-000000000002') = 0,
  'a forged owner claim does not override the trusted profile role'
);
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102","app_metadata":{"role":"staff"},"shop_ids":["10000000-0000-4000-8000-000000000002"]}';
select ok(
  pg_temp.visible_count('invoices', '10000000-0000-4000-8000-000000000001') = 1
  and pg_temp.visible_count('invoices', '10000000-0000-4000-8000-000000000002') = 0,
  'a forged shop assignment claim does not expand database access'
);

reset role;
update public.profiles
set is_active = false
where id = '10000000-0000-4000-8000-000000000102';
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select ok(
  not pg_temp.try_financial_insert('expenses'),
  'deactivated profiles cannot mutate financial records'
);

reset role;
update public.profiles
set is_active = true
where id = '10000000-0000-4000-8000-000000000101';
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select ok(
  not exists (
    select 1 from unnest(array[
      'batches', 'invoices', 'payments', 'customer_credits', 'expenses',
      'corrections', 'daily_closes', 'audit_events'
    ]) as financial(table_name)
    where pg_temp.try_financial_insert(financial.table_name)
  ),
  'authenticated clients cannot directly insert financial events'
);
select ok(
  not exists (
    select 1 from unnest(array[
      'batches', 'invoices', 'payments', 'customer_credits', 'expenses',
      'corrections', 'daily_closes', 'audit_events'
    ]) as financial(table_name)
    where pg_temp.try_financial_update(financial.table_name)
  ),
  'authenticated clients cannot directly update financial events'
);
select ok(
  not exists (
    select 1 from unnest(array[
      'batches', 'invoices', 'payments', 'customer_credits', 'expenses',
      'corrections', 'daily_closes', 'audit_events'
    ]) as financial(table_name)
    where pg_temp.try_financial_delete(financial.table_name)
  ),
  'authenticated clients cannot directly delete financial events'
);

reset role;
select ok(
  not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prokind = 'f'
      and p.proname in ('submit_batch', 'record_payment', 'approve_overpayment', 'create_expense')
  ),
  'Task 4 RLS does not implement Phase 3 financial commands'
);
select ok(
  exists (select 1 from pg_namespace where nspname = 'private'),
  'RLS helpers use a private schema'
);
select ok(
  to_regprocedure('private.is_owner()') is not null
  and to_regprocedure('private.has_shop_access(uuid)') is not null
  and to_regprocedure('private.is_active_actor()') is not null,
  'the intended RLS helper functions exist in the private schema'
);
select ok(
  exists (
    select 1 from pg_namespace n
    where n.nspname = 'private'
      and not has_schema_privilege('anon', n.oid, 'USAGE')
      and has_schema_privilege('authenticated', n.oid, 'USAGE')
  ),
  'the private helper schema grants only narrow authenticated helper access and is not treated as API exposure'
);
select ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.prokind = 'f'
      and p.oid in (
        to_regprocedure('private.is_owner()'),
        to_regprocedure('private.has_shop_access(uuid)'),
        to_regprocedure('private.is_active_actor()')
      )
      and p.prosecdef
      and not ('search_path=""' = any(coalesce(p.proconfig, array[]::text[])))
  ),
  'every SECURITY DEFINER helper locks search_path to an empty value'
);
select ok(
  exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.prokind = 'f'
      and p.oid in (
        to_regprocedure('private.is_owner()'),
        to_regprocedure('private.has_shop_access(uuid)'),
        to_regprocedure('private.is_active_actor()')
      )
      and pg_get_functiondef(p.oid) ilike '%public.profiles%'
  ),
  'RLS helper SQL reads trusted public.profiles data'
);
select ok(
  exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.prokind = 'f'
      and p.oid = to_regprocedure('private.has_shop_access(uuid)')
      and pg_get_functiondef(p.oid) ilike '%public.user_shop_assignments%'
  ),
  'RLS helper SQL reads trusted assignment data'
);
select ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.prokind = 'f'
      and p.oid in (
        to_regprocedure('private.is_owner()'),
        to_regprocedure('private.has_shop_access(uuid)'),
        to_regprocedure('private.is_active_actor()')
      )
      and (
        pg_get_functiondef(p.oid) ilike '%raw_user_meta_data%'
        or pg_get_functiondef(p.oid) ilike '%raw_app_meta_data%'
        or pg_get_functiondef(p.oid) ilike '%request.jwt.claims%'
      )
  ),
  'RLS helpers do not trust user-editable metadata or ordinary custom claims'
);
select ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.prokind = 'f'
      and p.oid in (
        to_regprocedure('private.is_owner()'),
        to_regprocedure('private.has_shop_access(uuid)'),
        to_regprocedure('private.is_active_actor()')
      )
      and (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      )
  ),
  'RLS helper EXECUTE privileges are restricted to authenticated clients'
);

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select ok(
  not exists (
    select 1 from unnest(array[
      'customers', 'batches', 'invoices', 'payments', 'customer_credits',
      'expenses', 'attachments', 'corrections', 'daily_closes', 'audit_events'
    ]) as business(table_name)
    where pg_temp.visible_count(
      business.table_name, '10000000-0000-4000-8000-000000000001'
    ) > 0
  ),
  'unauthenticated helper evaluation fails closed'
);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000199"}';
select ok(
  not exists (
    select 1 from unnest(array[
      'customers', 'batches', 'invoices', 'payments', 'customer_credits',
      'expenses', 'attachments', 'corrections', 'daily_closes', 'audit_events'
    ]) as business(table_name)
    where pg_temp.visible_count(
      business.table_name, '10000000-0000-4000-8000-000000000001'
    ) <> 0
  ),
  'helper evaluation fails closed when the profile is missing'
);

reset role;
select ok(
  not exists (
    select 1
    from unnest(array[
      'batches', 'invoices', 'payments', 'customer_credits', 'expenses',
      'corrections', 'daily_closes', 'audit_events'
    ]) as financial(table_name)
    where not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = financial.table_name
    )
      or pg_temp.try_financial_update(financial.table_name)
      or pg_temp.try_financial_delete(financial.table_name)
  ),
  'Task 3 append-only protections remain effective'
);

select * from finish();
rollback;
