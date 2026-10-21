import { describe, expect, it } from "vitest";

import { isValidBatchReceipt, prepareInvoiceBatch, qatarBusinessDate, selectInvoiceAttempt, type EntryRow } from "@/lib/invoice-entry";

const shopId = "10000000-0000-4000-8000-000000000001";
const base = {
  shopId,
  businessDate: "2026-09-24",
  isBackdated: false,
  backdatedReason: "",
  idempotencyKey: "entry-key-1",
  rows: [
    { rowId: "a", invoiceId: "A-1", total: "100.00", received: "100.00", delivered: true, customerId: "", customerName: "", customerMobile: "" },
    { rowId: "b", invoiceId: "B-1", total: "80.50", received: "20.00", delivered: true, customerId: "", customerName: "Mary", customerMobile: "" },
    { rowId: "c", invoiceId: "C-1", total: "60.00", received: "10.00", delivered: false, customerId: "", customerName: "", customerMobile: "" },
  ],
};

describe("invoice entry command", () => {
  it("prepares a mixed batch in integer dirham with an inline customer", () => {
    const result = prepareInvoiceBatch(base, []);
    expect(result.errors).toEqual([]);
    expect(result.totals).toEqual({ invoiced: 24050, received: 13000, due: 11050 });
    expect(result.command).toEqual({
      shop_id: shopId,
      business_date: "2026-09-24",
      is_backdated: false,
      backdated_reason: null,
      idempotency_key: "entry-key-1",
      rows: [
        { row_id: "a", invoice_number: "A-1", total_dirham: 10000, received_dirham: 10000, payment_method: "cash", delivered: true, customer: null },
        { row_id: "b", invoice_number: "B-1", total_dirham: 8050, received_dirham: 2000, payment_method: "cash", delivered: true, customer: { type: "quick_add", name: "Mary", mobile: null } },
        { row_id: "c", invoice_number: "C-1", total_dirham: 6000, received_dirham: 1000, payment_method: "cash", delivered: false, customer: null },
      ],
    });
  });

  it("blocks the whole batch when a delivered due row has no customer", () => {
    const input = { ...base, rows: base.rows.map((row) => row.rowId === "b" ? { ...row, customerName: "" } : row) };
    const result = prepareInvoiceBatch(input, []);
    expect(result.command).toBeNull();
    expect(result.errors).toContainEqual({ rowId: "b", field: "customer", message: "A customer is required for a delivered invoice with due." });
  });

  it("blocks fractional dirham and a duplicate invoice in the current shop", () => {
    const input = { ...base, rows: [{ ...base.rows[0], total: "100.001" }] };
    const result = prepareInvoiceBatch(input, ["A-1"]);
    expect(result.command).toBeNull();
    expect(result.errors).toEqual(expect.arrayContaining([
      { rowId: "a", field: "total", message: "Enter a positive amount in QAR with at most two decimals." },
      { rowId: "a", field: "invoiceId", message: "Invoice ID already exists in this shop." },
    ]));
  });

  it("lets a committed key replay the identical command through the RPC", () => {
    const result = prepareInvoiceBatch(base, ["A-1", "B-1", "C-1"], true);
    expect(result.errors).toEqual([]);
    expect(result.command?.idempotency_key).toBe("entry-key-1");
  });

  it("carries an owner backdate flag and normalized reason into the batch command", () => {
    const result = prepareInvoiceBatch({
      ...base,
      businessDate: "2026-09-23",
      isBackdated: true,
      backdatedReason: "  month-end catch-up  ",
    }, [], false, "2026-09-24");
    expect(result.errors).toEqual([]);
    expect(result.command).toMatchObject({
      business_date: "2026-09-23",
      is_backdated: true,
      backdated_reason: "month-end catch-up",
    });
  });

  it("requires a reason for a backdated batch", () => {
    const result = prepareInvoiceBatch({
      ...base,
      businessDate: "2026-09-23",
      isBackdated: true,
      backdatedReason: "   ",
    }, [], false, "2026-09-24");
    expect(result.command).toBeNull();
    expect(result.errors).toContainEqual({ rowId: "", field: "backdatedReason", message: "Enter a reason for the backdated batch." });
  });

  it("rejects an aggregate that exceeds safe integer dirham before review formatting", () => {
    const input = { ...base, rows: [
      { ...base.rows[0], rowId: "large-a", invoiceId: "LARGE-A", total: "50000000000000.00", received: "0", delivered: false },
      { ...base.rows[0], rowId: "large-b", invoiceId: "LARGE-B", total: "50000000000000.00", received: "0", delivered: false },
    ] };
    const result = prepareInvoiceBatch(input, []);
    expect(result.command).toBeNull();
    expect(result.errors).toContainEqual({ rowId: "", field: "rows", message: "Batch totals exceed the supported dirham range." });
    expect(result.totals).toBeNull();
  });

  it("accepts only an explicit successful batch receipt with a UUID batch ID", () => {
    expect(isValidBatchReceipt(null)).toBe(false);
    expect(isValidBatchReceipt({ ok: true })).toBe(false);
    expect(isValidBatchReceipt({ ok: false, batch_id: "10000000-0000-4000-8000-000000000001" })).toBe(false);
    expect(isValidBatchReceipt({ ok: true, batch_id: "not-a-uuid" })).toBe(false);
    expect(isValidBatchReceipt({ ok: true, batch_id: "10000000-0000-4000-8000-000000000001" })).toBe(true);
  });

  it("uses the Qatar operating date after local midnight while UTC is still yesterday", () => {
    const now = new Date("2026-09-24T22:30:00.000Z"); // 01:30 on September 25 in Qatar.
    expect(qatarBusinessDate(now)).toBe("2026-09-25");
    expect(selectInvoiceAttempt({ ...base, businessDate: "2026-09-25" }, null).businessDate).toBe("2026-09-25");
  });

  it("keeps the first attempted command across midnight after an uncertain response", () => {
    const backdated = { ...base, businessDate: "2026-09-23", isBackdated: true, backdatedReason: "month-end close" };
    const first = selectInvoiceAttempt(backdated, null);
    expect(first.businessDate).toBe("2026-09-23");
    const changedDraft = { ...base, businessDate: "2026-09-25", rows: [{ ...base.rows[0], invoiceId: "CHANGED" }] };
    const retry = selectInvoiceAttempt(changedDraft, first);
    expect(retry).toBe(first);
    expect(retry.idempotencyKey).toBe("entry-key-1");
    expect(retry.rows[0].invoiceId).toBe("A-1");
    expect(retry.shopId).toBe(shopId);
    expect(retry.isBackdated).toBe(true);
    expect(retry.backdatedReason).toBe("month-end close");
  });
});

