import type { Actor } from "@/lib/auth/permissions";
import { can } from "@/lib/auth/permissions";
import type { CustomerLedgerSource } from "@/lib/customer-operations";
import { runningLedger, type CustomerCredit, type CustomerInvoice, type LedgerEntry, type PaymentMeta } from "@/lib/customer-view";
import { readAllPages } from "@/lib/read-all-pages";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type CustomerDetail = {
  customer: { id: string; publicId: string; name: string | null; mobile: string | null; createdAt: string; createdBy: string | null };
  shopName: string;
  dueDirham: number;
  creditDirham: number;
  invoiceCount: number;
  lastActivityDate: string | null;
  invoices: CustomerInvoice[];
  ledger: LedgerEntry[];
  /** Method and customer-payment batch of each payment row in the ledger, keyed by payment id. */
  paymentMeta: Map<string, PaymentMeta>;
  credits: CustomerCredit[];
  /** Display names the viewer may read; anyone else stays an anonymised label. */
  people: Record<string, string>;
};

/**
 * The customer page's read model: the same views the page always read (customer_financial_balances,
 * effective_invoices, customer_ledger, approved customer_credits and their applications), plus the
 * payment rows' method and batch so one customer payment is shown with all its allocations.
 * Read-only. Returns null when the customer is not in a shop the actor can see.
 */
