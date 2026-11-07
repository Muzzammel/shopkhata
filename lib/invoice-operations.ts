import { z } from "zod";
import { SHOP_INACTIVE_MESSAGE } from "@/lib/shop-admin";

const base = { shop_id: z.uuid(), invoice_id: z.uuid(), idempotency_key: z.uuid(), reason: z.string().trim().min(1).max(2000) };
// An invoice-total correction states the corrected total and the total it was made against; the
// database derives the delta. Only a payment correction still carries a signed delta.
const totalCorrection = z.object({ ...base, payment_id: z.null(), expected_total_dirham: z.number().int().safe().min(0), corrected_total_dirham: z.number().int().safe().min(0) }).strict()
  .refine((value) => value.corrected_total_dirham !== value.expected_total_dirham);
const paymentCorrection = z.object({ ...base, payment_id: z.uuid(), amount_delta_dirham: z.number().int().safe().refine((n) => n !== 0) }).strict();
export const correctionInput = z.union([totalCorrection, paymentCorrection]);

export type CorrectionPreview = { differenceDirham: number; resultingDueDirham: number; error: "UNCHANGED" | "BELOW_SETTLED" | null };
/** What a corrected invoice total would do. Shown before submit; the database decides again on its own. */
export function previewTotalCorrection(current: { totalDirham: number; paidDirham: number; creditAppliedDirham: number }, correctedTotalDirham: number): CorrectionPreview {
  const resultingDueDirham = correctedTotalDirham - current.paidDirham - current.creditAppliedDirham;
  return {
    differenceDirham: correctedTotalDirham - current.totalDirham, resultingDueDirham,
    error: correctedTotalDirham === current.totalDirham ? "UNCHANGED" : resultingDueDirham < 0 ? "BELOW_SETTLED" : null,
  };
}
export const replacementInput = z.object({ ...base, expected_revision: z.number().int().min(0).max(2147483646), invoice_number: z.string().trim().min(1).max(120), customer_id: z.uuid().nullable(), delivered: z.boolean() }).strict();
export const decisionInput = z.object({ shop_id: z.uuid(), request_id: z.uuid(), expected_revision: z.number().int().min(0).max(2147483646), decision: z.enum(["approved", "rejected"]), reason: z.string().trim().max(2000).nullable(), idempotency_key: z.uuid() }).strict();
// A void needs a real explanation: trimmed, 10 to 2000 Unicode characters (code points, as PostgreSQL length()
// counts them; String.length would count an emoji as 2). UI, server action and database apply this one rule.
export const VOID_REASON_MIN = 10;
export const VOID_REASON_MAX = 2000;
/** The reason rule as a code, checked before sending; null when the reason is acceptable. */
export function voidReasonError(reason: string): "REASON_REQUIRED" | "REASON_TOO_SHORT" | "INVALID_REQUEST" | null {
  const length = [...reason.trim()].length;
  return length === 0 ? "REASON_REQUIRED" : length < VOID_REASON_MIN ? "REASON_TOO_SHORT" : length > VOID_REASON_MAX ? "INVALID_REQUEST" : null;
}
export const voidInput = z.object({ shop_id: z.uuid(), invoice_id: z.uuid(), idempotency_key: z.uuid(), reason: z.string().trim().refine((reason) => voidReasonError(reason) === null) }).strict();
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
    INVALID_FINANCIAL_RESULT: "This correction would leave invalid balances: an invoice total cannot be less than the amount already paid, and a payment cannot go below zero.",
    STALE_TOTAL: "The invoice total changed since this correction was requested. Refresh and request it again against the current total.",
    CORRECTION_NO_CHANGE: "The corrected total is the same as the current total.",
    NUMBER_ALREADY_REGISTERED: "This number belongs to another invoice in this shop.",
    STALE_REVISION: "The invoice version changed. Refresh and make a new request against the current version.",
    ALREADY_DECIDED: "This request already has a decision. Refresh to see its status.",
    IDEMPOTENCY_CONFLICT: "This retry key already belongs to a different command.",
    CLOSED_DATE: "This business date is closed.",
    SHOP_INACTIVE: SHOP_INACTIVE_MESSAGE,
    REASON_REQUIRED: "Enter the reason for voiding this invoice.",
    REASON_TOO_SHORT: `Explain the void in at least ${VOID_REASON_MIN} characters.`,
    PAYMENTS_OUTSTANDING: "This invoice has payments. Reverse the payments before voiding it.",
    CREDIT_APPLIED: "Customer credit is applied to this invoice, so it cannot be voided.",
    ALREADY_VOID: "This invoice is already void.",
    INVOICE_VOID: "This invoice is void. It cannot be changed.",
  };
  return Object.hasOwn(messages, code) ? messages[code] : "The operation could not be completed.";
}
