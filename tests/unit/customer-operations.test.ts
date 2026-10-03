import { describe, expect, it } from "vitest";
import { mapCustomerLedger, previewCustomerPaymentAllocation } from "@/lib/customer-operations";

describe("previewCustomerPaymentAllocation", () => {
  it("allocates oldest business date first and uses canonical id as tie breaker", () => {
    expect(previewCustomerPaymentAllocation([
      { invoiceId: "b", invoiceNumber: "INV-B", businessDate: "2026-10-01", dueDirham: 200 },
      { invoiceId: "a", invoiceNumber: "INV-A", businessDate: "2026-10-01", dueDirham: 300 },
      { invoiceId: "c", invoiceNumber: "INV-C", businessDate: "2026-09-30", dueDirham: 100 },
    ], 350)).toEqual([
      { invoiceId: "c", invoiceNumber: "INV-C", amountDirham: 100, dueBeforeDirham: 100, dueAfterDirham: 0 },
      { invoiceId: "a", invoiceNumber: "INV-A", amountDirham: 250, dueBeforeDirham: 300, dueAfterDirham: 50 },
    ]);
  });

  it("rejects non-positive, fractional, unsafe, or excessive payments", () => {
    const invoices = [{ invoiceId: "a", invoiceNumber: "INV-A", businessDate: "2026-10-01", dueDirham: 10 }];
    expect(() => previewCustomerPaymentAllocation(invoices, 0)).toThrow();
    expect(() => previewCustomerPaymentAllocation(invoices, 1.5)).toThrow();
    expect(() => previewCustomerPaymentAllocation(invoices, Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => previewCustomerPaymentAllocation(invoices, 11)).toThrow();
  });
});

describe("mapCustomerLedger", () => {
  it("sorts by business time and computes one deterministic running due", () => {
    const ledger = mapCustomerLedger([
      { businessDate: "2026-10-02", recordedAt: "2026-10-02T08:00:00Z", sequenceId: "p1", invoiceId: "i1", type: "payment", reference: "INV-1", invoiceNumber: "INV-1", actorName: "Staff", debitDirham: 0, creditDirham: 40 },
      { businessDate: "2026-10-01", recordedAt: "2026-10-01T08:00:00Z", sequenceId: "i1", invoiceId: "i1", type: "invoice", reference: "INV-1", invoiceNumber: "INV-1", actorName: "Staff", debitDirham: 100, creditDirham: 0 },
    ]);
    expect(ledger.map((entry) => [entry.sequenceId, entry.balanceDirham])).toEqual([["i1", 100], ["p1", 60]]);
  });
});
