-- OPS-01A: owner-only Active / Inactive controls for shops and accounts. Nothing is deleted:
-- deactivation flips the existing is_active flag, and every record that carries the shop or
-- account id (invoices, payments, expenses, Daily Close events, audit rows) is left untouched.
-- Both status RPCs reuse private.assert_account_admin() (administration advisory lock, then an
-- active-owner check) and write the status change and its audit row in one transaction.

-- 1. An inactive shop accepts no new business record ------------------------------------------
-- Every operational table is append-only (UPDATE/DELETE are rejected by
-- reject_append_only_mutation), so guarding INSERT guards every write, whichever RPC (or future
-- path) performs it. FOR SHARE on the shop row conflicts with the FOR UPDATE that
-- admin_set_shop_status takes before flipping is_active: a write that locked first commits before
-- the deactivation proceeds, and a write that arrives after waits for it and then sees the shop
-- inactive. Exact idempotent retries return before inserting, so they are unaffected.
-- A missing shop is left to the foreign key, as before.
create function private.enforce_active_shop() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select s.is_active from public.shops s where s.id = new.shop_id for share) is false then
    raise exception 'SHOP_INACTIVE' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function private.enforce_active_shop() from public, anon, authenticated;

-- audit_events (the history itself) and user_shop_assignments (access configuration, owner-only)
-- are deliberately not guarded. The check below fails the migration if any other shop-scoped
-- table is left without the trigger, so a table added later must be classified here.
do $$
declare t text; uncovered text;
  guarded text[] := array['attachments', 'batches', 'correction_decisions', 'correction_requests', 'corrections',
    'credit_application_batches', 'credit_applications', 'customer_credits', 'customer_payment_batches', 'customers',
    'daily_closes', 'expense_correction_decisions', 'expense_correction_requests', 'expenses', 'invoice_number_registry',
    'invoices', 'payments', 'replacement_decisions', 'replacement_requests'];
begin
  foreach t in array guarded loop
    -- "<table>_active_shop" sorts before "_append_only" and "_open_business_date", so an inactive
    -- shop is reported before a closed date.
    execute format('create trigger %I before insert on public.%I for each row execute function private.enforce_active_shop()', t || '_active_shop', t);
  end loop;
  select string_agg(c.table_name::text, ', ') into uncovered
  from information_schema.columns c join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
  where c.table_schema = 'public' and c.column_name = 'shop_id' and tb.table_type = 'BASE TABLE'
    and c.table_name::text <> all (guarded || array['audit_events', 'user_shop_assignments']);
  if uncovered is not null then raise exception 'ops_01a: shop-scoped tables without the active-shop guard: %', uncovered; end if;
end $$;

-- 2. Shop status -----------------------------------------------------------------------------------
-- command: {shop_id, is_active, reason}. Setting the current state again is a no-op (changed:
-- false, no audit row), so a retried request is safe. Reactivation re-checks the active-name rule
-- that admin_create_shop / admin_update_shop enforce, because a new shop may have taken the name.
create function public.admin_set_shop_status(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.assert_account_admin(); sid uuid; want boolean; why text; prior public.shops%rowtype;
begin
  if jsonb_typeof(command) is distinct from 'object'
    or not private.jsonb_object_keys_subset(command, array['shop_id', 'is_active', 'reason'])
    or not private.is_valid_uuid_text(command ->> 'shop_id')
    or jsonb_typeof(command -> 'is_active') is distinct from 'boolean'
    or jsonb_typeof(command -> 'reason') is distinct from 'string'
  then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  sid := (command ->> 'shop_id')::uuid; want := (command -> 'is_active')::boolean; why := btrim(command ->> 'reason');
  if why = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if length(why) > 2000 then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  select s.* into prior from public.shops s where s.id = sid for update;
  if not found then raise exception 'SHOP_NOT_FOUND' using errcode = 'P0001'; end if;
  if prior.is_active = want then return jsonb_build_object('ok', true, 'shop_id', sid, 'is_active', want, 'changed', false); end if;
  if want and exists (select 1 from public.shops s where s.id <> sid and s.is_active and lower(btrim(s.name)) = lower(btrim(prior.name))) then
    raise exception 'SHOP_NAME_EXISTS' using errcode = 'P0001';
  end if;
  update public.shops set is_active = want, updated_at = now() where id = sid;
  insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, reason, metadata)
  values (sid, actor, case when want then 'shop.reactivate' else 'shop.deactivate' end, 'shop', sid::text, why,
    jsonb_build_object('name', prior.name, 'before', jsonb_build_object('is_active', prior.is_active), 'after', jsonb_build_object('is_active', want)));
  return jsonb_build_object('ok', true, 'shop_id', sid, 'is_active', want, 'changed', true);
