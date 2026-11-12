import type { SupabaseClient } from "@supabase/supabase-js";

import { mapCustomerLedger, type CustomerLedgerSource } from "@/lib/customer-operations";
import { readAllPages } from "@/lib/read-all-pages";
import { DELIVERY_EXPORT_CELL, deliveryStatus, type DeliveryStatus } from "@/lib/invoice-delivery";
import type { Database } from "@/lib/supabase/database.types";

type Client = SupabaseClient<Database>;
export type Cell = string | number | { value: string | number; type?: NumberConstructor; format?: string; fontWeight?: "bold" } | null;
export type ExportSheet = { sheet: string; stickyRowsCount: 1; columns: { width: number }[]; data: Cell[][] };

// ponytail: whole export is read into memory; fine for two shops. Stream by
// date window if a single export ever approaches this cap.
export const MAX_EXPORT_ROWS = 20_000;

/** Integer dirham shown as a QAR number cell with two decimals. */
export function qar(dirham: number | null | undefined): Cell {
  if (dirham === null || dirham === undefined) return null;
  if (!Number.isSafeInteger(dirham)) throw new Error("EXPORT_AMOUNT_INVALID");
  return { value: dirham / 100, type: Number, format: "0.00" };
}

export function recordedAt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Qatar" }) : "";
}

export function sheet(name: string, headers: string[], rows: Cell[][]): ExportSheet {
  return {
    sheet: name, stickyRowsCount: 1, columns: headers.map(() => ({ width: 20 })),
    data: [headers.map((value) => ({ value, fontWeight: "bold" as const })), ...rows],
  };
}

export const INVOICE_EXPORT_HEADERS = ["Invoice Number", "Business Date", "Current Total QAR", "Paid QAR", "Credit Applied QAR", "Due QAR", "Delivered", "Customer", "Customer Mobile", "Recorded At (Qatar)", "Original Number", "Invoice Reference", "Status", "Original Total QAR"];
export type InvoiceExportRow = {
  invoiceNumber: string; businessDate: string; totalDirham: number; paidDirham: number; creditAppliedDirham: number;
  dueDirham: number; delivery: DeliveryStatus; customerName: string; customerMobile: string; recordedAt: string | null;
  originalNumber: string; invoiceId: string;
  /**
   * CURRENT STATE register: Current Total/Paid/Due are where the invoice stands now (a void: 0, Status VOID).
   * Original Total is the amount recorded on its business date; for date movements use the Sales report export.
   */
  isVoid?: boolean; originalTotalDirham: number;
};
export function invoiceExportSheet(rows: readonly InvoiceExportRow[]): ExportSheet {
  return sheet("Invoices", INVOICE_EXPORT_HEADERS, rows.map((row) => [
    row.invoiceNumber, row.businessDate, qar(row.totalDirham), qar(row.paidDirham), qar(row.creditAppliedDirham),
    qar(row.dueDirham), DELIVERY_EXPORT_CELL[row.delivery], row.customerName, row.customerMobile, recordedAt(row.recordedAt),
    row.originalNumber, row.invoiceId, row.isVoid ? "VOID" : "ACTIVE", qar(row.originalTotalDirham),
  ]));
}

export const LEDGER_EXPORT_HEADERS = ["Business Date", "Type", "Reference", "Invoice Number", "Debit QAR", "Credit QAR", "Balance QAR", "Recorded At (Qatar)"];
export function ledgerExportSheet(sources: readonly CustomerLedgerSource[]): ExportSheet {
  // Same ordering and running balance as the customer ledger screen.
  return sheet("Customer ledger", LEDGER_EXPORT_HEADERS, mapCustomerLedger(sources).map((row) => [
    row.businessDate, row.type.replaceAll("_", " "), row.reference, row.invoiceNumber ?? "",
    qar(row.debitDirham), qar(row.creditDirham), qar(row.balanceDirham), recordedAt(row.recordedAt),
  ]));
}

export const EXPENSE_EXPORT_HEADERS = ["Business Date", "Category", "Description", "Amount QAR", "Created By", "Recorded At (Qatar)", "Expense Reference"];
export type ExpenseExportRow = { businessDate: string; category: string; description: string; amountDirham: number; createdBy: string; recordedAt: string | null; expenseId: string; corrected?: boolean; backdatedReason?: string };
export function expenseExportSheet(rows: readonly ExpenseExportRow[]): ExportSheet {
  return sheet("Expenses", EXPENSE_EXPORT_HEADERS, rows.map((row) => [
    row.businessDate, row.category, row.description, qar(row.amountDirham), row.createdBy, recordedAt(row.recordedAt), row.expenseId,
  ]));
}

/** One page of `limit` rows for a screen, or every row for an export. */
const readRows = <T>(fetchPage: (offset: number, end: number) => PromiseLike<{ data: T[] | null; error: unknown }>, limit?: number) =>
  limit ? fetchPage(0, limit - 1) : readAllPages(fetchPage);

function chunks<T>(items: readonly T[], size = 200): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

