"use server";

import { revalidatePath } from "next/cache";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { deliveryError, deliveryInput, orderCorrectionInput, reversalInput } from "@/lib/invoice-delivery";
import { correctionInput, replacementInput, decisionInput, voidInput, voidReasonError, operationError, type InvoiceOperation } from "@/lib/invoice-operations";
import { logFailure } from "@/lib/server-log";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type OperationResult = { ok: true } | { ok: false; uncertain: boolean; message: string; code?: string };
export async function runInvoiceOperation(operation: InvoiceOperation, raw: unknown, invoiceId: string): Promise<OperationResult> {
  const schema = operation === "request_invoice_correction" ? correctionInput : operation === "request_invoice_replacement" ? replacementInput : decisionInput;
  if (!["request_invoice_correction", "request_invoice_replacement", "decide_invoice_correction", "decide_invoice_replacement"].includes(operation)) return { ok: false, uncertain: false, message: operationError("INVALID_REQUEST") };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, uncertain: false, message: operationError("INVALID_REQUEST") };
  try {
    const actor = await getCurrentActor();
    const permission = operation === "request_invoice_correction" ? "correction.request" : operation === "request_invoice_replacement" ? "invoice.replacement.request" : operation === "decide_invoice_correction" ? "correction.approve" : "invoice.replacement.approve";
    if (!can(actor, permission, parsed.data.shop_id)) return { ok: false, uncertain: false, message: operationError("UNAUTHORIZED_SHOP") };
    const supabase = await createServerSupabaseClient();
    if (operation === "request_invoice_replacement" && "delivered" in parsed.data) {
      // A piece-tracked invoice takes its delivery from the delivery ledger; a replacement may not change it.
      const [{ data: invoice, error: invoiceError }, { data: effective, error: effectiveError }] = await Promise.all([
        supabase.from("invoices").select("ordered_pieces").eq("shop_id", parsed.data.shop_id).eq("id", parsed.data.invoice_id).maybeSingle(),
        supabase.from("effective_invoices").select("effective_delivered").eq("shop_id", parsed.data.shop_id).eq("canonical_invoice_id", parsed.data.invoice_id).maybeSingle(),
      ]);
      if (invoiceError || effectiveError) return { ok: false, uncertain: false, message: "The invoice could not be checked. Nothing was saved; try again." };
      if (invoice?.ordered_pieces != null && effective && parsed.data.delivered !== effective.effective_delivered) {
        return { ok: false, uncertain: false, message: "Delivery of this invoice is recorded by pieces. Use Record delivery instead.", code: "DELIVERY_BY_PIECES" };
      }
    }
    const { data, error } = await supabase.rpc(operation, { command: parsed.data });
    if (error) {
      logFailure(operation, error, { shopId: parsed.data.shop_id, actorId: actor.id });
      return error.code ? { ok: false, uncertain: false, message: operationError(error.message), code: error.message } : { ok: false, uncertain: true, message: "Status is uncertain. Retry the exact saved command." };
    }
    if (typeof data !== "object" || data === null || Array.isArray(data) || data.ok !== true || data.invoice_id !== invoiceId || typeof data.request_id !== "string" || (operation.startsWith("decide_") && typeof data.decision_id !== "string")) return { ok: false, uncertain: true, message: "Status is uncertain. Retry the exact saved command." };
    revalidatePath(`/shops/${parsed.data.shop_id}/invoices/${invoiceId}`);
    revalidatePath("/");
    return { ok: true };
  } catch {
    logFailure(operation, null, { shopId: parsed.data.shop_id });
    return { ok: false, uncertain: true, message: "Status is uncertain. Retry the exact saved command after signing in again." };
  }
}

