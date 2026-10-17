begin;

select plan(37);

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
create temp table priv_fn as
  select p.oid, p.proname::text as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public';
grant select on priv_rel, priv_all, priv_seq, priv_fn to public;

select ok((select count(*) from priv_rel) >= 30 and (select count(*) from priv_seq) >= 2 and (select count(*) from priv_fn) >= 27,
  'the catalog scan sees the real public tables, views, sequences and functions');

-- 1. anon: nothing.
select is((select count(*) from priv_rel r cross join priv_all a where has_table_privilege('anon', r.oid, a.p)), 0::bigint,
  'anon holds no privilege (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) on any public table or view');
select is((select count(*) from priv_seq s where has_sequence_privilege('anon', s.oid, 'USAGE') or has_sequence_privilege('anon', s.oid, 'SELECT')
  or has_sequence_privilege('anon', s.oid, 'UPDATE')), 0::bigint, 'anon has no sequence privilege');
select is((select count(*) from priv_fn f where has_function_privilege('anon', f.oid, 'EXECUTE')), 0::bigint, 'anon can execute no public function');
select is((select count(*) from priv_fn f join pg_proc p on p.oid = f.oid
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0), 0::bigint,
  'PUBLIC can execute no public function');

-- 2. authenticated: SELECT only.
select is((select count(*) from priv_rel r cross join priv_all a where a.p <> 'SELECT' and has_table_privilege('authenticated', r.oid, a.p)), 0::bigint,
  'authenticated has no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on any public table or view');
select is((select count(*) from priv_rel r where not has_table_privilege('authenticated', r.oid, 'SELECT')), 0::bigint,
  'authenticated can SELECT every public table and view (RLS decides the rows)');
select is((select count(*) from priv_seq s where has_sequence_privilege('authenticated', s.oid, 'USAGE') or has_sequence_privilege('authenticated', s.oid, 'SELECT')
  or has_sequence_privilege('authenticated', s.oid, 'UPDATE')), 0::bigint, 'authenticated has no sequence privilege');
select is((select array_agg(name order by name) from priv_fn where has_function_privilege('authenticated', oid, 'EXECUTE')),
  array['admin_register_account', 'admin_set_shop_assignment', 'admin_update_account', 'apply_customer_credit', 'approve_overpayment',
    'close_business_date', 'create_customer', 'create_expense', 'decide_expense_correction', 'decide_invoice_correction',
    'decide_invoice_replacement', 'record_customer_payment', 'record_payment', 'register_expense_attachment', 'reopen_business_date',
    'report_customer_due_totals', 'report_daily_summary', 'report_day_pending_requests', 'report_expense_totals', 'report_payment_totals',
    'report_sales_totals', 'report_top_customers_by_payments', 'report_top_customers_by_sales', 'request_expense_correction',
    'request_invoice_correction', 'request_invoice_replacement', 'submit_batch'],
  'authenticated can execute exactly the application RPCs and nothing else');
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
select is((select count(*) from priv_fn f where has_function_privilege('service_role', f.oid, 'EXECUTE')), 0::bigint, 'service_role can execute no public function');
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
