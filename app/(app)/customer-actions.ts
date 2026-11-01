"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { PAYMENT_METHODS } from "@/lib/payment-method";
import { logFailure } from "@/lib/server-log";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";
import { expenseOperationError } from "@/lib/expense-operations";
import { SHOP_INACTIVE_MESSAGE } from "@/lib/shop-admin";

function isRpcObject(value: Json | null): value is { [key: string]: Json | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const paymentSchema = z.object({ shop_id: z.uuid(), customer_id: z.uuid(), amount_dirham: z.number().int().positive().safe(), business_date: z.iso.date(), idempotency_key: z.uuid() }).strict();
// Applying credit is not a receipt, so only a cash/bank payment names a method.
const customerPaymentSchema = z.object({ ...paymentSchema.shape, payment_method: z.enum(PAYMENT_METHODS) }).strict();
const customerSchema = z.object({ shop_id: z.uuid(), name: z.string().max(160).optional(), mobile: z.string().max(40).optional() }).strict();
const creditSchema = paymentSchema;
const attachmentSchema = z.object({ shop_id: z.uuid(), expense_id: z.uuid(), file_path: z.string().max(500), file_name: z.string().max(255), content_type: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]), byte_size: z.number().int().positive().max(10_485_760), idempotency_key: z.uuid() }).strict();

export async function createCustomer(raw: unknown) {
  const parsed = customerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, uncertain: false, message: "Enter a name or mobile number." };
  const actor = await getCurrentActor();
  if (!can(actor, "records.view_assigned", parsed.data.shop_id)) return { ok: false as const, uncertain: false, message: "You cannot access this shop." };
  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc("create_customer", { command: parsed.data });
    if (error) logFailure("create_customer", error, { shopId: parsed.data.shop_id, actorId: actor.id });
    if (error) return { ok: false as const, uncertain: !error.code, message: error.message === "SHOP_INACTIVE" ? SHOP_INACTIVE_MESSAGE : error.message === "DUPLICATE_CUSTOMER" ? "A customer with these details already exists in this shop." : "Customer could not be created." };
    if (!isRpcObject(data) || data.ok !== true || typeof data.customer_id !== "string") return { ok: false as const, uncertain: true, message: "Customer status is uncertain. Retry the same details." };
    revalidatePath("/customers");
    return { ok: true as const, customerId: data.customer_id as string };
  } catch { return { ok: false as const, uncertain: true, message: "Customer status is uncertain. Retry the same details." }; }
}

export async function recordCustomerPayment(raw: unknown) {
  const parsed = customerPaymentSchema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, uncertain: false, message: "Check the payment amount." };
  const actor = await getCurrentActor();
  if (!can(actor, "payment.record", parsed.data.shop_id)) return { ok: false as const, uncertain: false, message: "You cannot record payments for this shop." };
  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc("record_customer_payment", { command: parsed.data });
    if (error) logFailure("record_customer_payment", error, { shopId: parsed.data.shop_id, actorId: actor.id });
    if (error) return { ok: false as const, uncertain: !error.code, message: error.message === "SHOP_INACTIVE" ? SHOP_INACTIVE_MESSAGE : error.message === "AMOUNT_EXCEEDS_DUE" ? "The customer due changed. Refresh and review the allocation again." : error.message === "CLOSED_DATE" ? "This business date is closed." : "Payment could not be recorded." };
    if (!isRpcObject(data) || data.ok !== true || data.customer_id !== parsed.data.customer_id || !Array.isArray(data.allocations)) return { ok: false as const, uncertain: true, message: "Payment status is uncertain. Retry the exact payment." };
    revalidatePath(`/customers/${parsed.data.customer_id}`);
    revalidatePath(`/shops/${parsed.data.shop_id}/invoices`);
    revalidatePath("/");
    return { ok: true as const, receipt: data };
  } catch { return { ok: false as const, uncertain: true, message: "Payment status is uncertain. Retry the exact payment." }; }
}

export async function applyCustomerCredit(raw: unknown) {
  const parsed = creditSchema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, uncertain: false, message: "Check the credit amount." };
  const actor = await getCurrentActor();
  if (!can(actor, "payment.record", parsed.data.shop_id)) return { ok: false as const, uncertain: false, message: "You cannot apply credit for this shop." };
  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc("apply_customer_credit", { command: parsed.data });
    if (error) logFailure("apply_customer_credit", error, { shopId: parsed.data.shop_id, actorId: actor.id });
    if (error) return { ok: false as const, uncertain: !error.code, message: error.message === "SHOP_INACTIVE" ? SHOP_INACTIVE_MESSAGE : error.message === "CREDIT_OR_DUE_INSUFFICIENT" ? "Available credit or outstanding due changed. Refresh and review again." : "Credit could not be applied." };
    if (!isRpcObject(data) || data.ok !== true || data.customer_id !== parsed.data.customer_id || !Array.isArray(data.allocations)) return { ok: false as const, uncertain: true, message: "Credit application status is uncertain. Retry the exact request." };
    revalidatePath(`/customers/${parsed.data.customer_id}`);
    revalidatePath("/");
    return { ok: true as const, receipt: data };
  } catch { return { ok: false as const, uncertain: true, message: "Credit application status is uncertain. Retry the exact request." }; }
}

