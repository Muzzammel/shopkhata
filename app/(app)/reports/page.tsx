import Link from "next/link";
import { DownloadIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ui } from "@/components/sales/ui";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { dailyGroups } from "@/lib/closing-view";
import { qar } from "@/lib/dashboard-view";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { paymentMethodLabel } from "@/lib/payment-method";
import {
  PAYMENT_SOURCES, REPORT_KINDS, REPORT_TITLES, SCREEN_ROW_LIMIT, emptyDailySummary, fetchCustomerDueReport,
  fetchDailySummary, fetchExpenseReport, fetchPaymentReport, fetchSalesReport, parseReportFilter, type ReportKind,
} from "@/lib/reports";
import { REPORT_PERIODS, activePeriod, periodRange } from "@/lib/report-view";
import { qatarDateTime } from "@/lib/sales-view";
import { getReadableShops, pickShop } from "@/lib/shop-switching";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

const qatarTime = (iso: string | null) => iso ? qatarDateTime(iso) : "—";
const card = cn(ui.card, "grid content-start gap-5 p-5 sm:p-6");
const pillLink = ui.chip;

/** One figure. `total` is the data-total hook the tests and the shared figures use. */
function Stat({ label, value, total, note }: { label: string; value: string | number; total?: string; note?: string }) {
  return <div className="grid content-start gap-1 rounded-2xl bg-card p-4 ring-1 ring-border ring-inset">
    <span className="text-xs text-muted-foreground">{label}</span>
    <strong data-total={total} className="text-lg font-semibold sm:text-xl tracking-tight tabular-nums">{typeof value === "string" && value.startsWith("QAR ") ? <><span className="text-xs font-medium opacity-65">QAR</span> {value.slice(4)}</> : value}</strong>
    {note && <span className="text-xs text-muted-foreground">{note}</span>}
  </div>;
}