export async function readCustomerDetail(actor: Actor, shopId: string, customerId: string): Promise<CustomerDetail | null> {
  if (!can(actor, "records.view_assigned", shopId)) return null;
  const supabase = await createServerSupabaseClient();
  const [{ data: customer, error: customerError }, { data: balance, error: balanceError }, { data: shop }] = await Promise.all([
    supabase.from("customers").select("id,shop_id,public_id,name,mobile,created_at,created_by").eq("shop_id", shopId).eq("id", customerId).maybeSingle(),
    supabase.from("customer_financial_balances").select("outstanding_due_dirham,available_credit_dirham,invoice_count,last_activity_date").eq("shop_id", shopId).eq("customer_id", customerId).maybeSingle(),
    supabase.from("shops").select("name").eq("id", shopId).maybeSingle(),
  ]);
  if (customerError || balanceError || !customer || !balance || customer.shop_id !== shopId) return null;

  const [invoiceResult, ledgerResult, creditResult] = await Promise.all([
    readAllPages((offset, end) => supabase.from("effective_invoices").select("canonical_invoice_id,effective_invoice_number,business_date,effective_total_dirham,effective_paid_dirham,effective_credit_applied_dirham,effective_due_dirham,effective_delivered,revision,original_total_dirham,is_void").eq("shop_id", shopId).eq("effective_customer_id", customerId).order("business_date", { ascending: false }).order("canonical_invoice_id").range(offset, end)),
    readAllPages((offset, end) => supabase.from("customer_ledger").select("business_date,recorded_at,sequence_id,invoice_id,entry_type,reference,invoice_number,actor_id,debit_dirham,credit_dirham").eq("shop_id", shopId).eq("customer_id", customerId).order("business_date").order("recorded_at").order("sequence_id").range(offset, end)),
    readAllPages((offset, end) => supabase.from("customer_credits").select("id,invoice_id,amount_dirham,business_date,recorded_at,reason,approved_by").eq("shop_id", shopId).eq("customer_id", customerId).not("approved_by", "is", null).order("recorded_at", { ascending: false }).range(offset, end)),
  ]);
  if (invoiceResult.error || !invoiceResult.data || ledgerResult.error || !ledgerResult.data || creditResult.error || !creditResult.data) throw new Error("CUSTOMER_HISTORY_UNAVAILABLE");

  const invoices: CustomerInvoice[] = invoiceResult.data.map((i) => ({
    invoiceId: i.canonical_invoice_id!, invoiceNumber: i.effective_invoice_number!, businessDate: i.business_date!,
    totalDirham: i.effective_total_dirham!, paidDirham: i.effective_paid_dirham!, creditAppliedDirham: i.effective_credit_applied_dirham ?? 0,
    dueDirham: i.effective_due_dirham!, delivered: Boolean(i.effective_delivered), revision: i.revision ?? 0,
    // Same rule as the Sales list: only an approved correction can move the effective total off the recorded one.
    corrected: i.effective_total_dirham !== i.original_total_dirham, isVoid: i.is_void === true,
  }));
  const sources: CustomerLedgerSource[] = ledgerResult.data.map((entry) => ({
    businessDate: entry.business_date!, recordedAt: entry.recorded_at!, sequenceId: entry.sequence_id!, invoiceId: entry.invoice_id!,
    type: entry.entry_type as CustomerLedgerSource["type"], reference: entry.reference!, invoiceNumber: entry.invoice_number,
    actorName: entry.actor_id, debitDirham: entry.debit_dirham!, creditDirham: entry.credit_dirham!,
  }));
  const ledger = runningLedger(sources);

  const creditIds = creditResult.data.map((row) => row.id);
  const paymentIds = ledger.filter((entry) => entry.type === "payment").map((entry) => entry.sequenceId);
  const [applications, payments] = await Promise.all([
    readInChunks(creditIds, (ids) => readAllPages((offset, end) => supabase.from("credit_applications").select("credit_id,amount_dirham").eq("shop_id", shopId).in("credit_id", ids).range(offset, end))),
    readInChunks(paymentIds, (ids) => readAllPages((offset, end) => supabase.from("payments").select("id,customer_payment_batch_id,payment_method").eq("shop_id", shopId).in("id", ids).range(offset, end))),
  ]);
  if (!applications) throw new Error("CUSTOMER_CREDIT_HISTORY_UNAVAILABLE");
  if (!payments) throw new Error("CUSTOMER_HISTORY_UNAVAILABLE");
  const used = new Map<string, number>();
  for (const item of applications) used.set(item.credit_id, (used.get(item.credit_id) ?? 0) + item.amount_dirham);
  const credits: CustomerCredit[] = creditResult.data.map((row) => ({
    id: row.id, amountDirham: row.amount_dirham, usedDirham: used.get(row.id) ?? 0, businessDate: row.business_date, recordedAt: row.recorded_at,
    reason: row.reason, sourceInvoiceId: row.invoice_id, approvedBy: row.approved_by,
  }));

  const actorIds = [...new Set([customer.created_by, ...ledger.map((entry) => entry.actorName), ...credits.map((credit) => credit.approvedBy)].filter((id): id is string => Boolean(id)))];
  const people: Record<string, string> = {};
  // Profiles are read under the viewer's own access; staff see only themselves, everyone else keeps the safe label.
  const profiles = await readInChunks(actorIds, async (ids) => supabase.from("profiles").select("id,display_name").in("id", ids));
  for (const profile of profiles ?? []) if (profile.display_name) people[profile.id] = profile.display_name;

  return {
    customer: { id: customer.id, publicId: customer.public_id, name: customer.name, mobile: customer.mobile, createdAt: customer.created_at, createdBy: customer.created_by },
    shopName: shop?.name ?? "Shop",
    dueDirham: balance.outstanding_due_dirham ?? 0,
    creditDirham: balance.available_credit_dirham ?? 0,
    invoiceCount: balance.invoice_count ?? 0,
    lastActivityDate: balance.last_activity_date,
    invoices, ledger,
    paymentMeta: new Map(payments.map((row) => [row.id, { batchId: row.customer_payment_batch_id, method: row.payment_method }])),
    credits, people,
  };
}

// ponytail: 100 ids per request keeps the `in` filter well inside URL limits; no request at all for none.
async function readInChunks<T>(ids: readonly string[], read: (ids: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[] | null> {
  const rows: T[] = [];
  for (let start = 0; start < ids.length; start += 100) {
    const page = await read(ids.slice(start, start + 100));
    if (page.error || !page.data) return null;
    rows.push(...page.data);
  }
  return rows;
}
