import { z } from "zod";

import { operationError, voidReasonError } from "@/lib/invoice-operations";

/** One later delivery: the exact command sent to record_invoice_delivery, and resent unchanged on a retry. */
export const deliveryInput = z.object({
  shop_id: z.uuid(), invoice_id: z.uuid(), pieces: z.number().int().min(1).max(2_147_483_647), idempotency_key: z.uuid(),
}).strict();
export type DeliveryCommand = z.infer<typeof deliveryInput>;

/**
 * One reversal of a whole delivery event: the exact command sent to reverse_invoice_delivery, resent unchanged on a retry.
 * The reason follows the void rule (10 to 2000 characters after trimming).
 */
export const reversalInput = z.object({
  shop_id: z.uuid(), invoice_id: z.uuid(), delivery_id: z.uuid(), idempotency_key: z.uuid(),
  reason: z.string().trim().refine((reason) => voidReasonError(reason) === null),
}).strict();
export type ReversalCommand = z.infer<typeof reversalInput>;

/**
 * One correction of the ordered pieces: the exact command sent to correct_invoice_ordered_pieces, resent unchanged on a
 * retry. expected_ordered_pieces is the quantity the editor saw; the database refuses the command if it changed since.
 */
const pieceCount = z.number().int().min(1).max(2_147_483_647);
export const orderCorrectionInput = z.object({
  shop_id: z.uuid(), invoice_id: z.uuid(), expected_ordered_pieces: pieceCount, ordered_pieces: pieceCount, idempotency_key: z.uuid(),
  reason: z.string().trim().refine((reason) => voidReasonError(reason) === null),
}).strict();
export type OrderCorrectionCommand = z.infer<typeof orderCorrectionInput>;
export type OrderCorrection = { id: string; before: number; after: number; reason: string; businessDate: string; recordedAt: string; createdBy: string };

/** A delivery has positive pieces. A reversal has negative pieces, the id of the delivery it reverses, and a reason. */
export type DeliveryEvent = { id: string; pieces: number; businessDate: string; recordedAt: string; createdBy: string; withSale: boolean; reversesId?: string | null; reason?: string | null };
export type DeliveryStatus = "none" | "partial" | "full";
export type PieceDelivery = {
  ordered: number; originalOrdered: number; delivered: number; remaining: number; status: DeliveryStatus; events: DeliveryEvent[]; corrections: OrderCorrection[];
};

/**
 * Totals come from the append-only ledgers only: delivered from the delivery events, ordered from the latest correction
 * (corrections arrive oldest first), else the original ordered quantity.
 */
export function summarizeDeliveries(originalOrdered: number, events: DeliveryEvent[], corrections: OrderCorrection[] = []): PieceDelivery {
  const ordered = corrections.at(-1)?.after ?? originalOrdered;
  const delivered = events.reduce((sum, event) => sum + event.pieces, 0);
  return { ordered, originalOrdered, delivered, remaining: ordered - delivered, status: delivered === 0 ? "none" : delivered < ordered ? "partial" : "full", events, corrections };
}

export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = { none: "Not delivered", partial: "Partially delivered", full: "Fully delivered" };

/**
 * Reporting state from effective_invoices.delivery_status. Legacy invoices arrive as full/none from their yes/no flag,
 * so the shared labels below keep reading Delivered / Not delivered for them; only tracked invoices can be partial.
 */
export const deliveryStatus = (value: string | null | undefined): DeliveryStatus => value === "partial" || value === "full" ? value : "none";
export const DELIVERY_REPORT_LABEL: Record<DeliveryStatus, string> = { none: "Not delivered", partial: "Partially delivered", full: "Delivered" };
export const DELIVERY_EXPORT_CELL: Record<DeliveryStatus, string> = { none: "No", partial: "Partial", full: "Yes" };

/** Why "Record delivery" is unavailable, or null when it may be offered. The database checks all of this again. */
export function deliveryBlockReason(input: {
  pieces: PieceDelivery | null; isVoid: boolean; shopActive: boolean; todayClosed: boolean; canRecord: boolean;
}): string | null {
  if (!input.canRecord) return "You cannot record deliveries in this shop.";
  if (!input.pieces) return "This invoice was recorded without piece counts. Use Request delivery change.";
  if (input.isVoid) return "This invoice is void. Deliveries cannot be recorded.";
  if (!input.shopActive) return "This shop is inactive. Deliveries cannot be recorded.";
  if (input.todayClosed) return "Today's business date is closed. Deliveries cannot be recorded until it is reopened.";
  if (input.pieces.remaining <= 0) return "All ordered pieces are delivered.";
  return null;
}

