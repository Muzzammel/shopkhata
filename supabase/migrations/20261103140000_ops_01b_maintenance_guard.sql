-- OPS-01B slice 1: database-enforced maintenance boundary.
--
-- The Vercel Firewall blocks the app during a release, but an authenticated session can still call the Data API and
-- Storage directly. While maintenance is on, every business write RPC and receipt upload refuses with
-- MAINTENANCE_ACTIVE, except for one owner given a short-lived operator bypass for release smoke. Reads stay governed
-- by RLS only (a user's own shop data is not new exposure); the firewall keeps app pages closed.
--
-- This migration sorts BEFORE the invoice-void migrations, so production can enable maintenance at 35 + this and keep
-- it on through the rest of the release. void_invoice (next migration) calls the guard itself.

-- 1. State: one row, written only by the owner RPCs below (security definer). No API role can touch it.
create table private.system_maintenance (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  enabled_at timestamptz,
  enabled_by uuid,
  reason text,
  release_ref text,
  bypass_user_id uuid,
  bypass_expires_at timestamptz,
  bypass_enabled_by uuid,
  bypass_reason text,
  updated_at timestamptz not null default now(),
  constraint system_maintenance_bypass_needs_maintenance check (enabled or bypass_user_id is null),
  constraint system_maintenance_bypass_complete check ((bypass_user_id is null) = (bypass_expires_at is null))
);
insert into private.system_maintenance(id) values (true);
alter table private.system_maintenance enable row level security;
revoke all on table private.system_maintenance from public, anon, authenticated, service_role;

-- 2. Guards. Fail closed: a missing row counts as maintenance.
-- ponytail: one bypass row, i.e. one operator at a time; a table of grants if two operators ever smoke in parallel.
create function private.maintenance_write_allowed() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select not m.enabled or (m.bypass_user_id = auth.uid() and m.bypass_expires_at > now())
                   from private.system_maintenance m where m.id), false);
$$;
revoke all on function private.maintenance_write_allowed() from public, anon, service_role;
-- The Storage INSERT policy runs as authenticated.
grant execute on function private.maintenance_write_allowed() to authenticated;

-- FOR SHARE conflicts with the control RPCs' FOR UPDATE: enabling waits for in-flight writes to finish, and every
-- write that starts after the enable commits re-reads the row and refuses. Called before any other work.
create function private.assert_not_in_maintenance() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from private.system_maintenance where id for share;
  if not private.maintenance_write_allowed() then raise exception 'MAINTENANCE_ACTIVE' using errcode = 'P0001'; end if;
end $$;
revoke all on function private.assert_not_in_maintenance() from public, anon, authenticated, service_role;

