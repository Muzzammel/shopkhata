import { describe, expect, it } from "vitest";

import type { InvoiceDetail } from "@/lib/invoice-detail";
import { buildTimeline, invoiceBadges, personLabel } from "@/lib/sales-view";

const base: InvoiceDetail = {
  id: "a9000000-0000-4000-8000-000000000001", shopId: "s", invoiceNumber: "INV-1", originalInvoiceNumber: "INV-1", originalCustomerId: null, originalDelivered: false,
  revision: 0, changes: [], originalTotalDirham: 10000, effectiveTotalDirham: 10000, effectivePaidDirham: 0, effectiveCreditAppliedDirham: 0, effectiveDueDirham: 10000,
  businessDate: "2026-10-01", recordedAt: "2026-10-01T08:00:00Z", createdBy: "u-staff", creatorName: null, delivered: false, pieces: null, customer: null,
  payments: [], corrections: [], people: { "u-owner": "Owner Name" }, customerNames: { "c-1": "Mary · CUS-1" },
};
const change = { reason: "r", amountDelta: null, correctedTotal: null, expectedTotal: null, paymentId: null, invoiceNumber: null, customerId: null, delivered: null, expectedRevision: null, decision: null };

describe("invoice badges", () => {
  it("derives only supported display states", () => {
    expect(invoiceBadges({ dueDirham: 500, delivery: "none", corrected: false, revision: 0 })).toEqual(["due"]);
    expect(invoiceBadges({ dueDirham: 0, delivery: "full", corrected: true, revision: 2 })).toEqual(["paid", "delivered", "corrected", "replaced"]);
    expect(invoiceBadges({ dueDirham: -100, delivery: "none", corrected: false, revision: 0 })).toEqual(["paid"]);
  });
});

describe("invoice timeline", () => {
  it("falls back to a shortened identifier when a name is not readable", () => {
    expect(personLabel({}, "1234567890abcdef")).toBe("Team member …90abcdef");
    expect(personLabel({ a: "Ann" }, "a")).toBe("Ann");
  });

  it("tells the story oldest first, with names, decisions and only the replaced fields that changed", () => {
    const events = buildTimeline({
      ...base,
      payments: [{ id: "p1", amountDirham: 2000, businessDate: "2026-10-02", recordedAt: "2026-10-02T08:00:00Z", paymentMethod: "cash", createdBy: "u-owner", creatorName: "Owner Name" }],
      changes: [
        { ...change, id: "r1", kind: "replacement", requestedBy: "u-staff", requestedAt: "2026-10-03T08:00:00Z", invoiceNumber: "INV-1", customerId: null, delivered: true, expectedRevision: 0,
          decision: { outcome: "approved", actor: "u-owner", at: "2026-10-03T09:00:00Z", reason: null, revision: 1 } },
        { ...change, id: "c1", kind: "correction", requestedBy: "u-staff", requestedAt: "2026-10-04T08:00:00Z", amountDelta: -1000, correctedTotal: 9000, expectedTotal: 10000 },
      ],
      corrections: [{ id: "x1", amountDeltaDirham: -500, reason: "legacy", businessDate: "2026-10-05", recordedAt: "2026-10-05T08:00:00Z", actorId: "u-owner", actorName: "Owner Name", paymentId: null, requestId: null }],
    });
    expect(events.map((e) => e.title)).toEqual(["Invoice recorded", "Payment recorded", "Delivery change requested", "Correction requested", "Correction applied"]);
    expect(events[0].actor).toBe("Team member …u-staff");
    expect(events[2]).toMatchObject({ status: "approved", decidedBy: "Owner Name", version: 1, changes: [{ label: "Delivery", from: "Not delivered", to: "Delivered" }] });
    expect(events[3]).toMatchObject({ status: "pending", changes: [{ label: "Invoice total", from: "QAR 100.00", to: "QAR 90.00" }, { label: "Difference", to: "−QAR 10.00" }] });
  });

  it("does not repeat an approved correction that already appears as its request", () => {
    const events = buildTimeline({
      ...base,
      changes: [{ ...change, id: "c1", kind: "correction", requestedBy: "u-staff", requestedAt: "2026-10-04T08:00:00Z", amountDelta: 1000, correctedTotal: 11000, expectedTotal: 10000,
        decision: { outcome: "approved", actor: "u-owner", at: "2026-10-04T09:00:00Z", reason: "ok", revision: null } }],
      corrections: [{ id: "x1", amountDeltaDirham: 1000, reason: "r", businessDate: "2026-10-04", recordedAt: "2026-10-04T09:00:00Z", actorId: "u-owner", actorName: null, paymentId: null, requestId: "c1" }],
    });
    expect(events.map((e) => e.kind)).toEqual(["created", "correction"]);
  });
});
