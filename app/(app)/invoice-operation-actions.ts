"use server";

import { revalidatePath } from "next/cache";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { correctionInput, replacementInput, decisionInput, operationError, type InvoiceOperation } from "@/lib/invoice-operations";
import { logFailure } from "@/lib/server-log";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type OperationResult = { ok: true } | { ok: false; uncertain: boolean; message: string };
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
    const { data, error } = await supabase.rpc(operation, { command: parsed.data });
    if (error) {
      logFailure(operation, error, { shopId: parsed.data.shop_id, actorId: actor.id });
      return { ok: false, uncertain: !error.code, message: error.code ? operationError(error.message) : "Status is uncertain. Retry the exact saved command." };
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
