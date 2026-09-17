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
  confirmation_token,
  recovery_token,
  email_change,
  email_change_token_new,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  (
    '10000000-0000-4000-8000-000000000101',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'owner@shopkhata.local',
    crypt('ShopKhata-Local-Owner-E2E-Only-2026!', gen_salt('bf')),
    now(),
    '',
    '',
    '',
    '',
    '{"provider":"email","providers":["email"]}',
    '{"display_name":"Local Owner"}',
    now(),
    now()
  ),
  (
    '10000000-0000-4000-8000-000000000102',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'staff1@shopkhata.local',
    crypt('ShopKhata-Local-E2E-Only-2026!', gen_salt('bf')),
    now(),
    '',
    '',
    '',
    '',
    '{"provider":"email","providers":["email"]}',
    '{"display_name":"Local Shop 1 Staff"}',
    now(),
    now()
  ),
  (
    '10000000-0000-4000-8000-000000000103',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'staff2@shopkhata.local',
    '',
    now(),
    '',
    '',
    '',
    '',
    '{"provider":"email","providers":["email"]}',
    '{"display_name":"Local Shop 2 Staff"}',
    now(),
    now()
  )
on conflict (id) do update set
  instance_id = excluded.instance_id,
  encrypted_password = case
    when auth.users.id in (
      '10000000-0000-4000-8000-000000000101',
      '10000000-0000-4000-8000-000000000102'
    ) then excluded.encrypted_password
    else auth.users.encrypted_password
  end,
  email_confirmed_at = case
    when auth.users.id in (
      '10000000-0000-4000-8000-000000000101',
      '10000000-0000-4000-8000-000000000102'
    ) then excluded.email_confirmed_at
    else auth.users.email_confirmed_at
  end,
  confirmation_token = excluded.confirmation_token,
  recovery_token = excluded.recovery_token,
  email_change = excluded.email_change,
  email_change_token_new = excluded.email_change_token_new;

-- 1a. Seed the explicitly local-only email identity for the E2E staff user
insert into auth.identities (
  id,
  user_id,
  identity_data,
  provider,
  provider_id,
  created_at,
  updated_at,
  last_sign_in_at
) values (
  '20000000-0000-4000-8000-000000000102',
  '10000000-0000-4000-8000-000000000102',
  '{"sub":"10000000-0000-4000-8000-000000000102","email":"staff1@shopkhata.local"}',
  'email',
  '10000000-0000-4000-8000-000000000102',
  now(),
  now(),
  now()
)
on conflict (provider_id, provider) do update set
  id = excluded.id,
  user_id = excluded.user_id,
  identity_data = excluded.identity_data,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  last_sign_in_at = excluded.last_sign_in_at;

-- 1b. Seed the explicitly local-only email identity for the E2E owner user
insert into auth.identities (
  id, user_id, identity_data, provider, provider_id, created_at, updated_at, last_sign_in_at
) values (
  '20000000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000101',
  '{"sub":"10000000-0000-4000-8000-000000000101","email":"owner@shopkhata.local"}',
  'email', '10000000-0000-4000-8000-000000000101', now(), now(), now()
)
on conflict (provider_id, provider) do update set
  id = excluded.id, user_id = excluded.user_id, identity_data = excluded.identity_data,
  created_at = excluded.created_at, updated_at = excluded.updated_at, last_sign_in_at = excluded.last_sign_in_at;

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
