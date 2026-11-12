import { readAllPages } from "@/lib/read-all-pages";
import { can, type Actor } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import { readInvoiceChanges, type ChangeRequest } from "@/lib/invoice-change-history";
import { summarizeDeliveries, type PieceDelivery } from "@/lib/invoice-delivery";

export type InvoiceDetailCorrection = {
  id: string;
  amountDeltaDirham: number;
  reason: string;
  businessDate: string;
  recordedAt: string;
  actorId: string | null;
  actorName: string | null;
  paymentId: string | null;
  requestId: string | null;
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
  /** Piece tracking from the delivery ledger; null for a legacy invoice (yes/no delivery only, no piece counts). */
  pieces: PieceDelivery | null;
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
  /** The void, when the invoice was voided. The invoice row itself is never changed. */
  voided?: { id: string; reason: string; businessDate: string; actorId: string; createdAt: string; correctionId: string | null } | null;
  /** Display names for every person in the history, read under the viewer's own profile access; a missing id stays unresolved. */
  people: Record<string, string>;
  /** Names of customers the history refers to (original and requested), from this shop only. */
  customerNames: Record<string, string>;
};

export async function readInvoiceDetail(actor: Actor, shopId: string, canonicalInvoiceId: string): Promise<InvoiceDetail | null> {
  if (!can(actor, "records.view_assigned", shopId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(canonicalInvoiceId)) return null;
  const supabase = await createServerSupabaseClient();
  const { data: invoice, error: invoiceError } = await supabase.from("invoices")
    .select("id, shop_id, invoice_id, total_amount_dirham, business_date, recorded_at, created_by, delivered, customer_id, ordered_pieces")
    .eq("shop_id", shopId).eq("id", canonicalInvoiceId).maybeSingle();
  if (invoiceError || !invoice) return null;

  const { data: effective, error: effectiveError } = await supabase.from("effective_invoices").select("*")
    .eq("shop_id", shopId).eq("canonical_invoice_id", canonicalInvoiceId).maybeSingle();
  if (effectiveError || !effective) return null;
  const changes = await readInvoiceChanges(shopId, canonicalInvoiceId);
  const [customerResult, paymentResult, invoiceCorrectionsResult, voidResult, deliveryResult, pieceCorrectionResult] = await Promise.all([
    effective.effective_customer_id
      ? supabase.from("customers").select("id, shop_id, name, mobile, public_id").eq("shop_id", shopId).eq("id", effective.effective_customer_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    readAllPages((o, e) => supabase.from("payments")
      .select("id, shop_id, amount_dirham, business_date, recorded_at, payment_method, created_by")
      .eq("shop_id", shopId).eq("invoice_id", canonicalInvoiceId).order("recorded_at", { ascending: true }).order("id", { ascending: true }).range(o,e)),
    readAllPages((o, e) => supabase.from("corrections")
      .select("id, shop_id, amount_delta_dirham, reason, business_date, recorded_at, created_by, approved_by, payment_id, request_id")
      .eq("shop_id", shopId).eq("invoice_id", canonicalInvoiceId).not("approved_by", "is", null)
      .order("recorded_at", { ascending: true }).order("id", { ascending: true }).range(o,e)),
    effective.is_void
      ? supabase.from("invoice_voids").select("id, reason, business_date, actor_user_id, created_at, correction_id").eq("shop_id", shopId).eq("invoice_id", canonicalInvoiceId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    invoice.ordered_pieces != null
      ? readAllPages((o, e) => supabase.from("invoice_deliveries")
        .select("id, pieces, business_date, recorded_at, created_by, batch_id, reverses_delivery_id, reason")
        .eq("shop_id", shopId).eq("invoice_id", canonicalInvoiceId).order("recorded_at", { ascending: true }).order("id", { ascending: true }).range(o, e))
      : Promise.resolve({ data: [], error: null }),
    invoice.ordered_pieces != null
      ? readAllPages((o, e) => supabase.from("invoice_piece_corrections")
        .select("id, ordered_before, ordered_after, reason, business_date, recorded_at, created_by")
        .eq("shop_id", shopId).eq("invoice_id", canonicalInvoiceId).order("seq", { ascending: true }).range(o, e))
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (deliveryResult.error || !deliveryResult.data || pieceCorrectionResult.error || !pieceCorrectionResult.data) return null;
  const pieceCorrections = pieceCorrectionResult.data;
  const deliveries = deliveryResult.data;
  const payments = paymentResult.data;
  const invoiceCorrections = invoiceCorrectionsResult.data;
  if (voidResult.error || (effective.is_void && !voidResult.data)) return null;
  if (customerResult.error || paymentResult.error || !payments || invoiceCorrectionsResult.error || !invoiceCorrections) return null;
  if (effective.effective_customer_id && (!customerResult.data || customerResult.data.shop_id !== shopId)) return null;

  const paymentIds = payments.map((payment) => payment.id);
  const paymentCorrections: NonNullable<typeof invoiceCorrections> = [];
  for (let offset=0; offset<paymentIds.length; offset+=100) {
    const result = await readAllPages((o,e) => supabase.from("corrections")
      .select("id, shop_id, amount_delta_dirham, reason, business_date, recorded_at, created_by, approved_by, payment_id, request_id")
      .eq("shop_id", shopId).in("payment_id", paymentIds.slice(offset,offset+100)).not("approved_by", "is", null)
      .order("recorded_at").order("id").range(o,e));
    if (result.error || !result.data) return null;
    paymentCorrections.push(...result.data);
  }

  const corrections = [...invoiceCorrections, ...paymentCorrections];
  const actorIds = [...new Set([
    invoice.created_by, ...payments.map((p) => p.created_by), ...deliveries.map((d) => d.created_by), ...pieceCorrections.map((c) => c.created_by), ...corrections.flatMap((c) => [c.created_by, c.approved_by]),
    ...changes.flatMap((c) => [c.requestedBy, c.decision?.actor]), voidResult.data?.actor_user_id,
  ].filter((id): id is string => Boolean(id)))];
  // One read each for people and customers. Customer names only label the history, so a failed read leaves them unresolved instead of hiding the invoice.
  const customerIds = [...new Set([invoice.customer_id, ...changes.map((c) => c.customerId)].filter((id): id is string => Boolean(id)))];
  const [{ data: profiles, error: profilesError }, { data: historyCustomers }] = await Promise.all([
    actorIds.length ? supabase.from("profiles").select("id, display_name").in("id", actorIds) : Promise.resolve({ data: [], error: null }),
    customerIds.length ? supabase.from("customers").select("id, name, public_id").eq("shop_id", shopId).in("id", customerIds) : Promise.resolve({ data: [] }),
  ]);
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
    pieces: invoice.ordered_pieces == null ? null : summarizeDeliveries(invoice.ordered_pieces, deliveries.map((d) => ({
      id: d.id, pieces: d.pieces, businessDate: d.business_date, recordedAt: d.recorded_at, createdBy: d.created_by, withSale: d.batch_id != null, reversesId: d.reverses_delivery_id, reason: d.reason,
    })), pieceCorrections.map((c) => ({
      id: c.id, before: c.ordered_before, after: c.ordered_after, reason: c.reason, businessDate: c.business_date, recordedAt: c.recorded_at, createdBy: c.created_by,
    }))),
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
      requestId: correction.request_id,
    })),
    voided: voidResult.data ? {
      id: voidResult.data.id, reason: voidResult.data.reason, businessDate: voidResult.data.business_date,
      actorId: voidResult.data.actor_user_id, createdAt: voidResult.data.created_at, correctionId: voidResult.data.correction_id,
    } : null,
    people: Object.fromEntries(names),
    customerNames: Object.fromEntries((historyCustomers ?? []).map((c) => [c.id, `${c.name || "Unnamed customer"} · ${c.public_id}`])),
  };
}
