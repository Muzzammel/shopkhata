import { readAllPages } from "@/lib/read-all-pages";
import { can, type Actor } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import { readInvoiceChanges, type ChangeRequest } from "@/lib/invoice-change-history";

export type InvoiceDetailCorrection = {
  id: string;
  amountDeltaDirham: number;
  reason: string;
  businessDate: string;
  recordedAt: string;
  actorId: string | null;
  actorName: string | null;
  paymentId: string | null;
};

export type InvoiceDetail = {
  id: string;
  shopId: string;
  invoiceNumber: string;
  originalInvoiceNumber: string;
  originalCustomerId: string | null;
  originalDelivered: boolean;
  revision: number;
  changes: ChangeRequest[];
  originalTotalDirham: number;
  effectiveTotalDirham: number;
  effectivePaidDirham: number;
  effectiveCreditAppliedDirham: number;
  effectiveDueDirham: number;
  businessDate: string;
  recordedAt: string;
  createdBy: string | null;
  creatorName: string | null;
  delivered: boolean;
  customer: { id: string; name: string | null; mobile: string | null; publicId: string } | null;
  payments: Array<{
    id: string;
    amountDirham: number;
    businessDate: string;
    recordedAt: string;
    paymentMethod: string;
    createdBy: string | null;
    creatorName: string | null;
  }>;
  corrections: InvoiceDetailCorrection[];
};

export async function readInvoiceDetail(actor: Actor, shopId: string, canonicalInvoiceId: string): Promise<InvoiceDetail | null> {
  if (!can(actor, "records.view_assigned", shopId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(canonicalInvoiceId)) return null;
  const supabase = await createServerSupabaseClient();
  const { data: invoice, error: invoiceError } = await supabase.from("invoices")
    .select("id, shop_id, invoice_id, total_amount_dirham, business_date, recorded_at, created_by, delivered, customer_id")
    .eq("shop_id", shopId).eq("id", canonicalInvoiceId).maybeSingle();
  if (invoiceError || !invoice) return null;

  const { data: effective, error: effectiveError } = await supabase.from("effective_invoices").select("*")
    .eq("shop_id", shopId).eq("canonical_invoice_id", canonicalInvoiceId).maybeSingle();
  if (effectiveError || !effective) return null;
  const changes = await readInvoiceChanges(shopId, canonicalInvoiceId);
  const [customerResult, paymentResult, invoiceCorrectionsResult] = await Promise.all([
    effective.effective_customer_id
      ? supabase.from("customers").select("id, shop_id, name, mobile, public_id").eq("shop_id", shopId).eq("id", effective.effective_customer_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    readAllPages((o, e) => supabase.from("payments")
      .select("id, shop_id, amount_dirham, business_date, recorded_at, payment_method, created_by")
      .eq("shop_id", shopId).eq("invoice_id", canonicalInvoiceId).order("recorded_at", { ascending: true }).order("id", { ascending: true }).range(o,e)),
    readAllPages((o, e) => supabase.from("corrections")
      .select("id, shop_id, amount_delta_dirham, reason, business_date, recorded_at, created_by, approved_by, payment_id")
      .eq("shop_id", shopId).eq("invoice_id", canonicalInvoiceId).not("approved_by", "is", null)
      .order("recorded_at", { ascending: true }).order("id", { ascending: true }).range(o,e)),
  ]);
  const payments = paymentResult.data;
  const invoiceCorrections = invoiceCorrectionsResult.data;
  if (customerResult.error || paymentResult.error || !payments || invoiceCorrectionsResult.error || !invoiceCorrections) return null;
  if (effective.effective_customer_id && (!customerResult.data || customerResult.data.shop_id !== shopId)) return null;

  const paymentIds = payments.map((payment) => payment.id);
  const paymentCorrections: NonNullable<typeof invoiceCorrections> = [];
  for (let offset=0; offset<paymentIds.length; offset+=100) {
    const result = await readAllPages((o,e) => supabase.from("corrections")
      .select("id, shop_id, amount_delta_dirham, reason, business_date, recorded_at, created_by, approved_by, payment_id")
      .eq("shop_id", shopId).in("payment_id", paymentIds.slice(offset,offset+100)).not("approved_by", "is", null)
      .order("recorded_at").order("id").range(o,e));
    if (result.error || !result.data) return null;
    paymentCorrections.push(...result.data);
  }

  const corrections = [...invoiceCorrections, ...paymentCorrections];
  const actorIds = [...new Set([invoice.created_by, ...payments.map((p) => p.created_by), ...corrections.flatMap((c) => [c.created_by, c.approved_by])].filter((id): id is string => Boolean(id)))];
  const { data: profiles, error: profilesError } = actorIds.length
    ? await supabase.from("profiles").select("id, display_name").in("id", actorIds)
    : { data: [], error: null };
  if (profilesError || !profiles) return null;
  const names = new Map(profiles.map((profile) => [profile.id, profile.display_name]));

  return {
    id: invoice.id,
    shopId: invoice.shop_id,
    invoiceNumber: effective.effective_invoice_number!,
    originalInvoiceNumber: invoice.invoice_id,
    originalCustomerId: invoice.customer_id,
    originalDelivered: invoice.delivered,
    revision: effective.revision!,
    changes,
    originalTotalDirham: invoice.total_amount_dirham,
    effectiveTotalDirham: effective.effective_total_dirham!,
    effectivePaidDirham: effective.effective_paid_dirham!,
    effectiveCreditAppliedDirham: effective.effective_credit_applied_dirham ?? 0,
    effectiveDueDirham: effective.effective_due_dirham!,
    businessDate: invoice.business_date,
    recordedAt: invoice.recorded_at,
    createdBy: invoice.created_by,
    creatorName: invoice.created_by ? names.get(invoice.created_by) ?? null : null,
    delivered: effective.effective_delivered!,
    customer: customerResult.data ? {
      id: customerResult.data.id,
      name: customerResult.data.name,
      mobile: customerResult.data.mobile,
      publicId: customerResult.data.public_id,
    } : null,
    payments: payments.map((payment) => ({
      id: payment.id,
      amountDirham: payment.amount_dirham,
      businessDate: payment.business_date,
      recordedAt: payment.recorded_at,
      paymentMethod: payment.payment_method,
      createdBy: payment.created_by,
      creatorName: payment.created_by ? names.get(payment.created_by) ?? null : null,
    })),
    corrections: corrections.map((correction) => ({
      id: correction.id,
      amountDeltaDirham: correction.amount_delta_dirham,
      reason: correction.reason,
      businessDate: correction.business_date,
      recordedAt: correction.recorded_at,
      actorId: correction.approved_by,
      actorName: correction.approved_by ? names.get(correction.approved_by) ?? null : null,
      paymentId: correction.payment_id,
    })),
  };
}
