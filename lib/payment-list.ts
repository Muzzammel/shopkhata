import type { SupabaseClient } from "@supabase/supabase-js";

import { first, parseDateRangeFilter, type DateRangeFilter } from "@/lib/date-range";
import { normalizeInvoiceNumber } from "@/lib/invoice-operations";
import { PAYMENT_SOURCES, type PaymentSource } from "@/lib/reports";
import type { Database } from "@/lib/supabase/database.types";

type Client = SupabaseClient<Database>;

// The Payments page's history browser, over report_payments — the same
// one-row-per-money-movement view Reports already uses. A correction is its
// own row dated on its approval day; it is never folded back into the
// original payment, so the effective picture always comes from reading both
// rows rather than mutating either one.

export const PAYMENT_PAGE_SIZE = 30;
const PAYMENT_COLUMNS = "entry_id,business_date,recorded_at,source,method,amount_dirham,invoice_id,created_by,reference";
type PaymentRow = { entry_id: string | null; business_date: string | null; recorded_at: string | null; source: string | null; method: string | null; amount_dirham: number | null; invoice_id: string | null; created_by: string | null; reference: string | null };

export type PaymentListFilter = DateRangeFilter & { invoiceQuery: string; offset: number };

export function parsePaymentListFilter(query: Record<string, string | string[] | undefined>, today: string): PaymentListFilter {
  const invoiceQuery = (first(query.invoice) ?? "").trim().slice(0, 120);
  const rawOffset = first(query.offset);
  const offset = Math.max(0, Math.min(100_000, Number.parseInt(rawOffset ?? "0", 10) || 0));
  return { ...parseDateRangeFilter(query, today), invoiceQuery, offset };
}

export type PaymentListRow = {
  entryId: string; businessDate: string; recordedAt: string | null; source: PaymentSource; method: string; amountDirham: number;
  invoiceId: string | null; invoiceNumber: string; customerId: string | null; customerName: string; createdByName: string; reference: string;
};

async function enrich(supabase: Client, shopId: string, rows: readonly PaymentRow[]): Promise<PaymentListRow[]> {
  const invoiceIds = [...new Set(rows.flatMap((row) => row.invoice_id ? [row.invoice_id] : []))];
  const invoices = new Map<string, { number: string; customerId: string | null }>();
  if (invoiceIds.length) {
    const { data, error } = await supabase.from("effective_invoices")
      .select("canonical_invoice_id,effective_invoice_number,effective_customer_id").eq("shop_id", shopId).in("canonical_invoice_id", invoiceIds);
    if (error || !data) throw new Error("PAYMENT_LIST_UNAVAILABLE");
    for (const invoice of data) invoices.set(invoice.canonical_invoice_id!, { number: invoice.effective_invoice_number!, customerId: invoice.effective_customer_id });
  }
  const customerIds = [...new Set([...invoices.values()].flatMap((invoice) => invoice.customerId ? [invoice.customerId] : []))];
  const customerNames = new Map<string, string>();
  if (customerIds.length) {
    const { data, error } = await supabase.from("customers").select("id,name,public_id").eq("shop_id", shopId).in("id", customerIds);
    if (error || !data) throw new Error("PAYMENT_LIST_UNAVAILABLE");
    for (const customer of data) customerNames.set(customer.id, customer.name || customer.public_id);
  }
  const actorIds = [...new Set(rows.flatMap((row) => row.created_by ? [row.created_by] : []))];
  const actorNames = new Map<string, string>();
  if (actorIds.length) {
    // RLS restricts staff to their own profile; another actor falls back to their ID below.
    const { data } = await supabase.from("profiles").select("id,display_name").in("id", actorIds);
    for (const profile of data ?? []) actorNames.set(profile.id, profile.display_name);
  }
  return rows.map((row) => {
    const invoice = row.invoice_id ? invoices.get(row.invoice_id) : undefined;
    return {
      entryId: row.entry_id!, businessDate: row.business_date!, recordedAt: row.recorded_at, source: row.source as PaymentSource, method: row.method!,
      amountDirham: row.amount_dirham!, invoiceId: row.invoice_id, invoiceNumber: invoice?.number ?? "",
      customerId: invoice?.customerId ?? null, customerName: invoice?.customerId ? customerNames.get(invoice.customerId) ?? "" : "",
      createdByName: row.created_by ? actorNames.get(row.created_by) ?? row.created_by : "", reference: row.reference ?? "",
    };
  });
}

/**
 * One deterministically-ordered, deterministically-paginated page of payment
 * history. An invoice-number search (exact, normalized, shop-scoped — the
 * same registry lookup the rest of the app uses) ignores the date range, the
 * same way invoice search does, because a follow-up payment can land on a
 * much later business date than its invoice.
 */
export async function fetchPaymentList(supabase: Client, shopId: string, filter: PaymentListFilter): Promise<{ rows: PaymentListRow[]; hasMore: boolean }> {
  let request = supabase.from("report_payments").select(PAYMENT_COLUMNS).eq("shop_id", shopId);
  if (filter.invoiceQuery) {
    const { data: registered, error } = await supabase.from("invoice_number_registry")
      .select("canonical_invoice_id").eq("shop_id", shopId).eq("normalized_invoice_number", normalizeInvoiceNumber(filter.invoiceQuery)).maybeSingle();
    if (error) throw new Error("PAYMENT_LIST_UNAVAILABLE");
    // A non-matching search intentionally resolves to "no rows", not to every payment.
    request = request.eq("invoice_id", registered?.canonical_invoice_id ?? "00000000-0000-0000-0000-000000000000");
  } else {
    request = request.gte("business_date", filter.from).lte("business_date", filter.to);
  }
  const { data, error } = await request
    .order("business_date", { ascending: false }).order("recorded_at", { ascending: false }).order("entry_id", { ascending: false })
    .range(filter.offset, filter.offset + PAYMENT_PAGE_SIZE);
  if (error || !data) throw new Error("PAYMENT_LIST_UNAVAILABLE");
  const page = data.slice(0, PAYMENT_PAGE_SIZE);
  return { hasMore: data.length > PAYMENT_PAGE_SIZE, rows: await enrich(supabase, shopId, page) };
}

/** Sibling rows sharing one customer-payment batch reference, for FIFO allocation detail across invoices. */
export async function fetchPaymentAllocation(supabase: Client, shopId: string, reference: string): Promise<PaymentListRow[]> {
  const { data, error } = await supabase.from("report_payments").select(PAYMENT_COLUMNS)
    .eq("shop_id", shopId).eq("reference", reference).order("recorded_at").order("entry_id").limit(200);
  if (error || !data) throw new Error("PAYMENT_LIST_UNAVAILABLE");
  return enrich(supabase, shopId, data);
}

export { PAYMENT_SOURCES };
