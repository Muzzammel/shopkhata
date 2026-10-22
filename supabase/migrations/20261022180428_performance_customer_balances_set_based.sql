-- PERF-04a: customer balances as one set-based pass per shop. No result changes.
--
-- customer_financial_balances (and through it report_customer_due_totals) read every invoice through
-- effective_invoices, which evaluates about six correlated subqueries per invoice (invoice_effective_balances
-- plus the latest approved replacement and the credit applied), and then read the whole customer_ledger union
-- again for the last activity date. The effective customer of an invoice is a computed value, so no index can
-- serve a customer filter either: every read cost a scan of the shop's whole history, 0.2 to 1.1 s at 25k
-- invoices, and the dashboard evaluates it several times per load.
--
-- The same figures are now built from one grouped aggregate per table, joined by (shop_id, invoice_id):
--
--   private.invoice_customer_due   one row per invoice: its effective customer, its due and its last activity;
--                                  the single definition of the balance arithmetic.
--   customer_financial_balances    groups those rows by customer and adds the customer's approved credit.
--   report_customer_due_totals     reads the same two objects; the unassigned part is the invoices with no customer.
--
-- The aggregates are grouped by shop_id, so a shop_id filter reaches them and the cost follows that shop's history,
-- never the whole database. A UNION of per-movement lines joined to the invoice looked faster for a single
-- customer, but its plan depended on row estimates (corrections are only indexed by a partial index) and re-scanned
-- whole tables per invoice when the estimate was low, so it was rejected.
--
-- Arithmetic, unchanged from invoice_effective_balances / effective_invoices / customer_ledger:
--   due of an invoice = total + approved invoice corrections
--                       - payments - approved corrections of those payments (a negative delta lowers what was paid)
--                       - credit applied to the invoice
--   effective customer = the invoice's own customer, unless an approved replacement exists; then the customer of
--                       the latest approved revision's request (which may be none)
--   last activity     = latest of greatest(business_date, recorded_at::date) over the invoice, its payments, its
--                       approved corrections and the credit applied to it
--   available credit  = approved customer_credits - all credit_applications of the customer (not by invoice)
-- Pending, rejected and unapproved rows never count. Customers without invoices still get a row.
--
-- Both views stay security_invoker, so every base table is still read under the caller's RLS. No table, index,
-- policy or grant of an existing object changes; CREATE OR REPLACE keeps owner and ACL. Rollback is the
-- previous definitions of the two replaced objects plus dropping the helper view (see the PERF-04a review package).

-- One row per invoice. Its movements are summed per invoice before the join, so each table is read once.
-- A correction counts for the due against its invoice_id and, separately, against its payment's invoice, as the
-- old views did; for the last activity it counts against its invoice_id, or against its payment's invoice when it
-- has no invoice_id. (No CHECK forbids a correction naming both an invoice and a payment, so both paths are kept.)
create view private.invoice_customer_due with (security_invoker = true) as
with invoice_customer as (
  -- Invoices with no approved replacement keep their own customer.
  select i.shop_id, i.id as invoice_id, i.customer_id, i.total_amount_dirham, i.business_date, i.recorded_at
  from public.invoices i
  where not exists (
    select 1 from public.replacement_decisions d
    where d.shop_id = i.shop_id and d.invoice_id = i.id and d.decision = 'approved')
  union all
  -- Invoices with an approved replacement take the customer of its latest revision (UNIQUE shop, invoice, revision).
  select i.shop_id, i.id, r.customer_id, i.total_amount_dirham, i.business_date, i.recorded_at
  from (
    select distinct on (d.shop_id, d.invoice_id) d.shop_id, d.invoice_id, d.request_id
    from public.replacement_decisions d
    where d.decision = 'approved'
    order by d.shop_id, d.invoice_id, d.revision desc
  ) l
  join public.invoices i on i.shop_id = l.shop_id and i.id = l.invoice_id
  left join public.replacement_requests r on r.shop_id = l.shop_id and r.id = l.request_id
)
select ic.shop_id, ic.invoice_id, ic.customer_id,
  (ic.total_amount_dirham + coalesce(inv_corr.delta_dirham, 0) - coalesce(paid.amount_dirham, 0)
    - coalesce(pay_corr.delta_dirham, 0) - coalesce(applied.amount_dirham, 0))::bigint as due_dirham,
  greatest(ic.business_date, ic.recorded_at::date, paid.activity_date, inv_corr.activity_date, pay_corr.activity_date, applied.activity_date) as last_activity_date
