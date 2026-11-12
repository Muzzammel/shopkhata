import type { SupabaseClient } from "@supabase/supabase-js";

import { first, parseDateRangeFilter } from "@/lib/date-range";
import { deliveryStatus, type DeliveryStatus } from "@/lib/invoice-delivery";
import { normalizeInvoiceNumber } from "@/lib/invoice-operations";
import type { Database } from "@/lib/supabase/database.types";

type Client = SupabaseClient<Database>;

// The Invoices page's history browser. Every amount and status comes from
// effective_invoices (the same authoritative projection Reports and the
// invoice detail page already use) — nothing here recomputes a total,
// payment or due.

export const INVOICE_PAGE_SIZE = 30;
export const INVOICE_STATUSES = ["all", "delivered", "partial", "advance", "with_due", "fully_paid"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  all: "All", delivered: "Delivered", partial: "Partially delivered", advance: "Not delivered", with_due: "Due", fully_paid: "Paid",
};

export type InvoiceListFilter = { from: string; to: string; status: InvoiceStatus; offset: number; error: string | null };

export function parseInvoiceListFilter(query: Record<string, string | string[] | undefined>, today: string): InvoiceListFilter {
  const status = INVOICE_STATUSES.find((item) => item === first(query.status)) ?? "all";
  const rawOffset = first(query.offset);
  const offset = Math.max(0, Math.min(100_000, Number.parseInt(rawOffset ?? "0", 10) || 0));
  const range = parseDateRangeFilter(query, today);
  return { ...range, status, offset };
}

export type InvoiceListRow = {
  invoiceId: string; invoiceNumber: string; businessDate: string; recordedAt: string | null; customerId: string | null;
  customerName: string; totalDirham: number; paidDirham: number; creditAppliedDirham: number; dueDirham: number;
  /** none | partial | full; legacy invoices are full/none from their yes/no flag. */
  delivery: DeliveryStatus;
  /** Approved replacement version (0 = never replaced). */
  revision: number;
  /** The effective total differs from the recorded one, which only an approved correction can cause. */
  corrected: boolean;
  isVoid?: boolean;
};

function mapRow(row: {
  canonical_invoice_id: string | null; effective_invoice_number: string | null; business_date: string | null; recorded_at: string | null;
  effective_total_dirham: number | null; effective_paid_dirham: number | null; effective_credit_applied_dirham: number | null;
  effective_due_dirham: number | null; delivery_status: string | null; effective_customer_id: string | null;
  revision: number | null; original_total_dirham: number | null; is_void: boolean | null;
}, customerName: string): InvoiceListRow {
  return {
    invoiceId: row.canonical_invoice_id!, invoiceNumber: row.effective_invoice_number!, businessDate: row.business_date!, recordedAt: row.recorded_at,
    customerId: row.effective_customer_id, customerName, totalDirham: row.effective_total_dirham!, paidDirham: row.effective_paid_dirham!,
    creditAppliedDirham: row.effective_credit_applied_dirham ?? 0, dueDirham: row.effective_due_dirham!, delivery: deliveryStatus(row.delivery_status),
    // ponytail: misses a correction chain that lands back on the recorded total; a per-page correction_decisions read would catch it.
    revision: row.revision ?? 0, corrected: row.effective_total_dirham !== row.original_total_dirham,
    isVoid: row.is_void === true,
  };
}

const INVOICE_COLUMNS = "canonical_invoice_id,effective_invoice_number,business_date,recorded_at,effective_total_dirham,effective_paid_dirham,effective_credit_applied_dirham,effective_due_dirham,delivery_status,effective_customer_id,revision,original_total_dirham,is_void";

async function customerNames(supabase: Client, shopId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return names;
  const { data, error } = await supabase.from("customers").select("id,name").eq("shop_id", shopId).in("id", uniqueIds);
  if (error || !data) throw new Error("INVOICE_LIST_UNAVAILABLE");
  for (const customer of data) names.set(customer.id, customer.name ?? "");
  return names;
}

/**
 * One deterministically-ordered, deterministically-paginated page of invoice
 * history: newest business date first, then newest recorded time, then the
 * canonical ID as a stable tiebreaker. Server-side filtered — never an
 * unbounded fetch filtered in the browser.
 */
export async function fetchInvoiceList(supabase: Client, shopId: string, filter: InvoiceListFilter): Promise<{ rows: InvoiceListRow[]; hasMore: boolean }> {
  let request = supabase.from("effective_invoices").select(INVOICE_COLUMNS).eq("shop_id", shopId)
    .gte("business_date", filter.from).lte("business_date", filter.to);
  // delivery_status, not effective_delivered: a partially delivered invoice is neither Delivered nor Not delivered.
  if (filter.status === "delivered" || filter.status === "partial") request = request.eq("delivery_status", filter.status === "delivered" ? "full" : "partial");
  else if (filter.status === "advance") request = request.eq("delivery_status", "none");
  else if (filter.status === "with_due") request = request.gt("effective_due_dirham", 0);
  // A void invoice has no due, but it was not paid either.
  else if (filter.status === "fully_paid") request = request.lte("effective_due_dirham", 0).eq("is_void", false);
  const { data, error } = await request
    .order("business_date", { ascending: false }).order("recorded_at", { ascending: false }).order("canonical_invoice_id", { ascending: false })
    .range(filter.offset, filter.offset + INVOICE_PAGE_SIZE);
  if (error || !data) throw new Error("INVOICE_LIST_UNAVAILABLE");
  const page = data.slice(0, INVOICE_PAGE_SIZE);
  const names = await customerNames(supabase, shopId, page.flatMap((row) => row.effective_customer_id ? [row.effective_customer_id] : []));
  return {
    hasMore: data.length > INVOICE_PAGE_SIZE,
    rows: page.map((row) => mapRow(row, row.effective_customer_id ? names.get(row.effective_customer_id) ?? "" : "")),
  };
}

/**
 * Exact normalized invoice-number lookup, reusing the same registry path as
 * invoice payment lookup. This is how a search finds an invoice outside the
 * default 30-day window: it never scans the date-filtered page above. Shop
 * scoped throughout, so a number that exists only in another shop returns
 * null rather than revealing that it exists.
 */
export async function findInvoiceByNumber(supabase: Client, shopId: string, rawNumber: string): Promise<InvoiceListRow | null> {
  const normalized = normalizeInvoiceNumber(rawNumber);
  const { data: registered, error: registryError } = await supabase.from("invoice_number_registry")
    .select("canonical_invoice_id").eq("shop_id", shopId).eq("normalized_invoice_number", normalized).maybeSingle();
  if (registryError) throw new Error("INVOICE_LIST_UNAVAILABLE");
  if (!registered) return null;
  const { data, error } = await supabase.from("effective_invoices").select(INVOICE_COLUMNS)
    .eq("shop_id", shopId).eq("canonical_invoice_id", registered.canonical_invoice_id).maybeSingle();
  if (error) throw new Error("INVOICE_LIST_UNAVAILABLE");
  if (!data) return null;
  const names = await customerNames(supabase, shopId, data.effective_customer_id ? [data.effective_customer_id] : []);
  return mapRow(data, data.effective_customer_id ? names.get(data.effective_customer_id) ?? "" : "");
}
