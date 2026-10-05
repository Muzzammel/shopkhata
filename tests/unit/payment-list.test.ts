import { describe, expect, it } from "vitest";

import { parsePaymentListFilter } from "@/lib/payment-list";

describe("parsePaymentListFilter", () => {
  const today = "2026-10-04";
  it("defaults to the last 30 days with no invoice search and offset 0", () => {
    expect(parsePaymentListFilter({}, today)).toEqual({ from: "2026-09-05", to: "2026-10-04", invoiceQuery: "", offset: 0, error: null });
  });
  it("trims and bounds the invoice search text", () => {
    expect(parsePaymentListFilter({ invoice: "  INV-1  " }, today).invoiceQuery).toBe("INV-1");
    expect(parsePaymentListFilter({ invoice: "x".repeat(200) }, today).invoiceQuery).toHaveLength(120);
  });
  it("clamps the offset", () => {
    expect(parsePaymentListFilter({ offset: "-10" }, today).offset).toBe(0);
    expect(parsePaymentListFilter({ offset: "999999999" }, today).offset).toBe(100_000);
  });
});
