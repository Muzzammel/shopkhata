import type { EntryError, EntryRow } from "@/lib/invoice-entry";

// Fixed import schema. Order and names are part of the contract; a workbook
// with a missing, duplicated, shifted or unknown column is rejected whole.
export const IMPORT_HEADERS = ["Invoice Number", "Total QAR", "Received QAR", "Delivered", "Customer Name", "Customer Mobile", "Note"] as const;
export const IMPORT_SHEET_NAME = "Invoices";
export const MAX_IMPORT_ROWS = 100; // matches the server's rows-per-batch limit
export const MAX_IMPORT_FILE_BYTES = 1_048_576;

export type ImportCell = string | number | boolean | Date | null | undefined | object;
export type ImportResult = {
  rows: EntryRow[];
  /** Spreadsheet row number (1-based, header is row 1) for each imported row ID. */
  sheetRows: Record<string, number>;
  /** Cell-level problems; rowId "" marks a file-level problem that blocks the whole import. */
  errors: EntryError[];
};

const normalizeHeader = (value: ImportCell) => typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
const isBlank = (value: ImportCell) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");
const fileError = (message: string): ImportResult => ({ rows: [], sheetRows: {}, errors: [{ rowId: "", field: "file", message }] });

const TRUE_VALUES = new Set(["yes", "y", "true", "1", "delivered"]);
const FALSE_VALUES = new Set(["no", "n", "false", "0", "advance", ""]);

/** Text cell, or a whole number typed into a numeric cell (invoice IDs, mobiles). */
function textCell(value: ImportCell): string | null {
  if (isBlank(value)) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/** Money stays a decimal string so the shared parseQar validation decides. */
function moneyCell(value: ImportCell): string | null {
  if (isBlank(value)) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel stores 19.99 as a binary float; toFixed(2) is exact only when the
    // cell really has at most two decimals. Otherwise keep the raw digits so
    // the row fails validation instead of being silently rounded.
    const fixed = value.toFixed(2);
    return Number(fixed) === value ? fixed : String(value);
  }
  return null;
}

function deliveredCell(value: ImportCell): boolean | null {
  if (typeof value === "boolean") return value;
  const text = isBlank(value) ? "" : typeof value === "string" || typeof value === "number" ? String(value).trim().toLowerCase() : null;
  if (text === null) return null;
  return TRUE_VALUES.has(text) ? true : FALSE_VALUES.has(text) ? false : null;
}

/**
 * Turns sheet cells into the same draft rows manual entry produces. It only
 * checks structure and cell types; money, duplicate, customer and total rules
 * stay in prepareInvoiceBatch and submit_batch so import cannot diverge.
 */