-- 3. Every existing write RPC becomes guard + unchanged body. The body moves to private under the same name (same
-- owner, security definer and search_path; no API grant), so financial semantics are untouched.
do $do$
declare f text;
begin
  foreach f in array array[
    'admin_create_shop', 'admin_register_account', 'admin_set_account_status', 'admin_set_shop_assignment',
    'admin_set_shop_status', 'admin_update_account', 'admin_update_shop', 'apply_customer_credit', 'approve_overpayment',
    'close_business_date', 'create_customer', 'create_expense', 'decide_expense_correction', 'decide_invoice_correction',
    'decide_invoice_replacement', 'record_customer_payment', 'record_payment', 'register_expense_attachment',
    'reopen_business_date', 'request_expense_correction', 'request_invoice_correction', 'request_invoice_replacement',
    'submit_batch'
  ] loop
    if pg_get_function_result(format('public.%I(jsonb)', f)::regprocedure) <> 'jsonb' then
      raise exception 'ops_01b maintenance: %(jsonb) does not return jsonb', f;
    end if;
    execute format('alter function public.%I(jsonb) set schema private', f);
    execute format('revoke all on function private.%I(jsonb) from public, anon, authenticated, service_role', f);
    execute format($sql$create function public.%1$I(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $body$
begin
  perform private.assert_not_in_maintenance();
  return private.%1$I(command);
end $body$$sql$, f);
    execute format('revoke all on function public.%I(jsonb) from public, anon, service_role', f);
    execute format('grant execute on function public.%I(jsonb) to authenticated', f);
  end loop;
end $do$;

-- 4. Receipt uploads go browser -> Storage directly, so the INSERT policy carries the same check.
alter policy expense_receipts_shop_insert on storage.objects with check (
  bucket_id = 'expense-receipts'
  and private.maintenance_write_allowed()
  and private.is_valid_uuid_text((storage.foldername(name))[1])
  and private.has_shop_access(((storage.foldername(name))[1])::uuid)
  and private.is_valid_uuid_text((storage.foldername(name))[2])
  and coalesce(array_length(storage.foldername(name), 1), 0) = 2
  and exists (select 1 from public.expenses e where e.shop_id = ((storage.foldername(name))[1])::uuid and e.id = ((storage.foldername(name))[2])::uuid)
  and split_part(name, '/', 3) ~ '^[0-9a-f-]{36}\.(jpg|png|webp|pdf)$'
);

-- 5. Control RPCs: active owner only, reason required, audited in audit_events, idempotent (a repeat returns
-- changed=false and writes no audit row). Not maintenance-guarded, or maintenance could never be turned off.
create function private.maintenance_reason(command jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare why text;
begin
  if jsonb_typeof(command -> 'reason') is distinct from 'string' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  why := regexp_replace(command ->> 'reason', '^\s+|\s+$', '', 'g');
  if why = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if length(why) > 2000 then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  return why;
end $$;
revoke all on function private.maintenance_reason(jsonb) from public, anon, authenticated, service_role;

create function private.maintenance_state(m private.system_maintenance) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('enabled', m.enabled, 'enabled_at', m.enabled_at, 'release_ref', m.release_ref,
    'bypass_user_id', m.bypass_user_id, 'bypass_expires_at', m.bypass_expires_at);
$$;
revoke all on function private.maintenance_state(private.system_maintenance) from public, anon, authenticated, service_role;

-- command: {enabled: boolean, reason: text, release_ref?: text}. Disabling also revokes any operator bypass.
create function public.set_maintenance(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid; want boolean; why text; ref text; m private.system_maintenance;
begin
  actor := private.assert_account_admin();
  if jsonb_typeof(command) is distinct from 'object' or not private.jsonb_object_keys_subset(command, array['enabled', 'reason', 'release_ref'])
    or jsonb_typeof(command -> 'enabled') is distinct from 'boolean'
    or (command ? 'release_ref' and jsonb_typeof(command -> 'release_ref') not in ('string', 'null'))
    or length(command ->> 'release_ref') > 200
  then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  want := (command ->> 'enabled')::boolean;
  why := private.maintenance_reason(command);
  ref := private.normalize_optional_text(command ->> 'release_ref');

  select * into m from private.system_maintenance where id for update;
  if m.enabled = want then return jsonb_build_object('ok', true, 'changed', false) || private.maintenance_state(m); end if;

  if want then
    update private.system_maintenance set enabled = true, enabled_at = now(), enabled_by = actor, reason = why,
      release_ref = ref, updated_at = now() where id returning * into m;
    insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, reason, metadata)
    values (null, actor, 'maintenance.enabled', 'system_maintenance', 'global', why,
      jsonb_build_object('actor', actor, 'at', now(), 'reason', why, 'release_ref', ref));
  else
    if m.bypass_user_id is not null then
      insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, reason, metadata)
      values (null, actor, 'maintenance.operator_bypass_disabled', 'system_maintenance', 'global', why,
        jsonb_build_object('actor', actor, 'at', now(), 'reason', why, 'user_id', m.bypass_user_id,
          'expires_at', m.bypass_expires_at, 'cause', 'maintenance_disabled'));
    end if;
    insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, reason, metadata)
    values (null, actor, 'maintenance.disabled', 'system_maintenance', 'global', why,
      jsonb_build_object('actor', actor, 'at', now(), 'reason', why, 'release_ref', coalesce(ref, m.release_ref),
        'enabled_at', m.enabled_at, 'enabled_by', m.enabled_by));
    update private.system_maintenance set enabled = false, enabled_at = null, enabled_by = null, reason = null,
      release_ref = null, bypass_user_id = null, bypass_expires_at = null, bypass_enabled_by = null, bypass_reason = null,
      updated_at = now() where id returning * into m;
  end if;
  return jsonb_build_object('ok', true, 'changed', true) || private.maintenance_state(m);
