alter table public.batches
  add constraint batches_shop_id_id_uq unique (shop_id, id);

alter table public.customers
  add constraint customers_shop_id_id_uq unique (shop_id, id);

alter table public.invoices
  add constraint invoices_shop_id_id_uq unique (shop_id, id);

alter table public.payments
  add constraint payments_shop_id_id_uq unique (shop_id, id);

alter table public.invoices
  drop constraint invoices_batch_id_fkey,
  drop constraint invoices_customer_id_fkey,
  add constraint invoices_shop_id_batch_id_fkey
    foreign key (shop_id, batch_id)
    references public.batches (shop_id, id)
    on delete restrict,
  add constraint invoices_shop_id_customer_id_fkey
    foreign key (shop_id, customer_id)
    references public.customers (shop_id, id)
    on delete restrict;

alter table public.payments
  drop constraint payments_batch_id_fkey,
  drop constraint payments_invoice_id_fkey,
  add constraint payments_shop_id_batch_id_fkey
    foreign key (shop_id, batch_id)
    references public.batches (shop_id, id)
    on delete restrict,
  add constraint payments_shop_id_invoice_id_fkey
    foreign key (shop_id, invoice_id)
    references public.invoices (shop_id, id)
    on delete restrict;

alter table public.customer_credits
  drop constraint customer_credits_customer_id_fkey,
  drop constraint customer_credits_invoice_id_fkey,
  add constraint customer_credits_shop_id_customer_id_fkey
    foreign key (shop_id, customer_id)
    references public.customers (shop_id, id)
    on delete restrict,
  add constraint customer_credits_shop_id_invoice_id_fkey
    foreign key (shop_id, invoice_id)
    references public.invoices (shop_id, id)
    on delete restrict;

alter table public.attachments
  drop constraint attachments_batch_id_fkey,
  drop constraint attachments_invoice_id_fkey,
  add constraint attachments_shop_id_batch_id_fkey
    foreign key (shop_id, batch_id)
    references public.batches (shop_id, id)
    on delete restrict,
  add constraint attachments_shop_id_invoice_id_fkey
    foreign key (shop_id, invoice_id)
    references public.invoices (shop_id, id)
    on delete restrict;

alter table public.corrections
  drop constraint corrections_invoice_id_fkey,
  drop constraint corrections_payment_id_fkey,
  add constraint corrections_shop_id_invoice_id_fkey
    foreign key (shop_id, invoice_id)
    references public.invoices (shop_id, id)
    on delete restrict,
  add constraint corrections_shop_id_payment_id_fkey
    foreign key (shop_id, payment_id)
    references public.payments (shop_id, id)
    on delete restrict;

do $$
declare
  malformed_count integer;
begin
  select count(*)
  into malformed_count
  from public.daily_closes
  where is_reopened = true
    and (
      reopened_at is null
      or reopen_reason is null
      or btrim(reopen_reason) = ''
    );

  if malformed_count > 0 then
    raise exception 'Migration 20260902073650_phase2_security_remediation preflight failed: found % legacy daily_closes row(s) where is_reopened is true but reopened_at is null or reopen_reason is null/blank. Repair required before upgrade.', malformed_count
      using errcode = 'check_violation',
            hint = 'Inspect legacy rows with is_reopened = true and ensure reopened_at and reopen_reason are non-blank, or revert is_reopened to false if not reopened.';
  end if;
end $$;

alter table public.daily_closes
  drop constraint daily_closes_shop_date_uq;

alter table public.daily_closes
  rename column closed_at to recorded_at;

alter table public.daily_closes
  rename column closed_by to actor_id;

alter table public.daily_closes
  rename constraint daily_closes_closed_by_fkey to daily_closes_actor_id_fkey;

alter table public.daily_closes
  add column event_sequence bigint generated always as identity;

alter table public.daily_closes
  add constraint daily_closes_event_sequence_uq unique (event_sequence);

alter table public.daily_closes
  add column event_type text not null default 'closed',
  add column reason text;

insert into public.daily_closes (
  id,
  shop_id,
  business_date,
  recorded_at,
  actor_id,
  event_type,
  reason
)
select
  gen_random_uuid(),
  shop_id,
  business_date,
  reopened_at,
  reopened_by,
  'reopened',
  reopen_reason
from public.daily_closes
where is_reopened = true
order by business_date, reopened_at, id;

alter table public.daily_closes
  drop column is_reopened,
  drop column reopened_at,
  drop column reopened_by,
  drop column reopen_reason,
  add constraint daily_closes_event_type_check
    check (event_type in ('closed', 'reopened')),
  add constraint daily_closes_event_reason_check
    check (
      (event_type = 'closed' and reason is null)
      or (
        event_type = 'reopened'
        and reason is not null
        and btrim(reason) <> ''
      )
    );
