import { describe, expect, it } from "vitest";

import { invoiceExportSheet } from "@/lib/excel/exports";
import { DELIVERY_REPORT_LABEL, deliveryStatus } from "@/lib/invoice-delivery";
import { fetchInvoiceList, INVOICE_STATUS_LABELS } from "@/lib/invoice-list";
import { salesReportSheet } from "@/lib/reports";
import { BADGE_LABEL, invoiceBadges } from "@/lib/sales-view";

// Partial delivery step 4. effective_invoices.delivery_status is none|partial|full; legacy invoices arrive as full/none
// from their yes/no flag, so they keep reading Delivered / Not delivered. A partial invoice is never Delivered.
const CASES = [
  { name: "tracked 0 of 100", status: "none", badges: ["due"], cell: "No" },
  { name: "tracked 60 of 100", status: "partial", badges: ["due", "partial"], cell: "Partial" },
  { name: "tracked 100 of 100", status: "full", badges: ["due", "delivered"], cell: "Yes" },
  { name: "legacy delivered", status: "full", badges: ["due", "delivered"], cell: "Yes" },
  { name: "legacy not delivered", status: "none", badges: ["due"], cell: "No" },
] as const;

describe("delivery reporting states", () => {
  it.each(CASES)("$name: badges and export cell", ({ status, badges, cell }) => {
    const delivery = deliveryStatus(status);
    expect(invoiceBadges({ dueDirham: 10000, delivery, corrected: false, revision: 0 })).toEqual(badges);
    const row = { invoiceNumber: "A", businessDate: "2026-11-12", totalDirham: 10000, paidDirham: 0, creditAppliedDirham: 0, dueDirham: 10000,
      delivery, customerName: "", customerMobile: "", recordedAt: null, originalNumber: "A", invoiceId: "x", originalTotalDirham: 10000 };
    expect(invoiceExportSheet([row]).data[1][6]).toBe(cell);
  });

  it("labels: partial is its own state; legacy rows keep Delivered / Not delivered", () => {
    expect(BADGE_LABEL.partial).toBe("Partially delivered");
    expect(BADGE_LABEL.delivered).toBe("Delivered");
    expect(DELIVERY_REPORT_LABEL).toEqual({ none: "Not delivered", partial: "Partially delivered", full: "Delivered" });
    expect(INVOICE_STATUS_LABELS.partial).toBe("Partially delivered");
    expect(deliveryStatus(null)).toBe("none");
  });

  it("payment status stays independent: a paid partial invoice is Paid + Partially delivered", () => {
    expect(invoiceBadges({ dueDirham: 0, delivery: "partial", corrected: false, revision: 0 })).toEqual(["paid", "partial"]);
  });

  it("sales report sheet: per-row delivery cell and a three-way summary", () => {
    const current = { totalDirham: 100, paidDirham: 0, creditAppliedDirham: 0, dueDirham: 100, delivery: "partial" as const, isVoid: false };
    const sheet = salesReportSheet([{ movementId: "m", movement: "sale", businessDate: "2026-11-12", recordedAt: null, amountDirham: 100, invoiceId: "i", invoiceNumber: "A", customerName: "", current }],
      { invoiceCount: 5, grossSalesDirham: 500, salesCorrectionsDirham: 0, netSalesDirham: 500, paidDirham: 0, creditAppliedDirham: 0, dueDirham: 500, deliveredCount: 2, partiallyDeliveredCount: 1, undeliveredCount: 2 });
    expect(sheet.data[1][10]).toBe("Partial");
    expect(sheet.data.at(-1)?.[10]).toBe("2 delivered, 1 partially delivered, 2 not delivered");
  });
});

describe("invoice list delivery filters", () => {
  // Records the filter calls the list sends; the shop and date filters must stay on every request.
  function client(calls: string[]) {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "gte", "lte", "gt", "order", "in"]) {
      builder[method] = (...args: unknown[]) => { calls.push(`${method}:${args.join("=")}`); return builder; };
    }
    builder.range = async () => ({ data: [], error: null });
    return { from: () => builder } as never;
  }
  it.each([["delivered", "full"], ["partial", "partial"], ["advance", "none"]] as const)("%s filters delivery_status = %s", async (status, value) => {
    const calls: string[] = [];
    await fetchInvoiceList(client(calls), "shop-1", { from: "2026-11-01", to: "2026-11-12", status, offset: 0, error: null });
    expect(calls).toEqual(expect.arrayContaining(["eq:shop_id=shop-1", "gte:business_date=2026-11-01", "lte:business_date=2026-11-12", `eq:delivery_status=${value}`]));
    expect(calls.some((call) => call.startsWith("eq:effective_delivered"))).toBe(false);
  });
});
