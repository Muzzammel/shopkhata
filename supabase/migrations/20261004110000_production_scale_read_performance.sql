-- BIG SLICE 5: read performance at one year of data. Two changes, both found by
-- `pnpm perf:check` and neither changing any result.
--
-- 1. Evaluate shop access once per statement instead of once per row.
--
-- Every read policy called private.has_shop_access(shop_id) for each row it
-- examined. With one year of data (21,960 invoices) a plain count of one shop's
-- invoices spent 1.36 s in that filter alone, the workspace's recent-invoice
-- list took about 3 s and the customer list hit the API statement timeout
-- (docs/release/v1-rc1-verification.md, "Performance").
--
-- The rule is unchanged: an active owner reads every shop, any other active
-- account reads exactly its assigned shops, anyone else reads nothing. The
-- accessible shops are now computed by one uncorrelated subquery, which
-- PostgreSQL runs once per statement and can use as an index condition.
-- private.has_shop_access(uuid) stays as the single-shop check of the RPCs
-- and the storage policies.

create function private.accessible_shop_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select case
    when private.is_owner() then coalesce((select array_agg(s.id) from public.shops s), '{}'::uuid[])
    when private.is_active_actor() then coalesce((select array_agg(a.shop_id) from public.user_shop_assignments a where a.user_id = auth.uid()), '{}'::uuid[])
    else '{}'::uuid[]
  end
$$;
revoke all on function private.accessible_shop_ids() from public, anon, authenticated;
grant execute on function private.accessible_shop_ids() to authenticated;

do $$
declare p record; remaining integer;
begin
  for p in select tablename, policyname from pg_policies where schemaname = 'public' and qual = 'private.has_shop_access(shop_id)' loop
    execute format('alter policy %I on public.%I using (shop_id = any ((select private.accessible_shop_ids())::uuid[]))', p.policyname, p.tablename);
  end loop;
  alter policy shops_select_authenticated on public.shops
    using (id = any ((select private.accessible_shop_ids())::uuid[]));
  -- Rows without a shop (account administration) remain owner-only.
  alter policy audit_events_select_authenticated on public.audit_events
    using ((select private.is_owner()) or shop_id = any ((select private.accessible_shop_ids())::uuid[]));
  alter policy profiles_select_authenticated on public.profiles
    using (id = (select auth.uid()) or (select private.is_owner()));
  alter policy assignments_select_authenticated on public.user_shop_assignments
    using (user_id = (select auth.uid()) or (select private.is_owner()));

  -- A table added later with the per-row form would silently be slow; one left behind here would be a bug in this migration.
  select count(*) into remaining from pg_policies where schemaname = 'public' and qual like '%has_shop_access(%';
  if remaining > 0 then raise exception 'production_scale_read_performance: % public policies still call has_shop_access per row', remaining; end if;
end $$;

-- 2. Customer balances: one pass per shop instead of one pass per customer.
--
-- The view computed each customer's invoices and last activity with a
-- subquery correlated on the customer. The effective customer of an invoice is
-- a computed value (a replacement can change it), so no index can serve that
-- lookup and every customer cost a scan of the whole shop: 366 s for 429
-- customers at this size, and a statement timeout on the customer list.
-- The same values are now aggregated once and joined. Columns, types and
-- results are unchanged (verified by hashing both definitions' output).
create or replace view public.customer_financial_balances with (security_invoker = true) as
select c.shop_id, c.id customer_id,
  coalesce(inv.due_dirham, 0)::bigint outstanding_due_dirham,
  coalesce((select sum(cc.amount_dirham) from public.customer_credits cc where cc.shop_id = c.shop_id and cc.customer_id = c.id and cc.approved_by is not null), 0)::bigint
    - coalesce((select sum(ca.amount_dirham) from public.credit_applications ca where ca.shop_id = c.shop_id and ca.customer_id = c.id), 0)::bigint available_credit_dirham,
  coalesce(inv.invoice_count, 0)::bigint invoice_count,
  act.last_activity_date
from public.customers c
left join (
  select e.shop_id, e.effective_customer_id customer_id, sum(e.effective_due_dirham) due_dirham, count(e.canonical_invoice_id) invoice_count
  from public.effective_invoices e where e.effective_customer_id is not null group by e.shop_id, e.effective_customer_id
) inv on inv.shop_id = c.shop_id and inv.customer_id = c.id
left join (
  select l.shop_id, l.customer_id, max(greatest(l.business_date, l.recorded_at::date)) last_activity_date
  from public.customer_ledger l group by l.shop_id, l.customer_id
) act on act.shop_id = c.shop_id and act.customer_id = c.id;
revoke all on public.customer_financial_balances from public, anon;
grant select on public.customer_financial_balances to authenticated;
