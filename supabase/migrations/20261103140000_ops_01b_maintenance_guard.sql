-- OPS-01B slice 1: database-enforced maintenance boundary.
--
-- The Vercel Firewall blocks the app during a release, but an authenticated session can still call the Data API and
-- Storage directly. While maintenance is on, every business write RPC and receipt upload refuses with
-- MAINTENANCE_ACTIVE, except for one owner given a short-lived operator bypass for release smoke. Reads stay governed
-- by RLS only (a user's own shop data is not new exposure); the firewall keeps app pages closed.
--
-- This is release migration 36 of the OPS-01B sequence (35 = last migration in production, 36 = this one, 37 = invoice
-- void, 38 = historical-sales remediation, 39 = release compatibility). It sorts BEFORE the void migrations, so
-- production can enable maintenance at 36 and keep it on through 37-39. void_invoice (37) calls the guard itself.
--
-- LOCK CONTRACT. One global order, never the reverse. A path that needs several of these takes them in this order:
--   L1  the single private.system_maintenance row
--         FOR SHARE  : every business write RPC (first statement) and every expense-receipts Storage insert
--                      (BEFORE INSERT trigger on storage.objects), held until that transaction ends.
--         FOR UPDATE : set_maintenance and set_maintenance_bypass (enable, disable, grant/renew, revoke), as their
--                      first lock.
--   L2  advisory lock 'account-administration' (private.assert_account_admin): admin RPCs and the two control RPCs.
--   L3  everything else: per-shop and idempotency advisory locks, invoice/ledger row locks.
-- Consequences: (a) a control transition waits for every write admitted before it and reports success only after they
-- committed or rolled back; (b) a write that starts after the transition commits re-reads the row and refuses;
-- (c) L1 is never requested while L2 or L3 is held, so the control and admin paths cannot deadlock.
--
-- WHY STORAGE IS GUARDED BY A TRIGGER, NOT A POLICY. The Storage service checks the INSERT policy in a throw-away
-- transaction that it always rolls back, then uploads the bytes, then writes the real storage.objects row in a second
-- transaction as a service-role connection with no RLS. A lock taken inside the policy is therefore released long before
-- the object commits and serializes nothing. A BEFORE INSERT trigger fires in BOTH transactions, in particular the one
-- that really commits the row, so its L1 share lock is held through that commit. The uploader identity there is
-- NEW.owner_id (set by Storage from the verified JWT subject); the connection claims are only {"role":"service_role"}.
-- The existing INSERT policy is left untouched: a BEFORE trigger runs ahead of the WITH CHECK, so a refused upload fails
-- in the permission-test transaction already, before any bytes are sent.

-- 1. State: one row, written only by the owner RPCs below (security definer). No API role can touch it. The CHECKs make
-- an inconsistent combination unrepresentable: enabled state carries its full metadata, disabled state carries none, and
-- the bypass is all-or-nothing.
create table private.system_maintenance (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  enabled_at timestamptz,
  enabled_by uuid,
  reason text,
  -- Optional (the runbook always sets it); when present it is trimmed and 1-200 characters.
  release_ref text,
  bypass_user_id uuid,
  bypass_expires_at timestamptz,
  bypass_enabled_by uuid,
  bypass_reason text,
  updated_at timestamptz not null default now(),
  constraint system_maintenance_enabled_group check (
    (enabled and enabled_at is not null and enabled_by is not null and btrim(coalesce(reason, '')) <> '' and coalesce(length(reason), 0) <= 2000)
    or (not enabled and enabled_at is null and enabled_by is null and reason is null and release_ref is null)),
  constraint system_maintenance_release_ref check (release_ref is null or (release_ref = btrim(release_ref) and length(release_ref) between 1 and 200)),
  constraint system_maintenance_bypass_group check (
    (bypass_user_id is null and bypass_expires_at is null and bypass_enabled_by is null and bypass_reason is null)
    or (bypass_user_id is not null and bypass_expires_at is not null and bypass_enabled_by is not null
        and btrim(coalesce(bypass_reason, '')) <> '' and coalesce(length(bypass_reason), 0) <= 2000)),
  constraint system_maintenance_bypass_needs_maintenance check (enabled or bypass_user_id is null)
);
insert into private.system_maintenance(id) values (true);
alter table private.system_maintenance enable row level security;
revoke all on table private.system_maintenance from public, anon, service_role, authenticated;

-- 2. Guards. Fail closed: a missing row refuses every write.
-- Pure decision, wall clock (clock_timestamp, not the transaction start): an operator bypass is valid only if it has not
-- expired at the moment of the decision. Callers evaluate it AFTER acquiring L1, so a transaction that waited for the lock
-- is judged at the time it got the lock. Expiry is an admission boundary, not a commit boundary: a write admitted a
-- moment before expiry may commit after it (it holds L1 SHARE, so only an explicit revoke or disable waits for it).
create function private.maintenance_allows(m private.system_maintenance, p_user uuid) returns boolean
language sql volatile set search_path = '' as $$
  select not m.enabled or coalesce(p_user is not null and m.bypass_user_id = p_user and m.bypass_expires_at > clock_timestamp(), false);
$$;
revoke all on function private.maintenance_allows(private.system_maintenance, uuid) from public, anon, authenticated, service_role;

-- L1 FOR SHARE, then decide. FOR SHARE conflicts with the control RPCs' FOR UPDATE: a transition waits for every holder,
-- and a later requester queues behind a waiting transition and then sees the committed row.
create function private.maintenance_admit(p_user uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare m private.system_maintenance;
begin
  select * into m from private.system_maintenance where id for share;
  if not found then return false; end if;
  return coalesce(private.maintenance_allows(m, p_user), false);
end $$;
revoke all on function private.maintenance_admit(uuid) from public, anon, authenticated, service_role;

-- First statement of every business write RPC.
create function private.assert_not_in_maintenance() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.maintenance_admit(auth.uid()) then raise exception 'MAINTENANCE_ACTIVE' using errcode = 'P0001'; end if;
end $$;
revoke all on function private.assert_not_in_maintenance() from public, anon, authenticated, service_role;

-- L1 FOR UPDATE for the control RPCs. A missing singleton is an invariant violation: refuse, never improvise.
create function private.maintenance_lock_exclusive() returns private.system_maintenance
language plpgsql security definer set search_path = '' as $$
declare m private.system_maintenance;
begin
  select * into m from private.system_maintenance where id for update;
  if not found then raise exception 'MAINTENANCE_STATE_MISSING' using errcode = 'P0001'; end if;
  return m;
end $$;
revoke all on function private.maintenance_lock_exclusive() from public, anon, authenticated, service_role;

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

-- 4. Receipt uploads go browser -> Storage directly, so the guard is a trigger on the row that Storage commits (see the
-- header).
-- Update and delete stay denied to every API role by the existing policies, so insert is the only user-reachable Storage mutation.
-- Trigger functions are not EXECUTE-checked when they fire, so the function needs no grant.
--
-- RECEIPT RESTORE CONTEXT. A disaster restore loads the database (which may come up LOCKED, by design) and then puts the
-- receipt bytes back through the Storage API with the service key. Those uploads carry no uploader (owner_id NULL), so the
-- guard would refuse them. The restore context admits exactly the object names it lists, only uploads without an
-- uploader (service key; an authenticated user's upload always carries owner_id = its JWT subject), only until its
-- expiry, and only for the restore reference that opened it. It is NOT a service-role exemption: any other service-key
-- upload is still refused while maintenance is on. Opening and closing it are private functions with no API grant, so
-- only a direct database-owner connection (the restore operator) can use them; every open and close is logged in
-- private.receipt_restore_log. Tooling: scripts/backup.mjs (restore, restore-receipts), which always closes it.
create table private.receipt_restore_objects (
  bucket_id text not null check (bucket_id = 'expense-receipts'),
  name text not null,
  restore_ref text not null check (restore_ref = btrim(restore_ref) and length(restore_ref) between 1 and 200),
  expires_at timestamptz not null,
  primary key (bucket_id, name)
);
create table private.receipt_restore_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(),
  db_user text not null default current_user,
  action text not null check (action in ('opened', 'closed')),
  restore_ref text not null,
  object_count integer not null,
  expires_at timestamptz
);
alter table private.receipt_restore_objects enable row level security;
alter table private.receipt_restore_log enable row level security;
revoke all on table private.receipt_restore_objects, private.receipt_restore_log from public, anon, authenticated, service_role;

-- Opens (or extends) the context for the listed objects, at most 60 minutes. Refuses while another restore is open.
create function private.receipt_restore_open(p_restore_ref text, p_names text[], p_minutes integer) returns integer
language plpgsql set search_path = '' as $$
declare n integer; until_ts timestamptz;
begin
  if p_restore_ref is null or p_names is null or cardinality(p_names) = 0 or p_minutes is null or p_minutes not between 1 and 60
    or exists (select 1 from unnest(p_names) x where x is null or btrim(x) = '')
  then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  if exists (select 1 from private.receipt_restore_objects where restore_ref <> p_restore_ref) then
    raise exception 'RESTORE_CONTEXT_BUSY' using errcode = 'P0001';
  end if;
  until_ts := clock_timestamp() + make_interval(mins => p_minutes);
  insert into private.receipt_restore_objects(bucket_id, name, restore_ref, expires_at)
  select distinct 'expense-receipts', x, p_restore_ref, until_ts from unnest(p_names) x
  on conflict (bucket_id, name) do update set expires_at = excluded.expires_at;
  get diagnostics n = row_count;
  insert into private.receipt_restore_log(action, restore_ref, object_count, expires_at) values ('opened', p_restore_ref, n, until_ts);
  return n;
end $$;
-- Closes the context (idempotent); returns how many grants it removed.
create function private.receipt_restore_close(p_restore_ref text) returns integer
language plpgsql set search_path = '' as $$
declare n integer;
begin
  delete from private.receipt_restore_objects where restore_ref = p_restore_ref;
  get diagnostics n = row_count;
  insert into private.receipt_restore_log(action, restore_ref, object_count) values ('closed', p_restore_ref, n);
  return n;
end $$;
revoke all on function private.receipt_restore_open(text, text[], integer), private.receipt_restore_close(text) from public, anon, authenticated, service_role;

create function private.storage_receipt_maintenance_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare uploader uuid;
begin
  if private.is_valid_uuid_text(new.owner_id) then uploader := new.owner_id::uuid; end if;
  if private.maintenance_admit(uploader) then return new; end if;
  -- Still under L1 (maintenance_admit took it). Only an uploader-less (service key) insert of a listed, unexpired name.
  if new.owner_id is null and exists (select 1 from private.receipt_restore_objects r
      where r.bucket_id = new.bucket_id and r.name = new.name and r.expires_at > clock_timestamp()) then
    return new;
  end if;
  raise exception 'MAINTENANCE_ACTIVE' using errcode = 'P0001';
end $$;
revoke all on function private.storage_receipt_maintenance_guard() from public, anon, authenticated, service_role;
create trigger expense_receipts_maintenance_guard before insert on storage.objects
  for each row when (new.bucket_id = 'expense-receipts') execute function private.storage_receipt_maintenance_guard();

-- 5. Control RPCs: active owner only, reason required, audited in audit_events, idempotent (a repeat of an enable, a
-- disable or a revoke returns changed=false and writes no audit row). A bypass GRANT is a renewal, not idempotent: it
-- always sets a fresh expiry and always audits. Not maintenance-guarded, or maintenance could never be turned off.
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

-- Pre-lock authorization. Only an active owner may queue for the exclusive L1 lock, so nobody else can stall writes by
-- calling a control RPC. The authoritative owner check repeats under L2 (assert_account_admin), after L1.
create function private.assert_maintenance_controller() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000'; end if;
  if not private.is_owner() then raise exception 'INSUFFICIENT_ROLE' using errcode = '42501'; end if;
end $$;
revoke all on function private.assert_maintenance_controller() from public, anon, authenticated, service_role;

-- command: {enabled: boolean, reason: text, release_ref?: text}. Disabling also clears any operator bypass.
-- Lock order: L1 (FOR UPDATE) then L2.
create function public.set_maintenance(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid; want boolean; why text; ref text; m private.system_maintenance; prior private.system_maintenance; at_ts timestamptz;
begin
  perform private.assert_maintenance_controller();
  if jsonb_typeof(command) is distinct from 'object' or not private.jsonb_object_keys_subset(command, array['enabled', 'reason', 'release_ref'])
    or jsonb_typeof(command -> 'enabled') is distinct from 'boolean'
    or (command ? 'release_ref' and jsonb_typeof(command -> 'release_ref') not in ('string', 'null'))
    or length(command ->> 'release_ref') > 200
  then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  want := (command ->> 'enabled')::boolean;
  why := private.maintenance_reason(command);
  ref := private.normalize_optional_text(command ->> 'release_ref');

  prior := private.maintenance_lock_exclusive();            -- L1
  actor := private.assert_account_admin();                  -- L2, authoritative owner check
  if prior.enabled = want then return jsonb_build_object('ok', true, 'changed', false) || private.maintenance_state(prior); end if;
  at_ts := clock_timestamp();

  if want then
    update private.system_maintenance set enabled = true, enabled_at = at_ts, enabled_by = actor, reason = why,
      release_ref = ref, updated_at = at_ts where id returning * into m;
    if not found then raise exception 'MAINTENANCE_STATE_MISSING' using errcode = 'P0001'; end if;
    insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, reason, metadata)
    values (null, actor, 'maintenance.enabled', 'system_maintenance', 'global', why,
      jsonb_build_object('actor', actor, 'at', at_ts, 'reason', why, 'release_ref', ref));
  else
    update private.system_maintenance set enabled = false, enabled_at = null, enabled_by = null, reason = null,
      release_ref = null, bypass_user_id = null, bypass_expires_at = null, bypass_enabled_by = null, bypass_reason = null,
      updated_at = at_ts where id returning * into m;
    if not found then raise exception 'MAINTENANCE_STATE_MISSING' using errcode = 'P0001'; end if;
    if prior.bypass_user_id is not null then
      insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, reason, metadata)
      values (null, actor, 'maintenance.operator_bypass_disabled', 'system_maintenance', 'global', why,
        jsonb_build_object('actor', actor, 'at', at_ts, 'reason', why, 'user_id', prior.bypass_user_id,
          'expires_at', prior.bypass_expires_at, 'release_ref', prior.release_ref, 'cause', 'maintenance_disabled'));
    end if;
    insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, reason, metadata)
    values (null, actor, 'maintenance.disabled', 'system_maintenance', 'global', why,
      jsonb_build_object('actor', actor, 'at', at_ts, 'reason', why, 'release_ref', coalesce(ref, prior.release_ref),
        'enabled_at', prior.enabled_at, 'enabled_by', prior.enabled_by));
  end if;
  return jsonb_build_object('ok', true, 'changed', true) || private.maintenance_state(m);
