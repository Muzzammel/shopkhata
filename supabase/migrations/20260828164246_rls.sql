-- Task 4: trusted actor helpers and row-level access control.

create schema if not exists private;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create or replace function private.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where public.profiles.id = auth.uid()
      and public.profiles.role = 'owner'
      and public.profiles.is_active = true
  );
$$;

create or replace function private.is_active_actor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where public.profiles.id = auth.uid()
      and public.profiles.is_active = true
      and public.profiles.role in ('owner', 'manager', 'staff')
  );
$$;

create or replace function private.has_shop_access(target_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_owner()
    or (
      private.is_active_actor()
      and exists (
        select 1
        from public.user_shop_assignments
        where public.user_shop_assignments.user_id = auth.uid()
          and public.user_shop_assignments.shop_id = target_shop_id
      )
    );
$$;

revoke all on function private.is_owner() from public, anon, authenticated;
revoke all on function private.has_shop_access(uuid) from public, anon, authenticated;
revoke all on function private.is_active_actor() from public, anon, authenticated;
grant execute on function private.is_owner() to authenticated;
grant execute on function private.has_shop_access(uuid) to authenticated;
grant execute on function private.is_active_actor() to authenticated;

alter table public.shops enable row level security;
alter table public.profiles enable row level security;
alter table public.user_shop_assignments enable row level security;
alter table public.customers enable row level security;
alter table public.batches enable row level security;
alter table public.invoices enable row level security;
alter table public.payments enable row level security;
alter table public.customer_credits enable row level security;
alter table public.expenses enable row level security;
alter table public.attachments enable row level security;
alter table public.corrections enable row level security;
alter table public.daily_closes enable row level security;
alter table public.audit_events enable row level security;

grant select on table
  public.shops,
  public.profiles,
  public.user_shop_assignments,
  public.customers,
  public.batches,
  public.invoices,
  public.payments,
  public.customer_credits,
  public.expenses,
  public.attachments,
  public.corrections,
  public.daily_closes,
  public.audit_events
to authenticated;

create policy shops_select_authenticated
on public.shops
for select
to authenticated
using (private.has_shop_access(id));

create policy profiles_select_authenticated
on public.profiles
for select
to authenticated
using (id = auth.uid() or private.is_owner());

create policy assignments_select_authenticated
on public.user_shop_assignments
for select
to authenticated
using (user_id = auth.uid() or private.is_owner());

create policy customers_select_authenticated
on public.customers
for select
to authenticated
using (private.has_shop_access(shop_id));

create policy batches_select_authenticated
on public.batches
for select
to authenticated
using (private.has_shop_access(shop_id));

create policy invoices_select_authenticated
on public.invoices
for select
to authenticated
using (private.has_shop_access(shop_id));

create policy payments_select_authenticated
on public.payments
for select
to authenticated
using (private.has_shop_access(shop_id));

create policy customer_credits_select_authenticated
on public.customer_credits
for select
to authenticated
using (private.has_shop_access(shop_id));

create policy expenses_select_authenticated
on public.expenses
for select
to authenticated
using (private.has_shop_access(shop_id));

create policy attachments_select_authenticated
on public.attachments
for select
to authenticated
using (private.has_shop_access(shop_id));

create policy corrections_select_authenticated
on public.corrections
for select
to authenticated
using (private.has_shop_access(shop_id));

create policy daily_closes_select_authenticated
on public.daily_closes
for select
to authenticated
using (private.has_shop_access(shop_id));

create policy audit_events_select_authenticated
on public.audit_events
for select
to authenticated
using (
  private.is_owner()
  or (shop_id is not null and private.has_shop_access(shop_id))
);