/** Void an invoice: owner or manager only. The database re-checks role, shop, reason, payments, credit and today's date. */
export async function voidInvoice(raw: unknown): Promise<OperationResult> {
  const parsed = voidInput.safeParse(raw);
  if (!parsed.success) {
    const reason = typeof raw === "object" && raw !== null ? (raw as { reason?: unknown }).reason : undefined;
    const code = (typeof reason === "string" && voidReasonError(reason)) || "INVALID_REQUEST";
    return { ok: false, uncertain: false, message: operationError(code), code };
  }
  const { shop_id: shopId, invoice_id: invoiceId } = parsed.data;
  try {
    const actor = await getCurrentActor();
    if (!can(actor, "invoice.void", shopId)) return { ok: false, uncertain: false, message: "Only a manager or owner can void an invoice.", code: "INSUFFICIENT_ROLE" };
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc("void_invoice", { command: parsed.data });
    if (error) {
      logFailure("void_invoice", error, { shopId, actorId: actor.id });
      // Only the database's own domain codes reach the screen; anything else is a fixed generic message.
      return error.code ? { ok: false, uncertain: false, message: operationError(error.message), code: /^[A-Z_]+$/.test(error.message) ? error.message : undefined } : { ok: false, uncertain: true, message: "Status is uncertain. Retry the exact saved command." };
    }
    if (typeof data !== "object" || data === null || Array.isArray(data) || data.ok !== true || data.invoice_id !== invoiceId || typeof data.void_id !== "string") return { ok: false, uncertain: true, message: "Status is uncertain. Retry the exact saved command." };
    revalidatePath(`/shops/${shopId}/invoices/${invoiceId}`);
    revalidatePath("/");
    return { ok: true };
  } catch {
    logFailure("void_invoice", null, { shopId });
    return { ok: false, uncertain: true, message: "Status is uncertain. Retry the exact saved command after signing in again." };
  }
}

/**
 * Record a later delivery of pieces. Any member who can enter sales in the shop, as the RPC allows. The caller keeps
 * the command (and its idempotency key) and resends it unchanged until the outcome is known.
 */
export async function recordInvoiceDelivery(raw: unknown): Promise<OperationResult> {
  const parsed = deliveryInput.safeParse(raw);
  if (!parsed.success) return { ok: false, uncertain: false, message: deliveryError("PIECES_INVALID"), code: "INVALID_REQUEST" };
  const { shop_id: shopId, invoice_id: invoiceId } = parsed.data;
  try {
    const actor = await getCurrentActor();
    if (!can(actor, "batch.enter", shopId)) return { ok: false, uncertain: false, message: deliveryError("UNAUTHORIZED_SHOP"), code: "UNAUTHORIZED_SHOP" };
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc("record_invoice_delivery", { command: parsed.data });
    if (error) {
      logFailure("record_invoice_delivery", error, { shopId, actorId: actor.id });
      // A database refusal proves nothing was written under this key; anything else leaves the outcome unknown.
      return error.code ? { ok: false, uncertain: false, message: deliveryError(error.message), code: /^[A-Z_]+$/.test(error.message) ? error.message : undefined } : { ok: false, uncertain: true, message: "Status is uncertain. Retry the exact delivery." };
    }
    if (typeof data !== "object" || data === null || Array.isArray(data) || data.ok !== true || data.invoice_id !== invoiceId
      || typeof data.delivery_id !== "string" || data.pieces !== parsed.data.pieces) return { ok: false, uncertain: true, message: "Status is uncertain. Retry the exact delivery." };
    revalidatePath(`/shops/${shopId}/invoices/${invoiceId}`);
    revalidatePath("/");
    return { ok: true };
  } catch {
    logFailure("record_invoice_delivery", null, { shopId });
    return { ok: false, uncertain: true, message: "Status is uncertain. Retry the exact delivery after signing in again." };
  }
}

/**
 * Reverse one whole delivery event: owner or manager only. The database re-checks role, shop, reason, void, legacy,
 * today's date, "once only" and the net delivered total. The caller resends the exact command until the outcome is known.
 */
