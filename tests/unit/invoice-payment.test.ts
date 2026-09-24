import { describe, expect, it } from "vitest";

import { isValidPaymentReceipt, preparePaymentAttempt } from "@/lib/invoice-payment";

const invoice = {
  shopId: "10000000-0000-4000-8000-000000000001",
  invoiceId: "20000000-0000-4000-8000-000000000001",
  invoiceNumber: "INV-42",
  amount: "25.50",
  idempotencyKey: "30000000-0000-4000-8000-000000000001",
};

describe("follow-up payment command", () => {
  it("prepares a partial cash payment using the canonical invoice UUID", () => {
    const result = preparePaymentAttempt(invoice, 5000, new Date("2026-09-24T20:59:00.000Z"));
    expect(result).toEqual({
      command: {
        shop_id: invoice.shopId,
        invoice_id: invoice.invoiceId,
        amount_dirham: 2550,
        payment_method: "cash",
        business_date: "2026-09-24",
        idempotency_key: invoice.idempotencyKey,
      },
      error: null,
    });
  });

  it("allows an exact full payment and rejects zero or overpayment", () => {
    expect(preparePaymentAttempt({ ...invoice, amount: "50.00" }, 5000, new Date()).error).toBeNull();
    expect(preparePaymentAttempt({ ...invoice, amount: "0" }, 5000, new Date()).error).toMatch(/positive/i);
    expect(preparePaymentAttempt({ ...invoice, amount: "50.01" }, 5000, new Date()).error).toMatch(/due/i);
    expect(preparePaymentAttempt(invoice, 0, new Date()).error).toMatch(/no amount due/i);
  });

  it("uses Qatar's date after UTC midnight and preserves an uncertain command on retry", () => {
    const first = preparePaymentAttempt(invoice, 5000, new Date("2026-09-24T20:59:00.000Z"));
    const retry = preparePaymentAttempt({ ...invoice, amount: "30.00" }, 4000,
      new Date("2026-09-24T21:01:00.000Z"), first.command);
    expect(first.command?.business_date).toBe("2026-09-24");
    expect(retry.command).toBe(first.command);
  });

  it("accepts only a complete receipt for the canonical invoice", () => {
    const receipt = {
      ok: true,
      payment_id: "40000000-0000-4000-8000-000000000001",
      invoice_id: invoice.invoiceId,
      effective_paid: 2550,
      effective_due: 2450,
    };
    expect(isValidPaymentReceipt(receipt, invoice.invoiceId)).toBe(true);
    expect(isValidPaymentReceipt({ ...receipt, invoice_id: "50000000-0000-4000-8000-000000000001" }, invoice.invoiceId)).toBe(false);
    expect(isValidPaymentReceipt({ ...receipt, effective_due: "2450" }, invoice.invoiceId)).toBe(false);
    expect(isValidPaymentReceipt({ ok: true }, invoice.invoiceId)).toBe(false);
  });
});
