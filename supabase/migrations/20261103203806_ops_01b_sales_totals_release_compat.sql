-- OPS-01B slice 1: release compatibility for report_sales_totals (expand step).
--
-- 20261103190000 replaced effective_total_dirham with gross/corrections/net. The application released before OPS-01B
-- (e4f4cfe) still reads effective_total_dirham for the Dashboard sales KPI, the shop comparison, the average invoice and
-- the Sales report total; without it those read undefined and the Sales report throws REPORT_AMOUNT_INVALID. Production
-- applies migrations before promoting the application, so both versions must work against this contract.
--
-- effective_total_dirham comes back as an alias of net_sales_dirham (business-date gross + approved invoice corrections),
-- NOT the old "current effective total of the invoices dated in the range". The two are identical unless a correction is
-- dated outside its invoice's range, and there the old definition is the historical-sales defect the owner ruled out
-- (a void or correction would rewrite the original day). The old app therefore shows the same sales figure as the new
-- app and as Daily Close. Every other column is unchanged.
--
-- Contract step (later, once no deployed application reads it): drop effective_total_dirham.
-- Adding an OUT column changes the return type, so the function is dropped and recreated in this one transaction with the
-- same body, the same search_path and the same grants (authenticated only; public and anon revoked).

drop function public.report_sales_totals(uuid, date, date);
create function public.report_sales_totals(p_shop_id uuid, p_from date, p_to date)
returns table(invoice_count bigint, gross_sales_dirham bigint, sales_corrections_dirham bigint, net_sales_dirham bigint,
  effective_paid_dirham bigint, credit_applied_dirham bigint, effective_due_dirham bigint, delivered_count bigint, undelivered_count bigint,
  effective_total_dirham bigint)
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
  select e.n, m.gross, m.corrections, m.gross + m.corrections, e.paid, e.credit, e.due, e.delivered, e.undelivered,
    m.gross + m.corrections from m, e
$$;
revoke all on function public.report_sales_totals(uuid, date, date) from public, anon;
grant execute on function public.report_sales_totals(uuid, date, date) to authenticated;
comment on function public.report_sales_totals(uuid, date, date) is
  'effective_total_dirham is a deprecated release-compatibility alias of net_sales_dirham for applications built before OPS-01B; drop it in a later contract migration.';
