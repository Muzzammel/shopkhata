-- BIG SLICE 6 FOLLOW-UP: the Dashboard's top-customer ranking was computed in
-- React from a capped select (3,000 rows), which silently drops customers
-- once a period's qualifying rows exceed the cap. Aggregate by customer in
-- the database instead and return only the requested top N rows, consistent
-- with the other report_* projections.

-- Same effective (corrected) total per invoice that report_sales_totals sums,
-- grouped by customer instead of summed over the whole shop.
create function public.report_top_customers_by_sales(p_shop_id uuid, p_from date, p_to date, p_limit int default 5)
returns table(customer_id uuid, name text, amount_dirham bigint)
language sql stable set search_path = '' as $$
  select c.id, coalesce(c.name, c.public_id), t.amount_dirham
  from (
    select e.effective_customer_id cid, sum(e.effective_total_dirham)::bigint amount_dirham
    from public.effective_invoices e
    where e.shop_id = p_shop_id and e.business_date between p_from and p_to and e.effective_customer_id is not null
    group by e.effective_customer_id
  ) t
  join public.customers c on c.shop_id = p_shop_id and c.id = t.cid
  order by t.amount_dirham desc, c.id
  limit greatest(p_limit, 0)
$$;

-- Same report_payments rows (follow-up, invoice-entry, customer payment,
-- payment correction, overpayment credit, credit application) that
-- report_payment_totals sums, joined to the invoice's current customer and
-- grouped by customer.
create function public.report_top_customers_by_payments(p_shop_id uuid, p_from date, p_to date, p_limit int default 5)
returns table(customer_id uuid, name text, amount_dirham bigint)
language sql stable set search_path = '' as $$
  select c.id, coalesce(c.name, c.public_id), t.amount_dirham
  from (
    select e.effective_customer_id cid, sum(r.amount_dirham)::bigint amount_dirham
    from public.report_payments r
    join public.effective_invoices e on e.shop_id = r.shop_id and e.canonical_invoice_id = r.invoice_id
    where r.shop_id = p_shop_id and r.business_date between p_from and p_to and e.effective_customer_id is not null
    group by e.effective_customer_id
  ) t
  join public.customers c on c.shop_id = p_shop_id and c.id = t.cid
  order by t.amount_dirham desc, c.id
  limit greatest(p_limit, 0)
$$;

revoke all on function public.report_top_customers_by_sales(uuid, date, date, int),
  public.report_top_customers_by_payments(uuid, date, date, int) from public, anon;
grant execute on function public.report_top_customers_by_sales(uuid, date, date, int),
  public.report_top_customers_by_payments(uuid, date, date, int) to authenticated;
