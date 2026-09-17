do $$
declare
  invalid_totals integer;
begin
  select count(*) into invalid_totals
  from public.invoices
  where total_amount_dirham <= 0;

  if invalid_totals > 0 then
    raise exception 'Migration invoice_delivered_flag_and_note preflight failed: found % existing invoice(s) with total_amount_dirham <= 0. Repair required before tightening the constraint.', invalid_totals
      using errcode = 'check_violation';
  end if;
end $$;

alter table public.invoices
  add column delivered boolean not null default false,
  add column note text;

alter table public.invoices
  drop constraint invoices_total_amount_nonnegative,
  add constraint invoices_total_amount_positive check (total_amount_dirham > 0);
