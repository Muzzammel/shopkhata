-- Core schema: Shops, Profiles, User Shop Assignments, Customers
-- Sequence for customer human-readable public IDs (CUS-00001 form)
create sequence if not exists public.customer_public_id_seq start with 1 increment by 1;

-- 1. Shops (Master Data)
create table if not exists public.shops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. Profiles (Linked to auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null,
  role text not null check (role in ('owner', 'manager', 'staff')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3. User Shop Assignments
create table if not exists public.user_shop_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint user_shop_assignments_user_shop_uq unique (user_id, shop_id)
);

-- 4. Customers
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  public_id text not null default ('CUS-' || lpad(nextval('public.customer_public_id_seq'::regclass)::text, 5, '0')),
  name text,
  mobile text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_public_id_uq unique (public_id)
);