describe("invoice entry payment method", () => {
  const methodOf = (rows: EntryRow[]) => prepareInvoiceBatch({ ...base, rows }, []).command?.rows.map((row) => row.payment_method);

  it("sends each paid row's own method and treats a row without one as cash", () => {
    const [a, b, c] = base.rows;
    expect(methodOf([{ ...a, paymentMethod: "bank" as const }, { ...b, paymentMethod: "cash" as const }, c])).toEqual(["bank", "cash", "cash"]);
  });

  it("does not carry a method for a row that receives nothing", () => {
    const [a] = base.rows;
    expect(methodOf([{ ...a, received: "", delivered: false, paymentMethod: "bank" as const }])).toEqual(["cash"]);
  });

  it("changes the idempotency payload when only the method changes", () => {
    const [a] = base.rows;
    const cash = prepareInvoiceBatch({ ...base, rows: [{ ...a, paymentMethod: "cash" as const }] }, []).command;
    const bank = prepareInvoiceBatch({ ...base, rows: [{ ...a, paymentMethod: "bank" as const }] }, []).command;
    expect(JSON.stringify(cash)).not.toBe(JSON.stringify(bank));
    expect(prepareInvoiceBatch({ ...base, rows: [{ ...a, paymentMethod: "bank" as const }] }, [], true).command).toEqual(bank);
  });
});
