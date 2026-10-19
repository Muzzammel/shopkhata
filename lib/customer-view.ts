import { qatarBusinessDate } from "@/lib/invoice-entry";
import type { CustomerLedgerSource } from "@/lib/customer-operations";

// View-only helpers for the Customers screens. Nothing here computes a balance the database does
// not already hold: due and available credit come from customer_financial_balances, invoice figures
// from effective_invoices, and the running balance from runningLedger over customer_ledger rows.

export const CUSTOMER_TABS = ["overview", "invoices", "payments", "credits", "activity"] as const;
export type CustomerTab = (typeof CUSTOMER_TABS)[number];

export type BalanceStatus = "due" | "credit" | "clear";
export const BALANCE_LABEL: Record<BalanceStatus, string> = { due: "Due", credit: "Credit available", clear: "Clear balance" };

/** Factual states only: there is no approved threshold for "high due", "VIP" or "inactive". */
export function balanceStatuses(balance: { dueDirham: number; creditDirham: number }): BalanceStatus[] {
  const states: BalanceStatus[] = [];
  if (balance.dueDirham > 0) states.push("due");
  if (balance.creditDirham > 0) states.push("credit");
  return states.length ? states : ["clear"];
}

export type CustomerInvoice = {
  invoiceId: string; invoiceNumber: string; businessDate: string;
  totalDirham: number; paidDirham: number; creditAppliedDirham: number; dueDirham: number;
  delivered: boolean; revision: number; corrected: boolean;
};

/** Sums of this customer's effective invoices, all dates. Due equals the balance view's own sum of the same rows. */
export function customerTotals(invoices: readonly CustomerInvoice[]) {
  return invoices.reduce((sum, invoice) => ({
    salesDirham: sum.salesDirham + invoice.totalDirham,
    paidDirham: sum.paidDirham + invoice.paidDirham,
    creditAppliedDirham: sum.creditAppliedDirham + invoice.creditAppliedDirham,
  }), { salesDirham: 0, paidDirham: 0, creditAppliedDirham: 0 });
}

export type LedgerEntry = CustomerLedgerSource & { balanceDirham: number };

/**
 * The ledger in order with its running due, as mapCustomerLedger builds it, except that rows sharing
 * a business date and recorded time put debits first. A sale and its receipt are written in one
 * transaction with one timestamp; ordering them by id alone could show a passing negative due.
 * The final balance is the same either way.
 */
export function runningLedger(rows: readonly CustomerLedgerSource[]): LedgerEntry[] {
  let balanceDirham = 0;
  return [...rows]
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate) || a.recordedAt.localeCompare(b.recordedAt)
      || Number(b.debitDirham > 0) - Number(a.debitDirham > 0) || a.sequenceId.localeCompare(b.sequenceId))
    .map((row) => { balanceDirham += row.debitDirham - row.creditDirham; return { ...row, balanceDirham }; });
}
export type PaymentMeta = { batchId: string | null; method: string };
export type Allocation = { invoiceId: string; invoiceNumber: string; amountDirham: number };

export type PaymentGroup = {
  id: string; kind: "payment" | "overpayment" | "correction"; businessDate: string; recordedAt: string; actorId: string | null;
  /** Signed: a correction that reduces a payment is negative. */
  amountDirham: number;
  method: string | null;
  /** Overpayment only: the excess kept as customer credit. It is not counted as paid. */
  creditDirham?: number;
  /** One customer payment can settle several invoices; each share is listed, never collapsed into one label. */
  allocations: Allocation[];
  balanceAfterDirham: number;
};

/**
 * Payments as the customer made them: rows that one customer payment wrote across several invoices
 * (same customer_payment_batch_id) become one entry with its allocations. An approved overpayment
 * writes a payment for the applied part and a credit for the excess with one timestamp; the pair is
 * shown as one overpayment. Newest first.
 */
export function groupPayments(ledger: readonly LedgerEntry[], meta: ReadonlyMap<string, PaymentMeta>, credits: readonly CustomerCredit[] = []): PaymentGroup[] {
  const overpaid = (entry: LedgerEntry) => credits.find((credit) => credit.sourceInvoiceId === entry.invoiceId && Date.parse(credit.recordedAt) === Date.parse(entry.recordedAt));
  const groups = new Map<string, PaymentGroup>();
  for (const entry of ledger) {
    if (entry.type !== "payment" && entry.type !== "payment_correction") continue;
    const info = meta.get(entry.sequenceId);
    const key = entry.type === "payment" && info?.batchId ? `batch:${info.batchId}` : entry.sequenceId;
    const share = { invoiceId: entry.invoiceId, invoiceNumber: entry.invoiceNumber ?? entry.reference, amountDirham: entry.creditDirham - entry.debitDirham };
    const group = groups.get(key);
    if (group) {
      group.amountDirham += share.amountDirham;
      group.allocations.push(share);
      group.balanceAfterDirham = entry.balanceDirham; // ledger order: the last share leaves the balance
    } else {
      const credit = entry.type === "payment" && !info?.batchId ? overpaid(entry) : undefined;
      groups.set(key, {
        id: key, kind: entry.type === "payment_correction" ? "correction" : credit ? "overpayment" : "payment", creditDirham: credit?.amountDirham, businessDate: entry.businessDate, recordedAt: entry.recordedAt,
        actorId: entry.actorName, amountDirham: share.amountDirham, method: entry.type === "payment" ? info?.method ?? null : null,
        allocations: [share], balanceAfterDirham: entry.balanceDirham,
      });
    }
  }
  return [...groups.values()].reverse();
}

