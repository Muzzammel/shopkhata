import { describe, expect, it } from "vitest";

import { INVOICE_STATUSES, parseInvoiceListFilter } from "@/lib/invoice-list";

describe("parseInvoiceListFilter", () => {
  const today = "2026-10-04";
  it("defaults to the last 30 days, status all, offset 0", () => {
    expect(parseInvoiceListFilter({}, today)).toEqual({ from: "2026-09-05", to: "2026-10-04", status: "all", offset: 0, error: null });
  });
  it("accepts a known status and ignores an unknown one", () => {
    expect(parseInvoiceListFilter({ status: "fully_paid" }, today).status).toBe("fully_paid");
    expect(parseInvoiceListFilter({ status: "bogus" }, today).status).toBe("all");
    expect(INVOICE_STATUSES).toContain("with_due");
  });
  it("clamps a negative or absurd offset back into range", () => {
    expect(parseInvoiceListFilter({ offset: "-5" }, today).offset).toBe(0);
    expect(parseInvoiceListFilter({ offset: "30" }, today).offset).toBe(30);
    expect(parseInvoiceListFilter({ offset: "not-a-number" }, today).offset).toBe(0);
  });
  it("carries a custom range and its validation through from parseDateRangeFilter", () => {
    expect(parseInvoiceListFilter({ from: "2026-10-03", to: "2026-10-01" }, today).error).toBe("The start date must not be after the end date.");
  });
});
