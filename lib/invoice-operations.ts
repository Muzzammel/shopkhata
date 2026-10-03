import { z } from "zod";

const base = { shop_id: z.uuid(), invoice_id: z.uuid(), idempotency_key: z.uuid(), reason: z.string().trim().min(1).max(2000) };
export const correctionInput = z.object({ ...base, payment_id: z.uuid().nullable(), amount_delta_dirham: z.number().int().safe().refine((n) => n !== 0) }).strict();
export const replacementInput = z.object({ ...base, expected_revision: z.number().int().min(0).max(2147483646), invoice_number: z.string().trim().min(1).max(120), customer_id: z.uuid().nullable(), delivered: z.boolean() }).strict();
export const decisionInput = z.object({ shop_id: z.uuid(), request_id: z.uuid(), expected_revision: z.number().int().min(0).max(2147483646), decision: z.enum(["approved", "rejected"]), reason: z.string().trim().max(2000).nullable(), idempotency_key: z.uuid() }).strict();
export type InvoiceOperation = "request_invoice_correction" | "request_invoice_replacement" | "decide_invoice_correction" | "decide_invoice_replacement";
export function normalizeInvoiceNumber(value: string): string { return value.trim().toLowerCase(); }
export function operationError(code: string): string {
  const messages: Record<string, string> = {
    AUTHENTICATION_REQUIRED: "Sign in again to continue.",
    UNAUTHORIZED_SHOP: "You cannot perform this operation in this shop.",
    INSUFFICIENT_ROLE: "Only a manager or owner can approve or reject requests.",
    INVALID_REQUEST: "Check the request fields and reason.",
    INVOICE_NOT_FOUND: "The invoice was not found in this shop.",
    REQUEST_NOT_FOUND: "The request was not found in this shop.",
    PAYMENT_NOT_FOUND: "The payment was not found on this invoice.",
    CUSTOMER_NOT_FOUND: "Select a customer belonging to this shop.",
    CUSTOMER_REQUIRED: "A delivered invoice with due requires a customer.",
    INVALID_FINANCIAL_RESULT: "This correction would produce invalid balances. Review the current total and payments.",
    NUMBER_ALREADY_REGISTERED: "This number belongs to another invoice in this shop.",
    STALE_REVISION: "The invoice version changed. Refresh and make a new request against the current version.",
    ALREADY_DECIDED: "This request already has a decision. Refresh to see its status.",
    IDEMPOTENCY_CONFLICT: "This retry key already belongs to a different command.",
    CLOSED_DATE: "This business date is closed.",
  };
  return Object.hasOwn(messages, code) ? messages[code] : "The operation could not be completed.";
}
