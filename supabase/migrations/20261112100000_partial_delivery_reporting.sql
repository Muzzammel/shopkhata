-- Partial delivery, step 4: reporting reads three delivery states.
--
-- Additive only; money is untouched.
--   1. effective_invoices gains three trailing columns (existing columns, order and formulas unchanged):
--        ordered_pieces, delivered_pieces  NULL for legacy invoices (no piece counts are invented);
--        delivery_status                   'none' | 'partial' | 'full'. Tracked: from the delivery ledger, exactly as
--                                          invoice_delivery_totals. Legacy: the existing yes/no flag as 'full'/'none',
--                                          so legacy invoices keep their Delivered / Not delivered behaviour.
--      effective_delivered keeps its step-1 meaning ("any piece delivered"); the customer rule and the correction
--      RPCs depend on it. Reports read delivery_status instead, so a partial invoice is never counted as delivered.
--      The piece sum is taken once per row in a lateral that legacy rows skip (one-time filter on ordered_pieces).
--   2. report_sales_totals: delivered_count = 'full', undelivered_count = 'none', new trailing partially_delivered_count.
--      Same body, search_path and grants otherwise. Adding an OUT column changes the return type: drop + create in this
--      one transaction. An application built before this step reads delivered + undelivered < invoice_count when partial
--      invoices exist; it cannot create tracked invoices, so that only arises once this step's app is live.

create or replace view public.effective_invoices with(security_invoker=true) as
select i.id as canonical_invoice_id, i.shop_id, i.invoice_id as original_invoice_number,
 coalesce(r.invoice_number,i.invoice_id) as effective_invoice_number,
 case when d.id is null then i.customer_id else r.customer_id end as effective_customer_id,
 case when i.ordered_pieces is not null then dp.pieces > 0
  when d.id is null then i.delivered else r.delivered end as effective_delivered,
 coalesce(d.revision,0) as revision,i.total_amount_dirham as original_total_dirham,i.business_date,i.recorded_at,i.created_by,
 b.effective_total_dirham,b.effective_paid_dirham,b.effective_due_dirham,coalesce(ca.amount_dirham,0)::bigint effective_credit_applied_dirham,
 exists(select 1 from public.invoice_voids v where v.shop_id=i.shop_id and v.invoice_id=i.id) as is_void,
 i.ordered_pieces, dp.pieces as delivered_pieces,
 case when i.ordered_pieces is null then case when (case when d.id is null then i.delivered else r.delivered end) then 'full' else 'none' end
  when dp.pieces = 0 then 'none' when dp.pieces < i.ordered_pieces then 'partial' else 'full' end as delivery_status
from public.invoices i join public.invoice_effective_balances b on b.canonical_invoice_id=i.id and b.shop_id=i.shop_id
left join lateral(select rd.* from public.replacement_decisions rd where rd.invoice_id=i.id and rd.shop_id=i.shop_id and rd.decision='approved' order by rd.revision desc limit 1)d on true
left join public.replacement_requests r on r.id=d.request_id and r.shop_id=i.shop_id
left join lateral(select sum(a.amount_dirham) amount_dirham from public.credit_applications a where a.shop_id=i.shop_id and a.invoice_id=i.id)ca on true
-- NULL for legacy rows; the outer-reference filter means their delivery ledger is never scanned.
left join lateral(select coalesce(sum(x.pieces),0)::integer pieces from public.invoice_deliveries x
  where i.ordered_pieces is not null and x.shop_id=i.shop_id and x.invoice_id=i.id)dp on i.ordered_pieces is not null;

drop function public.report_sales_totals(uuid, date, date);
create function public.report_sales_totals(p_shop_id uuid, p_from date, p_to date)
returns table(invoice_count bigint, gross_sales_dirham bigint, sales_corrections_dirham bigint, net_sales_dirham bigint,
  effective_paid_dirham bigint, credit_applied_dirham bigint, effective_due_dirham bigint, delivered_count bigint, undelivered_count bigint,
  effective_total_dirham bigint, partially_delivered_count bigint)
language sql stable set search_path = '' as $$
  with m as (
    select coalesce(sum(s.amount_dirham) filter (where s.movement_type = 'sale'), 0)::bigint gross,
      coalesce(sum(s.amount_dirham) filter (where s.movement_type <> 'sale'), 0)::bigint corrections
    from public.sales_movements s where s.shop_id = p_shop_id and s.business_date between p_from and p_to
  ), e as (
    select count(*) n, coalesce(sum(e.effective_paid_dirham), 0)::bigint paid, coalesce(sum(e.effective_credit_applied_dirham), 0)::bigint credit,
      coalesce(sum(e.effective_due_dirham), 0)::bigint due, count(*) filter (where e.delivery_status = 'full') delivered,
      count(*) filter (where e.delivery_status = 'none') undelivered, count(*) filter (where e.delivery_status = 'partial') partial
    from public.effective_invoices e where e.shop_id = p_shop_id and e.business_date between p_from and p_to
  )
  select e.n, m.gross, m.corrections, m.gross + m.corrections, e.paid, e.credit, e.due, e.delivered, e.undelivered,
    m.gross + m.corrections, e.partial from m, e
$$;
revoke all on function public.report_sales_totals(uuid, date, date) from public, anon;
grant execute on function public.report_sales_totals(uuid, date, date) to authenticated;
comment on function public.report_sales_totals(uuid, date, date) is
  'effective_total_dirham is a deprecated release-compatibility alias of net_sales_dirham for applications built before OPS-01B; drop it in a later contract migration. delivered_count counts fully delivered invoices only (legacy: delivered flag); partially_delivered_count counts piece-tracked invoices with some but not all pieces delivered.';
