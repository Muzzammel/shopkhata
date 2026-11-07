-- OPS-01B slice 1 remediation: historical business-date reporting across invoice voids, plus review findings m2/m3/O.
--
-- Owner ruling: historical business-date reporting is immutable. An invoice recorded on D1 for 100 and voided on D2
-- reports +100 sales on D1 and -100 invoice correction on D2; the range D1..D2 nets to 0. The void never rewrites D1.
--
-- Two read concepts, kept apart:
--   CURRENT EFFECTIVE STATE   effective_invoices / invoice_effective_balances / customer_financial_balances: what an
--                             invoice or customer stands at now (a voided invoice: VOID, effective total 0).
--   BUSINESS-DATE MOVEMENTS   report_daily_summary (Daily Close), customer_ledger and, from here, sales_movements: what
--                             happened ON each business date. Original invoice totals on the invoice's date, approved
--                             invoice-total corrections (a void included) on the correction's own date.
-- Date-range sales totals now read movements, with the same source rows and predicates as Daily Close's
-- gross_invoice_dirham + invoice_corrections_dirham, so the two reconcile exactly. This applies to every approved
-- invoice-total correction, not only voids: before this, a correction dated D2 silently restated D1's sales.

-- 1. Business-date sales movements ------------------------------------------------------------------------------
create view public.sales_movements with (security_invoker = true) as
select i.shop_id, i.business_date, i.recorded_at, i.id as movement_id, i.id as invoice_id, 'sale'::text as movement_type,
  i.total_amount_dirham::bigint as amount_dirham
from public.invoices i
union all
select c.shop_id, c.business_date, c.recorded_at, c.id, c.invoice_id,
  case when exists (select 1 from public.invoice_voids v where v.shop_id = c.shop_id and v.correction_id = c.id) then 'invoice_void' else 'invoice_correction' end,
  c.amount_delta_dirham
from public.corrections c
where c.invoice_id is not null and c.approved_by is not null;
revoke all on public.sales_movements from public, anon;
grant select on public.sales_movements to authenticated;

-- 2. report_sales_totals: movement sales + the current state of the invoices dated in the range -----------------
-- The return shape changes (effective_total_dirham is replaced by gross/corrections/net), so it is dropped and
-- recreated with the same grants. Paid, credit applied, due and delivery remain the CURRENT state of the invoices whose
-- business date is in the range; they are labelled as such wherever shown.
drop function public.report_sales_totals(uuid, date, date);
create function public.report_sales_totals(p_shop_id uuid, p_from date, p_to date)
returns table(invoice_count bigint, gross_sales_dirham bigint, sales_corrections_dirham bigint, net_sales_dirham bigint,
  effective_paid_dirham bigint, credit_applied_dirham bigint, effective_due_dirham bigint, delivered_count bigint, undelivered_count bigint)
language sql stable set search_path = '' as $$
  with m as (
    select coalesce(sum(s.amount_dirham) filter (where s.movement_type = 'sale'), 0)::bigint gross,
      coalesce(sum(s.amount_dirham) filter (where s.movement_type <> 'sale'), 0)::bigint corrections
    from public.sales_movements s where s.shop_id = p_shop_id and s.business_date between p_from and p_to
  ), e as (
    select count(*) n, coalesce(sum(e.effective_paid_dirham), 0)::bigint paid, coalesce(sum(e.effective_credit_applied_dirham), 0)::bigint credit,
      coalesce(sum(e.effective_due_dirham), 0)::bigint due, count(*) filter (where e.effective_delivered) delivered,
      count(*) filter (where not e.effective_delivered) undelivered
    from public.effective_invoices e where e.shop_id = p_shop_id and e.business_date between p_from and p_to
  )
  select e.n, m.gross, m.corrections, m.gross + m.corrections, e.paid, e.credit, e.due, e.delivered, e.undelivered from m, e
$$;
revoke all on function public.report_sales_totals(uuid, date, date) from public, anon;
grant execute on function public.report_sales_totals(uuid, date, date) to authenticated;

-- 3. Top customers by sales: the same movements, attributed to the invoice's current (effective) customer ----------
create or replace function public.report_top_customers_by_sales(p_shop_id uuid, p_from date, p_to date, p_limit int default 5)
returns table(customer_id uuid, name text, amount_dirham bigint)
language sql stable set search_path = '' as $$
  select c.id, coalesce(c.name, c.public_id), t.amount_dirham
  from (
    select e.effective_customer_id cid, sum(s.amount_dirham)::bigint amount_dirham
    from public.sales_movements s join public.effective_invoices e on e.shop_id = s.shop_id and e.canonical_invoice_id = s.invoice_id
    where s.shop_id = p_shop_id and s.business_date between p_from and p_to and e.effective_customer_id is not null
    group by e.effective_customer_id
    having sum(s.amount_dirham) > 0
  ) t
  join public.customers c on c.shop_id = p_shop_id and c.id = t.cid
  order by t.amount_dirham desc, c.id
  limit greatest(p_limit, 0)
$$;

-- 4. Finding O: report_dashboard_snapshot -----------------------------------------------------------------------
-- PERF-04D was closed (gate FAIL) and the app never calls this RPC. It still reports current-state effective totals
-- for a date range and counts voided invoices as fully paid. Rather than keep a misleading, unused Data API surface,
-- it is dropped; its own header names dropping as the rollback. Nothing reads it.
drop function public.report_dashboard_snapshot(uuid, date, date, uuid[]);

-- 5. Finding m2: the void marker's correction must belong to the same shop AND the same invoice ------------------
alter table public.corrections add constraint corrections_shop_invoice_id_uq unique (shop_id, invoice_id, id);
alter table public.invoice_voids
  drop constraint invoice_voids_correction_id_fkey,
  add constraint invoice_voids_correction_fkey foreign key (shop_id, invoice_id, correction_id)
    references public.corrections (shop_id, invoice_id, id) on delete restrict;

-- 6. Finding m3: check BOTH invoice relationships of a row independently -----------------------------------------
-- A corrections row may name an invoice_id and a payment_id at once. Each named invoice is locked and checked, so the
-- choice of target cannot route a write past the guard.
create or replace function private.enforce_invoice_not_void() returns trigger
language plpgsql set search_path = '' as $$
declare r jsonb := to_jsonb(new); ids uuid[];
begin
  if r ? 'decision' and r ->> 'decision' <> 'approved' then return new; end if;
  ids := array_remove(array[(r ->> 'invoice_id')::uuid,
    (select p.invoice_id from public.payments p where p.shop_id = new.shop_id and p.id = (r ->> 'payment_id')::uuid)], null);
  if cardinality(ids) = 0 then return new; end if;
  perform 1 from public.invoices i where i.shop_id = new.shop_id and i.id = any (ids) order by i.id for share;
  if exists (select 1 from public.invoice_voids v where v.invoice_id = any (ids)) then
    raise exception 'INVOICE_VOID' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function private.enforce_invoice_not_void() from public, anon, authenticated;
