"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { can, getCurrentActor, type Actor } from "@/lib/auth/permissions";
import { isValidBatchReceipt, prepareInvoiceBatch, qatarBusinessDate, type EntryError } from "@/lib/invoice-entry";
import { normalizeInvoiceNumber } from "@/lib/invoice-operations";
import { PAYMENT_METHODS } from "@/lib/payment-method";
import { logFailure } from "@/lib/server-log";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const rowSchema = z.object({
  rowId: z.uuid(), invoiceId: z.string().max(120), total: z.string().max(32),
  received: z.string().max(32), paymentMethod: z.enum(PAYMENT_METHODS).optional(), delivered: z.boolean(), customerId: z.string().max(100),
  customerName: z.string().max(200), customerMobile: z.string().max(100),
  note: z.string().max(1000).optional(),
}).strict();
const entrySchema = z.object({
  shopId: z.uuid(), businessDate: z.iso.date(), isBackdated: z.boolean(),
  backdatedReason: z.string().max(1000), idempotencyKey: z.uuid(),
  rows: z.array(rowSchema).min(1).max(100),
}).strict();

/**
 * `code` tells the client what the server established, so a locally kept
 * draft can be classified: UNAUTHENTICATED, UNAUTHORIZED_SHOP,
 * INSUFFICIENT_ROLE and UNAVAILABLE say nothing about whether the key was
 * committed earlier; VALIDATION, STALE_DATE, CLOSED_DATE and
 * IDEMPOTENCY_CONFLICT prove this key is not committed with this payload.
 */
export type SaveResult = { ok: boolean; message: string; errors: EntryError[]; uncertain?: boolean; code?: string };

const REAUTH_MESSAGE = "Sign in again to continue. Your draft is kept on this device and has not been saved to ShopKhata.";

export async function saveInvoiceBatch(raw: unknown): Promise<SaveResult> {
  const parsed = entrySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "VALIDATION", message: "Check the batch fields and try again.", errors: [] };
  const input = parsed.data;
  let actor: Actor;
  try {
    actor = await getCurrentActor();
  } catch {
    return { ok: false, code: "UNAUTHENTICATED", message: REAUTH_MESSAGE, errors: [] };
  }
  if (!can(actor, "batch.enter", input.shopId)) {
    return { ok: false, code: "UNAUTHORIZED_SHOP", message: "You cannot enter invoices for this shop.", errors: [] };
  }
  if (input.isBackdated && actor.role !== "owner") {
    return { ok: false, code: "INSUFFICIENT_ROLE", message: "Only an owner can submit a backdated batch.", errors: [] };
  }
  const supabase = await createServerSupabaseClient();
  const { data: priorBatch, error: priorError } = await supabase
    .from("batches").select("id").eq("shop_id", input.shopId)
    .eq("idempotency_key", input.idempotencyKey).maybeSingle();
  if (priorError) return { ok: false, code: "UNAVAILABLE", message: "Batch retry could not be checked.", errors: [] };
  if (!priorBatch && input.isBackdated !== (input.businessDate < qatarBusinessDate(new Date()))) {
    return { ok: false, code: "STALE_DATE", message: "Refresh the business date and review the batch again.", errors: [] };
  }
  const existingNumbers: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data: existing, error: lookupError } = await supabase
      .from("invoice_number_registry").select("invoice_number").eq("shop_id", input.shopId)
      .order("invoice_number").range(offset, offset + 999);
    if (lookupError || !existing) return { ok: false, code: "UNAVAILABLE", message: "Invoice numbers could not be checked.", errors: [] };
    existingNumbers.push(...existing.map((row) => row.invoice_number));
    if (existing.length < 1000) break;
  }
  const prepared = prepareInvoiceBatch(input, existingNumbers, Boolean(priorBatch), qatarBusinessDate(new Date()));
  if (!prepared.command) {
    const registered = new Set(existingNumbers.map(normalizeInvoiceNumber));
    const taken = new Set(priorBatch ? [] : input.rows.filter((row) => registered.has(normalizeInvoiceNumber(row.invoiceId))).map((row) => row.rowId));
    return {
      ok: false, code: "VALIDATION", message: "Fix the marked rows before saving.",
      errors: prepared.errors.map((error) => error.field === "invoiceId" && taken.has(error.rowId) ? { ...error, code: "DUPLICATE_INVOICE" } : error),
    };
  }

  const { data, error } = await supabase.rpc("submit_batch", { command: prepared.command });
  if (error) {
    // Also the path a queued offline draft takes when its replay is rejected.
    logFailure("submit_batch", error, { shopId: input.shopId, actorId: actor.id });
    let errors: EntryError[] = [];
    try {
      const detail = JSON.parse(error.details ?? "null") as unknown;
      if (Array.isArray(detail)) errors = detail.filter((item): item is { row_id: string; field: string; message: string; code?: unknown } =>
        typeof item === "object" && item !== null && typeof item.row_id === "string" && typeof item.field === "string" && typeof item.message === "string"
      ).map((item) => ({ rowId: item.row_id, field: item.field, message: item.message, ...(typeof item.code === "string" ? { code: item.code } : {}) }));
    } catch { /* The RPC may return a non-validation error. */ }
    const known: Record<string, string> = {
      IDEMPOTENCY_CONFLICT: "This save key was already used for different invoices.",
      CLOSED_DATE: "This business date is closed. Nothing was saved; the draft is kept on this device until the date is reopened.",
      UNAUTHORIZED_SHOP: "You no longer have access to this shop. Nothing was saved; the draft is kept on this device.",
      INSUFFICIENT_ROLE: "Only an owner can submit a backdated batch.",
      AUTHENTICATION_REQUIRED: REAUTH_MESSAGE,
    };
    return {
      ok: false,
      uncertain: !error.code,
      code: error.message === "AUTHENTICATION_REQUIRED" ? "UNAUTHENTICATED" : Object.hasOwn(known, error.message) ? error.message : error.code ? "VALIDATION" : undefined,
      message: Object.hasOwn(known, error.message) ? known[error.message] : "Batch was not saved. Check the rows and try again.",
      errors,
    };
  }
  if (!isValidBatchReceipt(data)) {
    return { ok: false, uncertain: true, message: "Batch could not be confirmed. Retry with the same draft.", errors: [] };
  }
  revalidatePath("/");
  return { ok: true, message: "Batch saved.", errors: [] };
}
