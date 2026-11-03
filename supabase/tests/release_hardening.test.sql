begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

-- The read policies resolve shop access once per statement (migration
-- 20261004110000) and submit_batch enforces the 100-row limit itself
-- (20261004120000). These assertions hold that no rule changed otherwise.

create function pg_temp.rows(n integer, prefix text) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('row_id', prefix || i, 'invoice_number', prefix || i, 'total_dirham', 100, 'received_dirham', 0, 'payment_method', 'cash', 'delivered', false, 'customer', null))
  from generate_series(1, n) i $$;
create function pg_temp.batch(n integer, prefix text) returns jsonb language sql as $$
  select jsonb_build_object('shop_id', '10000000-0000-4000-8000-000000000001', 'business_date', (now() at time zone 'Asia/Qatar')::date::text, 'idempotency_key', prefix, 'rows', pg_temp.rows(n, prefix)) $$;

create function pg_temp.act(account text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', account)::text, true) $$;
-- Compares the list with the per-shop check, account by account, one statement at a time.
create function pg_temp.access_mismatches() returns text language plpgsql as $$
declare account text; shop uuid; one boolean; listed boolean; found text := '';
begin
  foreach account in array array['10000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000102', '10000000-0000-4000-8000-000000000103',
    '10000000-0000-4000-8000-000000000104', 'b5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-0000000000ff'] loop
    perform pg_temp.act(account);
    foreach shop in array array['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002']::uuid[] loop
      select private.has_shop_access(shop) into one;
      select shop = any (private.accessible_shop_ids()) into listed;
      if one is distinct from listed then found := found || account || '/' || shop || ' '; end if;
    end loop;
  end loop;
  return found;
end $$;

-- Owner (101), Shop 1 staff (102), a deactivated Shop 2 staff (103), Shop 1 manager (104),
-- an active account with no shop (b5…01) and a sign-in with no profile (b5…ff).
insert into auth.users(id, instance_id, aud, role, email, encrypted_password, email_confirmed_at)
values ('b5000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'unassigned@shopkhata.local', '', now());
insert into public.profiles(id, email, display_name, role, is_active) values ('b5000000-0000-4000-8000-000000000001', 'unassigned@shopkhata.local', 'Unassigned', 'staff', true);
update public.profiles set is_active = false where id = '10000000-0000-4000-8000-000000000103';
insert into public.invoices(shop_id, invoice_id, total_amount_dirham, business_date) values
  ('10000000-0000-4000-8000-000000000001', 'READ-PERF-1', 100, current_date - 900), ('10000000-0000-4000-8000-000000000002', 'READ-PERF-2', 100, current_date - 900);
insert into public.audit_events(shop_id, action, entity_type) values (null, 'read-perf.account', 'profile'), ('10000000-0000-4000-8000-000000000001', 'read-perf.shop1', 'invoice'), ('10000000-0000-4000-8000-000000000002', 'read-perf.shop2', 'invoice');

select ok(not has_function_privilege('anon', 'private.accessible_shop_ids()', 'EXECUTE'), 'anon cannot read the accessible shop list');
select is((select count(*)::int from pg_policies where schemaname = 'public' and qual like '%has_shop_access(%'), 0, 'no table policy evaluates shop access once per row');
select is((select count(*)::int from pg_policies where schemaname = 'public' and qual like '%accessible_shop_ids()%'), 22, 'every shop-scoped table reads through the once-per-statement rule');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity), 0, 'every table still has row-level security enabled');

set local role authenticated;
select is(pg_temp.access_mismatches(), '', 'the list agrees with the per-shop check for every kind of account');

select pg_temp.act('10000000-0000-4000-8000-000000000101');
select is((select count(distinct shop_id)::int from public.invoices where invoice_id like 'READ-PERF-%'), 2, 'the owner reads both shops');
select is((select count(*)::int from public.audit_events where action like 'read-perf.%'), 3, 'the owner reads shop and account audit rows');
select pg_temp.act('10000000-0000-4000-8000-000000000102');
select is((select string_agg(invoice_id, ',') from public.invoices where invoice_id like 'READ-PERF-%'), 'READ-PERF-1', 'Shop 1 staff read only Shop 1');
select is((select string_agg(action, ',') from public.audit_events where action like 'read-perf.%'), 'read-perf.shop1', 'Shop 1 staff read only Shop 1 audit rows, never account administration');
select is((select count(*)::int from public.profiles) || ':' || (select count(*) from public.shops), '1:1', 'staff read only their own profile and shop');
select pg_temp.act('10000000-0000-4000-8000-000000000103');
select is((select count(*)::int from public.invoices) + (select count(*)::int from public.shops) + (select count(*)::int from public.customers), 0, 'a deactivated account reads nothing although it is still assigned');
select pg_temp.act('b5000000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.invoices) + (select count(*)::int from public.shops), 0, 'an active account with no shop reads nothing');

-- The batch limit holds for a direct RPC call, for the owner too, and writes nothing when exceeded.
select pg_temp.act('10000000-0000-4000-8000-000000000102');
select throws_ok($$select public.submit_batch(pg_temp.batch(101, 'LIMIT-OVER-'))$$, 'P0001', 'BATCH_VALIDATION_FAILED', 'a direct call with 101 rows is refused');
select pg_temp.act('10000000-0000-4000-8000-000000000101');
select throws_ok($$select public.submit_batch(pg_temp.batch(5000, 'LIMIT-HUGE-'))$$, 'P0001', 'BATCH_VALIDATION_FAILED', 'the owner is bound by the limit as well');
select is((select count(*)::int from public.invoices where invoice_id like 'LIMIT-%'), 0, 'a refused oversized batch saves nothing');
select pg_temp.act('10000000-0000-4000-8000-000000000102');
select is(jsonb_array_length(public.submit_batch(pg_temp.batch(100, 'LIMIT-FULL-')) -> 'rows'), 100, 'exactly 100 rows are accepted as one batch');

select * from finish();
rollback;