function Group({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return <div className={cn("grid gap-3", className)}>
    <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>
  </div>;
}

/** `num` lists the right-aligned (numeric) column positions. Tables scroll inside their own box, never the page. */
function Table({ head, num = [], children, empty }: { head: string[]; num?: number[]; children: ReactNode[]; empty: string }) {
  return <div className="grid gap-2">
    <div className="overflow-x-auto rounded-2xl ring-1 ring-border ring-inset">
      <table className="w-full min-w-max border-collapse text-sm">
        <thead className="bg-muted text-left text-xs text-muted-foreground"><tr>{head.map((title, index) => <th key={title} scope="col" className={cn("px-3 py-2.5 font-semibold", num.includes(index) && "text-right")}>{title}</th>)}</tr></thead>
        <tbody className="[&_td]:border-t [&_td]:border-border [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-top">
          {children.length ? children.slice(0, SCREEN_ROW_LIMIT) : <tr><td colSpan={head.length} className="text-muted-foreground">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
    {children.length > SCREEN_ROW_LIMIT && <p className="text-sm text-muted-foreground">Showing the first {SCREEN_ROW_LIMIT} rows. The totals above cover every row; export the report for the full list.</p>}
  </div>;
}

const num = "text-right tabular-nums";

export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const actor = await getCurrentActor();
  const query = await searchParams;
  const supabase = await createServerSupabaseClient();
  const { data: allShops, error: shopsError } = await supabase.from("shops").select("id,name,is_active").order("name");
  if (shopsError || !allShops) throw new Error("REPORTS_UNAVAILABLE");
  const shops = getReadableShops(actor, allShops);
  const requestedShop = Array.isArray(query.shop) ? query.shop[0] : query.shop;
  const shop = pickShop(shops, requestedShop);
  if (!shop || !can(actor, "records.view_assigned", shop.id)) return <main className="mx-auto max-w-[1280px] px-4 pt-5 sm:px-6"><h1 className="text-3xl font-semibold tracking-tight">Reports unavailable</h1></main>;

  const today = qatarBusinessDate(new Date());
  const { kind, from, to, error } = parseReportFilter(query, today);
  const range = kind === "daily" ? `date=${from}` : `from=${from}&to=${to}`;
  const period = kind === "daily" || kind === "dues" ? null : activePeriod(from, to, today);
  const exportHref = kind === "dues" ? `/exports/report-dues?shop=${shop.id}` : `/exports/report-${kind}?shop=${shop.id}&from=${from}&to=${to}`;
  // One extra row tells the table that the list was cut short.
  const limit = SCREEN_ROW_LIMIT + 1;

  let body: ReactNode;
  if (kind === "daily") {
    const day = (await fetchDailySummary(supabase, shop.id, from, to))[0] ?? emptyDailySummary(from);
    body = <>
      <p className="text-sm text-muted-foreground">Everything recorded for business date {from}, whenever it was typed in. Sales, receipts, dues and expenses only — ShopKhata holds no cost of goods, so no figure here is profit.</p>
      {dailyGroups().map((group) => <div key={group.title} className="grid gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">{group.title}</h3>
        <div className="overflow-x-auto rounded-2xl ring-1 ring-border ring-inset"><table className="w-full min-w-max border-collapse text-sm">
          <thead className="bg-muted text-left text-xs text-muted-foreground"><tr><th scope="col" className="px-3 py-2.5 font-semibold">Metric</th><th scope="col" className="px-3 py-2.5 text-right font-semibold">Value</th><th scope="col" className="px-3 py-2.5 font-semibold">Meaning</th></tr></thead>
          <tbody>{group.metrics.map((metric) => <tr key={metric.key} className="[&_td]:border-t [&_td]:border-border [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-top">
            <td>{metric.label}</td><td className={num}><strong data-metric={metric.key}>{metric.kind === "money" ? qar(day[metric.key]) : day[metric.key]}</strong></td><td className="text-muted-foreground">{metric.meaning}</td>
          </tr>)}</tbody>
        </table></div>
      </div>)}
      <p><Link href={`/closing?shop=${shop.id}&date=${from}`} className="font-semibold underline underline-offset-4">Close or reopen this date</Link></p>
    </>;
  } else if (kind === "sales") {
    const { rows, totals } = await fetchSalesReport(supabase, shop.id, from, to, limit);
    body = <>
      <p className="text-sm text-muted-foreground">Invoices whose business date is in the range, at their current effective values: approved corrections, later payments and applied credit are included, and a replaced invoice appears once under its current number.</p>
      <Group title="Sales">
        <Stat label="Invoices" value={totals.invoiceCount} total="invoiceCount" />
        <Stat label="Effective invoice amount" value={qar(totals.totalDirham)} total="total" />
        <Stat label="Delivered" value={totals.deliveredCount} />
        <Stat label="Advance (not delivered)" value={totals.undeliveredCount} />
      </Group>
      <Group title="Collection">
        <Stat label="Payments received" value={qar(totals.paidDirham)} total="paid" />
        <Stat label="Customer credit applied" value={qar(totals.creditAppliedDirham)} total="credit" note="Not a receipt" />
        <Stat label="Outstanding due now" value={qar(totals.dueDirham)} total="due" note="Current position" />
      </Group>
      <Table num={[4, 5, 6, 7]} head={["Invoice", "Business date", "Recorded (Qatar)", "Customer", "Total", "Paid", "Credit applied", "Due", "Status"]} empty="No invoices in this range.">
        {rows.map((row) => <tr key={row.invoiceId}><td><Link href={`/shops/${shop.id}/invoices/${row.invoiceId}`} className="font-semibold underline underline-offset-4">{row.invoiceNumber}</Link></td><td>{row.businessDate}</td><td>{qatarTime(row.recordedAt)}</td><td>{row.customerName || "—"}</td><td className={num}>{qar(row.totalDirham)}</td><td className={num}>{qar(row.paidDirham)}</td><td className={num}>{qar(row.creditAppliedDirham)}</td><td className={num}>{qar(row.dueDirham)}</td><td>{row.isVoid ? <span data-badge="void" className={cn(ui.badge, "bg-danger-soft text-destructive")}>Void</span> : <span className={cn(ui.badge, row.delivered ? "bg-muted text-foreground" : "bg-warning-soft text-warning")}>{row.delivered ? "Delivered" : "Advance"}</span>}</td></tr>)}
      </Table>
    </>;
  } else if (kind === "dues") {
    const { rows, totals } = await fetchCustomerDueReport(supabase, shop.id, limit);
    body = <>
      <p className="text-sm text-muted-foreground">The current position of every customer who owes money or holds unused credit. It is not limited to a date range.</p>
      <Group title="Customers">
        <Stat label="Customers with due" value={totals.customersWithDue} />
        <Stat label="Customer outstanding due" value={qar(totals.outstandingDueDirham)} total="due" />
        <Stat label="Available customer credit" value={qar(totals.availableCreditDirham)} total="credit" />
        <Stat label="Due on invoices without a customer" value={qar(totals.unassignedDueDirham)} />
      </Group>
      <Table num={[2, 3, 4]} head={["Customer", "Mobile", "Outstanding due", "Available credit", "Invoices", "Latest activity"]} empty="No customer owes money or holds credit.">
        {rows.map((row) => <tr key={row.customerId}><td><Link href={`/customers/${row.customerId}?shop=${shop.id}`} className="grid gap-0.5 font-semibold underline underline-offset-4"><span>{row.name || "Unnamed customer"}</span><small className="font-normal text-muted-foreground no-underline">{row.publicId}</small></Link></td><td>{row.mobile || "—"}</td><td className={num}>{qar(row.outstandingDueDirham)}</td><td className={num}>{qar(row.availableCreditDirham)}</td><td className={num}>{row.invoiceCount}</td><td>{row.lastActivity || "—"}</td></tr>)}
      </Table>
    </>;
  } else if (kind === "expenses") {
    const { rows, totals } = await fetchExpenseReport(supabase, shop.id, from, to, limit);
    body = <>
      <p className="text-sm text-muted-foreground">Expenses whose business date is in the range, at their effective amount after any approved correction.</p>
      <Group title="Expenses">
        <Stat label="Expenses" value={totals.count} total="count" />
        <Stat label="Effective expense amount" value={qar(totals.totalDirham)} total="expenses" />
        {totals.byCategory.map((item) => <Stat key={item.category} label={`${item.category} (${item.count})`} value={qar(item.amountDirham)} />)}
      </Group>
      <Table num={[4]} head={["Business date", "Recorded (Qatar)", "Category", "Description", "Amount", "Correction", "Created by"]} empty="No expenses in this range.">
        {rows.map((row) => <tr key={row.expenseId}><td>{row.businessDate}{row.backdatedReason && <small className="block text-muted-foreground">Backdated: {row.backdatedReason}</small>}</td><td>{qatarTime(row.recordedAt)}</td><td>{row.category}</td><td>{row.description}</td><td className={num}>{qar(row.amountDirham)}</td><td>{row.corrected ? "Corrected" : "As entered"}</td><td>{row.createdBy || "—"}</td></tr>)}
      </Table>
    </>;
  } else {
    const { rows, totals } = await fetchPaymentReport(supabase, shop.id, from, to, limit);
    body = <>
      <p className="text-sm text-muted-foreground">Every money movement whose business date is in the range, one row per record. A correction is its own row on the day it was approved. Applied customer credit is listed but is not a cash or bank receipt.</p>
      <Group title="Money received">
        <Stat label="Cash received" value={qar(totals.cashDirham)} total="cash" />
        <Stat label="Bank received" value={qar(totals.bankDirham)} total="bank" />
        <Stat label="Total received (cash + bank)" value={qar(totals.receivedDirham)} total="received" />
        <Stat label="Customer credit applied (not a receipt)" value={qar(totals.creditDirham)} total="credit" />
        {totals.bySource.map((item) => <Stat key={`${item.source}-${item.method}`} label={`${PAYMENT_SOURCES[item.source]} · ${paymentMethodLabel(item.method)} (${item.count})`} value={qar(item.amountDirham)} />)}
      </Group>
      <Table num={[4]} head={["Business date", "Recorded (Qatar)", "Type", "Method", "Amount", "Invoice", "Customer", "Reference"]} empty="No payments in this range.">
        {rows.map((row) => <tr key={`${row.source}-${row.entryId}`}><td>{row.businessDate}</td><td>{qatarTime(row.recordedAt)}</td><td>{PAYMENT_SOURCES[row.source]}</td><td>{paymentMethodLabel(row.method)}</td><td className={num}>{qar(row.amountDirham)}</td><td>{row.invoiceNumber || "—"}</td><td>{row.customerName || "—"}</td><td><small>{row.reference}</small></td></tr>)}
      </Table>
    </>;
  }

  const kindLinks = (item: ReportKind) => `/reports?shop=${shop.id}&report=${item}`;

  return <main className="mx-auto grid w-full max-w-[1280px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6">
    <header className="grid min-w-0 gap-1.5 px-1">
      <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">{shop.name}</p>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Reports</h1>
      <p className="text-sm text-muted-foreground">Dates are Qatar business dates. Showing {kind === "daily" ? from : kind === "dues" ? "the current position" : `${from} to ${to}`}.</p>
    </header>
    {shops.length > 1 && <nav className="flex flex-wrap gap-2" aria-label="Choose shop">{shops.map((item) => <Link key={item.id} aria-current={item.id === shop.id ? "page" : undefined} href={`/reports?shop=${item.id}&report=${kind}&${range}`} className={cn(pillLink, item.id === shop.id ? "bg-primary text-primary-foreground" : "border border-input bg-card text-foreground hover:bg-muted")}>{item.name}{!item.is_active && " (inactive)"}</Link>)}</nav>}
    <nav className="flex flex-wrap gap-2" aria-label="Choose report">{REPORT_KINDS.map((item) => <Link key={item} aria-current={item === kind ? "page" : undefined} href={kindLinks(item)} className={cn(pillLink, item === kind ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>{REPORT_TITLES[item]}</Link>)}</nav>

    <section aria-labelledby="report-heading" className={card}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="report-heading" className="text-lg font-semibold tracking-tight">{REPORT_TITLES[kind]}</h2>
        {can(actor, "records.export", shop.id) && <a className={ui.secondary} href={exportHref}><DownloadIcon aria-hidden />Export this report (.xlsx)</a>}
      </div>
      {period !== null && <nav className="flex flex-wrap gap-2" aria-label="Period">
        {REPORT_PERIODS.map((item) => {
          const window = periodRange(item.key, today);
          return <Link key={item.key} aria-current={period === item.key ? "page" : undefined} href={`/reports?shop=${shop.id}&report=${kind}&from=${window.from}&to=${window.to}`} className={cn(pillLink, period === item.key ? "bg-primary text-primary-foreground" : "border border-input bg-card text-foreground hover:bg-muted")}>{item.label}</Link>;
        })}
        <span aria-current={period === "custom" ? "page" : undefined} className={cn(pillLink, period === "custom" ? "bg-primary text-primary-foreground" : "border border-dashed border-input text-muted-foreground")}>Custom range</span>
      </nav>}
      <form className="flex flex-wrap items-end gap-3" action="/reports">
        <input type="hidden" name="shop" value={shop.id} />
        <input type="hidden" name="report" value={kind} />
        {kind === "daily"
          ? <label className="grid gap-1.5 text-[13px] font-medium text-muted-foreground">Business date<input type="date" name="date" defaultValue={from} max={today} required className={cn(ui.field, "w-auto")} /></label>
          : kind === "dues" ? null
          : <><label className="grid gap-1.5 text-[13px] font-medium text-muted-foreground">From<input type="date" name="from" defaultValue={from} max={today} required className={cn(ui.field, "w-auto")} /></label><label className="grid gap-1.5 text-[13px] font-medium text-muted-foreground">To<input type="date" name="to" defaultValue={to} max={today} required className={cn(ui.field, "w-auto")} /></label></>}
        {kind !== "dues" && <button className={ui.secondary}>Show report</button>}
      </form>
      {error && <p role="alert" className={ui.warn}>{error} Showing {today} instead.</p>}
      {body}
    </section>
  </main>;
}