// Every read below goes through the caller's RLS-scoped client; nothing here
// can return a shop the signed-in user cannot already see.

export async function fetchInvoiceExport(supabase: Client, shopId: string, from: string, to: string, limit?: number): Promise<InvoiceExportRow[]> {
  const { data, error } = await readRows((offset, end) => supabase.from("effective_invoices")
    .select("canonical_invoice_id,effective_invoice_number,original_invoice_number,business_date,recorded_at,effective_total_dirham,effective_paid_dirham,effective_credit_applied_dirham,effective_due_dirham,delivery_status,effective_customer_id,is_void,original_total_dirham")
    .eq("shop_id", shopId).gte("business_date", from).lte("business_date", to)
    .order("business_date").order("recorded_at").order("canonical_invoice_id").range(offset, end), limit);
  if (error || !data) throw new Error("EXPORT_UNAVAILABLE");
  const customers = new Map<string, { name: string | null; mobile: string | null }>();
  for (const ids of chunks([...new Set(data.flatMap((row) => row.effective_customer_id ? [row.effective_customer_id] : []))])) {
    const result = await supabase.from("customers").select("id,name,mobile").eq("shop_id", shopId).in("id", ids);
    if (result.error || !result.data) throw new Error("EXPORT_UNAVAILABLE");
    for (const customer of result.data) customers.set(customer.id, customer);
  }
  return data.map((row) => {
    const customer = row.effective_customer_id ? customers.get(row.effective_customer_id) : undefined;
    return {
      invoiceNumber: row.effective_invoice_number!, businessDate: row.business_date!, totalDirham: row.effective_total_dirham!,
      paidDirham: row.effective_paid_dirham!, creditAppliedDirham: row.effective_credit_applied_dirham ?? 0,
      dueDirham: row.effective_due_dirham!, delivery: deliveryStatus(row.delivery_status), customerName: customer?.name ?? "",
      customerMobile: customer?.mobile ?? "", recordedAt: row.recorded_at, originalNumber: row.original_invoice_number!,
      invoiceId: row.canonical_invoice_id!, isVoid: row.is_void === true, originalTotalDirham: row.original_total_dirham!,
    };
  });
}

/** Returns null when the customer is not visible in this shop. */
export async function fetchLedgerExport(supabase: Client, shopId: string, customerId: string): Promise<{ customer: string; sources: CustomerLedgerSource[] } | null> {
  const { data: customer, error: customerError } = await supabase.from("customers").select("public_id")
    .eq("shop_id", shopId).eq("id", customerId).maybeSingle();
  if (customerError) throw new Error("EXPORT_UNAVAILABLE");
  if (!customer) return null;
  const { data, error } = await readAllPages((offset, end) => supabase.from("customer_ledger")
    .select("business_date,recorded_at,sequence_id,invoice_id,entry_type,reference,invoice_number,actor_id,debit_dirham,credit_dirham")
    .eq("shop_id", shopId).eq("customer_id", customerId).order("business_date").order("recorded_at").order("sequence_id").range(offset, end));
  if (error || !data) throw new Error("EXPORT_UNAVAILABLE");
  return {
    customer: customer.public_id,
    sources: data.map((entry) => ({
      businessDate: entry.business_date!, recordedAt: entry.recorded_at!, sequenceId: entry.sequence_id!, invoiceId: entry.invoice_id!,
      type: entry.entry_type as CustomerLedgerSource["type"], reference: entry.reference!, invoiceNumber: entry.invoice_number,
      actorName: entry.actor_id, debitDirham: entry.debit_dirham!, creditDirham: entry.credit_dirham!,
    })),
  };
}

export async function fetchExpenseExport(supabase: Client, shopId: string, from: string, to: string, limit?: number): Promise<ExpenseExportRow[]> {
  // effective_expenses carries the latest approved correction, not the original entry.
  const { data, error } = await readRows((offset, end) => supabase.from("effective_expenses")
    .select("id,business_date,recorded_at,created_by,description,amount_dirham,category,correction_request_id,backdated_reason")
    .eq("shop_id", shopId).gte("business_date", from).lte("business_date", to)
    .order("business_date").order("recorded_at").order("id").range(offset, end), limit);
  if (error || !data) throw new Error("EXPORT_UNAVAILABLE");
  const names = new Map<string, string>();
  for (const ids of chunks([...new Set(data.flatMap((row) => row.created_by ? [row.created_by] : []))])) {
    // RLS lets staff read only their own profile; other creators fall back to their ID.
    const result = await supabase.from("profiles").select("id,display_name").in("id", ids);
    for (const profile of result.data ?? []) names.set(profile.id, profile.display_name);
  }
  return data.map((row) => ({
    businessDate: row.business_date!, category: row.category!, description: row.description!, amountDirham: row.amount_dirham!,
    createdBy: row.created_by ? names.get(row.created_by) ?? row.created_by : "", recordedAt: row.recorded_at, expenseId: row.id!,
    corrected: row.correction_request_id !== null, backdatedReason: row.backdated_reason ?? "",
  }));
}