end $$;

-- 3. Account status --------------------------------------------------------------------------------
-- command: {user_id, is_active, reason}. The auth user, the profile row, its assignments and every
-- record it authored stay; is_active = false makes private.is_active_actor() false, which every
-- RPC and read policy already checks on each statement, so an existing session is refused at its
-- next request. An owner cannot change their own status, and the acting owner is an active owner
-- proven under the administration lock, so an active owner always remains; the final check states
-- that rule in the database rather than relying on the reasoning alone.
create function public.admin_set_account_status(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.assert_account_admin(); uid uuid; want boolean; why text; prior public.profiles%rowtype;
begin
  if jsonb_typeof(command) is distinct from 'object'
    or not private.jsonb_object_keys_subset(command, array['user_id', 'is_active', 'reason'])
    or not private.is_valid_uuid_text(command ->> 'user_id')
    or jsonb_typeof(command -> 'is_active') is distinct from 'boolean'
    or jsonb_typeof(command -> 'reason') is distinct from 'string'
  then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  uid := (command ->> 'user_id')::uuid; want := (command -> 'is_active')::boolean; why := btrim(command ->> 'reason');
  if why = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if length(why) > 2000 then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  if uid = actor then raise exception 'SELF_CHANGE_FORBIDDEN' using errcode = 'P0001'; end if;
  select p.* into prior from public.profiles p where p.id = uid for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0001'; end if;
  if prior.is_active = want then return jsonb_build_object('ok', true, 'user_id', uid, 'is_active', want, 'changed', false); end if;
  update public.profiles set is_active = want, updated_at = now() where id = uid;
  if not exists (select 1 from public.profiles p where p.role = 'owner' and p.is_active) then
    raise exception 'LAST_ACTIVE_OWNER' using errcode = 'P0001';
  end if;
  insert into public.audit_events(actor_id, action, entity_type, entity_id, reason, metadata)
  values (actor, case when want then 'account.reactivate' else 'account.deactivate' end, 'profile', uid::text, why,
    jsonb_build_object('role', prior.role, 'before', jsonb_build_object('is_active', prior.is_active), 'after', jsonb_build_object('is_active', want)));
  return jsonb_build_object('ok', true, 'user_id', uid, 'is_active', want, 'changed', true);
end $$;

revoke all on function public.admin_set_shop_status(jsonb), public.admin_set_account_status(jsonb) from public, anon;
grant execute on function public.admin_set_shop_status(jsonb), public.admin_set_account_status(jsonb) to authenticated;

-- 4. admin_update_account no longer changes status --------------------------------------------------
-- Status now needs a reason, so it moves to admin_set_account_status. is_active becomes optional
-- here; a command that would change it is refused instead of silently skipping the reason. Sending
-- the unchanged value (as the previous app release always does) still works, so the release that
-- is live when this migration is applied keeps role and assignment changes working.
create or replace function public.admin_update_account(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.assert_account_admin(); uid uuid; new_role text; prior public.profiles%rowtype;
begin
  if jsonb_typeof(command) is distinct from 'object'
    or not private.jsonb_object_keys_subset(command, array['user_id', 'role', 'is_active'])
    or not private.is_valid_uuid_text(command ->> 'user_id')
    or jsonb_typeof(command -> 'role') is distinct from 'string'
    or command ->> 'role' not in ('owner', 'manager', 'staff')
    or (command ? 'is_active' and jsonb_typeof(command -> 'is_active') is distinct from 'boolean')
  then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  uid := (command ->> 'user_id')::uuid; new_role := command ->> 'role';
  if uid = actor then raise exception 'SELF_CHANGE_FORBIDDEN' using errcode = 'P0001'; end if;
  select p.* into prior from public.profiles p where p.id = uid for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0001'; end if;
  if command ? 'is_active' and (command -> 'is_active')::boolean <> prior.is_active then
    raise exception 'STATUS_REASON_REQUIRED' using errcode = 'P0001';
  end if;
  if prior.role = new_role then return jsonb_build_object('ok', true, 'changed', false); end if;
  update public.profiles set role = new_role, updated_at = now() where id = uid;
  insert into public.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (actor, 'account.update', 'profile', uid::text, jsonb_build_object(
    'before', jsonb_build_object('role', prior.role, 'is_active', prior.is_active),
    'after', jsonb_build_object('role', new_role, 'is_active', prior.is_active)));
  return jsonb_build_object('ok', true, 'changed', true);
end $$;
