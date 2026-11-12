import { validateBatch } from "@/lib/domain/batches";
import { invoiceKey } from "@/lib/domain/ids";
import { parseQar } from "@/lib/domain/money";
import type { PaymentMethod } from "@/lib/payment-method";

export type EntryRow = {
  rowId: string;
  invoiceId: string;
  total: string;
  received: string;
  /** Only meaningful when something is received; a missing value (older drafts, imports) is cash. */
  paymentMethod?: PaymentMethod;
  delivered: boolean;
  customerId: string;
  customerName: string;
  customerMobile: string;
  note?: string;
  /**
   * Piece tracking. Both undefined = legacy row (older drafts, Excel imports): only the yes/no `delivered` flag is
   * sent, exactly as before. Otherwise both are sent and `delivered` is derived from `deliveredPieces > 0`.
   */
  orderedPieces?: string;
  deliveredPieces?: string;
};

export const isPieceTracked = (row: Pick<EntryRow, "orderedPieces" | "deliveredPieces">) =>
  row.orderedPieces !== undefined || row.deliveredPieces !== undefined;

const MAX_PIECES = 2_147_483_647;
/** Whole number of pieces, or null when it is not one (no signs, decimals or exponents). */
export function parsePieces(value: string | undefined): number | null {
  const text = (value ?? "").trim();
  if (!/^\d{1,10}$/.test(text)) return null;
  const n = Number(text);
  return n <= MAX_PIECES ? n : null;
}

/** Ordered/delivered/remaining for a tracked row; null parts while a field is not a valid count yet. */
export function rowPieces(row: Pick<EntryRow, "orderedPieces" | "deliveredPieces">) {
  const ordered = parsePieces(row.orderedPieces);
  const delivered = parsePieces(row.deliveredPieces);
  const valid = ordered !== null && ordered >= 1 && delivered !== null && delivered <= ordered;
  return { ordered, delivered, remaining: valid ? ordered - delivered : null, valid };
}

/** The delivery flag the server will record for this row. */
export function rowDelivered(row: EntryRow): boolean {
  return isPieceTracked(row) ? (parsePieces(row.deliveredPieces) ?? 0) > 0 : row.delivered;
}

export type InvoiceEntryInput = {
  shopId: string;
  businessDate: string;
  isBackdated: boolean;
  backdatedReason: string;
  idempotencyKey: string;
  rows: EntryRow[];
};

export function qatarBusinessDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Qatar", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function selectInvoiceAttempt(input: InvoiceEntryInput, previous: InvoiceEntryInput | null): InvoiceEntryInput {
  return previous ?? {
    ...input,
    rows: input.rows.map((row) => ({ ...row })),
  };
}

/**
 * Suggests the next invoice number by incrementing the numeric portion of the current number.
 * Preserves any prefix, separator, suffix, and leading zero padding.
 * If the current number has no numeric portion or cannot be safely incremented, returns an empty string.
 */
export function suggestNextInvoiceNumber(currentNumber: string | null | undefined): string {
  if (typeof currentNumber !== "string") return "";
  const trimmed = currentNumber.trim();
  if (!trimmed) return "";

  // Match the last sequence of digits in the string
  const match = /^(.*?)(\d+)(\D*)$/.exec(trimmed);
  if (!match) return "";

  const [, prefix, digits, suffix] = match;
  try {
    const nextVal = BigInt(digits) + BigInt(1);
    if (nextVal < BigInt(0)) return "";
    const nextDigits = nextVal.toString().padStart(digits.length, "0");
    return `${prefix}${nextDigits}${suffix}`;
  } catch {
    return "";
  }
}

