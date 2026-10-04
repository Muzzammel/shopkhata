import Link from "next/link";
import type { ReactNode } from "react";

import { can, getCurrentActor } from "@/lib/auth/permissions";
import { formatQar } from "@/lib/domain/money";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import {
  DAILY_METRICS, PAYMENT_SOURCES, REPORT_KINDS, REPORT_TITLES, SCREEN_ROW_LIMIT, emptyDailySummary, fetchCustomerDueReport,
  fetchDailySummary, fetchExpenseReport, fetchPaymentReport, fetchSalesReport, parseReportFilter,
} from "@/lib/reports";
import { getVisibleShops } from "@/lib/shop-switching";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import styles from "../customers/operations.module.css";

const qar = (dirham: number) => `QAR ${formatQar(dirham)}`;
const qatarTime = (iso: string | null) => iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Qatar" }) : "—";

function Table({ head, children, empty }: { head: string[]; children: ReactNode[]; empty: string }) {
  return <div className={styles.tableWrap}><table><thead><tr>{head.map((title) => <th key={title} scope="col">{title}</th>)}</tr></thead>
    <tbody>{children.length ? children.slice(0, SCREEN_ROW_LIMIT) : <tr><td colSpan={head.length}>{empty}</td></tr>}</tbody></table>
    {children.length > SCREEN_ROW_LIMIT && <p className={styles.muted}>Showing the first {SCREEN_ROW_LIMIT} rows. The totals above cover every row; export the report for the full list.</p>}
  </div>;
}

