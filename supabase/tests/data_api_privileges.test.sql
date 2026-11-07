begin;

select plan(39);

-- Data API privilege model (migration 20261017100000). RLS does not guard TRUNCATE, TRIGGER, REFERENCES
-- or MAINTAIN and does not apply to functions, so the grants themselves are asserted for every public object.

create temp table priv_rel as
  select c.oid, c.relname::text as name, c.relkind
  from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relkind in ('r', 'v', 'm', 'p', 'f');
create temp table priv_all(p text);
insert into priv_all values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN');
create temp table priv_seq as
  select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public' where c.relkind = 'S';
-- One row per public function, keyed by name plus argument types so overloads cannot hide behind a shared name.
create temp table priv_fn as
  select p.oid, p.proname::text as name,
    p.proname || '(' || array_to_string(p.proargtypes::oid[]::regtype[], ',') || ')' as sig,
    has_function_privilege('anon', p.oid, 'EXECUTE') as anon_x,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x,
    has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_x,
    exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_x
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public';
-- The approved application RPC surface: the only public functions authenticated may execute.
create temp table priv_rpc(sig text);
insert into priv_rpc values
  ('admin_create_shop(jsonb)'), ('admin_register_account(jsonb)'), ('admin_set_account_status(jsonb)'), ('admin_set_shop_assignment(jsonb)'), ('admin_set_shop_status(jsonb)'),
  ('admin_update_account(jsonb)'), ('admin_update_shop(jsonb)'),
  ('apply_customer_credit(jsonb)'), ('approve_overpayment(jsonb)'), ('close_business_date(jsonb)'),
  ('create_customer(jsonb)'), ('create_expense(jsonb)'), ('decide_expense_correction(jsonb)'),
  ('decide_invoice_correction(jsonb)'), ('decide_invoice_replacement(jsonb)'), ('record_customer_payment(jsonb)'),
  ('record_payment(jsonb)'), ('register_expense_attachment(jsonb)'), ('reopen_business_date(jsonb)'),
  ('report_customer_due_totals(uuid)'), ('report_daily_summary(uuid,date,date)'), ('report_day_pending_requests(uuid,date)'),
  ('report_expense_totals(uuid,date,date)'), ('report_payment_totals(uuid,date,date)'), ('report_sales_totals(uuid,date,date)'),
  ('report_top_customers_by_payments(uuid,date,date,integer)'), ('report_top_customers_by_sales(uuid,date,date,integer)'),
  ('request_expense_correction(jsonb)'), ('request_invoice_correction(jsonb)'), ('request_invoice_replacement(jsonb)'),
  ('set_maintenance(jsonb)'), ('set_maintenance_bypass(jsonb)'),
  ('submit_batch(jsonb)'), ('void_invoice(jsonb)');
grant select on priv_rel, priv_all, priv_seq, priv_fn, priv_rpc to public;

select ok((select count(*) from priv_rel) >= 30 and (select count(*) from priv_seq) >= 2 and (select count(*) from priv_fn) >= 27,
  'the catalog scan sees the real public tables, views, sequences and functions');
select is((select count(*) from priv_rpc), 34::bigint, 'the approved RPC list holds 34 distinct signatures');
select is((select array_agg(sig order by sig collate "C") from priv_fn),
  (select array_agg(sig order by sig collate "C") from (select sig from priv_rpc union all select 'reject_append_only_mutation()') u),
  'the public functions are exactly the 34 approved RPCs plus the append-only trigger function (a new or overloaded function must be classified here)');

-- 1. anon: nothing.
select is((select count(*) from priv_rel r cross join priv_all a where has_table_privilege('anon', r.oid, a.p)), 0::bigint,
  'anon holds no privilege (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) on any public table or view');
select is((select count(*) from priv_seq s where has_sequence_privilege('anon', s.oid, 'USAGE') or has_sequence_privilege('anon', s.oid, 'SELECT')
  or has_sequence_privilege('anon', s.oid, 'UPDATE')), 0::bigint, 'anon has no sequence privilege');
select is((select coalesce(array_agg(sig order by sig collate "C"), '{}') from priv_fn where anon_x), '{}'::text[], 'anon can execute no public function');
select is((select coalesce(array_agg(sig order by sig collate "C"), '{}') from priv_fn where public_x), '{}'::text[], 'PUBLIC can execute no public function');