export type EntryError = { rowId: string; field: string; message: string; code?: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidBatchReceipt(value: unknown): value is { ok: true; batch_id: string } {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true
    && "batch_id" in value && typeof value.batch_id === "string" && UUID_PATTERN.test(value.batch_id);
}

export function prepareInvoiceBatch(input: InvoiceEntryInput, existingInvoiceIds: readonly string[], replay = false, today?: string) {
  const errors: EntryError[] = [];
  if (today && !replay && input.isBackdated !== (input.businessDate < today)) {
    errors.push({ rowId: "", field: "businessDate", message: "Refresh the business date and review the batch again." });
  }
  const backdatedReason = input.backdatedReason.trim() || null;
  if (input.isBackdated && !backdatedReason) {
    errors.push({ rowId: "", field: "backdatedReason", message: "Enter a reason for the backdated batch." });
  }
  const amounts = input.rows.map((row) => {
    let total = 0;
    let received = 0;
    try {
      total = parseQar(row.total.trim());
      if (total <= 0) throw new Error("positive total required");
    } catch {
      errors.push({ rowId: row.rowId, field: "total", message: "Enter a positive amount in QAR with at most two decimals." });
    }
    try {
      received = parseQar((row.received.trim() || "0"));
      if (received > total && total > 0) throw new Error("overpayment");
    } catch {
      errors.push({ rowId: row.rowId, field: "received", message: "Received must be a valid QAR amount no greater than the total." });
    }
    if (!row.invoiceId.trim()) errors.push({ rowId: row.rowId, field: "invoiceId", message: "Invoice ID is required." });
    if (isPieceTracked(row)) {
      const pieces = rowPieces(row);
      if (pieces.ordered === null || pieces.ordered < 1) {
        errors.push({ rowId: row.rowId, field: "orderedPieces", message: "Ordered pieces must be a whole number of at least 1." });
      } else if (pieces.delivered === null || pieces.delivered > pieces.ordered) {
        errors.push({ rowId: row.rowId, field: "deliveredPieces", message: `Delivered now must be a whole number from 0 to ${pieces.ordered}.` });
      }
    }
    return { total, received };
  });

  if (input.rows.length === 0) errors.push({ rowId: "", field: "rows", message: "Add at least one invoice." });
  const domain = validateBatch({
    shopId: input.shopId,
    rows: input.rows.map((row, index) => ({
      rowId: row.rowId,
      invoiceId: row.invoiceId,
      type: "ADVANCE" as const,
      total: amounts[index].total,
      received: amounts[index].received,
      delivered: rowDelivered(row),
      customerId: row.customerId.trim() || (row.customerName.trim() || row.customerMobile.trim() ? "quick-add" : ""),
    })),
  }, { existingInvoiceKeys: new Set((replay ? [] : existingInvoiceIds).map((id) => invoiceKey(input.shopId, id))) });
  errors.push(...domain.rowErrors.map((error) => ({ rowId: error.rowId, field: error.field === "customerId" ? "customer" : error.field, message: error.message })));
  errors.push(...domain.warnings.map((warning) => ({ rowId: warning.rowId, field: "received", message: warning.message })));

  const totalsAreSafe = Object.values(domain.totals).every(Number.isSafeInteger);
  if (!totalsAreSafe) errors.push({ rowId: "", field: "rows", message: "Batch totals exceed the supported dirham range." });

  const command = errors.length ? null : {
    shop_id: input.shopId,
    business_date: input.businessDate,
    is_backdated: input.isBackdated,
    backdated_reason: input.isBackdated ? backdatedReason : null,
    idempotency_key: input.idempotencyKey,
    rows: input.rows.map((row, index) => ({
      row_id: row.rowId,
      invoice_number: row.invoiceId.trim(),
      total_dirham: amounts[index].total,
      received_dirham: amounts[index].received,
      payment_method: amounts[index].received > 0 ? row.paymentMethod ?? "cash" : "cash",
      delivered: rowDelivered(row),
      ...(isPieceTracked(row) ? { ordered_pieces: parsePieces(row.orderedPieces) as number, delivered_pieces: parsePieces(row.deliveredPieces) as number } : {}),
      ...(row.note?.trim() ? { note: row.note.trim() } : {}),
      customer: row.customerId.trim()
        ? { type: "existing", customer_id: row.customerId.trim() }
        : row.customerName.trim() || row.customerMobile.trim()
          ? { type: "quick_add", name: row.customerName.trim() || null, mobile: row.customerMobile.trim() || null }
          : null,
    })),
  };
  return { command, errors, totals: totalsAreSafe ? domain.totals : null };
}
