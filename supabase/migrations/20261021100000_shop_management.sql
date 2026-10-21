-- Owner-only shop management. public.shops stays read-only for every application role
-- (direct INSERT/UPDATE/DELETE were revoked in 20261004100000); the only write path is these
-- RPCs. Both reuse private.assert_account_admin(): it takes the administration advisory lock
-- first and then proves the caller is an active owner, so two owners naming a shop at the same
-- moment cannot both pass the duplicate-name check below.
-- Independent of 20261021090000_bank_payment_method.sql: neither migration reads the other.

-- Creates an empty, active shop. No assignment is written: owners already reach every active
-- shop, and manager/staff access is granted afterwards with admin_set_shop_assignment.
create function public.admin_create_shop(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.assert_account_admin(); nm text; sid uuid;
begin
  if jsonb_typeof(command) is distinct from 'object'
    or not private.jsonb_object_keys_subset(command, array['name'])
    or jsonb_typeof(command -> 'name') is distinct from 'string'
  then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  nm := btrim(command ->> 'name');
  if length(nm) not between 1 and 100 then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  if exists (select 1 from public.shops s where s.is_active and lower(btrim(s.name)) = lower(nm)) then
    raise exception 'SHOP_NAME_EXISTS' using errcode = 'P0001';
  end if;
  insert into public.shops(name) values (nm) returning id into sid;
  insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, metadata)
  values (sid, actor, 'shop.create', 'shop', sid::text, jsonb_build_object('name', nm));
  return jsonb_build_object('ok', true, 'shop_id', sid, 'name', nm);
end $$;

-- Renames a shop. Only the name changes: the UUID, is_active and every record that carries the
-- shop id are untouched, so history stays attached to the same shop.
create function public.admin_update_shop(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.assert_account_admin(); sid uuid; nm text; prior text;
begin
  if jsonb_typeof(command) is distinct from 'object'
    or not private.jsonb_object_keys_subset(command, array['shop_id', 'name'])
    or not private.is_valid_uuid_text(command ->> 'shop_id')
    or jsonb_typeof(command -> 'name') is distinct from 'string'
  then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  sid := (command ->> 'shop_id')::uuid; nm := btrim(command ->> 'name');
  if length(nm) not between 1 and 100 then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  select s.name into prior from public.shops s where s.id = sid for update;
  if not found then raise exception 'SHOP_NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from public.shops s where s.id <> sid and s.is_active and lower(btrim(s.name)) = lower(nm)) then
    raise exception 'SHOP_NAME_EXISTS' using errcode = 'P0001';
  end if;
  if prior = nm then return jsonb_build_object('ok', true, 'shop_id', sid, 'changed', false); end if;
  update public.shops set name = nm, updated_at = now() where id = sid;
  insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, metadata)
  values (sid, actor, 'shop.update', 'shop', sid::text, jsonb_build_object('old_name', prior, 'new_name', nm));
  return jsonb_build_object('ok', true, 'shop_id', sid, 'changed', true);
end $$;

revoke all on function public.admin_create_shop(jsonb), public.admin_update_shop(jsonb) from public, anon;
grant execute on function public.admin_create_shop(jsonb), public.admin_update_shop(jsonb) to authenticated;
