import { describe, expect, it } from "vitest";

import { mapCustomerLedger, type CustomerLedgerSource } from "@/lib/customer-operations";
import { balanceStatuses, buildActivity, customerTotals, groupPayments, runningLedger, type PaymentMeta } from "@/lib/customer-view";

const row = (over: Partial<CustomerLedgerSource> & Pick<CustomerLedgerSource, "sequenceId" | "type">): CustomerLedgerSource => ({
  businessDate: "2026-10-01", recordedAt: "2026-10-01T08:00:00Z", invoiceId: "inv-a", reference: "A", invoiceNumber: "A", actorName: "u-1", debitDirham: 0, creditDirham: 0, ...over,
});

// Two invoices (A 300, B 200), then one customer payment of 400 that the database split A 300 / B 100.
const ledger = mapCustomerLedger([
  row({ sequenceId: "i-a", type: "invoice", debitDirham: 300 }),
  row({ sequenceId: "i-b", type: "invoice", invoiceId: "inv-b", reference: "B", invoiceNumber: "B", debitDirham: 200, recordedAt: "2026-10-01T09:00:00Z" }),
  row({ sequenceId: "p-1", type: "payment", creditDirham: 300, businessDate: "2026-10-02", recordedAt: "2026-10-02T08:00:00Z" }),
  row({ sequenceId: "p-2", type: "payment", invoiceId: "inv-b", reference: "B", invoiceNumber: "B", creditDirham: 100, businessDate: "2026-10-02", recordedAt: "2026-10-02T08:00:00Z" }),
  row({ sequenceId: "pc-1", type: "payment_correction", invoiceId: "inv-b", reference: "B", invoiceNumber: "B", debitDirham: 50, businessDate: "2026-10-03", recordedAt: "2026-10-03T08:00:00Z" }),
]);
const meta = new Map<string, PaymentMeta>([["p-1", { batchId: "batch-1", method: "cash" }], ["p-2", { batchId: "batch-1", method: "cash" }]]);

describe("customer view", () => {
  it("states balances factually, never inventing a tier", () => {
    expect(balanceStatuses({ dueDirham: 0, creditDirham: 0 })).toEqual(["clear"]);
    expect(balanceStatuses({ dueDirham: 5, creditDirham: 0 })).toEqual(["due"]);
    expect(balanceStatuses({ dueDirham: 5, creditDirham: 7 })).toEqual(["due", "credit"]);
  });

  it("sums effective invoice figures without touching due", () => {
    const invoice = { invoiceId: "a", invoiceNumber: "A", businessDate: "2026-10-01", delivery: "full" as const, revision: 0, corrected: false };
    expect(customerTotals([{ ...invoice, totalDirham: 300, paidDirham: 100, creditAppliedDirham: 50, dueDirham: 150 }, { ...invoice, invoiceId: "b", totalDirham: 200, paidDirham: 200, creditAppliedDirham: 0, dueDirham: 0 }]))
      .toEqual({ salesDirham: 500, paidDirham: 300, creditAppliedDirham: 50 });
  });

  it("shows one customer payment with every invoice it settled, and corrections separately", () => {
    const groups = groupPayments(ledger, meta);
    expect(groups).toHaveLength(2);
    const [correction, payment] = groups;
    expect(payment).toMatchObject({ kind: "payment", amountDirham: 400, method: "cash", balanceAfterDirham: 100 });
    expect(payment.allocations).toEqual([{ invoiceId: "inv-a", invoiceNumber: "A", amountDirham: 300 }, { invoiceId: "inv-b", invoiceNumber: "B", amountDirham: 100 }]);
    expect(correction).toMatchObject({ kind: "correction", amountDirham: -50, method: null, balanceAfterDirham: 150 });
  });

  it("keeps separate invoice payments apart when they share no batch", () => {
    expect(groupPayments(ledger, new Map())).toHaveLength(3);
  });

  it("builds activity newest first from proven events only, with the ledger's running due", () => {
    const events = buildActivity({
      ledger, meta, customerCreatedAt: "2026-09-30T07:00:00Z", customerCreatedBy: "u-1",
      credits: [{ id: "c-1", amountDirham: 80, usedDirham: 0, businessDate: "2026-10-04", recordedAt: "2026-10-04T08:00:00Z", reason: null, sourceInvoiceId: "inv-a", approvedBy: "u-owner" }],
    });
    expect(events.map((event) => event.title)).toEqual(["Credit issued", "Payment correction approved", "Payment received", "Invoice recorded", "Invoice recorded", "Customer added"]);
    expect(events[2]).toMatchObject({ dueEffectDirham: -400, balanceAfterDirham: 100, note: "Cash" });
    expect(events[2].invoices.map((invoice) => invoice.invoiceNumber)).toEqual(["A", "B"]);
    expect(events[0]).toMatchObject({ amountDirham: 80, note: "Approved overpayment" });
    expect(events[0].dueEffectDirham).toBeUndefined();
  });

  it("puts a sale before its same-timestamp receipt, so the running due never dips below zero", () => {
    const sale = [row({ sequenceId: "z-invoice", type: "invoice", debitDirham: 500 }), row({ sequenceId: "a-receipt", type: "payment", creditDirham: 200 })];
    expect(runningLedger(sale).map((entry) => entry.balanceDirham)).toEqual([500, 300]);
    expect(mapCustomerLedger(sale).at(-1)!.balanceDirham).toBe(300); // same final balance as the existing helper
  });

  it("shows an approved overpayment as one entry: the applied part, and the excess as credit", () => {
    const at = "2026-10-05T08:00:00.123Z";
    const overpay = runningLedger([row({ sequenceId: "i-c", type: "invoice", invoiceId: "inv-c", debitDirham: 300 }), row({ sequenceId: "r-c", type: "payment", invoiceId: "inv-c", creditDirham: 300 }), row({ sequenceId: "o-c", type: "payment", invoiceId: "inv-c", creditDirham: 0, businessDate: "2026-10-05", recordedAt: at })]);
    const credit = { id: "c-9", amountDirham: 80, usedDirham: 0, businessDate: "2026-10-05", recordedAt: "2026-10-05T08:00:00.123+00:00", reason: null, sourceInvoiceId: "inv-c", approvedBy: "u-1" };
    const [first] = groupPayments(overpay, new Map(), [credit]);
    expect(first).toMatchObject({ kind: "overpayment", amountDirham: 0, creditDirham: 80 });
    const activity = buildActivity({ ledger: overpay, meta: new Map(), credits: [credit], customerCreatedAt: "2026-10-01T07:00:00Z", customerCreatedBy: null });
    expect(activity.map((event) => event.title)).toEqual(["Credit issued", "Payment received", "Invoice recorded", "Customer added"]);
  });
});
