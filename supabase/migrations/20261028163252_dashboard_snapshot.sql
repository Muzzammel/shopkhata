-- PERF-04D: the Dashboard's database reads as one set-based snapshot. No result changes.
--
-- The Dashboard made about 21 concurrent reads per load. customer_financial_balances was evaluated five times
-- (due totals, largest dues, credit customers, recently active, and the other shop's due totals) and
-- effective_invoices four times for the same shop and range (sales totals and three invoice counts), so most of the
-- work per load was the same projection computed again. report_dashboard_snapshot builds each source set once:
--
--   invoice   one row per invoice of the shops in scope: effective customer, delivered flag, effective total, due
--             and last activity. The arithmetic is the one of effective_invoices / private.invoice_customer_due:
--               total    = invoice total + approved invoice corrections
--               due      = total - payments - approved corrections of those payments - credit applied to the invoice
--               customer = the invoice's own, unless an approved replacement exists; then the customer of the latest
--                          approved revision's request (which may be none); delivered follows the same rule
--             built from one grouped aggregate per table joined by (shop_id, invoice_id), as in PERF-04a.
--   balance   one row per customer: customer_financial_balances, grouped from `invoice` (all dates).
--   payment   report_payments rows in the range.     expense   effective_expenses rows in the range.
--
-- Every figure is derived from those sets with the same filter, grouping, ordering and limit as the read it replaces
-- (report_sales_totals, report_payment_totals, report_expense_totals, report_customer_due_totals, the
-- effective_invoices counts, report_top_customers_by_*, and the balances / expenses / daily_closes lists), grouped
-- by shop_id for the comparison shops instead of once per shop. report_daily_summary is called as is: it shares no
-- work with the rest. Lists that had no tie-breaker now break ties on their id, so equal keys come back in a fixed order.
--
-- SECURITY INVOKER (the default): every table and view is read under the caller's RLS, as the separate reads were.
-- The selected shop must be readable by the caller; comparison shops the caller cannot read are left out by RLS on
-- public.shops. Audit events and backups stay separate reads: they have their own permission gates. No table, view,
-- index, policy or existing function changes. Rollback: stop calling it (the old reads are unchanged), or drop it.
create function public.report_dashboard_snapshot(p_shop_id uuid, p_from date, p_to date, p_comparison_shop_ids uuid[] default '{}')
returns jsonb
language plpgsql stable
set search_path = ''
-- The range decides how much of the shop's history a plan touches (Today against Year), so never reuse a generic plan.
set plan_cache_mode = force_custom_plan
as $$
declare
  v_shops uuid[];
begin
  if auth.uid() is null or not private.is_active_actor() then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000'; end if;
  -- Same bounds as the Dashboard's date filter (parseDateRangeFilter): at most 366 days, start not after end.
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 366 then raise exception 'INVALID_DATE' using errcode = 'P0001'; end if;
  -- Readable shops only (public.shops RLS); the selected shop first, then the comparison shops in the order given.
  select coalesce(array_agg(s.id order by s.id <> p_shop_id, array_position(p_comparison_shop_ids, s.id)), '{}') into v_shops
  from public.shops s where s.id = p_shop_id or s.id = any(coalesce(p_comparison_shop_ids, '{}'));
  if p_shop_id is null or not (p_shop_id = any(v_shops)) then raise exception 'UNAUTHORIZED_SHOP' using errcode = '42501'; end if;

  return (
    with latest_replacement as (
      select distinct on (d.shop_id, d.invoice_id) d.shop_id, d.invoice_id, d.request_id
      from public.replacement_decisions d
      where d.shop_id = any(v_shops) and d.decision = 'approved'
      order by d.shop_id, d.invoice_id, d.revision desc
    ), invoice as materialized (
      select i.shop_id, i.id as invoice_id, i.business_date,
        case when l.invoice_id is null then i.customer_id else r.customer_id end as customer_id,
        case when l.invoice_id is null then i.delivered else r.delivered end as delivered,
        (i.total_amount_dirham + coalesce(inv_corr.delta_dirham, 0))::bigint as total_dirham,
        (i.total_amount_dirham + coalesce(inv_corr.delta_dirham, 0) - coalesce(paid.amount_dirham, 0)
          - coalesce(pay_corr.delta_dirham, 0) - coalesce(applied.amount_dirham, 0))::bigint as due_dirham,
        greatest(i.business_date, i.recorded_at::date, paid.activity_date, inv_corr.activity_date, pay_corr.activity_date, applied.activity_date) as last_activity_date
      from public.invoices i
      left join latest_replacement l on l.shop_id = i.shop_id and l.invoice_id = i.id
      left join public.replacement_requests r on r.shop_id = l.shop_id and r.id = l.request_id
      left join (
        select p.shop_id, p.invoice_id, sum(p.amount_dirham) as amount_dirham, max(greatest(p.business_date, p.recorded_at::date)) as activity_date
        from public.payments p where p.shop_id = any(v_shops)
        group by p.shop_id, p.invoice_id
      ) paid on paid.shop_id = i.shop_id and paid.invoice_id = i.id
      left join (
        select c.shop_id, c.invoice_id, sum(c.amount_delta_dirham) as delta_dirham, max(greatest(c.business_date, c.recorded_at::date)) as activity_date
        from public.corrections c where c.shop_id = any(v_shops) and c.approved_by is not null and c.invoice_id is not null
        group by c.shop_id, c.invoice_id
      ) inv_corr on inv_corr.shop_id = i.shop_id and inv_corr.invoice_id = i.id
      left join (
        select p.shop_id, p.invoice_id, sum(c.amount_delta_dirham) as delta_dirham,
          max(case when c.invoice_id is null then greatest(c.business_date, c.recorded_at::date) end) as activity_date
        from public.corrections c join public.payments p on p.shop_id = c.shop_id and p.id = c.payment_id
        where c.shop_id = any(v_shops) and c.approved_by is not null
        group by p.shop_id, p.invoice_id
      ) pay_corr on pay_corr.shop_id = i.shop_id and pay_corr.invoice_id = i.id
      left join (
        select ca.shop_id, ca.invoice_id, sum(ca.amount_dirham) as amount_dirham, max(greatest(ca.business_date, ca.recorded_at::date)) as activity_date
        from public.credit_applications ca where ca.shop_id = any(v_shops)
        group by ca.shop_id, ca.invoice_id
      ) applied on applied.shop_id = i.shop_id and applied.invoice_id = i.id
      where i.shop_id = any(v_shops)
    ), balance as materialized (
      select c.shop_id, c.id as customer_id, c.public_id, c.name, c.mobile,
        coalesce(t.due_dirham, 0)::bigint as outstanding_due_dirham,
        coalesce(cr.amount_dirham, 0)::bigint - coalesce(ap.amount_dirham, 0)::bigint as available_credit_dirham,
        coalesce(t.invoice_count, 0)::bigint as invoice_count, t.last_activity_date
      from public.customers c
      left join (
        select e.shop_id, e.customer_id, sum(e.due_dirham) as due_dirham, count(*) as invoice_count, max(e.last_activity_date) as last_activity_date
        from invoice e where e.customer_id is not null
        group by e.shop_id, e.customer_id
      ) t on t.shop_id = c.shop_id and t.customer_id = c.id
      left join (
        select cc.shop_id, cc.customer_id, sum(cc.amount_dirham) as amount_dirham
        from public.customer_credits cc where cc.shop_id = any(v_shops) and cc.approved_by is not null
        group by cc.shop_id, cc.customer_id
      ) cr on cr.shop_id = c.shop_id and cr.customer_id = c.id
      left join (
        select ca.shop_id, ca.customer_id, sum(ca.amount_dirham) as amount_dirham
        from public.credit_applications ca where ca.shop_id = any(v_shops)
        group by ca.shop_id, ca.customer_id
      ) ap on ap.shop_id = c.shop_id and ap.customer_id = c.id
      where c.shop_id = any(v_shops)
    ), payment as materialized (
      select r.shop_id, r.source, r.method, r.amount_dirham, r.invoice_id
      from public.report_payments r where r.shop_id = any(v_shops) and r.business_date between p_from and p_to
    ), expense as materialized (
      select x.shop_id, x.id, x.business_date, x.recorded_at, x.category, x.description, x.amount_dirham
      from public.effective_expenses x where x.shop_id = any(v_shops) and x.business_date between p_from and p_to
    ), scope as (
      select s.shop_id, s.ord from unnest(v_shops) with ordinality s(shop_id, ord)
    ), sales as (
      -- report_sales_totals, plus the fully paid / with due / no customer invoice counts.
      select s.shop_id, jsonb_build_object(
        'invoice_count', count(e.invoice_id), 'effective_total_dirham', coalesce(sum(e.total_dirham), 0)::bigint,
        'effective_due_dirham', coalesce(sum(e.due_dirham), 0)::bigint,
        'delivered_count', count(*) filter (where e.delivered), 'undelivered_count', count(*) filter (where not e.delivered),
        'fully_paid_count', count(*) filter (where e.due_dirham <= 0), 'with_due_count', count(*) filter (where e.due_dirham > 0),
        'anonymous_count', count(*) filter (where e.invoice_id is not null and e.customer_id is null)) as totals
      from scope s left join invoice e on e.shop_id = s.shop_id and e.business_date between p_from and p_to
      group by s.shop_id
    ), due as (
      -- report_customer_due_totals (the unassigned part is not shown on the Dashboard).
      select s.shop_id, jsonb_build_object(
        'customers_with_due', count(*) filter (where b.outstanding_due_dirham > 0),
        'outstanding_due_dirham', coalesce(sum(b.outstanding_due_dirham), 0)::bigint,
        'available_credit_dirham', coalesce(sum(b.available_credit_dirham), 0)::bigint) as totals
      from scope s left join balance b on b.shop_id = s.shop_id
      group by s.shop_id
    ), payment_totals as (
      -- report_payment_totals rows: source/method null = subtotal; both null = grand total.
      select g.shop_id, jsonb_agg(jsonb_build_object('source', g.source, 'method', g.method, 'entry_count', g.entry_count, 'amount_dirham', g.amount_dirham)
        order by g.source nulls last, g.method nulls last) as rows
      from (
        select r.shop_id, r.source, r.method, count(*) as entry_count, coalesce(sum(r.amount_dirham), 0)::bigint as amount_dirham
        from payment r group by grouping sets ((r.shop_id, r.source, r.method), (r.shop_id, r.method), (r.shop_id))
      ) g group by g.shop_id
    ), expense_totals as (
      -- report_expense_totals rows: category null = total.
      select g.shop_id, jsonb_agg(jsonb_build_object('category', g.category, 'expense_count', g.expense_count, 'amount_dirham', g.amount_dirham)
        order by g.category nulls last) as rows
      from (
        select x.shop_id, x.category, count(*) as expense_count, coalesce(sum(x.amount_dirham), 0)::bigint as amount_dirham
        from expense x group by grouping sets ((x.shop_id, x.category), (x.shop_id))
      ) g group by g.shop_id
    )
    select jsonb_build_object(
      'shops', (
        select jsonb_agg(jsonb_build_object('shop_id', s.shop_id, 'sales', sa.totals, 'due', du.totals,
          'payment_totals', coalesce(pt.rows, '[]'), 'expense_totals', coalesce(et.rows, '[]')) order by s.ord)
        from scope s join sales sa on sa.shop_id = s.shop_id join due du on du.shop_id = s.shop_id
        left join payment_totals pt on pt.shop_id = s.shop_id left join expense_totals et on et.shop_id = s.shop_id
      ),
      'daily', (
        select coalesce(jsonb_agg(to_jsonb(d) order by d.business_date), '[]') from public.report_daily_summary(p_shop_id, p_from, p_to) d
      ),
      'largest_dues', (
        select coalesce(jsonb_agg(to_jsonb(x) order by x.outstanding_due_dirham desc, x.customer_id), '[]') from (
          select b.customer_id, b.public_id, b.name, b.mobile, b.outstanding_due_dirham, b.available_credit_dirham, b.invoice_count, b.last_activity_date
          from balance b where b.shop_id = p_shop_id and (b.outstanding_due_dirham > 0 or b.available_credit_dirham > 0)
          order by b.outstanding_due_dirham desc, b.customer_id limit 5
        ) x
      ),
      'credit_customers', (
        select coalesce(jsonb_agg(to_jsonb(x) order by x.available_credit_dirham desc, x.customer_id), '[]') from (
          select b.customer_id, b.public_id, b.name, b.available_credit_dirham
          from balance b where b.shop_id = p_shop_id and b.available_credit_dirham > 0
          order by b.available_credit_dirham desc, b.customer_id limit 5
        ) x
      ),
      'recently_active', (
        select coalesce(jsonb_agg(to_jsonb(x) order by x.last_activity_date desc, x.customer_id), '[]') from (
          select b.customer_id, b.public_id, b.name, b.last_activity_date
          from balance b where b.shop_id = p_shop_id and b.last_activity_date is not null
          order by b.last_activity_date desc, b.customer_id limit 5
        ) x
      ),
      'top_by_sales', (
        -- report_top_customers_by_sales: effective totals of the period's invoices by effective customer.
        select coalesce(jsonb_agg(to_jsonb(x) order by x.amount_dirham desc, x.customer_id), '[]') from (
          select b.customer_id, coalesce(b.name, b.public_id) as name, t.amount_dirham
          from (
            select e.customer_id, sum(e.total_dirham)::bigint as amount_dirham from invoice e
            where e.shop_id = p_shop_id and e.business_date between p_from and p_to and e.customer_id is not null
            group by e.customer_id
          ) t join balance b on b.shop_id = p_shop_id and b.customer_id = t.customer_id
          order by t.amount_dirham desc, b.customer_id limit 5
        ) x
      ),
      'top_by_payments', (
        -- report_top_customers_by_payments: the period's report_payments rows by the invoice's effective customer.
        select coalesce(jsonb_agg(to_jsonb(x) order by x.amount_dirham desc, x.customer_id), '[]') from (
          select b.customer_id, coalesce(b.name, b.public_id) as name, t.amount_dirham
          from (
            select e.customer_id, sum(r.amount_dirham)::bigint as amount_dirham
            from payment r join invoice e on e.shop_id = r.shop_id and e.invoice_id = r.invoice_id
            where r.shop_id = p_shop_id and e.customer_id is not null
            group by e.customer_id
          ) t join balance b on b.shop_id = p_shop_id and b.customer_id = t.customer_id
          order by t.amount_dirham desc, b.customer_id limit 5
        ) x
      ),
      'recent_expenses', (
        select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at desc, x.id), '[]') from (
          select x.id, x.business_date, x.recorded_at, x.category, x.description, x.amount_dirham
          from public.effective_expenses x where x.shop_id = p_shop_id
          order by x.recorded_at desc, x.id limit 8
        ) x
      ),
      'largest_expenses', (
        select coalesce(jsonb_agg(to_jsonb(x) order by x.amount_dirham desc, x.id), '[]') from (
          select x.id, x.business_date, x.recorded_at, x.category, x.description, x.amount_dirham
          from expense x where x.shop_id = p_shop_id
          order by x.amount_dirham desc, x.id limit 5
        ) x
      ),
      'closes', (
        -- The actor's name is read under profiles RLS, exactly as the separate lookup was (null when not visible).
        select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at desc, x.event_sequence desc), '[]') from (
          select dc.event_sequence, dc.event_type, dc.actor_id, dc.recorded_at, dc.reason, dc.note, dc.business_date, pr.display_name as actor_name
          from (
            select * from public.daily_closes d where d.shop_id = p_shop_id order by d.recorded_at desc, d.event_sequence desc limit 10
          ) dc left join public.profiles pr on pr.id = dc.actor_id
        ) x
      )
    )
  );
end
$$;

comment on function public.report_dashboard_snapshot(uuid, date, date, uuid[]) is
  'Dashboard snapshot (PERF-04D): sales/payment/expense/due totals per readable shop, daily summary, customer and expense lists, recent closes. SECURITY INVOKER; same figures as the report_* reads it replaces.';

revoke all on function public.report_dashboard_snapshot(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.report_dashboard_snapshot(uuid, date, date, uuid[]) to authenticated;
