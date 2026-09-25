"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { can, getCurrentActor } from "@/lib/auth/permissions";
import { isValidBatchReceipt, prepareInvoiceBatch, type EntryError } from "@/lib/invoice-entry";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const rowSchema = z.object({
  rowId: z.uuid(), invoiceId: z.string().max(120), total: z.string().max(32),
  received: z.string().max(32), delivered: z.boolean(), customerId: z.string().max(100),
  customerName: z.string().max(200), customerMobile: z.string().max(100),
}).strict();
const entrySchema = z.object({
  shopId: z.uuid(), businessDate: z.iso.date(), idempotencyKey: z.uuid(),
  rows: z.array(rowSchema).min(1).max(100),
}).strict();

export type SaveResult = { ok: boolean; message: string; errors: EntryError[]; uncertain?: boolean };

export async function saveInvoiceBatch(raw: unknown): Promise<SaveResult> {
  const parsed = entrySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Check the batch fields and try again.", errors: [] };
  const input = parsed.data;
  const actor = await getCurrentActor();
  if (!can(actor, "batch.enter", input.shopId)) {
    return { ok: false, message: "You cannot enter invoices for this shop.", errors: [] };
  }
  const supabase = await createServerSupabaseClient();
  const { data: priorBatch, error: priorError } = await supabase
    .from("batches").select("id").eq("shop_id", input.shopId)
    .eq("idempotency_key", input.idempotencyKey).maybeSingle();
  if (priorError) return { ok: false, message: "Batch retry could not be checked.", errors: [] };
  const existingNumbers: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data: existing, error: lookupError } = await supabase
      .from("invoice_number_registry").select("invoice_number").eq("shop_id", input.shopId)
      .order("invoice_number").range(offset, offset + 999);
    if (lookupError || !existing) return { ok: false, message: "Invoice numbers could not be checked.", errors: [] };
    existingNumbers.push(...existing.map((row) => row.invoice_number));
    if (existing.length < 1000) break;
  }
  const prepared = prepareInvoiceBatch(input, existingNumbers, Boolean(priorBatch));
  if (!prepared.command) return { ok: false, message: "Fix the marked rows before saving.", errors: prepared.errors };

  const { data, error } = await supabase.rpc("submit_batch", { command: prepared.command });
  if (error) {
    let errors: EntryError[] = [];
    try {
      const detail = JSON.parse(error.details ?? "null") as unknown;
      if (Array.isArray(detail)) errors = detail.filter((item): item is { row_id: string; field: string; message: string } =>
        typeof item === "object" && item !== null && typeof item.row_id === "string" && typeof item.field === "string" && typeof item.message === "string"
      ).map((item) => ({ rowId: item.row_id, field: item.field, message: item.message }));
    } catch { /* The RPC may return a non-validation error. */ }
    return {
      ok: false,
      uncertain: !error.code,
      message: error.message === "IDEMPOTENCY_CONFLICT" ? "This save key was already used for different invoices." : "Batch was not saved. Check the rows and try again.",
      errors,
    };
  }
  if (!isValidBatchReceipt(data)) {
    return { ok: false, uncertain: true, message: "Batch could not be confirmed. Retry with the same draft.", errors: [] };
  }
  revalidatePath("/");
  return { ok: true, message: "Batch saved.", errors: [] };
}
