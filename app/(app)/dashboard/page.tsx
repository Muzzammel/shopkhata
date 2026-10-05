import Link from "next/link";

import { can, getCurrentActor } from "@/lib/auth/permissions";
import { DASHBOARD_PERIODS, loadDashboard, parseDashboardPeriod, type DashboardPeriod } from "@/lib/dashboard";
import { formatQar } from "@/lib/domain/money";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { getVisibleShops } from "@/lib/shop-switching";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import styles from "@/app/ui.module.css";

const qar = (dirham: number) => `QAR ${formatQar(dirham)}`;
const qatarTime = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Qatar" });
const PERIOD_LABELS: Record<DashboardPeriod, string> = { today: "Today", "7d": "Last 7 days", "30d": "Last 30 days", custom: "Custom" };

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const actor = await getCurrentActor();
  const query = await searchParams;
  const supabase = await createServerSupabaseClient();
  const { data: allShops, error: shopsError } = await supabase.from("shops").select("id,name,is_active").eq("is_active", true).order("name");
  if (shopsError || !allShops) throw new Error("DASHBOARD_UNAVAILABLE");
  const shops = getVisibleShops(actor, allShops);
  const requestedShop = Array.isArray(query.shop) ? query.shop[0] : query.shop;
  const shop = shops.find((item) => item.id === requestedShop) ?? shops[0];
  if (!shop || !can(actor, "records.view_assigned", shop.id)) return <main className={styles.workspace}><h1>Dashboard unavailable</h1></main>;

  const today = qatarBusinessDate(new Date());
  const range = parseDashboardPeriod(query, today);
  const canViewAudit = can(actor, "audit.view_full", shop.id);
  const data = await loadDashboard(supabase, shops, shop, range, canViewAudit);
  const periodQS = range.period === "custom" ? `period=custom&from=${range.from}&to=${range.to}` : `period=${range.period}`;

  return <main className={styles.workspace}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>{shop.name}</p><h1>Dashboard</h1><p>An operational view of today and recent activity. Not a profit statement — ShopKhata holds no cost of goods.</p></div>
      <Link href="/">Back to overview</Link>
    </header>
    {shops.length > 1 && <nav className={styles.shops} aria-label="Choose shop">{shops.map((item) => <Link key={item.id} aria-current={item.id === shop.id ? "page" : undefined} href={`/dashboard?shop=${item.id}&${periodQS}`}>{item.name}</Link>)}</nav>}

    <section className={styles.panel}>
      <div className={styles.toolbar}>
        <nav className={styles.shops} aria-label="Choose period">{DASHBOARD_PERIODS.map((item) => <Link key={item} aria-current={item === range.period ? "page" : undefined} href={`/dashboard?shop=${shop.id}&period=${item}`}>{PERIOD_LABELS[item]}</Link>)}</nav>
        {range.period === "custom" && <form className={styles.search} action="/dashboard">
          <input type="hidden" name="shop" value={shop.id} /><input type="hidden" name="period" value="custom" />
          <label>From<input type="date" name="from" defaultValue={range.from} max={today} required /></label>
          <label>To<input type="date" name="to" defaultValue={range.to} max={today} required /></label>
          <button className={styles.secondary}>Show range</button>
        </form>}
      </div>
      {range.error && <p role="alert">{range.error} Showing {PERIOD_LABELS[range.period]} instead.</p>}
      <p className={styles.muted}>Showing {range.from === range.to ? range.from : `${range.from} to ${range.to}`} (Qatar business dates). Outstanding due and credit below are the current balance, not limited to this period.</p>
      <div className={styles.metrics}>
        <div><span>Invoices</span><strong>{data.kpi.invoiceCount}</strong></div>
        <div><span>Sales (effective)</span><strong>{qar(data.kpi.salesDirham)}</strong></div>
        <div><span>Average invoice</span><strong>{qar(data.kpi.averageInvoiceDirham)}</strong></div>
        <div><span>Payments received (cash)</span><strong>{qar(data.kpi.paymentsReceivedDirham)}</strong></div>
        <div><span>Expenses</span><strong>{qar(data.kpi.expensesDirham)}</strong></div>
        <div><span>Net cash movement</span><strong>{qar(data.kpi.netCashMovementDirham)}</strong></div>
        <div><span>Outstanding due · current balance</span><strong className={data.kpi.outstandingDueDirham > 0 ? styles.due : undefined}>{qar(data.kpi.outstandingDueDirham)}</strong></div>
        <div><span>Available customer credit · current balance</span><strong>{qar(data.kpi.availableCreditDirham)}</strong></div>
        <div><span>Customers with due · current balance</span><strong>{data.kpi.customersWithDue}</strong></div>
      </div>
    </section>

    {data.shopComparison && <section className={styles.panel}>
      <h2>Shop comparison</h2>
      <div className={styles.tableWrap}><table><thead><tr><th scope="col">Shop</th><th scope="col" className={styles.num}>Invoices</th><th scope="col" className={styles.num}>Sales</th><th scope="col" className={styles.num}>Payments received</th><th scope="col" className={styles.num}>Expenses</th><th scope="col" className={styles.num}>Outstanding due</th></tr></thead>
        <tbody>{data.shopComparison.map((row) => <tr key={row.shopId}><td>{row.shopName}</td><td className={styles.num}>{row.invoiceCount}</td><td className={styles.num}>{qar(row.salesDirham)}</td><td className={styles.num}>{qar(row.paymentsReceivedDirham)}</td><td className={styles.num}>{qar(row.expensesDirham)}</td><td className={styles.num}>{qar(row.outstandingDueDirham)}</td></tr>)}</tbody>
      </table></div>
    </section>}

    <section className={styles.panel}>
      <h2>Trend</h2>
      {range.period === "today" ? <p className={styles.muted}>A single day has no trend to plot. Today so far: {qar(data.trend.today.grossInvoiceDirham)} invoiced, {qar(data.trend.today.cashReceivedDirham)} cash received, {qar(data.trend.today.expensesDirham)} in expenses.</p> : data.trend.days.length === 0 ? <p className={styles.empty}>No activity in this period.</p> : <>
        {(() => {
          const max = Math.max(1, ...data.trend.days.flatMap((d) => [d.salesDirham, d.paymentsDirham, d.expensesDirham]));
          const series: { label: string; key: "salesDirham" | "paymentsDirham" | "expensesDirham" }[] = [
            { label: "Gross invoice amount", key: "salesDirham" }, { label: "Cash received", key: "paymentsDirham" }, { label: "Expenses", key: "expensesDirham" },
          ];
          return series.map((item) => <div key={item.key}>
            <h3>{item.label}</h3>
            <div className={styles.trendBars}>{data.trend.days.map((day) => <div className={styles.trendRow} key={`${item.key}-${day.businessDate}`}>
              <span>{day.businessDate}</span>
              <span className={styles.trendBar}><span style={{ width: `${Math.round((day[item.key] / max) * 100)}%` }} /></span>
              <strong>{qar(day[item.key])}</strong>
            </div>)}</div>
          </div>);
        })()}
      </>}
    </section>

    <section className={styles.panel}>
      <h2>Invoice health</h2>
      <div className={styles.metrics}>
        <div><span>Total invoices</span><strong>{data.invoiceHealth.total}</strong></div>
        <div><span>Delivered</span><strong>{data.invoiceHealth.delivered}</strong></div>
        <div><span>Advance (not delivered)</span><strong>{data.invoiceHealth.advance}</strong></div>
        <div><span>Fully paid</span><strong>{data.invoiceHealth.fullyPaid}</strong></div>
        <div><span>With outstanding due</span><strong>{data.invoiceHealth.withDue}</strong></div>
      </div>
    </section>

    <section className={styles.panel}>
      <h2>Collection health</h2>
      <div className={styles.metrics}>
        <div><span>Outstanding due · current balance</span><strong className={data.collection.outstandingDueDirham > 0 ? styles.due : undefined}>{qar(data.collection.outstandingDueDirham)}</strong></div>
        <div><span>Customers with due</span><strong>{data.collection.customersWithDue}</strong></div>
        <div><span>Payments received (cash) this period</span><strong>{qar(data.collection.paymentsReceivedDirham)}</strong></div>
        <div><span>Available customer credit · current balance</span><strong>{qar(data.collection.availableCreditDirham)}</strong></div>
      </div>
      {data.collection.largestDues.length > 0 && <div><h3>Largest outstanding balances</h3><div className={styles.detailList}>{data.collection.largestDues.map((row) => <article key={row.customerId}><Link href={`/customers/${row.customerId}?shop=${shop.id}`}><strong>{row.name || "Unnamed customer"}</strong></Link><span>Due {qar(row.outstandingDueDirham)}</span></article>)}</div></div>}
    </section>

    <section className={styles.panel}>
      <h2>Customer insights</h2>
      <div className={styles.detailGrid}>
        <div><dt>Top customers by sales (period)</dt>{data.customers.topBySales.length === 0 ? <p className={styles.empty}>No invoices with a customer in this period.</p> : <div className={styles.detailList}>{data.customers.topBySales.map((row) => <article key={row.customerId}><Link href={`/customers/${row.customerId}?shop=${shop.id}`}><strong>{row.name || "Unnamed customer"}</strong></Link><span>{qar(row.amountDirham)}</span></article>)}</div>}</div>
        <div><dt>Top customers by payments (period)</dt>{data.customers.topByPayments.length === 0 ? <p className={styles.empty}>No customer payments in this period.</p> : <div className={styles.detailList}>{data.customers.topByPayments.map((row) => <article key={row.customerId}><Link href={`/customers/${row.customerId}?shop=${shop.id}`}><strong>{row.name || "Unnamed customer"}</strong></Link><span>{qar(row.amountDirham)}</span></article>)}</div>}</div>
        <div><dt>Customers with available credit</dt>{data.customers.creditCustomers.length === 0 ? <p className={styles.empty}>No customer holds available credit.</p> : <div className={styles.detailList}>{data.customers.creditCustomers.map((row) => <article key={row.customerId}><Link href={`/customers/${row.customerId}?shop=${shop.id}`}><strong>{row.name || "Unnamed customer"}</strong></Link><span>Credit {qar(row.availableCreditDirham)}</span></article>)}</div>}</div>
        <div><dt>Recently active customers</dt>{data.customers.recentlyActive.length === 0 ? <p className={styles.empty}>No recent customer activity.</p> : <div className={styles.detailList}>{data.customers.recentlyActive.map((row) => <article key={row.customerId}><Link href={`/customers/${row.customerId}?shop=${shop.id}`}><strong>{row.name || "Unnamed customer"}</strong></Link><span>Last activity {row.lastActivity}</span></article>)}</div>}</div>
      </div>
      {data.customers.anonymousInvoiceCount > 0 && <p className={styles.muted}>{data.customers.anonymousInvoiceCount} invoice{data.customers.anonymousInvoiceCount === 1 ? "" : "s"} in this period has no customer attached and is not counted above.</p>}
    </section>

    <section className={styles.panel}>
      <h2>Expenses</h2>
      <div className={styles.metrics}>
        <div><span>Expenses this period</span><strong>{qar(data.expenses.totalDirham)}</strong></div>
        {data.expenses.byCategory.map((item) => <div key={item.category}><span>{item.category} ({item.count})</span><strong>{qar(item.amountDirham)}</strong></div>)}
      </div>
      <div className={styles.detailGrid}>
        <div><dt>Largest expenses (period)</dt>{data.expenses.largest.length === 0 ? <p className={styles.empty}>No expenses in this period.</p> : <div className={styles.detailList}>{data.expenses.largest.map((row) => <article key={row.id}><strong>{qar(row.amountDirham)} · {row.category}</strong><span>{row.description}</span><span>{row.businessDate}</span></article>)}</div>}</div>
        <div><dt>Recent expenses</dt>{data.expenses.recent.length === 0 ? <p className={styles.empty}>No expenses recorded yet.</p> : <div className={styles.detailList}>{data.expenses.recent.map((row) => <article key={row.id}><strong>{qar(row.amountDirham)} · {row.category}</strong><span>{row.description}</span><span>{row.businessDate}</span></article>)}</div>}</div>
      </div>
      <p><Link href={`/expenses?shop=${shop.id}`}>Open expenses</Link></p>
    </section>

    <section className={styles.panel}>
      <h2>Daily closing health</h2>
      <div className={styles.metrics}>
        <div><span>Today&apos;s state</span><strong data-day-state={data.closing.state} className={styles.badge} data-tone={data.closing.state === "closed" ? "solid" : "success"}>{data.closing.state === "closed" ? "Closed" : "Open"}</strong></div>
        <div><span>Last close</span><strong>{data.closing.lastClose ? qatarTime(data.closing.lastClose.recordedAt) : "Never closed"}</strong></div>
      </div>
      {data.closing.recentlyReopened.length > 0 && <p className={styles.callout}>Recently reopened dates: {data.closing.recentlyReopened.join(", ")}.</p>}
      {data.closing.recentEvents.length > 0 && <div className={styles.detailList}>{data.closing.recentEvents.slice(0, 5).map((event) => <article key={event.sequence}><strong>{event.type === "closed" ? "Closed" : "Reopened"}</strong><span>{qatarTime(event.recordedAt)} by {event.actorName}{(event.reason || event.note) && ` · ${event.reason ?? event.note}`}</span></article>)}</div>}
      <p><Link href={`/closing?shop=${shop.id}`}>Open daily close</Link></p>
    </section>

    {data.activity.visible && <section className={styles.panel}>
      <h2>Recent activity</h2>
      {data.activity.events.length === 0 ? <p className={styles.empty}>No recorded activity yet.</p> : <div className={styles.detailList}>{data.activity.events.map((event) => <article key={event.id}>
        <strong>{event.href ? <Link href={event.href}>{event.label}</Link> : event.label}</strong>
        <span>{qatarTime(event.recordedAt)} by {event.actorName}</span>
      </article>)}</div>}
    </section>}

    <section className={styles.panel}>
      <h2>Quick actions</h2>
      <div className={styles.quickActions}>
        <Link className={styles.secondary} href="/">New invoice</Link>
        {can(actor, "payment.record", shop.id) && <Link className={styles.secondary} href={`/payments?shop=${shop.id}`}>Record payment</Link>}
        {can(actor, "expense.create", shop.id) && <Link className={styles.secondary} href={`/expenses?shop=${shop.id}`}>Add expense</Link>}
        <Link className={styles.secondary} href="/">Import Excel</Link>
        <Link className={styles.secondary} href={`/invoices?shop=${shop.id}`}>Find invoice</Link>
        <Link className={styles.secondary} href={`/customers?shop=${shop.id}`}>Find customer</Link>
        {can(actor, "date.close", shop.id) && <Link className={styles.secondary} href={`/closing?shop=${shop.id}`}>Daily close</Link>}
        <Link className={styles.secondary} href={`/reports?shop=${shop.id}`}>Reports</Link>
      </div>
    </section>
  </main>;
}
