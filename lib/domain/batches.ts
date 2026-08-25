import { DOMAIN_ERROR_CODES } from "@/lib/domain/errors";
import { invoiceKey } from "@/lib/domain/ids";
import {
  invoiceState,
  type InvoiceType,
} from "@/lib/domain/invoices";
import type { MoneyDirham } from "@/lib/domain/money";

export type BatchRowDraft = {
  rowId: string;
  invoiceId: string;
  type: InvoiceType;
  total: MoneyDirham;
  received: MoneyDirham;
  delivered?: boolean;
  customerId?: string;
  overpaymentApproved?: boolean;
};

export type BatchDraft = {
  shopId: string;
  rows: BatchRowDraft[];
};

export type ValidationContext = {
  existingInvoiceKeys: ReadonlySet<string>;
};

export type BatchValidationResult = {
  canSubmit: boolean;
  rowErrors: Array<{
    rowId: string;
    field: string;
    code: string;
    message: string;
  }>;
  warnings: Array<{
    rowId: string;
    code: string;
    message: string;
  }>;
  totals: {
    invoiced: MoneyDirham;
    received: MoneyDirham;
    due: MoneyDirham;
  };
};

export function validateBatch(
  input: BatchDraft,
  context: ValidationContext,
): BatchValidationResult {
  const rowErrors: BatchValidationResult["rowErrors"] = [];
  const warnings: BatchValidationResult["warnings"] = [];
  const seenInvoiceKeys = new Set(context.existingInvoiceKeys);
  const totals = input.rows.reduce<BatchValidationResult["totals"]>(
    (sum, row) => {
      const key = invoiceKey(input.shopId, row.invoiceId);

      if (seenInvoiceKeys.has(key)) {
        rowErrors.push({
          rowId: row.rowId,
          field: "invoiceId",
          code: DOMAIN_ERROR_CODES.duplicateInvoice,
          message: "Invoice ID already exists in this shop.",
        });
      } else {
        seenInvoiceKeys.add(key);
      }

      const hasCustomer = Boolean(row.customerId?.trim());
      const isOverpayment = row.received > row.total;

      if (isOverpayment && !row.overpaymentApproved) {
        warnings.push({
          rowId: row.rowId,
          code: DOMAIN_ERROR_CODES.overpaymentApprovalRequired,
          message: "Overpayment requires Manager or Owner approval.",
        });
      }

      if (isOverpayment && !hasCustomer) {
        rowErrors.push({
          rowId: row.rowId,
          field: "customerId",
          code: DOMAIN_ERROR_CODES.overpaymentCustomerRequired,
          message: "A customer is required for overpayment credit.",
        });
      } else if (
        invoiceState(row) === "DELIVERED_DUE" &&
        !hasCustomer
      ) {
        rowErrors.push({
          rowId: row.rowId,
          field: "customerId",
          code: DOMAIN_ERROR_CODES.customerRequired,
          message: "A customer is required for a delivered invoice with due.",
        });
      }

      return {
        invoiced: sum.invoiced + row.total,
        received: sum.received + row.received,
        due: sum.due + Math.max(row.total - row.received, 0),
      };
    },
    { invoiced: 0, received: 0, due: 0 },
  );

  return {
    canSubmit: rowErrors.length === 0 && warnings.length === 0,
    rowErrors,
    warnings,
    totals,
  };
}
