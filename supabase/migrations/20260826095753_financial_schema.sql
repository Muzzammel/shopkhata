-- Financial Schema: Batches, Invoices, Payments, Customer Credits, Expenses, Attachments, Corrections, Daily Closes, Audit Events
-- Append-only triggers and privilege restrictions

-- 1. Batches
create table if not exists public.batches (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  business_date date not null,
  is_backdated boolean not null default false,
  backdated_reason text,
  idempotency_key text,
  created_by uuid references public.profiles(id) on delete set null,
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- 2. Invoices
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  batch_id uuid references public.batches(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete restrict,
  invoice_id text not null,
  invoice_type text not null default 'advance',
  quantity integer not null default 1,
  total_amount_dirham bigint not null,
  business_date date not null,
  recorded_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint invoices_total_amount_nonnegative check (total_amount_dirham >= 0)
);

create unique index invoices_shop_invoice_id_uq
  on public.invoices (shop_id, invoice_id);

-- 3. Payments
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  batch_id uuid references public.batches(id) on delete restrict,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  amount_dirham bigint not null,
  business_date date not null,
  payment_method text not null default 'cash',
  recorded_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint payments_amount_nonnegative check (amount_dirham >= 0)
);

-- 4. Customer Credits
create table if not exists public.customer_credits (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  invoice_id uuid references public.invoices(id) on delete restrict,
  amount_dirham bigint not null,
  business_date date not null,
  reason text,
  recorded_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  approved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint customer_credits_amount_nonnegative check (amount_dirham >= 0)
);

-- 5. Expenses
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  description text not null,
  amount_dirham bigint not null,
  business_date date not null,
  recorded_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint expenses_amount_nonnegative check (amount_dirham >= 0)
);

-- 6. Attachments
create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  batch_id uuid references public.batches(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete set null,
  file_path text not null,
  file_name text not null,
  content_type text,
  byte_size bigint,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- 7. Corrections (Signed amount delta)
create table if not exists public.corrections (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  invoice_id uuid references public.invoices(id) on delete restrict,
  payment_id uuid references public.payments(id) on delete restrict,
  amount_delta_dirham bigint not null,
  reason text not null,
  business_date date not null,
  recorded_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  approved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- 8. Daily Closes
create table if not exists public.daily_closes (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  business_date date not null,
  closed_at timestamptz not null default now(),
  closed_by uuid references public.profiles(id) on delete set null,
  is_reopened boolean not null default false,
  reopened_at timestamptz,
  reopened_by uuid references public.profiles(id) on delete set null,
  reopen_reason text,
  created_at timestamptz not null default now(),
  constraint daily_closes_shop_date_uq unique (shop_id, business_date)
);

-- 9. Audit Events
create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.shops(id) on delete restrict,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  reason text,
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Append-only trigger function
create or replace function public.reject_append_only_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Table % is append-only; update and delete operations are prohibited', TG_TABLE_NAME
    using errcode = '55000';
end;
$$;

-- Append-only triggers on financial event tables
create trigger batches_append_only
  before update or delete on public.batches
  for each row execute function public.reject_append_only_mutation();

create trigger invoices_append_only
  before update or delete on public.invoices
  for each row execute function public.reject_append_only_mutation();

create trigger payments_append_only
  before update or delete on public.payments
  for each row execute function public.reject_append_only_mutation();

create trigger customer_credits_append_only
  before update or delete on public.customer_credits
  for each row execute function public.reject_append_only_mutation();

create trigger expenses_append_only
  before update or delete on public.expenses
  for each row execute function public.reject_append_only_mutation();

create trigger corrections_append_only
  before update or delete on public.corrections
  for each row execute function public.reject_append_only_mutation();

create trigger daily_closes_append_only
  before update or delete on public.daily_closes
  for each row execute function public.reject_append_only_mutation();

create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function public.reject_append_only_mutation();

-- Revoke UPDATE and DELETE on financial event tables from application roles
revoke update, delete on table
  public.batches,
  public.invoices,
  public.payments,
  public.customer_credits,
  public.expenses,
  public.corrections,
  public.daily_closes,
  public.audit_events
from anon, authenticated;
