import { describe, expect, it } from "vitest";

import { invoiceKey } from "@/lib/domain/ids";
import { invoiceState } from "@/lib/domain/invoices";

describe("invoice identity", () => {
  it("scopes an invoice ID by shop", () => {
    expect(invoiceKey("shop-1", "8704")).not.toBe(
      invoiceKey("shop-2", "8704"),
    );
    expect(invoiceKey("shop-1", "8704")).toBe(
      invoiceKey("shop-1", "8704"),
    );
  });
});

describe("invoice lifecycle", () => {
  it("treats Readymade invoices as delivered automatically", () => {
    expect(
      invoiceState({
        type: "READYMADE",
        total: 12550,
        received: 12550,
        delivered: false,
      }),
    ).toBe("DELIVERED_PAID");
  });
});