-- 2. authenticated: SELECT only.
select is((select count(*) from priv_rel r cross join priv_all a where a.p <> 'SELECT' and has_table_privilege('authenticated', r.oid, a.p)), 0::bigint,
  'authenticated has no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on any public table or view');
select is((select count(*) from priv_rel r where not has_table_privilege('authenticated', r.oid, 'SELECT')), 0::bigint,
  'authenticated can SELECT every public table and view (RLS decides the rows)');
select is((select count(*) from priv_seq s where has_sequence_privilege('authenticated', s.oid, 'USAGE') or has_sequence_privilege('authenticated', s.oid, 'SELECT')
  or has_sequence_privilege('authenticated', s.oid, 'UPDATE')), 0::bigint, 'authenticated has no sequence privilege');
select is((select array_agg(sig order by sig collate "C") from priv_fn where auth_x), (select array_agg(sig order by sig collate "C") from priv_rpc),
  'authenticated can execute exactly the 34 approved application RPC signatures and nothing else');
select ok(not has_function_privilege('authenticated', 'public.reject_append_only_mutation()', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.reject_append_only_mutation()', 'EXECUTE'),
  'the append-only trigger function is not callable through the API');

-- 3. service_role: SELECT and INSERT on backup_records, nothing else in public.
select is((select count(*) from priv_rel r cross join priv_all a where r.name <> 'backup_records' and has_table_privilege('service_role', r.oid, a.p)), 0::bigint,
  'service_role holds no privilege on any public table or view other than backup_records');
select is((select coalesce(array_agg(a.p order by a.p), '{}') from priv_all a where has_table_privilege('service_role', 'public.backup_records', a.p)),
  array['INSERT', 'SELECT'], 'service_role holds exactly SELECT and INSERT on backup_records');
select ok(has_table_privilege('service_role', 'public.backup_records', 'SELECT') and has_table_privilege('service_role', 'public.backup_records', 'INSERT')
  and not has_table_privilege('service_role', 'public.backup_records', 'UPDATE') and not has_table_privilege('service_role', 'public.backup_records', 'DELETE')
  and not has_table_privilege('service_role', 'public.backup_records', 'TRUNCATE') and not has_table_privilege('service_role', 'public.backup_records', 'REFERENCES')
  and not has_table_privilege('service_role', 'public.backup_records', 'TRIGGER') and not has_table_privilege('service_role', 'public.backup_records', 'MAINTAIN'),
  'service_role: backup_records SELECT yes, INSERT yes, UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN no');
select is((select count(*) from priv_seq s where has_sequence_privilege('service_role', s.oid, 'USAGE') or has_sequence_privilege('service_role', s.oid, 'SELECT')
  or has_sequence_privilege('service_role', s.oid, 'UPDATE')), 0::bigint, 'service_role has no sequence privilege');
select is((select coalesce(array_agg(sig order by sig collate "C"), '{}') from priv_fn where svc_x), '{}'::text[], 'service_role can execute no public function');
select is((select coalesce(array_agg(a.p order by a.p), '{}') from priv_all a where has_table_privilege('authenticated', 'public.backup_records', a.p)),
  array['SELECT'], 'authenticated holds exactly SELECT on backup_records');
select is((select coalesce(array_agg(a.p order by a.p), '{}') from priv_all a where has_table_privilege('anon', 'public.backup_records', a.p)),
  '{}'::text[], 'anon holds nothing on backup_records');

-- 4. RLS is untouched: every table is protected and nothing grants a write policy.
select is((select count(*) from priv_rel r join pg_class c on c.oid = r.oid where r.relkind = 'r' and not c.relrowsecurity), 0::bigint, 'every public table still has RLS enabled');
select is((select count(*) from pg_policies where schemaname = 'public' and cmd <> 'SELECT'), 0::bigint, 'no public table has a write policy');

-- 5. Default privileges: nothing postgres creates in public is exposed automatically.
select is(current_user::text, 'postgres', 'default-privilege probes run as the migration role');
select is((select count(*) from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace and n.nspname = 'public'
  cross join lateral aclexplode(d.defaclacl) a
  where d.defaclrole = 'postgres'::regrole and a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role'))),
  0::bigint, 'postgres default ACLs in public grant nothing to the API roles');
create table public.zz_default_probe(id bigserial primary key, note text);
create view public.zz_default_probe_view as select id from public.zz_default_probe;
create function public.zz_default_probe_fn() returns integer language sql as 'select 1';
create temp table probe_rel as
  select c.oid from pg_class c where c.oid in ('public.zz_default_probe'::regclass, 'public.zz_default_probe_view'::regclass);
grant select on probe_rel to public;

select is((select count(*) from probe_rel r cross join priv_all a cross join unnest(array['anon', 'authenticated', 'service_role']) role
  where has_table_privilege(role, r.oid, a.p)), 0::bigint, 'a future table or view is granted to no API role');
select is((select count(*) from unnest(array['anon', 'authenticated', 'service_role']) role cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) p
  where has_sequence_privilege(role, 'public.zz_default_probe_id_seq', p)), 0::bigint, 'a future sequence is granted to no API role');
select is((select count(*) from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  where p.oid = 'public.zz_default_probe_fn()'::regprocedure and a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role'))),
  0::bigint, 'a future function is granted to no API role (PUBLIC keeps its built-in default; the catalog scan above is the guard)');

-- 6. The grants hold when the API roles actually try.
create function pg_temp.denied(role_name text, statement text) returns boolean language plpgsql as $$
begin
  execute format('set local role %I', role_name);
  begin
    execute statement;
    reset role;
    return false;
  exception when insufficient_privilege then
    reset role;
    return true;
  end;
end $$;
grant execute on function pg_temp.denied(text, text) to public;

select ok(pg_temp.denied('anon', 'select * from public.shops'), 'anon cannot read shops');
select ok(pg_temp.denied('anon', 'select * from public.effective_invoices'), 'anon cannot read the invoice view');
select ok(pg_temp.denied('anon', $$select public.submit_batch('{}'::jsonb)$$), 'anon cannot call submit_batch');
select ok(pg_temp.denied('authenticated', $$insert into public.daily_closes(shop_id, business_date) values (gen_random_uuid(), current_date)$$), 'authenticated cannot INSERT into daily_closes');
select ok(pg_temp.denied('authenticated', 'truncate public.daily_closes') and pg_temp.denied('authenticated', 'truncate public.invoices'), 'authenticated cannot TRUNCATE ledger tables');
select ok(pg_temp.denied('authenticated', 'lock table public.invoices in access exclusive mode'), 'authenticated cannot take an exclusive LOCK on a ledger table');
select ok(pg_temp.denied('service_role', 'select * from public.invoices') and pg_temp.denied('service_role', 'select * from public.effective_invoices'),
  'service_role cannot read ledger tables or views');
select ok(pg_temp.denied('service_role', $$select public.submit_batch('{}'::jsonb)$$), 'service_role cannot call an application RPC');
select ok(pg_temp.denied('service_role', 'truncate public.backup_records') and pg_temp.denied('service_role', 'truncate public.invoices'), 'service_role cannot TRUNCATE');
select ok(pg_temp.denied('service_role', $$update public.backup_records set source = 'x'$$) and pg_temp.denied('service_role', 'delete from public.backup_records'),
  'service_role cannot UPDATE or DELETE backup_records');

-- The backup:record path (PostgREST upsert with ignoreDuplicates) needs no sequence or function access.
create function pg_temp.affected(role_name text, statement text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('set local role %I', role_name);
  execute statement;
  get diagnostics n = row_count;
  reset role;
  return n;
end $$;
grant execute on function pg_temp.affected(text, text) to public;

select is(pg_temp.affected('service_role', $$insert into public.backup_records(backup_created_at, environment, source, latest_migration, dump_bytes, receipt_count, manifest_sha256)
  values (now(), 'local', 'acl test', '20261017100000', 1, 0, repeat('a', 64)) on conflict (manifest_sha256, restore_verified_at) do nothing$$), 1::bigint,
  'service_role records a backup without sequence or function access');
select is(pg_temp.affected('service_role', $$insert into public.backup_records(backup_created_at, environment, source, latest_migration, dump_bytes, receipt_count, manifest_sha256)
  values (now(), 'local', 'acl test', '20261017100000', 1, 0, repeat('a', 64)) on conflict (manifest_sha256, restore_verified_at) do nothing$$), 0::bigint,
  'recording the same backup again is a no-op');
select ok(pg_temp.affected('service_role', 'select * from public.backup_records') >= 1, 'service_role can read the backup ledger back');

select * from finish();
rollback;
