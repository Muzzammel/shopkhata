// Simulated production drifts for the OPS-01B inventory gate (scripts/ops-01b-preflight.sql). Each is applied inside a
// rolled-back transaction on the migration-35 state; the gate must STOP, and the listed checks must be among the failures.
// admin: the drift needs the Storage/schema owner's rights; it is applied as supabase_admin and the gate then runs as
// postgres again (SET LOCAL SESSION AUTHORIZATION and postgres's search_path), i.e. as the migration identity.
export const AS_MIGRATION_ROLE = "set local session authorization postgres;\nset local search_path = \"$user\", public, extensions;\n";
export const PREFLIGHT_DRIFTS: Record<string, { sql: string; stops: string[]; admin?: boolean }> = {
  "an extra write grant to authenticated": { sql: "grant insert on public.customers to authenticated;", stops: ["C08"] },
  "a table published to Realtime": { sql: "alter publication supabase_realtime add table public.customers;", stops: ["C14"] },
  "a drifted RPC body": { sql: "create or replace function public.create_customer(command jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$ begin return '{}'::jsonb; end $$;", stops: ["C05"] },
  "an extra anon-executable function": { sql: "create function public.zz_extra() returns void language sql as $$ select 1 $$; grant execute on function public.zz_extra() to anon;", stops: ["C06"] },
  "a volatile function offered from another schema": { sql: "create schema zz; create function zz.w() returns void language sql as $$ select 1 $$; grant usage on schema zz to authenticated; grant execute on function zz.w() to authenticated;", stops: ["C07"] },
  "a custom trigger on storage.objects": { sql: "create function public.zz_t() returns trigger language plpgsql as $$ begin return new; end $$; create trigger zz_t before insert on storage.objects for each row execute function public.zz_t();", stops: ["C13b"] },
  "a disabled Storage trigger": { sql: "alter table storage.objects disable trigger update_objects_updated_at;", stops: ["C13b"], admin: true },
  "the guard trigger name already taken": { sql: "create function private.zz_g() returns trigger language plpgsql as $$ begin return new; end $$; revoke all on function private.zz_g() from public; create trigger expense_receipts_maintenance_guard after update on storage.objects for each row execute function private.zz_g();", stops: ["C03", "C13b"] },
  "owner_id with an unexpected type": { sql: "alter table storage.objects alter column owner_id type uuid using owner_id::uuid;", stops: ["C13a"], admin: true },
  "the migration role lacks TRIGGER on storage.objects": { sql: "revoke trigger on storage.objects from postgres, anon, authenticated, service_role;", stops: ["C13c"], admin: true },
  "an extra Storage bucket": { sql: "insert into storage.buckets(id, name) values ('zz', 'zz');", stops: ["C11"] },
  "a changed Storage policy": { sql: "alter policy expense_receipts_shop_insert on storage.objects with check (true);", stops: ["C12"] },
  "a write policy on another Storage table": { sql: "create policy zz on storage.buckets for insert to authenticated with check (true);", stops: ["C22"] },
  "RLS switched off on a table": { sql: "alter table public.customers disable row level security;", stops: ["C09"] },
  "an unexpected applied migration": { sql: "insert into supabase_migrations.schema_migrations(version, name) values ('20261103140000', 'x');", stops: ["C02"] },
  "the maintenance table already present": { sql: "create table private.system_maintenance(id int);", stops: ["C03"] },
  "a mutation trigger on a business table": { sql: "create function public.zz_h() returns trigger language plpgsql as $$ begin return new; end $$; create trigger zz_h after insert on public.payments for each row execute function public.zz_h();", stops: ["C15"] },
  // Q1-Q8: writable surfaces that information_schema.role_table_grants misses, and trigger drift.
  "Q1 INSERT granted to PUBLIC": { sql: "grant insert on public.customers to public;", stops: ["C08", "C18"] },
  "Q2 UPDATE granted to PUBLIC": { sql: "grant update on public.invoices to public;", stops: ["C08", "C18"] },
  "Q3 writable view granted to PUBLIC": { sql: "create view public.zz_v with (security_invoker = true) as select * from public.customers; grant insert on public.zz_v to public;", stops: ["C08", "C18", "C19", "C20"] },
  "Q4 writable view granted to authenticated": { sql: "create view public.zz_v with (security_invoker = true) as select * from public.customers; grant update on public.zz_v to authenticated;", stops: ["C08", "C19", "C20"] },
  "Q5 INSTEAD OF trigger mutation surface": { sql: "create view public.zz_v as select c.shop_id, count(*) n from public.customers c group by c.shop_id; create function private.zz_iot() returns trigger language plpgsql security definer as $$ begin return new; end $$; revoke all on function private.zz_iot() from public; create trigger zz_iot instead of insert on public.zz_v for each row execute function private.zz_iot(); grant insert on public.zz_v to authenticated;", stops: ["C19", "C20"] },
  "Q6 expected trigger disabled": { sql: "alter table public.payments disable trigger payments_append_only;", stops: ["C15", "C15b"] },
  "Q7 expected trigger function changed": { sql: "do $$ begin execute regexp_replace(pg_get_functiondef('private.enforce_active_shop()'::regprocedure), '\\mbegin\\M', 'begin perform 1;', 'i'); end $$;", stops: ["C15"] },
  "Q8 unexpected exposed mutation function": { sql: "create function public.zz_write(x jsonb) returns jsonb language sql volatile security definer as $$ select x $$; revoke all on function public.zz_write(jsonb) from public; grant execute on function public.zz_write(jsonb) to authenticated;", stops: ["C04"] },
  "Q8b unexpected mutation function in graphql_public": { sql: "create function graphql_public.zz_write() returns void language sql volatile as $$ select 1 $$; grant execute on function graphql_public.zz_write() to authenticated;", stops: ["C21"], admin: true },
};