export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const actor = await getCurrentActor();
  const query = await searchParams;
  const supabase = await createServerSupabaseClient();
  const { data: allShops, error: shopsError } = await supabase.from("shops").select("id,name,is_active").eq("is_active", true).order("name");
  if (shopsError || !allShops) throw new Error("REPORTS_UNAVAILABLE");
  const shops = getVisibleShops(actor, allShops);
  const requestedShop = Array.isArray(query.shop) ? query.shop[0] : query.shop;
  const shop = shops.find((item) => item.id === requestedShop) ?? shops[0];
  if (!shop || !can(actor, "records.view_assigned", shop.id)) return <main className={styles.workspace}><h1>Reports unavailable</h1></main>;

  const today = qatarBusinessDate(new Date());
  const { kind, from, to, error } = parseReportFilter(query, today);
  const range = kind === "daily" ? `date=${from}` : `from=${from}&to=${to}`;
  const exportHref = kind === "dues" ? `/exports/report-dues?shop=${shop.id}` : `/exports/report-${kind}?shop=${shop.id}&from=${from}&to=${to}`;
  // One extra row tells the table that the list was cut short.
  const limit = SCREEN_ROW_LIMIT + 1;

  let body: ReactNode;
  if (kind === "daily") {
    const day = (await fetchDailySummary(supabase, shop.id, from, to))[0] ?? emptyDailySummary(from);
    body = <>
      <p className={styles.muted}>Everything recorded for business date {from}, whenever it was typed in. Sales, receipts, dues and expenses only — ShopKhata holds no cost of goods, so no figure here is profit.</p>
      <div className={styles.tableWrap}><table><thead><tr><th scope="col">Metric</th><th scope="col">Value</th><th scope="col">Meaning</th></tr></thead><tbody>
        {DAILY_METRICS.map((metric) => <tr key={metric.key}><td>{metric.label}</td><td><strong data-metric={metric.key}>{metric.kind === "money" ? qar(day[metric.key]) : day[metric.key]}</strong></td><td>{metric.meaning}</td></tr>)}
      </tbody></table></div>
      <p><Link href={`/closing?shop=${shop.id}&date=${from}`}>Close or reopen this date</Link></p>
    </>;
  } else if (kind === "sales") {
    const { rows, totals } = await fetchSalesReport(supabase, shop.id, from, to, limit);
    body = <>
      <p className={styles.muted}>Invoices whose business date is in the range, at their current effective values: approved corrections, later payments and applied credit are included, and a replaced invoice appears once under its current number.</p>
      <div className={styles.metrics}>
        <div><span>Invoices</span><strong data-total="invoiceCount">{totals.invoiceCount}</strong></div>
        <div><span>Effective invoice amount</span><strong data-total="total">{qar(totals.totalDirham)}</strong></div>
        <div><span>Payments received</span><strong data-total="paid">{qar(totals.paidDirham)}</strong></div>
        <div><span>Customer credit applied</span><strong data-total="credit">{qar(totals.creditAppliedDirham)}</strong></div>
        <div><span>Outstanding due now</span><strong data-total="due">{qar(totals.dueDirham)}</strong></div>
        <div><span>Delivered</span><strong>{totals.deliveredCount}</strong></div>
        <div><span>Advance (not delivered)</span><strong>{totals.undeliveredCount}</strong></div>
      </div>
      <Table head={["Invoice", "Business date", "Recorded (Qatar)", "Customer", "Total", "Paid", "Credit applied", "Due", "Status"]} empty="No invoices in this range.">
        {rows.map((row) => <tr key={row.invoiceId}><td><Link href={`/shops/${shop.id}/invoices/${row.invoiceId}`}>{row.invoiceNumber}</Link></td><td>{row.businessDate}</td><td>{qatarTime(row.recordedAt)}</td><td>{row.customerName || "—"}</td><td>{qar(row.totalDirham)}</td><td>{qar(row.paidDirham)}</td><td>{qar(row.creditAppliedDirham)}</td><td>{qar(row.dueDirham)}</td><td>{row.delivered ? "Delivered" : "Advance"}</td></tr>)}
      </Table>
    </>;
  } else if (kind === "dues") {
    const { rows, totals } = await fetchCustomerDueReport(supabase, shop.id, limit);
    body = <>
      <p className={styles.muted}>The current position of every customer who owes money or holds unused credit. It is not limited to a date range.</p>
      <div className={styles.metrics}>
        <div><span>Customers with due</span><strong>{totals.customersWithDue}</strong></div>
        <div><span>Customer outstanding due</span><strong data-total="due">{qar(totals.outstandingDueDirham)}</strong></div>
        <div><span>Available customer credit</span><strong data-total="credit">{qar(totals.availableCreditDirham)}</strong></div>
        <div><span>Due on invoices without a customer</span><strong>{qar(totals.unassignedDueDirham)}</strong></div>
      </div>
      <Table head={["Customer", "Mobile", "Outstanding due", "Available credit", "Invoices", "Latest activity"]} empty="No customer owes money or holds credit.">
        {rows.map((row) => <tr key={row.customerId}><td><Link href={`/customers/${row.customerId}?shop=${shop.id}`}><strong>{row.name || "Unnamed customer"}</strong><small>{row.publicId}</small></Link></td><td>{row.mobile || "—"}</td><td>{qar(row.outstandingDueDirham)}</td><td>{qar(row.availableCreditDirham)}</td><td>{row.invoiceCount}</td><td>{row.lastActivity || "—"}</td></tr>)}
      </Table>
    </>;
  } else if (kind === "expenses") {
    const { rows, totals } = await fetchExpenseReport(supabase, shop.id, from, to, limit);
    body = <>
      <p className={styles.muted}>Expenses whose business date is in the range, at their effective amount after any approved correction.</p>
      <div className={styles.metrics}>
        <div><span>Expenses</span><strong>{totals.count}</strong></div>
        <div><span>Effective expense amount</span><strong data-total="expenses">{qar(totals.totalDirham)}</strong></div>
        {totals.byCategory.map((item) => <div key={item.category}><span>{item.category} ({item.count})</span><strong>{qar(item.amountDirham)}</strong></div>)}
      </div>
      <Table head={["Business date", "Recorded (Qatar)", "Category", "Description", "Amount", "Correction", "Created by"]} empty="No expenses in this range.">
        {rows.map((row) => <tr key={row.expenseId}><td>{row.businessDate}{row.backdatedReason && <small>Backdated: {row.backdatedReason}</small>}</td><td>{qatarTime(row.recordedAt)}</td><td>{row.category}</td><td>{row.description}</td><td>{qar(row.amountDirham)}</td><td>{row.corrected ? "Corrected" : "As entered"}</td><td>{row.createdBy || "—"}</td></tr>)}
      </Table>
    </>;
  } else {
    const { rows, totals } = await fetchPaymentReport(supabase, shop.id, from, to, limit);
    body = <>
      <p className={styles.muted}>Every money movement whose business date is in the range, one row per record. A correction is its own row on the day it was approved. Applied customer credit is listed but is not cash.</p>
      <div className={styles.metrics}>
        <div><span>Cash received</span><strong data-total="cash">{qar(totals.cashDirham)}</strong></div>
        <div><span>Customer credit applied (not cash)</span><strong data-total="credit">{qar(totals.creditDirham)}</strong></div>
        {totals.bySource.map((item) => <div key={`${item.source}-${item.method}`}><span>{PAYMENT_SOURCES[item.source]} ({item.count})</span><strong>{qar(item.amountDirham)}</strong></div>)}
      </div>
      <Table head={["Business date", "Recorded (Qatar)", "Type", "Method", "Amount", "Invoice", "Customer", "Reference"]} empty="No payments in this range.">
        {rows.map((row) => <tr key={`${row.source}-${row.entryId}`}><td>{row.businessDate}</td><td>{qatarTime(row.recordedAt)}</td><td>{PAYMENT_SOURCES[row.source]}</td><td>{row.method}</td><td>{qar(row.amountDirham)}</td><td>{row.invoiceNumber || "—"}</td><td>{row.customerName || "—"}</td><td><small>{row.reference}</small></td></tr>)}
      </Table>
    </>;
  }

  return <main className={styles.workspace}>
    <header className={styles.header}><div><p className={styles.eyebrow}>{shop.name}</p><h1>Reports</h1><p>Dates are Qatar business dates.</p></div><Link href="/">Back to overview</Link></header>
    {shops.length > 1 && <nav className={styles.shops} aria-label="Choose shop">{shops.map((item) => <Link key={item.id} aria-current={item.id === shop.id ? "page" : undefined} href={`/reports?shop=${item.id}&report=${kind}&${range}`}>{item.name}</Link>)}</nav>}
    <nav className={styles.shops} aria-label="Choose report">{REPORT_KINDS.map((item) => <Link key={item} aria-current={item === kind ? "page" : undefined} href={`/reports?shop=${shop.id}&report=${item}`}>{REPORT_TITLES[item]}</Link>)}</nav>
    <section className={styles.panel}>
      <h2>{REPORT_TITLES[kind]}</h2>
      {kind !== "dues" && <form className={styles.search} action="/reports"><input type="hidden" name="shop" value={shop.id} /><input type="hidden" name="report" value={kind} />
        {kind === "daily"
          ? <label>Business date<input type="date" name="date" defaultValue={from} max={today} required /></label>
          : <><label>From<input type="date" name="from" defaultValue={from} max={today} required /></label><label>To<input type="date" name="to" defaultValue={to} max={today} required /></label></>}
        <button>Show report</button></form>}
      {error && <p role="alert">{error} Showing {today} instead.</p>}
      {can(actor, "records.export", shop.id) && <p><a href={exportHref}>Export this report (.xlsx)</a></p>}
      {body}
    </section>
  </main>;
}