from invoice_customer ic
left join (
  select p.shop_id, p.invoice_id, sum(p.amount_dirham) as amount_dirham,
    max(greatest(p.business_date, p.recorded_at::date)) as activity_date
  from public.payments p
  group by p.shop_id, p.invoice_id
) paid on paid.shop_id = ic.shop_id and paid.invoice_id = ic.invoice_id
left join (
  select c.shop_id, c.invoice_id, sum(c.amount_delta_dirham) as delta_dirham,
    max(greatest(c.business_date, c.recorded_at::date)) as activity_date
  from public.corrections c
  where c.approved_by is not null and c.invoice_id is not null
  group by c.shop_id, c.invoice_id
) inv_corr on inv_corr.shop_id = ic.shop_id and inv_corr.invoice_id = ic.invoice_id
left join (
  select p.shop_id, p.invoice_id, sum(c.amount_delta_dirham) as delta_dirham,
    max(case when c.invoice_id is null then greatest(c.business_date, c.recorded_at::date) end) as activity_date
  from public.corrections c
  join public.payments p on p.shop_id = c.shop_id and p.id = c.payment_id
  where c.approved_by is not null
  group by p.shop_id, p.invoice_id
) pay_corr on pay_corr.shop_id = ic.shop_id and pay_corr.invoice_id = ic.invoice_id
left join (
  select ca.shop_id, ca.invoice_id, sum(ca.amount_dirham) as amount_dirham,
    max(greatest(ca.business_date, ca.recorded_at::date)) as activity_date
  from public.credit_applications ca
  group by ca.shop_id, ca.invoice_id
) applied on applied.shop_id = ic.shop_id and applied.invoice_id = ic.invoice_id;

revoke all on private.invoice_customer_due from public, anon;
grant select on private.invoice_customer_due to authenticated;

-- Same columns, types and meaning as before.
create or replace view public.customer_financial_balances with (security_invoker = true) as
select c.shop_id, c.id as customer_id,
  coalesce(t.due_dirham, 0)::bigint as outstanding_due_dirham,
  coalesce(cr.amount_dirham, 0)::bigint - coalesce(ap.amount_dirham, 0)::bigint as available_credit_dirham,
  coalesce(t.invoice_count, 0)::bigint as invoice_count,
  t.last_activity_date
from public.customers c
left join (
  select d.shop_id, d.customer_id, sum(d.due_dirham) as due_dirham, count(*) as invoice_count,
    max(d.last_activity_date) as last_activity_date
  from private.invoice_customer_due d
  where d.customer_id is not null
  group by d.shop_id, d.customer_id
) t on t.shop_id = c.shop_id and t.customer_id = c.id
left join (
  select cc.shop_id, cc.customer_id, sum(cc.amount_dirham) as amount_dirham
  from public.customer_credits cc
  where cc.approved_by is not null
  group by cc.shop_id, cc.customer_id
) cr on cr.shop_id = c.shop_id and cr.customer_id = c.id
left join (
  select ca.shop_id, ca.customer_id, sum(ca.amount_dirham) as amount_dirham
  from public.credit_applications ca
  group by ca.shop_id, ca.customer_id
) ap on ap.shop_id = c.shop_id and ap.customer_id = c.id;

-- Same signature, result columns, language, volatility, search_path and (SECURITY INVOKER) privileges as before.
create or replace function public.report_customer_due_totals(p_shop_id uuid)
returns table(customers_with_due bigint, outstanding_due_dirham bigint, available_credit_dirham bigint, unassigned_due_dirham bigint)
language sql stable set search_path = '' as $$
  select count(*) filter (where b.outstanding_due_dirham > 0), coalesce(sum(b.outstanding_due_dirham), 0)::bigint,
    coalesce(sum(b.available_credit_dirham), 0)::bigint,
    (select coalesce(sum(d.due_dirham), 0)::bigint from private.invoice_customer_due d where d.shop_id = p_shop_id and d.customer_id is null)
  from public.customer_financial_balances b where b.shop_id = p_shop_id
$$;