end $$;
revoke all on function public.set_maintenance(jsonb) from public, anon, service_role;
grant execute on function public.set_maintenance(jsonb) to authenticated;

-- command: {user_id: uuid | null, minutes?: 1..120, reason: text}. user_id null revokes. Only while maintenance is on;
-- the target must be an active owner, so the bypass never grants a role or shop the user lacks.
create function public.set_maintenance_bypass(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid; target uuid; mins int; why text; m private.system_maintenance;
begin
  actor := private.assert_account_admin();
  if jsonb_typeof(command) is distinct from 'object' or not private.jsonb_object_keys_subset(command, array['user_id', 'minutes', 'reason'])
    or not (command ? 'user_id') or (jsonb_typeof(command -> 'user_id') <> 'null' and not private.is_valid_uuid_text(command ->> 'user_id'))
  then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  target := (command ->> 'user_id')::uuid;
  if target is not null and (jsonb_typeof(command -> 'minutes') is distinct from 'number'
    or (command ->> 'minutes') !~ '^[0-9]{1,3}$' or (command ->> 'minutes')::int not between 1 and 120)
  then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  mins := (command ->> 'minutes')::int;
  why := private.maintenance_reason(command);

  select * into m from private.system_maintenance where id for update;
  if target is null then
    if m.bypass_user_id is null then return jsonb_build_object('ok', true, 'changed', false) || private.maintenance_state(m); end if;
    insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, reason, metadata)
    values (null, actor, 'maintenance.operator_bypass_disabled', 'system_maintenance', 'global', why,
      jsonb_build_object('actor', actor, 'at', now(), 'reason', why, 'user_id', m.bypass_user_id, 'expires_at', m.bypass_expires_at,
        'release_ref', m.release_ref, 'cause', 'revoked'));
    update private.system_maintenance set bypass_user_id = null, bypass_expires_at = null, bypass_enabled_by = null,
      bypass_reason = null, updated_at = now() where id returning * into m;
    return jsonb_build_object('ok', true, 'changed', true) || private.maintenance_state(m);
  end if;

  if not m.enabled then raise exception 'MAINTENANCE_NOT_ACTIVE' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.profiles p where p.id = target and p.role = 'owner' and p.is_active) then
    raise exception 'BYPASS_USER_NOT_ACTIVE_OWNER' using errcode = 'P0001';
  end if;
  update private.system_maintenance set bypass_user_id = target, bypass_expires_at = now() + make_interval(mins => mins),
    bypass_enabled_by = actor, bypass_reason = why, updated_at = now() where id returning * into m;
  insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, reason, metadata)
  values (null, actor, 'maintenance.operator_bypass_enabled', 'system_maintenance', 'global', why,
    jsonb_build_object('actor', actor, 'at', now(), 'reason', why, 'user_id', target, 'expires_at', m.bypass_expires_at,
      'minutes', mins, 'release_ref', m.release_ref));
  return jsonb_build_object('ok', true, 'changed', true) || private.maintenance_state(m);
end $$;
revoke all on function public.set_maintenance_bypass(jsonb) from public, anon, service_role;
grant execute on function public.set_maintenance_bypass(jsonb) to authenticated;