const expenseSchema = z.object({ shop_id: z.uuid(), amount_dirham: z.number().int().positive().safe(), business_date: z.iso.date(), category: z.enum(["rent", "utilities", "supplies", "transport", "maintenance", "other"]), description: z.string().trim().min(1).max(1000), backdated_reason: z.string().trim().min(1).max(2000).optional(), idempotency_key: z.uuid() }).strict();
const correctionSchema = z.object({ shop_id: z.uuid(), expense_id: z.uuid(), amount_dirham: z.number().int().positive().safe(), category: z.enum(["rent", "utilities", "supplies", "transport", "maintenance", "other"]), description: z.string().trim().min(1).max(1000), reason: z.string().trim().min(1).max(2000), idempotency_key: z.uuid() }).strict();
const decisionSchema = z.object({ shop_id: z.uuid(), request_id: z.uuid(), decision: z.enum(["approved", "rejected"]), reason: z.string().max(2000).optional(), idempotency_key: z.uuid() }).strict();

async function expenseRpc(name: "create_expense" | "request_expense_correction" | "decide_expense_correction", schema: z.ZodType, raw: unknown, shopId: string) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, uncertain: false, message: "Check the expense details." };
  const actor = await getCurrentActor();
  if (!can(actor, name === "decide_expense_correction" ? "correction.approve" : "expense.create", shopId)) return { ok: false as const, uncertain: false, message: "You are not authorized for this expense operation." };
  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc(name, { command: parsed.data as never });
    if (error) logFailure(name, error, { shopId, actorId: actor.id });
    if (error) return { ok: false as const, uncertain: !error.code, message: name === "create_expense" && error.message === "INSUFFICIENT_ROLE" ? "Only an owner may record a backdated expense, with a reason." : expenseOperationError(error.message) };
    if (!isRpcObject(data) || data.ok !== true) return { ok: false as const, uncertain: true, message: "Expense status is uncertain. Retry the exact request." };
    revalidatePath("/expenses");
    return { ok: true as const, receipt: data };
  } catch { return { ok: false as const, uncertain: true, message: "Expense status is uncertain. Retry the exact request." }; }
}

export async function createExpense(raw: unknown) {
  const parsed = expenseSchema.safeParse(raw);
  return expenseRpc("create_expense", expenseSchema, raw, parsed.success ? parsed.data.shop_id : "");
}
export async function requestExpenseCorrection(raw: unknown) {
  const parsed = correctionSchema.safeParse(raw);
  return expenseRpc("request_expense_correction", correctionSchema, raw, parsed.success ? parsed.data.shop_id : "");
}
export async function decideExpenseCorrection(raw: unknown) {
  const parsed = decisionSchema.safeParse(raw);
  return expenseRpc("decide_expense_correction", decisionSchema, raw, parsed.success ? parsed.data.shop_id : "");
}

export async function registerExpenseAttachment(raw: unknown) {
  const parsed = attachmentSchema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, uncertain: false, message: "The receipt file is invalid." };
  const actor = await getCurrentActor();
  if (!can(actor, "expense.create", parsed.data.shop_id)) return { ok: false as const, uncertain: false, message: "You cannot attach a file in this shop." };
  try {
    const supabase = await createServerSupabaseClient();
    const command = { ...parsed.data, file_path: parsed.data.file_path, file_name: parsed.data.file_name };
    const { data, error } = await supabase.rpc("register_expense_attachment", { command });
    // The file itself is uploaded by the browser; this is where a failed or unfinished upload becomes visible.
    if (error || !isRpcObject(data) || data.ok !== true) logFailure("register_expense_attachment", error, { shopId: parsed.data.shop_id, actorId: actor.id });
    if (error || !isRpcObject(data) || data.ok !== true) return { ok: false as const, uncertain: !error?.code, message: error?.message === "SHOP_INACTIVE" ? SHOP_INACTIVE_MESSAGE : "The receipt could not be linked to this expense." };
    revalidatePath("/expenses");
    return { ok: true as const, attachmentId: data.attachment_id as string };
  } catch { return { ok: false as const, uncertain: true, message: "Receipt link status is uncertain." }; }
}