export async function reverseInvoiceDelivery(raw: unknown): Promise<OperationResult> {
  const parsed = reversalInput.safeParse(raw);
  if (!parsed.success) {
    const reason = typeof raw === "object" && raw !== null ? (raw as { reason?: unknown }).reason : undefined;
    const code = (typeof reason === "string" && voidReasonError(reason)) || "INVALID_REQUEST";
    return { ok: false, uncertain: false, message: deliveryError(code), code };
  }
  const { shop_id: shopId, invoice_id: invoiceId, delivery_id: deliveryId } = parsed.data;
  try {
    const actor = await getCurrentActor();
    if (!can(actor, "delivery.reverse", shopId)) return { ok: false, uncertain: false, message: deliveryError("INSUFFICIENT_ROLE"), code: "INSUFFICIENT_ROLE" };
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc("reverse_invoice_delivery", { command: parsed.data });
    if (error) {
      logFailure("reverse_invoice_delivery", error, { shopId, actorId: actor.id });
      // A database refusal proves nothing was written under this key; anything else leaves the outcome unknown.
      return error.code ? { ok: false, uncertain: false, message: deliveryError(error.message), code: /^[A-Z_]+$/.test(error.message) ? error.message : undefined } : { ok: false, uncertain: true, message: "Status is uncertain. Retry the exact reversal." };
    }
    if (typeof data !== "object" || data === null || Array.isArray(data) || data.ok !== true || data.invoice_id !== invoiceId
      || data.delivery_id !== deliveryId || typeof data.reversal_id !== "string") return { ok: false, uncertain: true, message: "Status is uncertain. Retry the exact reversal." };
    revalidatePath(`/shops/${shopId}/invoices/${invoiceId}`);
    revalidatePath("/");
    return { ok: true };
  } catch {
    logFailure("reverse_invoice_delivery", null, { shopId });
    return { ok: false, uncertain: true, message: "Status is uncertain. Retry the exact reversal after signing in again." };
  }
}

const ORDER_ROLE_MESSAGE = "Only a manager or owner can correct ordered pieces.";

/**
 * Correct the ordered pieces of a tracked invoice: owner or manager only. The database re-checks role, shop, reason, void,
 * legacy, today's date, the expected (unchanged) quantity and the net delivered floor. Money is never touched. The caller
 * resends the exact command until the outcome is known.
 */
export async function correctOrderedPieces(raw: unknown): Promise<OperationResult> {
  const parsed = orderCorrectionInput.safeParse(raw);
  if (!parsed.success) {
    const reason = typeof raw === "object" && raw !== null ? (raw as { reason?: unknown }).reason : undefined;
    const code = (typeof reason === "string" && voidReasonError(reason)) || "PIECES_INVALID";
    return { ok: false, uncertain: false, message: deliveryError(code), code };
  }
  const { shop_id: shopId, invoice_id: invoiceId } = parsed.data;
  try {
    const actor = await getCurrentActor();
    if (!can(actor, "delivery.correct_ordered", shopId)) return { ok: false, uncertain: false, message: ORDER_ROLE_MESSAGE, code: "INSUFFICIENT_ROLE" };
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc("correct_invoice_ordered_pieces", { command: parsed.data });
    if (error) {
      logFailure("correct_invoice_ordered_pieces", error, { shopId, actorId: actor.id });
      if (!error.code) return { ok: false, uncertain: true, message: "Status is uncertain. Retry the exact correction." };
      const code = /^[A-Z_]+$/.test(error.message) ? error.message : undefined;
      return { ok: false, uncertain: false, message: code === "INSUFFICIENT_ROLE" ? ORDER_ROLE_MESSAGE : deliveryError(error.message), code };
    }
    if (typeof data !== "object" || data === null || Array.isArray(data) || data.ok !== true || data.invoice_id !== invoiceId
      || data.ordered_after !== parsed.data.ordered_pieces || typeof data.correction_id !== "string") return { ok: false, uncertain: true, message: "Status is uncertain. Retry the exact correction." };
    revalidatePath(`/shops/${shopId}/invoices/${invoiceId}`);
    revalidatePath("/");
    return { ok: true };
  } catch {
    logFailure("correct_invoice_ordered_pieces", null, { shopId });
    return { ok: false, uncertain: true, message: "Status is uncertain. Retry the exact correction after signing in again." };
  }
}
