import { describe, expect, it } from "vitest";

import { isPaymentMethod, PAYMENT_METHODS, paymentMethodLabel } from "@/lib/payment-method";

describe("payment methods", () => {
  it("supports exactly cash and bank", () => {
    expect([...PAYMENT_METHODS]).toEqual(["cash", "bank"]);
    expect(["cash", "bank"].every(isPaymentMethod)).toBe(true);
    for (const other of ["card", "cheque", "wallet", "credit", "Cash", "", null, undefined, 5]) expect(isPaymentMethod(other)).toBe(false);
  });

  it("labels each method, keeps applied credit distinct and defaults a missing method to cash", () => {
    expect(paymentMethodLabel("cash")).toBe("Cash");
    expect(paymentMethodLabel("bank")).toBe("Bank");
    expect(paymentMethodLabel("credit")).toBe("Customer credit");
    expect(paymentMethodLabel(null)).toBe("Cash");
  });
});