/** Why "Reverse delivery" is unavailable for every event of the invoice, or null when it may be offered. The database checks all of this again. */
export function reversalBlockReason(input: { isVoid: boolean; shopActive: boolean; todayClosed: boolean; canReverse: boolean }): string | null {
  if (!input.canReverse) return "Only a manager or owner can reverse a delivery.";
  if (input.isVoid) return "This invoice is void. Deliveries cannot be reversed.";
  if (!input.shopActive) return "This shop is inactive. Deliveries cannot be reversed.";
  if (input.todayClosed) return "Today's business date is closed. Deliveries cannot be reversed until it is reopened.";
  return null;
}

/** Why "Correct ordered pieces" is unavailable, or null when it may be offered. The database checks all of this again. */
export function orderCorrectionBlockReason(input: { isVoid: boolean; shopActive: boolean; todayClosed: boolean; canCorrect: boolean }): string | null {
  if (!input.canCorrect) return "Only a manager or owner can correct ordered pieces.";
  if (input.isVoid) return "This invoice is void. Ordered pieces cannot be corrected.";
  if (!input.shopActive) return "This shop is inactive. Ordered pieces cannot be corrected.";
  if (input.todayClosed) return "Today's business date is closed. Ordered pieces cannot be corrected until it is reopened.";
  return null;
}

/** A typed corrected quantity, or the message to show under the field. */
export function parseOrderedPieces(text: string, pieces: Pick<PieceDelivery, "ordered" | "delivered">): { pieces: number } | { error: string } {
  const value = text.trim();
  if (!/^\d{1,10}$/.test(value) || Number(value) < 1 || Number(value) > 2_147_483_647) return { error: "Enter a whole number of pieces, at least 1." };
  const n = Number(value);
  if (n === pieces.ordered) return { error: `The invoice already has ${n} ordered piece${n === 1 ? "" : "s"}.` };
  if (n < pieces.delivered) return { error: `${pieces.delivered} piece${pieces.delivered === 1 ? " is" : "s are"} already delivered. Reverse a delivery first to go lower.` };
  return { pieces: n };
}

/** Only a delivery (never a reversal) that has not been reversed yet can be reversed. */
export function reversibleDeliveryIds(events: DeliveryEvent[]): Set<string> {
  const reversed = new Set(events.map((event) => event.reversesId).filter(Boolean));
  return new Set(events.filter((event) => event.pieces > 0 && !event.reversesId && !reversed.has(event.id)).map((event) => event.id));
}

/** A typed count, or the message to show under the field. */
export function parseDeliveryPieces(text: string, remaining: number): { pieces: number } | { error: string } {
  const value = text.trim();
  if (!/^\d{1,10}$/.test(value) || Number(value) < 1) return { error: "Enter a whole number of pieces, at least 1." };
  const pieces = Number(value);
  if (pieces > remaining) return { error: `Only ${remaining} piece${remaining === 1 ? "" : "s"} remain to deliver.` };
  return { pieces };
}

export function deliveryError(code: string): string {
  const messages: Record<string, string> = {
    OVER_DELIVERY: "That is more than the pieces still to deliver. Refresh to see the latest deliveries.",
    PIECES_INVALID: "Enter a whole number of pieces, at least 1.",
    LEGACY_INVOICE: "This invoice was recorded without piece counts. Use Request delivery change.",
    CUSTOMER_REQUIRED: "This invoice has money due and no customer. Add a customer with Request replacement before delivering.",
    MAINTENANCE_ACTIVE: "ShopKhata is being updated. Nothing was saved. Try again after the update.",
    INSUFFICIENT_ROLE: "Only a manager or owner can reverse a delivery.",
    REASON_REQUIRED: "Enter the reason for reversing this delivery.",
    REASON_TOO_SHORT: "Explain the reversal in at least 10 characters.",
    REASON_TOO_LONG: "Keep the reason under 2000 characters.",
    ALREADY_REVERSED: "This delivery was already reversed. Refresh to see the latest history.",
    DELIVERY_NOT_FOUND: "The delivery was not found on this invoice.",
    NOT_A_DELIVERY: "A reversal cannot itself be reversed. Record the delivery again instead.",
    NEGATIVE_DELIVERY: "Reversing this delivery would leave fewer than 0 pieces delivered.",
    INVOICE_VOID: "This invoice is void. Deliveries cannot be changed.",
    CLOSED_DATE: "Today's business date is closed. Nothing was saved.",
    STALE_ORDERED_PIECES: "The ordered pieces were changed by someone else. Refresh and check the latest quantity.",
    NO_CHANGE: "That is already the ordered quantity.",
    BELOW_DELIVERED: "More pieces are already delivered than that. Reverse a delivery first to go lower.",
  };
  return Object.hasOwn(messages, code) ? messages[code] : operationError(code);
}
