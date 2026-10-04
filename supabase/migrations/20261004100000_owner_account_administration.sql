-- BIG SLICE 5: owner-only account administration.
-- Profiles and shop assignments stay read-only tables for every application
-- role; the only write path is these RPCs, which authorize against the stored
-- profile of the caller and write an audit row with the before/after state.

revoke insert, update, delete on public.profiles, public.user_shop_assignments, public.shops from public, anon, authenticated;

-- Serializes account administration and proves the caller is an active owner.
-- The lock is taken first so the owner check sees every committed change: two
-- owners demoting each other at the same moment cannot both succeed.
create function private.assert_account_admin() returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000'; end if;
  perform pg_advisory_xact_lock(hashtextextended('account-administration', 0));
  if not private.is_owner() then raise exception 'INSUFFICIENT_ROLE' using errcode = '42501'; end if;
  return auth.uid();
end $$;
revoke all on function private.assert_account_admin() from public, anon, authenticated;

-- Gives an existing sign-in (created in the Supabase dashboard) a ShopKhata
-- profile. Until this runs the sign-in can authenticate but can do nothing.
create function public.admin_register_account(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.assert_account_admin(); mail text; nm text; new_role text; uid uuid;
begin
  if jsonb_typeof(command) is distinct from 'object'
    or not private.jsonb_object_keys_subset(command, array['email', 'display_name', 'role'])
    or jsonb_typeof(command -> 'email') is distinct from 'string'
    or jsonb_typeof(command -> 'display_name') is distinct from 'string'
    or jsonb_typeof(command -> 'role') is distinct from 'string'
  then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  mail := lower(btrim(command ->> 'email')); nm := btrim(command ->> 'display_name'); new_role := command ->> 'role';
  if length(mail) not between 3 and 320 or length(nm) not between 1 and 200 or new_role not in ('owner', 'manager', 'staff') then
    raise exception 'INVALID_REQUEST' using errcode = 'P0001';
  end if;
  select u.id into uid from auth.users u where lower(u.email) = mail;
  if uid is null then raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from public.profiles p where p.id = uid) then raise exception 'ACCOUNT_EXISTS' using errcode = 'P0001'; end if;
  insert into public.profiles(id, email, display_name, role, is_active) values (uid, mail, nm, new_role, true);
  insert into public.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (actor, 'account.register', 'profile', uid::text, jsonb_build_object('email', mail, 'role', new_role, 'is_active', true));
  return jsonb_build_object('ok', true, 'user_id', uid);
end $$;

-- Sets the role and active state of another account. An owner cannot change
-- their own account, so the acting owner always remains an active owner and
-- the installation can never be left without one.
create function public.admin_update_account(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.assert_account_admin(); uid uuid; new_role text; new_active boolean; prior public.profiles%rowtype;
begin
  if jsonb_typeof(command) is distinct from 'object'
    or not private.jsonb_object_keys_subset(command, array['user_id', 'role', 'is_active'])
    or not private.is_valid_uuid_text(command ->> 'user_id')
    or jsonb_typeof(command -> 'role') is distinct from 'string'
    or command ->> 'role' not in ('owner', 'manager', 'staff')
    or jsonb_typeof(command -> 'is_active') is distinct from 'boolean'
  then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  uid := (command ->> 'user_id')::uuid; new_role := command ->> 'role'; new_active := (command -> 'is_active')::boolean;
  if uid = actor then raise exception 'SELF_CHANGE_FORBIDDEN' using errcode = 'P0001'; end if;
  select p.* into prior from public.profiles p where p.id = uid for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0001'; end if;
  if prior.role = new_role and prior.is_active = new_active then return jsonb_build_object('ok', true, 'changed', false); end if;
  update public.profiles set role = new_role, is_active = new_active, updated_at = now() where id = uid;
  insert into public.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (actor, 'account.update', 'profile', uid::text, jsonb_build_object(
    'before', jsonb_build_object('role', prior.role, 'is_active', prior.is_active),
    'after', jsonb_build_object('role', new_role, 'is_active', new_active)));
  return jsonb_build_object('ok', true, 'changed', true);
end $$;

-- Adds or removes one shop assignment. Access is read from this table on every
-- request, so the change applies to the account's very next read or write.
create function public.admin_set_shop_assignment(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.assert_account_admin(); uid uuid; sid uuid; want boolean; changed integer;
begin
  if jsonb_typeof(command) is distinct from 'object'
    or not private.jsonb_object_keys_subset(command, array['user_id', 'shop_id', 'assigned'])
    or not private.is_valid_uuid_text(command ->> 'user_id')
    or not private.is_valid_uuid_text(command ->> 'shop_id')
    or jsonb_typeof(command -> 'assigned') is distinct from 'boolean'
  then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  uid := (command ->> 'user_id')::uuid; sid := (command ->> 'shop_id')::uuid; want := (command -> 'assigned')::boolean;
  if not exists (select 1 from public.profiles p where p.id = uid) then raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.shops s where s.id = sid) then raise exception 'SHOP_NOT_FOUND' using errcode = 'P0001'; end if;
  if want then
    insert into public.user_shop_assignments(user_id, shop_id) values (uid, sid) on conflict (user_id, shop_id) do nothing;
  else
    delete from public.user_shop_assignments a where a.user_id = uid and a.shop_id = sid;
  end if;
  get diagnostics changed = row_count;
  if changed > 0 then
    insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, metadata)
    values (sid, actor, case when want then 'assignment.add' else 'assignment.remove' end, 'profile', uid::text, jsonb_build_object('shop_id', sid));
  end if;
  return jsonb_build_object('ok', true, 'changed', changed > 0);
end $$;

revoke all on function public.admin_register_account(jsonb), public.admin_update_account(jsonb), public.admin_set_shop_assignment(jsonb) from public, anon;
grant execute on function public.admin_register_account(jsonb), public.admin_update_account(jsonb), public.admin_set_shop_assignment(jsonb) to authenticated;
