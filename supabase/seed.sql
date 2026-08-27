-- Deterministic local test seeds for ShopKhata local environment

-- 1. Seed auth.users for local test profiles (no production credentials)
insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  (
    '10000000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000000',
    'authenticated',
    'authenticated',
    'owner@shopkhata.local',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"display_name":"Local Owner"}',
    now(),
    now()
  ),
  (
    '10000000-0000-4000-8000-000000000102',
    '00000000-0000-4000-8000-000000000000',
    'authenticated',
    'authenticated',
    'staff1@shopkhata.local',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"display_name":"Local Shop 1 Staff"}',
    now(),
    now()
  ),
  (
    '10000000-0000-4000-8000-000000000103',
    '00000000-0000-4000-8000-000000000000',
    'authenticated',
    'authenticated',
    'staff2@shopkhata.local',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"display_name":"Local Shop 2 Staff"}',
    now(),
    now()
  )
on conflict (id) do nothing;

-- 2. Seed Shops
insert into public.shops (id, name, is_active)
values
  ('10000000-0000-4000-8000-000000000001', 'Shop 1', true),
  ('10000000-0000-4000-8000-000000000002', 'Shop 2', true)
on conflict (id) do update set
  name = excluded.name,
  is_active = excluded.is_active;

-- 3. Seed Profiles
insert into public.profiles (id, email, display_name, role, is_active)
values
  ('10000000-0000-4000-8000-000000000101', 'owner@shopkhata.local', 'Local Owner', 'owner', true),
  ('10000000-0000-4000-8000-000000000102', 'staff1@shopkhata.local', 'Local Shop 1 Staff', 'staff', true),
  ('10000000-0000-4000-8000-000000000103', 'staff2@shopkhata.local', 'Local Shop 2 Staff', 'staff', true)
on conflict (id) do update set
  email = excluded.email,
  display_name = excluded.display_name,
  role = excluded.role,
  is_active = excluded.is_active;

-- 4. Seed User Shop Assignments
insert into public.user_shop_assignments (user_id, shop_id)
values
  ('10000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000102', '10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000103', '10000000-0000-4000-8000-000000000002')
on conflict (user_id, shop_id) do nothing;
