import { parseQar } from "@/lib/domain/money";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import type { PaymentMethod } from "@/lib/payment-method";

export type PaymentCommand = {
  shop_id: string;
  invoice_id: string;
  amount_dirham: number;
  payment_method: PaymentMethod;
  business_date: string;
  idempotency_key: string;
};

export type PaymentDraft = {
  shopId: string;
  invoiceId: string;
  invoiceNumber: string;
  amount: string;
  paymentMethod?: PaymentMethod;
  idempotencyKey: string;
};

export function preparePaymentAttempt(
  draft: PaymentDraft,
  effectiveDueDirham: number,
  now: Date,
  previous: PaymentCommand | null = null,
): { command: PaymentCommand | null; error: string | null } {
  if (previous) return { command: previous, error: null };
  if (!Number.isSafeInteger(effectiveDueDirham) || effectiveDueDirham <= 0) {
    return { command: null, error: "Already paid — no amount due." };
  }

  let amountDirham: number;
  try {
    amountDirham = parseQar(draft.amount.trim());
  } catch {
    return { command: null, error: "Enter a positive amount in QAR with at most two decimals." };
  }
  if (amountDirham <= 0) return { command: null, error: "Enter a positive amount in QAR with at most two decimals." };
  if (amountDirham > effectiveDueDirham) return { command: null, error: "Amount cannot exceed the effective amount due." };

  return {
    command: {
      shop_id: draft.shopId,
      invoice_id: draft.invoiceId,
      amount_dirham: amountDirham,
      payment_method: draft.paymentMethod ?? "cash",
      business_date: qatarBusinessDate(now),
      idempotency_key: draft.idempotencyKey,
    },
    error: null,
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidPaymentReceipt(value: unknown, expectedInvoiceId: string): value is {
  ok: true;
  payment_id: string;
  invoice_id: string;
  effective_paid: number;
  effective_due: number;
} {
  if (typeof value !== "object" || value === null) return false;
  const receipt = value as Record<string, unknown>;
  return receipt.ok === true
    && typeof receipt.payment_id === "string" && UUID_PATTERN.test(receipt.payment_id)
    && receipt.invoice_id === expectedInvoiceId && UUID_PATTERN.test(expectedInvoiceId)
    && Number.isSafeInteger(receipt.effective_paid)
    && Number.isSafeInteger(receipt.effective_due) && (receipt.effective_due as number) >= 0;
}
