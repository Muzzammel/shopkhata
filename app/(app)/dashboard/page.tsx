import Link from "next/link";

import { ActivityTimeline, AttentionCard, ExpenseCategories, ListCard, TopCustomers } from "@/components/dashboard/lists";
import { DashboardOverview } from "@/components/dashboard/dashboard-overview";
import { ui } from "@/components/sales/ui";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { summarizeBackups } from "@/lib/backup-status";
import { loadDashboard, parseDashboardPeriod } from "@/lib/dashboard";
import { deriveAttention, qar } from "@/lib/dashboard-view";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { longDate, qatarDateTime } from "@/lib/sales-view";
import { getReadableShops, pickShop, shopViewer } from "@/lib/shop-switching";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

import styles from "@/app/ui.module.css";

const qatarTime = qatarDateTime;

/** Label/value rows for the collapsed "More detail" section. */
function Rows({ rows, empty }: { rows: { key: string; label: string; value: string; href?: string; tone?: "due" }[]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return <ul className="grid grid-cols-1 list-none divide-y divide-border pl-0">{rows.map((row) => <li key={row.key} className="flex items-baseline justify-between gap-4 py-2 text-sm first:pt-0 last:pb-0">
    {row.href ? <Link href={row.href} className="min-w-0 truncate font-medium text-foreground no-underline hover:underline">{row.label}</Link> : <span className="min-w-0 truncate text-muted-foreground">{row.label}</span>}
    <strong className={cn("font-semibold whitespace-nowrap tabular-nums", row.tone === "due" && "text-warning")}>{row.value}</strong>
  </li>)}</ul>;
}

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const query = await searchParams;
  const supabase = await createServerSupabaseClient();
  // The shop list is RLS-scoped to the session, so it can be read while the actor is verified.
  const [actor, { data: allShops, error: shopsError }] = await Promise.all([
    getCurrentActor(),
    supabase.from("shops").select("id,name,is_active").order("name"),
  ]);
  if (shopsError || !allShops) throw new Error("DASHBOARD_UNAVAILABLE");
  const shops = getReadableShops(actor, allShops);
  const requestedShop = Array.isArray(query.shop) ? query.shop[0] : query.shop;
  const shop = pickShop(shops, requestedShop);
  if (!shop || !can(actor, "records.view_assigned", shop.id)) return <main className="mx-auto max-w-[1280px] px-4 pt-5 sm:px-6"><h1 className="text-3xl font-semibold tracking-tight">Dashboard unavailable</h1></main>;

  const today = qatarBusinessDate(new Date());
  const range = parseDashboardPeriod(query, today);
  const viewer = shopViewer(actor, shop);
  const canViewAudit = can(actor, "audit.view_full", shop.id);
  // Owner-only, and never allowed to break the dashboard: no reading, no attention item.
  const [data, backups] = await Promise.all([
    loadDashboard(supabase, shops.filter((item) => item.is_active || item.id === shop.id), shop, range, canViewAudit),
    can(actor, "users.manage") ? supabase.from("backup_records").select("*").order("backup_created_at", { ascending: false }).limit(200) : null,
  ]);
  const backup = backups?.data ? summarizeBackups(backups.data, new Date()) : null;
  const last = data.trend.today;
  const attention = deriveAttention({
    shopId: shop.id,
    dayOpenWithActivity: can(viewer, "date.close", shop.id) && data.closing.state === "open" && range.to === today && last.grossInvoiceDirham + last.totalReceivedDirham + last.expensesDirham > 0,
    customersWithDue: data.kpi.customersWithDue, outstandingDueDirham: data.kpi.outstandingDueDirham,
    backup: backup && { freshness: backup.freshness, ageHours: backup.ageHours },
  });
  const customerLink = (row: { customerId: string }) => `/customers/${row.customerId}?shop=${shop.id}`;

  return <main className="mx-auto grid w-full max-w-[1280px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6">
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1 px-1">
      <div>
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">{shop.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Dashboard</h1>
      </div>
      <p className="max-w-md text-xs text-muted-foreground sm:text-right">Qatar business dates. An operational view, not a profit statement — ShopKhata holds no cost of goods.</p>
    </header>

    <DashboardOverview
      shopId={shop.id} range={range} today={today} days={data.trend.days} lastDay={{ grossInvoiceDirham: last.grossInvoiceDirham, cashReceivedDirham: last.cashReceivedDirham, bankReceivedDirham: last.bankReceivedDirham, totalReceivedDirham: last.totalReceivedDirham, expensesDirham: last.expensesDirham }}
      kpi={{
        salesDirham: data.kpi.salesDirham, invoiceCount: data.kpi.invoiceCount, averageInvoiceDirham: data.kpi.averageInvoiceDirham, paymentsReceivedDirham: data.kpi.paymentsReceivedDirham, bankReceivedDirham: data.kpi.bankReceivedDirham, totalReceivedDirham: data.kpi.totalReceivedDirham,
        expensesDirham: data.kpi.expensesDirham, netCashMovementDirham: data.kpi.netCashMovementDirham, outstandingDueDirham: data.kpi.outstandingDueDirham,
        customersWithDue: data.kpi.customersWithDue, unpaidInvoicesDirham: data.kpi.unpaidInvoicesDirham, unpaidInvoiceCount: data.invoiceHealth.withDue,
      }}
    />

    {/* Phones (below md) show Attention, Top Customers and Activity; Top Expense Categories moves into "More insights". */}
    <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-12">
      <TopCustomers rows={data.customers.topBySales} shopId={shop.id} />
      <ExpenseCategories rows={data.expenses.byCategory} totalDirham={data.expenses.totalDirham} className="max-md:hidden" />
      <AttentionCard items={attention} className={cn("max-lg:order-first", !data.activity.visible && "lg:col-span-12")} />
      {data.activity.visible && <ActivityTimeline events={data.activity.events} shopName={shop.name} today={today} className="lg:col-span-8" />}
    </div>

    <details className="group/more rounded-3xl border border-border bg-card">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-3xl px-5 text-sm font-semibold sk-press [&::-webkit-details-marker]:hidden">
        <span><span className="md:hidden">More insights</span><span className="max-md:hidden">More detail</span></span>
        <span aria-hidden className="text-muted-foreground transition-transform duration-150 group-open/more:rotate-180">⌄</span>
      </summary>
      <div className="grid grid-cols-1 gap-4 p-4 pt-2 sm:grid-cols-2 sm:p-6 sm:pt-2 lg:grid-cols-3">
        <ExpenseCategories rows={data.expenses.byCategory} totalDirham={data.expenses.totalDirham} className="border-0 p-0 sm:p-0 md:hidden" />
        <ListCard title="Daily closing health" action={<Link href={`/closing?shop=${shop.id}`} className="text-[13px] font-semibold text-foreground">Open daily close</Link>} className="border-0 p-0 sm:p-0">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <div className="grid gap-1"><span className="text-xs text-muted-foreground">Today&apos;s state</span><span data-day-state={data.closing.state} className={cn(ui.badge, data.closing.state === "closed" ? "bg-foreground text-background" : "bg-success-soft text-success")}>{data.closing.state === "closed" ? "Closed" : "Open"}</span></div>
            <div className="grid gap-1"><span className="text-xs text-muted-foreground">Last close</span><strong className="text-sm font-semibold tabular-nums">{data.closing.lastClose ? qatarTime(data.closing.lastClose.recordedAt) : "Never closed"}</strong></div>
          </div>
          {data.closing.recentlyReopened.length > 0 && <p className="rounded-2xl bg-warning-soft px-4 py-3 text-sm font-medium text-warning">Recently reopened dates: {data.closing.recentlyReopened.join(", ")}.</p>}
          {data.closing.recentEvents.length > 0 && <Rows empty="" rows={data.closing.recentEvents.slice(0, 4).map((event) => ({ key: String(event.sequence), label: `${event.type === "closed" ? "Closed" : "Reopened"} by ${event.actorName}`, value: qatarTime(event.recordedAt) }))} />}
        </ListCard>
        {data.shopComparison && <ListCard title="Shop comparison" className="border-0 p-0 sm:col-span-2 sm:p-0 lg:col-span-2">
          <div className={styles.tableWrap}><table><thead><tr><th scope="col">Shop</th><th scope="col" className={styles.num}>Invoices</th><th scope="col" className={styles.num}>Sales</th><th scope="col" className={styles.num}>Payments received</th><th scope="col" className={styles.num}>Expenses</th><th scope="col" className={styles.num}>Outstanding due</th></tr></thead>
            <tbody>{data.shopComparison.map((row) => <tr key={row.shopId}><td>{row.shopName}</td><td className={styles.num}>{row.invoiceCount}</td><td className={styles.num}>{qar(row.salesDirham)}</td><td className={styles.num}>{qar(row.paymentsReceivedDirham)}</td><td className={styles.num}>{qar(row.expensesDirham)}</td><td className={styles.num}>{qar(row.outstandingDueDirham)}</td></tr>)}</tbody>
          </table></div>
        </ListCard>}
        <ListCard title="Invoice health" className="border-0 p-0 sm:p-0">
          <Rows empty="" rows={[
            { key: "total", label: "Total invoices", value: String(data.invoiceHealth.total) }, { key: "delivered", label: "Delivered", value: String(data.invoiceHealth.delivered) },
            { key: "advance", label: "Advance (not delivered)", value: String(data.invoiceHealth.advance) }, { key: "paid", label: "Fully paid", value: String(data.invoiceHealth.fullyPaid) },
            { key: "due", label: "With outstanding due", value: String(data.invoiceHealth.withDue), tone: data.invoiceHealth.withDue > 0 ? "due" : undefined },
          ]} />
        </ListCard>
        <ListCard title="Collection health" className="border-0 p-0 sm:p-0">
          <Rows empty="" rows={[
            { key: "out", label: "Outstanding due · current balance", value: qar(data.collection.outstandingDueDirham), tone: data.collection.outstandingDueDirham > 0 ? "due" : undefined },
            { key: "n", label: "Customers with due", value: String(data.collection.customersWithDue) },
            { key: "paid", label: "Cash received this period", value: qar(data.collection.paymentsReceivedDirham) },
            { key: "bank", label: "Bank received this period", value: qar(data.collection.bankReceivedDirham) },
            { key: "credit", label: "Available customer credit · current balance", value: qar(data.collection.availableCreditDirham) },
          ]} />
        </ListCard>
        <ListCard title="Largest outstanding balances" className="border-0 p-0 sm:p-0">
          <Rows empty="No customer owes anything." rows={data.collection.largestDues.map((row) => ({ key: row.customerId, label: row.name || "Unnamed customer", value: qar(row.outstandingDueDirham), href: customerLink(row), tone: "due" as const }))} />
        </ListCard>
        <ListCard title="Top customers by payments" className="border-0 p-0 sm:p-0">
          <Rows empty="No customer payments in this period." rows={data.customers.topByPayments.map((row) => ({ key: row.customerId, label: row.name || "Unnamed customer", value: qar(row.amountDirham), href: customerLink(row) }))} />
        </ListCard>
        <ListCard title="Customers with available credit" className="border-0 p-0 sm:p-0">
          <Rows empty="No customer holds available credit." rows={data.customers.creditCustomers.map((row) => ({ key: row.customerId, label: row.name || "Unnamed customer", value: qar(row.availableCreditDirham), href: customerLink(row) }))} />
        </ListCard>
        <ListCard title="Recently active customers" className="border-0 p-0 sm:p-0">
          <Rows empty="No recent customer activity." rows={data.customers.recentlyActive.map((row) => ({ key: row.customerId, label: row.name || "Unnamed customer", value: longDate(row.lastActivity), href: customerLink(row) }))} />
        </ListCard>
        <ListCard title="Largest expenses (period)" className="border-0 p-0 sm:p-0">
          <Rows empty="No expenses in this period." rows={data.expenses.largest.map((row) => ({ key: row.id, label: `${row.category} · ${row.description}`, value: qar(row.amountDirham) }))} />
        </ListCard>
        <ListCard title="Recent expenses" className="border-0 p-0 sm:p-0" action={<Link href={`/expenses?shop=${shop.id}`} className="text-[13px] font-semibold text-foreground">Open expenses</Link>}>
          <Rows empty="No expenses recorded yet." rows={data.expenses.recent.slice(0, 5).map((row) => ({ key: row.id, label: `${row.category} · ${row.description}`, value: qar(row.amountDirham) }))} />
        </ListCard>
        {data.customers.anonymousInvoiceCount > 0 && <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">{data.customers.anonymousInvoiceCount} invoice{data.customers.anonymousInvoiceCount === 1 ? "" : "s"} in this period has no customer attached and is not counted in the customer lists.</p>}
      </div>
    </details>
  </main>;
}