export function parseImportSheet(data: readonly (readonly ImportCell[])[], newRowId: () => string = () => crypto.randomUUID()): ImportResult {
  const header = data[0] ?? [];
  const seen = header.map(normalizeHeader);
  while (seen.length && seen[seen.length - 1] === "") seen.pop();
  const expected = IMPORT_HEADERS.map((name) => name.toLowerCase());
  const duplicate = seen.find((name, index) => name && seen.indexOf(name) !== index);
  if (duplicate) return fileError(`Column "${duplicate}" appears more than once. Use the import template.`);
  const missing = IMPORT_HEADERS.filter((name) => !seen.includes(name.toLowerCase()));
  if (missing.length) return fileError(`Missing column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Use the import template.`);
  const unknown = seen.filter((name) => !expected.includes(name));
  if (unknown.length) return fileError(`Unexpected column${unknown.length === 1 ? "" : "s"}: ${unknown.map((name) => name || "(blank)").join(", ")}. Use the import template.`);
  if (seen.some((name, index) => name !== expected[index])) return fileError(`Columns must be in this order: ${IMPORT_HEADERS.join(", ")}.`);

  const body = data.slice(1).map((cells, index) => ({ cells, sheetRow: index + 2 })).filter(({ cells }) => !cells.every(isBlank));
  if (body.length === 0) return fileError("The workbook has no invoice rows.");
  if (body.length > MAX_IMPORT_ROWS) return fileError(`The workbook has ${body.length} rows. Import at most ${MAX_IMPORT_ROWS} rows per batch.`);

  const result: ImportResult = { rows: [], sheetRows: {}, errors: [] };
  for (const { cells, sheetRow } of body) {
    const rowId = newRowId();
    const fail = (field: string, message: string) => result.errors.push({ rowId, field, message: `Row ${sheetRow}: ${message}` });
    if (cells.slice(IMPORT_HEADERS.length).some((cell) => !isBlank(cell))) fail("row", "has values outside the template columns.");
    const [number, total, received, delivered, name, mobile, note] = cells;
    const invoiceId = textCell(number);
    if (invoiceId === null) fail("invoiceId", "Invoice Number must be text or a whole number.");
    const totalText = moneyCell(total);
    if (totalText === null) fail("total", "Total QAR must be a number.");
    const receivedText = moneyCell(received);
    if (receivedText === null) fail("received", "Received QAR must be a number.");
    const deliveredValue = deliveredCell(delivered);
    if (deliveredValue === null) fail("delivered", "Delivered must be Yes or No.");
    const customerName = textCell(name);
    if (customerName === null) fail("customer", "Customer Name must be text.");
    const customerMobile = textCell(mobile);
    if (customerMobile === null) fail("customer", "Customer Mobile must be text or digits.");
    const noteText = textCell(note);
    if (noteText === null) fail("note", "Note must be text.");
    result.rows.push({
      rowId, invoiceId: invoiceId ?? "", total: totalText ?? "", received: receivedText ?? "",
      delivered: deliveredValue ?? false, customerId: "", customerName: customerName ?? "",
      customerMobile: customerMobile ?? "", note: noteText ?? "",
    });
    result.sheetRows[rowId] = sheetRow;
  }
  return result;
}

/** Spreadsheet-style paste: tab-separated rows in template column order, header optional. */
export function parsePastedRows(text: string, newRowId?: () => string): ImportResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.split("\t"));
  const hasHeader = normalizeHeader(lines[0]?.[0]) === IMPORT_HEADERS[0].toLowerCase();
  return parseImportSheet(hasHeader ? lines : [[...IMPORT_HEADERS], ...lines], newRowId);
}

const headerRow = (names: readonly string[]) => names.map((value) => ({ value, fontWeight: "bold" as const }));

/** Template workbook: an empty Invoices sheet plus instructions with illustrative, fictional rows. */
export function importTemplateSheets() {
  return [
    { sheet: IMPORT_SHEET_NAME, stickyRowsCount: 1, columns: IMPORT_HEADERS.map(() => ({ width: 20 })), data: [headerRow(IMPORT_HEADERS)] },
    {
      sheet: "Instructions", columns: [{ width: 20 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 20 }, { width: 18 }, { width: 44 }],
      data: [
        [{ value: "Fill the Invoices sheet. Do not rename, reorder, add or remove columns.", fontWeight: "bold" as const }],
        [`At most ${MAX_IMPORT_ROWS} rows per file. Shop and business date are chosen in ShopKhata, not in the file.`],
        ["Invoice Number: required text. Format the cell as Text to keep leading zeros."],
        ["Total QAR: required, greater than zero, at most two decimals. Received QAR: blank or 0 up to the total."],
        ["Delivered: Yes or No (blank means No). A delivered invoice with due needs a customer name or mobile."],
        ["Nothing is saved on import. Rows go to the draft for review before you save the batch."],
        [],
        [{ value: "Examples (do not copy into ShopKhata)", fontWeight: "bold" as const }],
        headerRow(IMPORT_HEADERS),
        ["EX-1001", 150, 150, "Yes", "", "", "Paid in full"],
        ["EX-1002", 80.5, 20, "Yes", "Example Customer", "55500000", "Balance due on delivery"],
        ["EX-1003", 60, 10, "No", "", "", "Advance"],
      ],
    },
  ];
}
