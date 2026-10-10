begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

create function pg_temp.act(who text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', case who
    when 'owner' then '10000000-0000-4000-8000-000000000101' when 'staff' then '10000000-0000-4000-8000-000000000102'
    when 'manager' then '10000000-0000-4000-8000-000000000104' end)::text, true)
$$;

-- 1. Privileges: the application can read, and nothing but the operator's service role can write.
select has_table('public', 'backup_records', 'the backup ledger exists');
select ok((select relrowsecurity from pg_class where oid = 'public.backup_records'::regclass), 'row-level security is enabled');
select ok(not has_table_privilege('anon', 'public.backup_records', 'SELECT'), 'anon cannot read the backup ledger');
select ok(not has_table_privilege('authenticated', 'public.backup_records', 'INSERT') and not has_table_privilege('authenticated', 'public.backup_records', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.backup_records', 'DELETE'), 'no application account can write the backup ledger');
select ok(has_table_privilege('service_role', 'public.backup_records', 'INSERT') and not has_table_privilege('service_role', 'public.backup_records', 'UPDATE')
  and not has_table_privilege('service_role', 'public.backup_records', 'DELETE'), 'the operator tool can record a backup and nothing else');

insert into public.backup_records(backup_created_at, environment, source, app_version, git_commit, latest_migration, dump_bytes, receipt_count, manifest_sha256)
values (now() - interval '2 hours', 'local', 'local Supabase stack', '0.1.0', repeat('a', 40), '20261009090100', 4096, 2, repeat('1', 64));

-- 2. Recording is idempotent per backup and per rehearsal.
select throws_ok($$insert into public.backup_records(backup_created_at, environment, source, latest_migration, dump_bytes, receipt_count, manifest_sha256)
  values (now(), 'local', 'local Supabase stack', '20261009090100', 4096, 2, repeat('1', 64))$$, '23505', null, 'the same unrehearsed backup cannot be recorded twice');
select lives_ok($$insert into public.backup_records(backup_created_at, environment, source, latest_migration, dump_bytes, receipt_count, manifest_sha256, restore_verified_at, restore_verified_ok)
  values (now() - interval '2 hours', 'local', 'local Supabase stack', '20261009090100', 4096, 2, repeat('1', 64), now(), true)$$, 'a rehearsal of a recorded backup is added as a new row');
select throws_ok($$insert into public.backup_records(backup_created_at, environment, source, latest_migration, dump_bytes, receipt_count, manifest_sha256, restore_verified_ok)
  values (now(), 'local', 'x', '20261009090100', 1, 0, repeat('2', 64), true)$$, '23514', null, 'a rehearsal result needs its time');
select throws_ok($$insert into public.backup_records(backup_created_at, environment, source, latest_migration, dump_bytes, receipt_count, manifest_sha256)
  values (now(), 'local', 'x', '20261009090100', 1, 0, 'not-a-hash')$$, '23514', null, 'the manifest hash must be a SHA-256');

-- 3. The ledger is append-only, even for the database owner.
select throws_ok($$update public.backup_records set restore_verified_ok = true, restore_verified_at = now()$$, '55000', null, 'a backup record cannot be edited');
select throws_ok($$delete from public.backup_records$$, '55000', null, 'a backup record cannot be deleted');

-- 4. Only an owner sees it.
set local role authenticated;
select pg_temp.act('owner');
select is((select count(*)::int from public.backup_records), 2, 'the owner sees every backup record');
select pg_temp.act('manager');
select is((select count(*)::int from public.backup_records), 0, 'a manager sees no backup record');
select pg_temp.act('staff');
select is((select count(*)::int from public.backup_records), 0, 'staff see no backup record');
select throws_ok($$insert into public.backup_records(backup_created_at, environment, source, latest_migration, dump_bytes, receipt_count, manifest_sha256)
  values (now(), 'production', 'forged', '20261009090100', 1, 0, repeat('3', 64))$$, '42501', null, 'an application account cannot forge a backup record');

select * from finish();
rollback;