end $$;
revoke all on function public.set_maintenance(jsonb) from public, anon, service_role;
grant execute on function public.set_maintenance(jsonb) to authenticated;

-- command: {user_id: uuid | null, minutes?: 1..120, reason: text}. user_id null revokes (idempotent). A uuid GRANTS or
-- RENEWS: there is one operator slot, so granting again (same or another owner) replaces it with a fresh expiry measured
-- from the moment the lock was acquired, and is audited as a new grant with renewal=true. Only while maintenance is on;
-- the target must be an active owner, so the bypass never grants a role or shop the user lacks.
-- Lock order: L1 (FOR UPDATE) then L2.
create function public.set_maintenance_bypass(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid; target uuid; mins int; why text; m private.system_maintenance; prior private.system_maintenance; at_ts timestamptz;
begin
  perform private.assert_maintenance_controller();
  if jsonb_typeof(command) is distinct from 'object' or not private.jsonb_object_keys_subset(command, array['user_id', 'minutes', 'reason'])
    or not (command ? 'user_id') or (jsonb_typeof(command -> 'user_id') <> 'null' and not private.is_valid_uuid_text(command ->> 'user_id'))
  then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  target := (command ->> 'user_id')::uuid;
  if target is not null and (jsonb_typeof(command -> 'minutes') is distinct from 'number'
    or (command ->> 'minutes') !~ '^[0-9]{1,3}$' or (command ->> 'minutes')::int not between 1 and 120)
  then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  mins := (command ->> 'minutes')::int;
  why := private.maintenance_reason(command);

  prior := private.maintenance_lock_exclusive();            -- L1
  actor := private.assert_account_admin();                  -- L2, authoritative owner check
  at_ts := clock_timestamp();
  if target is null then
    if prior.bypass_user_id is null then return jsonb_build_object('ok', true, 'changed', false) || private.maintenance_state(prior); end if;
    update private.system_maintenance set bypass_user_id = null, bypass_expires_at = null, bypass_enabled_by = null,
      bypass_reason = null, updated_at = at_ts where id returning * into m;
    if not found then raise exception 'MAINTENANCE_STATE_MISSING' using errcode = 'P0001'; end if;
    insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, reason, metadata)
    values (null, actor, 'maintenance.operator_bypass_disabled', 'system_maintenance', 'global', why,
      jsonb_build_object('actor', actor, 'at', at_ts, 'reason', why, 'user_id', prior.bypass_user_id, 'expires_at', prior.bypass_expires_at,
        'release_ref', prior.release_ref, 'cause', 'revoked'));
    return jsonb_build_object('ok', true, 'changed', true) || private.maintenance_state(m);
  end if;

  if not prior.enabled then raise exception 'MAINTENANCE_NOT_ACTIVE' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.profiles p where p.id = target and p.role = 'owner' and p.is_active) then
    raise exception 'BYPASS_USER_NOT_ACTIVE_OWNER' using errcode = 'P0001';
  end if;
  update private.system_maintenance set bypass_user_id = target, bypass_expires_at = at_ts + make_interval(mins => mins),
    bypass_enabled_by = actor, bypass_reason = why, updated_at = at_ts where id returning * into m;
  if not found then raise exception 'MAINTENANCE_STATE_MISSING' using errcode = 'P0001'; end if;
  insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, reason, metadata)
  values (null, actor, 'maintenance.operator_bypass_enabled', 'system_maintenance', 'global', why,
    jsonb_build_object('actor', actor, 'at', at_ts, 'reason', why, 'user_id', target, 'expires_at', m.bypass_expires_at,
      'minutes', mins, 'release_ref', m.release_ref, 'renewal', prior.bypass_user_id is not null,
      'previous_user_id', prior.bypass_user_id, 'previous_expires_at', prior.bypass_expires_at));
  return jsonb_build_object('ok', true, 'changed', true, 'renewal', prior.bypass_user_id is not null) || private.maintenance_state(m);
end $$;
revoke all on function public.set_maintenance_bypass(jsonb) from public, anon, service_role;
grant execute on function public.set_maintenance_bypass(jsonb) to authenticated;