// Drifts of the state right after migration 36, for scripts/ops-01b-post36-verify.sql (runbook W2b).
export const POST36_DRIFTS: Record<string, { sql: string; stops: string[]; admin?: boolean }> = {
  "the guard trigger is missing": { sql: "drop trigger expense_receipts_maintenance_guard on storage.objects;", stops: ["P02"], admin: true },
  "the guard trigger is disabled": { sql: "alter table storage.objects disable trigger expense_receipts_maintenance_guard;", stops: ["P02", "P07"], admin: true },
  "the guard trigger has another definition (AFTER INSERT)": { sql: "drop trigger expense_receipts_maintenance_guard on storage.objects; create trigger expense_receipts_maintenance_guard after insert on storage.objects for each row when (new.bucket_id = 'expense-receipts') execute function private.storage_receipt_maintenance_guard();", stops: ["P02"], admin: true },
  "the guard function body changed": { sql: "create or replace function private.storage_receipt_maintenance_guard() returns trigger language plpgsql security definer set search_path = '' as $$ begin return new; end $$;", stops: ["P03"] },
  "an extra foreign trigger on storage.objects": { sql: "create function private.zz_t() returns trigger language plpgsql as $$ begin return new; end $$; revoke all on function private.zz_t() from public; create trigger zz_t before insert on storage.objects for each row execute function private.zz_t();", stops: ["P07"] },
  "the maintenance state readable by authenticated": { sql: "grant select on private.system_maintenance to authenticated;", stops: ["P05"] },
  "the restore context executable by authenticated": { sql: "grant execute on function private.receipt_restore_open(text, text[], integer) to authenticated;", stops: ["P05"] },
  "a write RPC whose wrapper lost the guard": { sql: "create or replace function public.create_customer(command jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$ begin return private.create_customer(command); end $$;", stops: ["P09"] },
  "owner_id with an unexpected type": { sql: "alter table storage.objects alter column owner_id type uuid using owner_id::uuid;", stops: ["P04"], admin: true },
  "a leftover restore grant": { sql: "insert into private.receipt_restore_objects values ('expense-receipts', 'x', 'r', now() + interval '1 hour', now());", stops: ["P10"] },
  "a later migration already applied": { sql: "insert into supabase_migrations.schema_migrations(version, name) values ('20261103150000', 'x');", stops: ["P01"] },
};
