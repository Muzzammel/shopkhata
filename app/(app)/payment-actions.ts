"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { can, getCurrentActor } from "@/lib/auth/permissions";
import { isValidPaymentReceipt, type PaymentCommand } from "@/lib/invoice-payment";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const lookupSchema = z.object({ shopId: z.uuid(), invoiceNumber: z.string().trim().min(1).max(120) }).strict();
const commandSchema = z.object({
  shop_id: z.uuid(), invoice_id: z.uuid(), amount_dirham: z.number().int().positive().safe(),
  payment_method: z.literal("cash"), business_date: z.iso.date(), idempotency_key: z.uuid(),
}).strict();

export type PaymentLookup =
  | { ok: true; invoice: { id: string; invoiceNumber: string; effectiveTotal: number; effectivePaid: number; effectiveDue: number } }
  | { ok: false; message: string };

export type PaymentActionResult =
  | { ok: true; receipt: { ok: true; payment_id: string; invoice_id: string; effective_paid: number; effective_due: number } }
  | { ok: false; uncertain: boolean; message: string };

export async function lookupInvoiceForPayment(raw: unknown): Promise<PaymentLookup> {
  const parsed = lookupSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Enter a valid invoice number." };
  const actor = await getCurrentActor();
  if (!can(actor, "payment.record", parsed.data.shopId)) {
    return { ok: false, message: "You cannot access invoices for this shop." };
  }
  const supabase = await createServerSupabaseClient();
  const { data: registeredNumber, error: registryError } = await supabase.from("invoice_number_registry")
    .select("canonical_invoice_id").eq("shop_id", parsed.data.shopId)
    .eq("normalized_invoice_number", parsed.data.invoiceNumber.toLowerCase()).maybeSingle();
  if (registryError || !registeredNumber) return { ok: false, message: "No matching invoice was found in this shop." };
  const { data: invoice, error } = await supabase.from("effective_invoices")
    .select("canonical_invoice_id, effective_invoice_number, effective_total_dirham, effective_paid_dirham, effective_due_dirham").eq("shop_id", parsed.data.shopId)
    .eq("canonical_invoice_id", registeredNumber.canonical_invoice_id).maybeSingle();
  if (error || !invoice) return { ok: false, message: "No matching invoice was found in this shop." };
  return {
    ok: true,
    invoice: {
      id: invoice.canonical_invoice_id!,
      invoiceNumber: invoice.effective_invoice_number!,
      effectiveTotal: invoice.effective_total_dirham!,
      effectivePaid: invoice.effective_paid_dirham!,
      effectiveDue: invoice.effective_due_dirham!,
    },
  };
}

export async function recordInvoicePayment(raw: unknown): Promise<PaymentActionResult> {
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, uncertain: false, message: "Check the payment details and try again." };
  const command: PaymentCommand = parsed.data;
  const actor = await getCurrentActor();
  if (!can(actor, "payment.record", command.shop_id)) {
    return { ok: false, uncertain: false, message: "You cannot record payments for this shop." };
  }
  // Future dates are rejected here for clear feedback; the RPC applies the
  // same Qatar date rule authoritatively and allows exact replay after midnight.
  if (command.business_date > qatarBusinessDate(new Date())) {
    return { ok: false, uncertain: false, message: "The payment date cannot be in the future." };
  }
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("record_payment", { command });
  if (error) {
    if (!error.code) {
      return { ok: false, uncertain: true, message: "Payment status is uncertain. Retry the same payment command." };
    }
    const message = error.message === "IDEMPOTENCY_CONFLICT"
      ? "This retry key was already used for a different payment."
      : error.message === "INSUFFICIENT_ROLE"
        ? "Only the owner can record a payment for an earlier business date."
        : error.message === "CLOSED_DATE"
          ? "This business date is closed."
          : error.message === "PAYMENT_VALIDATION_FAILED"
            ? "The payment was rejected. Check the amount due and try again."
            : "Payment could not be recorded.";
    return { ok: false, uncertain: false, message };
  }
  if (!isValidPaymentReceipt(data, command.invoice_id)) {
    return { ok: false, uncertain: true, message: "Payment status is uncertain. Retry the same payment command." };
  }
  revalidatePath("/");
  revalidatePath(`/shops/${command.shop_id}/invoices/${command.invoice_id}`);
  return { ok: true, receipt: data };
}
