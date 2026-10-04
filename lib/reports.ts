import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  INVOICE_EXPORT_HEADERS, fetchExpenseExport, fetchInvoiceExport, invoiceExportSheet, qar, recordedAt, sheet,
  type Cell, type ExpenseExportRow, type ExportSheet, type InvoiceExportRow,
} from "@/lib/excel/exports";
import { readAllPages } from "@/lib/read-all-pages";
import type { Database } from "@/lib/supabase/database.types";

// Reports only read and relabel what the database projections return. No
// amount is added, subtracted or re-derived here; every total comes from a
// report_* SQL function over the same source rows.

type Client = SupabaseClient<Database>;
type Functions = Database["public"]["Functions"];

export const REPORT_KINDS = ["daily", "sales", "dues", "expenses", "payments"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_TITLES: Record<ReportKind, string> = {
  daily: "Daily summary", sales: "Sales by invoice date", dues: "Customer dues", expenses: "Expenses", payments: "Payments",
};
export const MAX_REPORT_RANGE_DAYS = 366;
/** Rows shown on screen; exports carry every row. */
export const SCREEN_ROW_LIMIT = 200;

const isoDate = z.iso.date();
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export type ReportFilter = { kind: ReportKind; from: string; to: string; error: string | null };

/**
 * `today` is the current Qatar business date. Dates are business dates as
 * typed (YYYY-MM-DD) and are never converted through a time zone. An invalid
 * or missing choice falls back to today and says why.
 */
export function parseReportFilter(query: Record<string, string | string[] | undefined>, today: string): ReportFilter {
  const requested = first(query.report);
  const kind = REPORT_KINDS.find((item) => item === requested) ?? "daily";
  const fallback = { kind, from: today, to: today };
  if (kind === "daily") {
    const date = first(query.date);
    if (date === undefined) return { ...fallback, error: null };
    if (!isoDate.safeParse(date).success) return { ...fallback, error: "Choose a valid business date." };
    if (date > today) return { ...fallback, error: "A future business date has no report." };
    return { kind, from: date, to: date, error: null };
  }
  const from = first(query.from), to = first(query.to);
  if (from === undefined && to === undefined) return { ...fallback, error: null };
  if (!isoDate.safeParse(from).success || !isoDate.safeParse(to).success) return { ...fallback, error: "Choose a valid date range." };
  if (from! > to!) return { ...fallback, error: "The start date must not be after the end date." };
  if (to! > today) return { ...fallback, error: "A future business date has no report." };
  if (daysBetween(from!, to!) > MAX_REPORT_RANGE_DAYS) return { ...fallback, error: `Choose a range of at most ${MAX_REPORT_RANGE_DAYS} days.` };
  return { kind, from: from!, to: to!, error: null };
}

// Daily summary -----------------------------------------------------------

export type DailySummary = {
  businessDate: string; invoiceCount: number; grossInvoiceDirham: number; initialReceivedDirham: number; dueCreatedDirham: number;
  followupPaymentsDirham: number; customerPaymentsDirham: number; paymentCorrectionsDirham: number; invoiceCorrectionsDirham: number;
  creditCreatedDirham: number; creditAppliedDirham: number; expenseCount: number; expensesDirham: number; cashReceivedDirham: number;
  netCashMovementDirham: number; netDueMovementDirham: number;
};
type MetricKey = Exclude<keyof DailySummary, "businessDate">;

/** The single list of daily metrics: order, wording and meaning for screen, export and docs. */
export const DAILY_METRICS: readonly { key: MetricKey; label: string; kind: "count" | "money"; meaning: string }[] = [
  { key: "invoiceCount", label: "Invoices entered", kind: "count", meaning: "Invoices whose business date is this day." },
  { key: "grossInvoiceDirham", label: "Gross invoice amount", kind: "money", meaning: "Original totals of those invoices, before any correction." },
  { key: "initialReceivedDirham", label: "Received at entry", kind: "money", meaning: "Cash recorded together with the invoices." },
  { key: "dueCreatedDirham", label: "Due created at entry", kind: "money", meaning: "Gross invoice amount minus received at entry." },
  { key: "followupPaymentsDirham", label: "Follow-up invoice payments", kind: "money", meaning: "Later payments against one invoice, dated this day, including the applied part of an approved overpayment." },
  { key: "customerPaymentsDirham", label: "Customer payments", kind: "money", meaning: "Customer payments dated this day, allocated to that customer's invoices." },
  { key: "paymentCorrectionsDirham", label: "Payment corrections", kind: "money", meaning: "Approved payment corrections approved on this day." },
  { key: "invoiceCorrectionsDirham", label: "Invoice corrections", kind: "money", meaning: "Approved invoice-total corrections approved on this day." },
  { key: "creditCreatedDirham", label: "Overpayment kept as customer credit", kind: "money", meaning: "Cash received above an invoice's due and held as customer credit." },
  { key: "creditAppliedDirham", label: "Customer credit applied (not cash)", kind: "money", meaning: "Existing customer credit used against invoices on this day." },
  { key: "expenseCount", label: "Expenses recorded", kind: "count", meaning: "Expenses whose business date is this day." },
  { key: "expensesDirham", label: "Expenses", kind: "money", meaning: "Effective (corrected) amount of those expenses." },
  { key: "cashReceivedDirham", label: "Cash received", kind: "money", meaning: "Received at entry + follow-up payments + customer payments + payment corrections + overpayment kept as credit." },
  { key: "netCashMovementDirham", label: "Net cash movement (cash received − expenses)", kind: "money", meaning: "Cash received minus expenses. This is not profit: ShopKhata holds no cost of goods." },
  { key: "netDueMovementDirham", label: "Net change in outstanding due", kind: "money", meaning: "Gross invoice amount + invoice corrections − all payments − payment corrections − credit applied." },
];

type DailySummaryRow = Functions["report_daily_summary"]["Returns"][number];
function amount(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error("REPORT_AMOUNT_INVALID");
  return value;
}
export function mapDailySummary(row: DailySummaryRow): DailySummary {
  return {
    businessDate: row.business_date, invoiceCount: amount(row.invoice_count), grossInvoiceDirham: amount(row.gross_invoice_dirham),
    initialReceivedDirham: amount(row.initial_received_dirham), dueCreatedDirham: amount(row.due_created_dirham),
    followupPaymentsDirham: amount(row.followup_payments_dirham), customerPaymentsDirham: amount(row.customer_payments_dirham),
    paymentCorrectionsDirham: amount(row.payment_corrections_dirham), invoiceCorrectionsDirham: amount(row.invoice_corrections_dirham),
    creditCreatedDirham: amount(row.credit_created_dirham), creditAppliedDirham: amount(row.credit_applied_dirham),
    expenseCount: amount(row.expense_count), expensesDirham: amount(row.expenses_dirham), cashReceivedDirham: amount(row.cash_received_dirham),
    netCashMovementDirham: amount(row.net_cash_movement_dirham), netDueMovementDirham: amount(row.net_due_movement_dirham),
  };
}
/** A day with no recorded activity has no summary row; every metric is zero. */
export function emptyDailySummary(businessDate: string): DailySummary {
  return { businessDate, ...Object.fromEntries(DAILY_METRICS.map((metric) => [metric.key, 0])) } as DailySummary;
}

export async function fetchDailySummary(supabase: Client, shopId: string, from: string, to: string): Promise<DailySummary[]> {
  const { data, error } = await supabase.rpc("report_daily_summary", { p_shop_id: shopId, p_from: from, p_to: to });
  if (error || !data) throw new Error("REPORT_UNAVAILABLE");
  return data.map(mapDailySummary);
}

// Row reports ---------------------------------------------------------------

export type SalesTotals = { invoiceCount: number; totalDirham: number; paidDirham: number; creditAppliedDirham: number; dueDirham: number; deliveredCount: number; undeliveredCount: number };
export type CustomerDueRow = { customerId: string; publicId: string; name: string; mobile: string; outstandingDueDirham: number; availableCreditDirham: number; invoiceCount: number; lastActivity: string };
export type CustomerDueTotals = { customersWithDue: number; outstandingDueDirham: number; availableCreditDirham: number; unassignedDueDirham: number };
export type ExpenseReportRow = ExpenseExportRow;
export type ExpenseTotals = { totalDirham: number; count: number; byCategory: { category: string; count: number; amountDirham: number }[] };
export const PAYMENT_SOURCES = {
  invoice_entry: "Received at invoice entry", follow_up: "Follow-up invoice payment", customer_payment: "Customer payment",
  payment_correction: "Payment correction", overpayment_credit: "Overpayment kept as credit", credit_application: "Customer credit applied",
} as const;
export type PaymentSource = keyof typeof PAYMENT_SOURCES;
export type PaymentReportRow = {
  entryId: string; businessDate: string; recordedAt: string | null; source: PaymentSource; method: string; amountDirham: number;
  invoiceNumber: string; customerName: string; reference: string;
};
export type PaymentTotals = { cashDirham: number; creditDirham: number; bySource: { source: PaymentSource; method: string; count: number; amountDirham: number }[] };

type Page<T> = PromiseLike<{ data: T[] | null; error: unknown }>;
const readRows = <T>(fetchPage: (offset: number, end: number) => Page<T>, limit?: number) => limit ? fetchPage(0, limit - 1) : readAllPages(fetchPage);
function chunks<T>(items: readonly T[], size = 200): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

export async function fetchSalesReport(supabase: Client, shopId: string, from: string, to: string, limit?: number): Promise<{ rows: InvoiceExportRow[]; totals: SalesTotals }> {
  const [rows, totals] = await Promise.all([
    fetchInvoiceExport(supabase, shopId, from, to, limit),
    supabase.rpc("report_sales_totals", { p_shop_id: shopId, p_from: from, p_to: to }),
  ]);
  const total = totals.data?.[0];
  if (totals.error || !total) throw new Error("REPORT_UNAVAILABLE");
  return {
    rows,
    totals: {
      invoiceCount: amount(total.invoice_count), totalDirham: amount(total.effective_total_dirham), paidDirham: amount(total.effective_paid_dirham),
      creditAppliedDirham: amount(total.credit_applied_dirham), dueDirham: amount(total.effective_due_dirham),
      deliveredCount: amount(total.delivered_count), undeliveredCount: amount(total.undelivered_count),
    },
  };
}

export async function fetchCustomerDueReport(supabase: Client, shopId: string, limit?: number): Promise<{ rows: CustomerDueRow[]; totals: CustomerDueTotals }> {
  const [balances, totals] = await Promise.all([
    readRows((offset, end) => supabase.from("customer_financial_balances")
      .select("customer_id,outstanding_due_dirham,available_credit_dirham,invoice_count,last_activity_date").eq("shop_id", shopId)
      .or("outstanding_due_dirham.gt.0,available_credit_dirham.gt.0")
      .order("outstanding_due_dirham", { ascending: false }).order("customer_id").range(offset, end), limit),
    supabase.rpc("report_customer_due_totals", { p_shop_id: shopId }),
  ]);
  const total = totals.data?.[0];
  if (balances.error || !balances.data || totals.error || !total) throw new Error("REPORT_UNAVAILABLE");
  const customers = new Map<string, { public_id: string; name: string | null; mobile: string | null }>();
  for (const ids of chunks(balances.data.map((row) => row.customer_id!))) {
    const result = await supabase.from("customers").select("id,public_id,name,mobile").eq("shop_id", shopId).in("id", ids);
    if (result.error || !result.data) throw new Error("REPORT_UNAVAILABLE");
    for (const customer of result.data) customers.set(customer.id, customer);
  }
  return {
    rows: balances.data.map((row) => {
      const customer = customers.get(row.customer_id!);
      return {
        customerId: row.customer_id!, publicId: customer?.public_id ?? "", name: customer?.name ?? "", mobile: customer?.mobile ?? "",
        outstandingDueDirham: amount(row.outstanding_due_dirham ?? 0), availableCreditDirham: amount(row.available_credit_dirham ?? 0),
        invoiceCount: row.invoice_count ?? 0, lastActivity: row.last_activity_date ?? "",
      };
    }),
    totals: {
      customersWithDue: amount(total.customers_with_due), outstandingDueDirham: amount(total.outstanding_due_dirham),
      availableCreditDirham: amount(total.available_credit_dirham), unassignedDueDirham: amount(total.unassigned_due_dirham),
    },
  };
}

type ExpenseTotalRow = Functions["report_expense_totals"]["Returns"][number];
/** The database returns one row per category plus a total row whose category is null. */
export function mapExpenseTotals(rows: readonly ExpenseTotalRow[]): ExpenseTotals {
  const total = rows.find((row) => row.category === null);
  return {
    totalDirham: amount(total?.amount_dirham ?? 0), count: total?.expense_count ?? 0,
    byCategory: rows.flatMap((row) => row.category === null ? [] : [{ category: row.category, count: row.expense_count, amountDirham: amount(row.amount_dirham) }])
      .sort((a, b) => a.category.localeCompare(b.category)),
  };
}

export async function fetchExpenseReport(supabase: Client, shopId: string, from: string, to: string, limit?: number): Promise<{ rows: ExpenseReportRow[]; totals: ExpenseTotals }> {
  const [rows, totals] = await Promise.all([
    fetchExpenseExport(supabase, shopId, from, to, limit),
    supabase.rpc("report_expense_totals", { p_shop_id: shopId, p_from: from, p_to: to }),
  ]);
  if (totals.error || !totals.data) throw new Error("REPORT_UNAVAILABLE");
  return { rows, totals: mapExpenseTotals(totals.data) };
}

type PaymentTotalRow = Functions["report_payment_totals"]["Returns"][number];
/** Picks the database's own subtotals: per source, and per method (source null). */
export function mapPaymentTotals(rows: readonly PaymentTotalRow[]): PaymentTotals {
  const method = (name: string) => amount(rows.find((row) => row.source === null && row.method === name)?.amount_dirham ?? 0);
  return {
    cashDirham: method("cash"), creditDirham: method("credit"),
    bySource: rows.flatMap((row) => row.source === null || row.method === null ? [] : [{ source: row.source as PaymentSource, method: row.method, count: row.entry_count, amountDirham: amount(row.amount_dirham) }])
      .sort((a, b) => a.source.localeCompare(b.source)),
  };
}

export async function fetchPaymentReport(supabase: Client, shopId: string, from: string, to: string, limit?: number): Promise<{ rows: PaymentReportRow[]; totals: PaymentTotals }> {
  const [entries, totals] = await Promise.all([
    readRows((offset, end) => supabase.from("report_payments")
      .select("entry_id,business_date,recorded_at,source,method,amount_dirham,invoice_id,reference").eq("shop_id", shopId)
      .gte("business_date", from).lte("business_date", to).order("business_date").order("recorded_at").order("entry_id").range(offset, end), limit),
    supabase.rpc("report_payment_totals", { p_shop_id: shopId, p_from: from, p_to: to }),
  ]);
  if (entries.error || !entries.data || totals.error || !totals.data) throw new Error("REPORT_UNAVAILABLE");
  const invoices = new Map<string, { number: string; customerId: string | null }>();
  for (const ids of chunks([...new Set(entries.data.flatMap((row) => row.invoice_id ? [row.invoice_id] : []))])) {
    const result = await supabase.from("effective_invoices").select("canonical_invoice_id,effective_invoice_number,effective_customer_id").eq("shop_id", shopId).in("canonical_invoice_id", ids);
    if (result.error || !result.data) throw new Error("REPORT_UNAVAILABLE");
    for (const invoice of result.data) invoices.set(invoice.canonical_invoice_id!, { number: invoice.effective_invoice_number!, customerId: invoice.effective_customer_id });
  }
  const names = new Map<string, string>();
  for (const ids of chunks([...new Set([...invoices.values()].flatMap((invoice) => invoice.customerId ? [invoice.customerId] : []))])) {
    const result = await supabase.from("customers").select("id,name,public_id").eq("shop_id", shopId).in("id", ids);
    if (result.error || !result.data) throw new Error("REPORT_UNAVAILABLE");
    for (const customer of result.data) names.set(customer.id, customer.name || customer.public_id);
  }
  return {
    rows: entries.data.map((row) => {
      const invoice = row.invoice_id ? invoices.get(row.invoice_id) : undefined;
      return {
        entryId: row.entry_id!, businessDate: row.business_date!, recordedAt: row.recorded_at, source: row.source as PaymentSource, method: row.method!,
        amountDirham: amount(row.amount_dirham!), invoiceNumber: invoice?.number ?? "", customerName: invoice?.customerId ? names.get(invoice.customerId) ?? "" : "",
        reference: row.reference ?? "",
      };
    }),
    totals: mapPaymentTotals(totals.data),
  };
}

// Excel sheets ----------------------------------------------------------------
// Same rows and the same database totals as the screen, in the same order.

const bold = (value: string): Cell => ({ value, fontWeight: "bold" });

export const DAILY_SUMMARY_HEADERS = ["Business Date", ...DAILY_METRICS.map((metric) => metric.kind === "money" ? `${metric.label} QAR` : metric.label)];
export function dailySummarySheet(days: readonly DailySummary[]): ExportSheet {
  return sheet("Daily summary", DAILY_SUMMARY_HEADERS, days.map((day) => [
    day.businessDate, ...DAILY_METRICS.map((metric) => metric.kind === "money" ? qar(day[metric.key]) : day[metric.key]),
  ]));
}

export function salesReportSheet(rows: readonly InvoiceExportRow[], totals: SalesTotals): ExportSheet {
  const result = invoiceExportSheet(rows);
  result.sheet = "Sales";
  result.data.push([
    bold("Total"), `${totals.invoiceCount} invoices`, qar(totals.totalDirham), qar(totals.paidDirham), qar(totals.creditAppliedDirham), qar(totals.dueDirham),
    `${totals.deliveredCount} delivered, ${totals.undeliveredCount} not delivered`, ...INVOICE_EXPORT_HEADERS.slice(7).map(() => null),
  ]);
  return result;
}

export const CUSTOMER_DUE_HEADERS = ["Customer ID", "Customer", "Mobile", "Outstanding Due QAR", "Available Credit QAR", "Invoices", "Last Activity"];
export function customerDueSheet(rows: readonly CustomerDueRow[], totals: CustomerDueTotals): ExportSheet {
  return sheet("Customer dues", CUSTOMER_DUE_HEADERS, [
    ...rows.map((row): Cell[] => [row.publicId, row.name, row.mobile, qar(row.outstandingDueDirham), qar(row.availableCreditDirham), row.invoiceCount, row.lastActivity]),
    [bold("Total"), `${totals.customersWithDue} customers with due`, null, qar(totals.outstandingDueDirham), qar(totals.availableCreditDirham), null, null],
    [bold("Due on invoices without a customer"), null, null, qar(totals.unassignedDueDirham), null, null, null],
  ]);
}

export const EXPENSE_REPORT_HEADERS = ["Business Date", "Category", "Description", "Amount QAR", "Correction State", "Created By", "Recorded At (Qatar)", "Backdate Reason", "Expense Reference"];
export function expenseReportSheet(rows: readonly ExpenseReportRow[], totals: ExpenseTotals): ExportSheet {
  return sheet("Expenses", EXPENSE_REPORT_HEADERS, [
    ...rows.map((row): Cell[] => [
      row.businessDate, row.category, row.description, qar(row.amountDirham), row.corrected ? "Corrected" : "As entered", row.createdBy,
      recordedAt(row.recordedAt), row.backdatedReason ?? "", row.expenseId,
    ]),
    ...totals.byCategory.map((item): Cell[] => [bold("Category total"), item.category, `${item.count} expenses`, qar(item.amountDirham), null, null, null, null, null]),
    [bold("Total"), null, `${totals.count} expenses`, qar(totals.totalDirham), null, null, null, null, null],
  ]);
}

export const PAYMENT_REPORT_HEADERS = ["Business Date", "Recorded At (Qatar)", "Type", "Method", "Amount QAR", "Invoice Number", "Customer", "Reference"];
export function paymentReportSheet(rows: readonly PaymentReportRow[], totals: PaymentTotals): ExportSheet {
  return sheet("Payments", PAYMENT_REPORT_HEADERS, [
    ...rows.map((row): Cell[] => [row.businessDate, recordedAt(row.recordedAt), PAYMENT_SOURCES[row.source], row.method, qar(row.amountDirham), row.invoiceNumber, row.customerName, row.reference]),
    ...totals.bySource.map((item): Cell[] => [bold("Type total"), null, PAYMENT_SOURCES[item.source], item.method, qar(item.amountDirham), `${item.count} entries`, null, null]),
    [bold("Total cash received"), null, null, "cash", qar(totals.cashDirham), null, null, null],
    [bold("Total customer credit applied"), null, null, "credit", qar(totals.creditDirham), null, null, null],
  ]);
}
