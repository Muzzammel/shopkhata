import { validateBatch } from "@/lib/domain/batches";
import { invoiceKey } from "@/lib/domain/ids";
import { parseQar } from "@/lib/domain/money";

export type EntryRow = {
  rowId: string;
  invoiceId: string;
  total: string;
  received: string;
  delivered: boolean;
  customerId: string;
  customerName: string;
  customerMobile: string;
};

export type InvoiceEntryInput = {
  shopId: string;
  businessDate: string;
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

export function selectInvoiceAttempt(input: InvoiceEntryInput, now: Date, previous: InvoiceEntryInput | null): InvoiceEntryInput {
  return previous ?? {
    ...input,
    businessDate: qatarBusinessDate(now),
    rows: input.rows.map((row) => ({ ...row })),
  };
}

export type EntryError = { rowId: string; field: string; message: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidBatchReceipt(value: unknown): value is { ok: true; batch_id: string } {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true
    && "batch_id" in value && typeof value.batch_id === "string" && UUID_PATTERN.test(value.batch_id);
}

export function prepareInvoiceBatch(input: InvoiceEntryInput, existingInvoiceIds: readonly string[], replay = false) {
  const errors: EntryError[] = [];
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
      delivered: row.delivered,
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
    idempotency_key: input.idempotencyKey,
    rows: input.rows.map((row, index) => ({
      row_id: row.rowId,
      invoice_number: row.invoiceId.trim(),
      total_dirham: amounts[index].total,
      received_dirham: amounts[index].received,
      payment_method: "cash",
      delivered: row.delivered,
      customer: row.customerId.trim()
        ? { type: "existing", customer_id: row.customerId.trim() }
        : row.customerName.trim() || row.customerMobile.trim()
          ? { type: "quick_add", name: row.customerName.trim() || null, mobile: row.customerMobile.trim() || null }
          : null,
    })),
  };
  return { command, errors, totals: totalsAreSafe ? domain.totals : null };
}