export type CustomerCredit = {
  id: string; amountDirham: number; usedDirham: number; businessDate: string; recordedAt: string;
  reason: string | null; sourceInvoiceId: string | null; approvedBy: string | null;
};

export type ActivityKind = "customer" | "invoice" | "payment" | "invoice_correction" | "payment_correction" | "credit_issued" | "credit_application";
export type ActivityEvent = {
  id: string; kind: ActivityKind; title: string; businessDate: string; recordedAt: string; actorId: string | null;
  /** Effect on the amount owed: positive raises due, negative lowers it. Absent when the event does not move the balance. */
  dueEffectDirham?: number;
  /** Amount shown for events that do not move due (credit issued). */
  amountDirham?: number;
  invoices: { invoiceId: string; invoiceNumber: string }[];
  balanceAfterDirham?: number;
  note?: string;
};

const TITLE: Record<Exclude<LedgerEntry["type"], "payment">, string> = {
  invoice: "Invoice recorded", invoice_correction: "Invoice correction approved", payment_correction: "Payment correction approved", credit_application: "Credit applied",
};

/**
 * Everything the read model can prove happened to this customer, newest first. Ledger events keep
 * the ledger's own order (business date, then recorded time), so each running balance reads true.
 * Replacements and delivery changes are not in the customer ledger; they stay on Invoice Detail.
 */
export function buildActivity({ ledger, meta, credits, customerCreatedAt, customerCreatedBy }: {
  ledger: readonly LedgerEntry[]; meta: ReadonlyMap<string, PaymentMeta>; credits: readonly CustomerCredit[];
  customerCreatedAt: string; customerCreatedBy: string | null;
}): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const emitted = new Set<string>();
  // An overpayment that applied nothing to the invoice is told by its "Credit issued" event alone.
  const payments = new Map(groupPayments(ledger, meta, credits).filter((group) => group.kind !== "correction" && group.amountDirham !== 0).map((group) => [group.id, group]));
  for (const entry of ledger) {
    if (entry.type === "payment") {
      const batchId = meta.get(entry.sequenceId)?.batchId;
      const group = payments.get(batchId ? `batch:${batchId}` : entry.sequenceId);
      if (!group || emitted.has(group.id)) continue;
      emitted.add(group.id);
      events.push({
        id: group.id, kind: "payment", title: "Payment received", businessDate: group.businessDate, recordedAt: group.recordedAt, actorId: group.actorId,
        dueEffectDirham: -group.amountDirham, invoices: group.allocations.map(({ invoiceId, invoiceNumber }) => ({ invoiceId, invoiceNumber })),
        balanceAfterDirham: group.balanceAfterDirham,
        note: [group.method && `${group.method[0].toUpperCase()}${group.method.slice(1)}`, group.creditDirham && "excess kept as credit"].filter(Boolean).join(" · ") || undefined,
      });
      continue;
    }
    events.push({
      id: entry.sequenceId, kind: entry.type, title: TITLE[entry.type], businessDate: entry.businessDate, recordedAt: entry.recordedAt, actorId: entry.actorName,
      dueEffectDirham: entry.debitDirham - entry.creditDirham, invoices: [{ invoiceId: entry.invoiceId, invoiceNumber: entry.invoiceNumber ?? entry.reference }],
      balanceAfterDirham: entry.balanceDirham,
    });
  }
  for (const credit of credits) {
    events.push({
      id: `credit-${credit.id}`, kind: "credit_issued", title: "Credit issued", businessDate: credit.businessDate, recordedAt: credit.recordedAt,
      actorId: credit.approvedBy, amountDirham: credit.amountDirham, invoices: [], note: credit.reason || "Approved overpayment",
    });
  }
  const order = new Map(events.map((event, index) => [event.id, index]));
  events.sort((a, b) => b.businessDate.localeCompare(a.businessDate) || b.recordedAt.localeCompare(a.recordedAt) || order.get(b.id)! - order.get(a.id)!);
  // The record starts the story even when sales were later entered with earlier business dates.
  events.push({ id: "customer-created", kind: "customer", title: "Customer added", businessDate: qatarBusinessDate(new Date(customerCreatedAt)), recordedAt: customerCreatedAt, actorId: customerCreatedBy, invoices: [] });
  return events;
}
