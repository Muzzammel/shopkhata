import { qar } from "@/lib/dashboard-view";
import type { InvoiceDetail } from "@/lib/invoice-detail";
import type { DeliveryStatus } from "@/lib/invoice-delivery";
import { paymentMethodLabel } from "@/lib/payment-method";

// View-only helpers for Sales, New Sale and Invoice Detail. Nothing here computes a balance:
// every figure is passed in from effective_invoices or the server's own history rows.

export type InvoiceBadge = "void" | "paid" | "due" | "delivered" | "partial" | "corrected" | "replaced";
export const BADGE_LABEL: Record<InvoiceBadge, string> = { void: "Void", paid: "Paid", due: "Due", delivered: "Delivered", partial: "Partially delivered", corrected: "Corrected", replaced: "Replaced" };

/**
 * Derived display states only; none of them is stored. Paid/due follow the list's own "fully paid" rule (due ≤ 0).
 * A void invoice is neither paid nor corrected: it shows Void instead. Delivered means fully delivered (legacy: the yes/no
 * flag); a piece-tracked invoice with some pieces still to hand over shows Partially delivered, never Delivered.
 */
export function invoiceBadges(invoice: { dueDirham: number; delivery: DeliveryStatus; corrected: boolean; revision: number; isVoid?: boolean }): InvoiceBadge[] {
  return [
    invoice.isVoid ? "void" : invoice.dueDirham > 0 ? "due" : "paid",
    ...(invoice.delivery === "full" ? ["delivered" as const] : invoice.delivery === "partial" ? ["partial" as const] : []),
    ...(invoice.corrected && !invoice.isVoid ? ["corrected" as const] : []),
    ...(invoice.revision > 0 ? ["replaced" as const] : []),
  ];
}

