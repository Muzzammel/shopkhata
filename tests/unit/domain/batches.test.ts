import { describe, expect, it } from "vitest";

import {
  type BatchDraft,
  type BatchValidationResult,
  type ValidationContext,
  validateBatch,
} from "@/lib/domain/batches";
import { invoiceKey } from "@/lib/domain/ids";

const emptyContext: ValidationContext = {
  existingInvoiceKeys: new Set(),
};

function validate(
  rows: BatchDraft["rows"],
  shopId = "shop-1",
  context = emptyContext,
): BatchValidationResult {
  return validateBatch({ shopId, rows }, context);
}

describe("batch invoice identity", () => {
  it("allows the same invoice ID in different shops", () => {
    const result = validate(
      [
        {
          rowId: "row-1",
          invoiceId: "8704",
          type: "ADVANCE",
          total: 15000,
          received: 10000,
        },
      ],
      "shop-2",
      { existingInvoiceKeys: new Set([invoiceKey("shop-1", "8704")]) },
    );

    expect(result.canSubmit).toBe(true);
    expect(result.rowErrors).toEqual([]);
    expect(result.totals).toEqual({
      invoiced: 15000,
      received: 10000,
      due: 5000,
    });
  });

  it("rejects an existing invoice ID inside the same shop", () => {
    const result = validate(
      [
        {
          rowId: "row-1",
          invoiceId: "8704",
          type: "ADVANCE",
          total: 10000,
          received: 10000,
        },
      ],
      "shop-1",
      { existingInvoiceKeys: new Set([invoiceKey("shop-1", "8704")]) },
    );

    expect(result.rowErrors[0]?.code).toBe("DUPLICATE_INVOICE");
    expect(result.canSubmit).toBe(false);
  });

  it("rejects a duplicate new invoice ID inside one shop", () => {
    const result = validate([
      {
        rowId: "row-1",
        invoiceId: "8704",
        type: "ADVANCE",
        total: 10000,
        received: 10000,
      },
      {
        rowId: "row-2",
        invoiceId: "8704",
        type: "ADVANCE",
        total: 5000,
        received: 5000,
      },
    ]);

    expect(result.rowErrors).toContainEqual({
      rowId: "row-2",
      field: "invoiceId",
      code: "DUPLICATE_INVOICE",
      message: "Invoice ID already exists in this shop.",
    });
    expect(result.canSubmit).toBe(false);
  });
});

describe("batch lifecycle validation", () => {
  it("requires a customer for a delivered invoice with due", () => {
    const result = validate([
      {
        rowId: "row-1",
        invoiceId: "A-8704",
        type: "ADVANCE",
        total: 10000,
        received: 2500,
        delivered: true,
      },
    ]);

    expect(result.rowErrors).toContainEqual({
      rowId: "row-1",
      field: "customerId",
      code: "CUSTOMER_REQUIRED",
      message: "A customer is required for a delivered invoice with due.",
    });
    expect(result.canSubmit).toBe(false);
  });

  it("accepts a fully paid anonymous invoice", () => {
    const result = validate([
      {
        rowId: "row-1",
        invoiceId: "R-100",
        type: "READYMADE",
        total: 10000,
        received: 10000,
      },
    ]);

    expect(result.canSubmit).toBe(true);
    expect(result.rowErrors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("blocks overpayment without approval", () => {
    const result = validate([
      {
        rowId: "row-1",
        invoiceId: "R-101",
        type: "READYMADE",
        total: 10000,
        received: 12500,
        customerId: "CUS-00001",
      },
    ]);

    expect(result.warnings).toContainEqual({
      rowId: "row-1",
      code: "OVERPAYMENT_APPROVAL_REQUIRED",
      message: "Overpayment requires Manager or Owner approval.",
    });
    expect(result.canSubmit).toBe(false);
  });

  it("requires a customer for an approved overpayment", () => {
    const result = validate([
      {
        rowId: "row-1",
        invoiceId: "R-102",
        type: "READYMADE",
        total: 10000,
        received: 12500,
        overpaymentApproved: true,
      },
    ]);

    expect(result.rowErrors).toContainEqual({
      rowId: "row-1",
      field: "customerId",
      code: "OVERPAYMENT_CUSTOMER_REQUIRED",
      message: "A customer is required for overpayment credit.",
    });
    expect(result.canSubmit).toBe(false);
  });

  it("blocks the whole batch when one row is invalid", () => {
    const result = validate([
      {
        rowId: "valid-row",
        invoiceId: "R-103",
        type: "READYMADE",
        total: 10000,
        received: 10000,
      },
      {
        rowId: "invalid-row",
        invoiceId: "R-104",
        type: "READYMADE",
        total: 10000,
        received: 5000,
      },
    ]);

    expect(result.rowErrors).toHaveLength(1);
    expect(result.rowErrors[0]?.rowId).toBe("invalid-row");
    expect(result.canSubmit).toBe(false);
  });
});
