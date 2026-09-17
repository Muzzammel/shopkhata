do $$
declare
  blank_count integer;
  blank_report text;
begin
  select count(*), string_agg(format('shop %s: invoice row %s', shop_id, id), '; ')
  into blank_count, blank_report
  from public.invoices
  where btrim(invoice_id) = '';

  if blank_count > 0 then
    raise exception 'Migration invoice_number_registry preflight failed: found % existing invoice(s) with a null-equivalent (blank-after-trim) invoice_id: %. Repair required before backfilling the registry.', blank_count, blank_report;
  end if;
end $$;

do $$
declare
  collision_count integer;
  collision_report text;
begin
  select count(*), string_agg(
    format('shop %s: %s', shop_id, invoice_ids), '; '
  )
  into collision_count, collision_report
  from (
    select shop_id, string_agg(distinct invoice_id, ', ' order by invoice_id) as invoice_ids
    from public.invoices
    group by shop_id, lower(btrim(invoice_id))
    having count(distinct invoice_id) > 1
  ) collisions;

  if collision_count > 0 then
    raise exception 'Migration invoice_number_registry preflight failed: found % same-shop invoice-number collision(s) after case/whitespace normalization: %. Resolve these before backfilling the registry.', collision_count, collision_report;
  end if;
end $$;

create table public.invoice_number_registry (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  invoice_number text not null,
  normalized_invoice_number text generated always as (lower(btrim(invoice_number))) stored,
  canonical_invoice_id uuid not null,
  created_at timestamptz not null default now(),
  constraint invoice_number_registry_invoice_number_not_blank check (btrim(invoice_number) <> ''),
  constraint invoice_number_registry_shop_id_normalized_number_uq unique (shop_id, normalized_invoice_number),
  constraint invoice_number_registry_shop_id_canonical_invoice_id_fkey
    foreign key (shop_id, canonical_invoice_id)
    references public.invoices (shop_id, id)
    on delete restrict
);

create trigger invoice_number_registry_append_only
  before update or delete on public.invoice_number_registry
  for each row execute function public.reject_append_only_mutation();

revoke update, delete on table public.invoice_number_registry from anon, authenticated;

alter table public.invoice_number_registry enable row level security;

grant select on table public.invoice_number_registry to authenticated;

create policy invoice_number_registry_select_authenticated
on public.invoice_number_registry
for select
to authenticated
using (private.has_shop_access(shop_id));

insert into public.invoice_number_registry (shop_id, invoice_number, canonical_invoice_id)
select shop_id, invoice_id, id
from public.invoices;