export const qatarDateTime = (iso: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Qatar" }).format(new Date(iso));
export const longDate = (isoDate: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${isoDate}T00:00:00Z`));
export const signedQar = (dirham: number) => `${dirham < 0 ? "−" : "+"}${qar(Math.abs(dirham))}`;

/** A person's name when the viewer may read it, otherwise the existing safe identifier, shortened. */
export function personLabel(people: Record<string, string>, id: string | null | undefined): string {
  if (!id) return "Unknown";
  return people[id] ?? `Team member …${id.slice(-8)}`;
}

export function customerLabel(customerNames: Record<string, string>, id: string | null): string {
  if (!id) return "No customer";
  return customerNames[id] ?? `Customer …${id.slice(-8)}`;
}

export type TimelineChange = { label: string; from?: string; to: string };
export type TimelineEvent = {
  id: string;
  at: string;
  kind: "created" | "payment" | "correction" | "replacement" | "applied" | "receipt";
  title: string;
  actor: string;
  status?: "pending" | "approved" | "rejected";
  decidedBy?: string;
  decidedAt?: string;
  decisionReason?: string | null;
  changes: TimelineChange[];
  reason?: string;
  /** Approved replacement version this event produced. */
  version?: number;
};

type Version = { number: string; customerId: string | null; delivered: boolean };

/**
 * The invoice's story, oldest first: how it was recorded, every payment, and every correction or
 * replacement request with its decision. A replacement is compared with the approved version it was
 * based on, so only the fields it actually changes are shown as changes.
 */
export function buildTimeline(detail: InvoiceDetail): TimelineEvent[] {
  const person = (id: string | null | undefined) => personLabel(detail.people, id);
  const customer = (id: string | null) => customerLabel(detail.customerNames, id);
  const delivery = (delivered: boolean) => delivered ? "Delivered" : "Not delivered";

  const versions = new Map<number, Version>([[0, { number: detail.originalInvoiceNumber, customerId: detail.originalCustomerId, delivered: detail.originalDelivered }]]);
  for (const change of detail.changes) {
    if (change.kind === "replacement" && change.decision?.outcome === "approved" && change.decision.revision !== null) {
      versions.set(change.decision.revision, { number: change.invoiceNumber ?? "", customerId: change.customerId, delivered: Boolean(change.delivered) });
    }
  }
  const requestIds = new Set(detail.changes.map((change) => change.id));
  const paymentsById = new Map(detail.payments.map((payment) => [payment.id, payment]));

  const events: TimelineEvent[] = [{
    id: `created-${detail.id}`, at: detail.recordedAt, kind: "created", title: "Invoice recorded", actor: person(detail.createdBy),
    changes: [
      { label: "Invoice number", to: detail.originalInvoiceNumber }, { label: "Total", to: qar(detail.originalTotalDirham) },
      { label: "Customer", to: customer(detail.originalCustomerId) }, { label: "Delivery", to: delivery(detail.originalDelivered) },
    ],
  }];
  for (const payment of detail.payments) {
    events.push({ id: payment.id, at: payment.recordedAt, kind: "payment", title: "Payment recorded", actor: person(payment.createdBy), changes: [{ label: `${paymentMethodLabel(payment.paymentMethod)} · business date ${payment.businessDate}`, to: qar(payment.amountDirham) }] });
  }
  for (const change of detail.changes) {
    const decision = change.decision;
    const base = {
      id: change.id, at: change.requestedAt, actor: person(change.requestedBy), reason: change.reason,
      status: !decision ? "pending" as const : decision.outcome === "approved" ? "approved" as const : "rejected" as const,
      decidedBy: decision ? person(decision.actor) : undefined, decidedAt: decision?.at, decisionReason: decision?.reason,
    };
    if (change.kind === "correction") {
      const payment = change.paymentId ? paymentsById.get(change.paymentId) : undefined;
      events.push({
        ...base, kind: "correction", title: change.paymentId ? "Payment correction requested" : "Correction requested",
        changes: change.correctedTotal !== null && change.expectedTotal !== null
          ? [{ label: "Invoice total", from: qar(change.expectedTotal), to: qar(change.correctedTotal) }, { label: "Difference", to: signedQar(change.amountDelta ?? 0) }]
          : [{ label: payment ? `Payment of ${qar(payment.amountDirham)} on ${payment.businessDate}` : change.paymentId ? "Payment" : "Invoice total", to: signedQar(change.amountDelta ?? 0) }],
      });
    } else {
      const before = change.expectedRevision === null ? undefined : versions.get(change.expectedRevision);
      const requested: Version = { number: change.invoiceNumber ?? "", customerId: change.customerId, delivered: Boolean(change.delivered) };
      const rows: TimelineChange[] = [
        { label: "Invoice number", from: before?.number, to: requested.number },
        { label: "Customer", from: before ? customer(before.customerId) : undefined, to: customer(requested.customerId) },
        { label: "Delivery", from: before ? delivery(before.delivered) : undefined, to: delivery(requested.delivered) },
      ];
      // Against a known base, unchanged fields are noise; without one, show every requested value.
      const changed = before ? rows.filter((row) => row.from !== row.to) : rows;
      const onlyDelivery = before !== undefined && changed.length === 1 && changed[0].label === "Delivery";
      events.push({
        ...base, kind: "replacement", title: onlyDelivery ? "Delivery change requested" : "Replacement requested", changes: changed.length ? changed : rows,
        version: decision?.outcome === "approved" && decision.revision !== null ? decision.revision : undefined,
      });
    }
  }
  // Approved corrections recorded without a request on this invoice (older records, and a void) still belong in the story.
  const voided = detail.voided;
  if (voided && !voided.correctionId) {
    events.push({ id: voided.id, at: voided.createdAt, kind: "applied", title: "Invoice voided", actor: person(voided.actorId), reason: voided.reason, status: "approved", changes: [{ label: `Business date ${voided.businessDate}`, to: qar(0) }] });
  }
  for (const correction of detail.corrections) {
    if (correction.requestId && requestIds.has(correction.requestId)) continue;
    events.push({
      id: correction.id, at: correction.recordedAt, kind: "applied", title: correction.id === voided?.correctionId ? "Invoice voided" : correction.paymentId ? "Payment correction applied" : "Correction applied",
      actor: person(correction.actorId), reason: correction.reason, status: "approved", changes: [{ label: `Business date ${correction.businessDate}`, to: signedQar(correction.amountDeltaDirham) }],
    });
  }
  // A sale's receipt payment shares the invoice's timestamp; the invoice still comes first.
  return events.sort((a, b) => a.at.localeCompare(b.at) || Number(b.kind === "created") - Number(a.kind === "created") || a.id.localeCompare(b.id));
}
