-- PERF-01: ordered read paths measured against the local performance fixture.
create index idx_audit_events_shop_recorded_at
  on public.audit_events (shop_id, recorded_at desc);

create index idx_expenses_shop_recorded_at
  on public.expenses (shop_id, recorded_at desc);

create index idx_invoice_number_registry_shop_invoice_number
  on public.invoice_number_registry (shop_id, invoice_number);

create index idx_customers_shop_name_public_id
  on public.customers (shop_id, name asc nulls last, public_id);

create index idx_daily_closes_shop_recorded_at
  on public.daily_closes (shop_id, recorded_at desc);
