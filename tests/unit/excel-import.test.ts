import readXlsxFile from "read-excel-file/universal";
import writeXlsxFile from "write-excel-file/universal";
import { describe, expect, it } from "vitest";

import { IMPORT_HEADERS, IMPORT_SHEET_NAME, MAX_IMPORT_ROWS, importTemplateSheets, parseImportSheet, parsePastedRows } from "@/lib/excel/invoice-import";
import { prepareInvoiceBatch } from "@/lib/invoice-entry";

const shopId = "10000000-0000-4000-8000-000000000001";
const ids = () => { let n = 0; return () => `row-${++n}`; };
const validate = (rows: ReturnType<typeof parseImportSheet>["rows"], existing: string[] = []) => prepareInvoiceBatch({
  shopId, businessDate: "2026-10-03", isBackdated: false, backdatedReason: "", idempotencyKey: "k", rows,
}, existing, false, "2026-10-03");

describe("Excel invoice import", () => {
  it("accepts the exact template headers regardless of case and spacing", () => {
    const result = parseImportSheet([IMPORT_HEADERS.map((name) => `  ${name.toUpperCase()} `), ["A-1", 10, 0, "no", null, null, null]], ids());
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
  });

  it.each([
    ["a missing column", [...IMPORT_HEADERS.slice(0, 6)], /Missing column: Note/],
    ["a duplicated column", [...IMPORT_HEADERS, "Total QAR"], /appears more than once/],
    ["an unknown column", [...IMPORT_HEADERS, "Discount"], /Unexpected column: discount/],
    ["shifted columns", ["Total QAR", "Invoice Number", ...IMPORT_HEADERS.slice(2)], /must be in this order/],
    ["a blank header inside the table", ["Invoice Number", "", ...IMPORT_HEADERS.slice(1)], /Unexpected column: \(blank\)/],
  ])("rejects the whole file for %s", (_label, header, message) => {
    const result = parseImportSheet([header, ["A-1", 10, 0, "no", "", "", ""]], ids());
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([{ rowId: "", field: "file", message: expect.stringMatching(message) }]);
  });

  it("rejects an empty workbook and one over the row limit without truncating", () => {
    expect(parseImportSheet([[...IMPORT_HEADERS]], ids()).errors[0].message).toBe("The workbook has no invoice rows.");
    const tooMany = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) => [`N-${index}`, 1, 0, "no", "", "", ""]);
    const result = parseImportSheet([[...IMPORT_HEADERS], ...tooMany], ids());
    expect(result.rows).toEqual([]);
    expect(result.errors[0].message).toBe("The workbook has 101 rows. Import at most 100 rows per batch.");
  });

  it("normalizes cells into the manual draft row shape with stable row IDs and sheet positions", () => {
    const result = parseImportSheet([
      [...IMPORT_HEADERS],
      [" INV-1 ", 80.5, 20, "Yes", " Mary ", 55512345, " call first "],
      [null, null, null, null, null, null, null],
      [1007, "60.00", null, false, null, null, null],
    ], ids());
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { rowId: "row-1", invoiceId: "INV-1", total: "80.50", received: "20.00", delivered: true, customerId: "", customerName: "Mary", customerMobile: "55512345", note: "call first" },
      { rowId: "row-2", invoiceId: "1007", total: "60.00", received: "", delivered: false, customerId: "", customerName: "", customerMobile: "", note: "" },
    ]);
    // The blank spreadsheet row 3 is skipped, so the second invoice still reports row 4.
    expect(result.sheetRows).toEqual({ "row-1": 2, "row-2": 4 });
  });

  it("feeds imported rows through the same batch validation as manual rows", () => {
    const result = parseImportSheet([[...IMPORT_HEADERS], ["INV-1", 80.5, 20, "Yes", "Mary", "", "note"], ["INV-2", 100, 100, "yes", "", "", ""]], ids());
    const prepared = validate(result.rows);
    expect(prepared.errors).toEqual([]);
    expect(prepared.totals).toEqual({ invoiced: 18050, received: 12000, due: 6050 });
    expect(prepared.command?.rows[0]).toEqual({
      row_id: "row-1", invoice_number: "INV-1", total_dirham: 8050, received_dirham: 2000, payment_method: "cash",
      delivered: true, note: "note", customer: { type: "quick_add", name: "Mary", mobile: null },
    });
    expect(prepared.command?.rows[1]).not.toHaveProperty("note");
  });

  it.each([
    [19.99, "19.99"], [0.1, "0.10"], [1234567.89, "1234567.89"], [150, "150.00"], ["12.5", "12.5"],
  ])("keeps money %s exact as %s", (cell, text) => {
    const result = parseImportSheet([[...IMPORT_HEADERS], ["A", cell, 0, "no", "", "", ""]], ids());
    expect(result.rows[0].total).toBe(text);
    expect(validate(result.rows).errors).toEqual([]);
  });

  it.each([
    ["three decimals", 10.005, "total"], ["zero total", 0, "total"], ["negative total", -5, "total"], ["text total", "ten", "total"],
  ])("blocks %s through the shared money validation instead of rounding", (_label, cell, field) => {
    const result = parseImportSheet([[...IMPORT_HEADERS], ["A", cell, 0, "no", "", "", ""]], ids());
    expect(validate(result.rows).command).toBeNull();
    expect(validate(result.rows).errors.map((error) => error.field)).toContain(field);
  });

  it("blocks negative received, received above total, and a delivered due row without a customer", () => {
    const result = parseImportSheet([
      [...IMPORT_HEADERS], ["A", 10, -1, "no", "", "", ""], ["B", 10, 10.01, "no", "", "", ""], ["C", 10, 4, "yes", "", "", ""],
    ], ids());
    const errors = validate(result.rows).errors;
    expect(errors).toContainEqual({ rowId: "row-1", field: "received", message: "Received must be a valid QAR amount no greater than the total." });
    expect(errors).toContainEqual({ rowId: "row-2", field: "received", message: "Received must be a valid QAR amount no greater than the total." });
    expect(errors).toContainEqual({ rowId: "row-3", field: "customer", message: "A customer is required for a delivered invoice with due." });
  });

  it.each([
    [true, true], ["YES", true], ["y", true], [1, true], ["Delivered", true],
    [false, false], ["No", false], ["n", false], [0, false], [null, false], ["", false],
  ])("reads delivered value %s as %s", (cell, expected) => {
    const result = parseImportSheet([[...IMPORT_HEADERS], ["A", 10, 0, cell, "", "", ""]], ids());
    expect(result.errors).toEqual([]);
    expect(result.rows[0].delivered).toBe(expected);
  });

  it("reports unsupported cell types and stray columns against the spreadsheet row", () => {
    const result = parseImportSheet([
      [...IMPORT_HEADERS],
      ["A", 10, 0, "maybe", "", "", ""],
      [new Date("2026-01-01"), true, new Date("2026-01-01"), "no", 12.5, 1.5, 3.25],
      ["C", 10, 0, "no", "", "", "", "extra"],
    ], ids());
    expect(result.errors).toEqual([
      { rowId: "row-1", field: "delivered", message: "Row 2: Delivered must be Yes or No." },
      { rowId: "row-2", field: "invoiceId", message: "Row 3: Invoice Number must be text or a whole number." },
      { rowId: "row-2", field: "total", message: "Row 3: Total QAR must be a number." },
      { rowId: "row-2", field: "received", message: "Row 3: Received QAR must be a number." },
      { rowId: "row-2", field: "customer", message: "Row 3: Customer Name must be text." },
      { rowId: "row-2", field: "customer", message: "Row 3: Customer Mobile must be text or digits." },
      { rowId: "row-2", field: "note", message: "Row 3: Note must be text." },
      { rowId: "row-3", field: "row", message: "Row 4: has values outside the template columns." },
    ]);
  });

  it("detects duplicates inside the import and against existing shop numbers, ignoring case", () => {
    const result = parseImportSheet([[...IMPORT_HEADERS], ["INV-9", 10, 0, "no", "", "", ""], ["inv-9", 10, 0, "no", "", "", ""], ["OLD-1", 10, 0, "no", "", "", ""]], ids());
    const errors = validate(result.rows, ["old-1"]).errors;
    expect(errors).toContainEqual({ rowId: "row-2", field: "invoiceId", message: "Invoice ID already exists in this shop." });
    expect(errors).toContainEqual({ rowId: "row-3", field: "invoiceId", message: "Invoice ID already exists in this shop." });
    expect(errors.filter((error) => error.rowId === "row-1")).toEqual([]);
  });

  it("parses pasted spreadsheet cells with or without the header row", () => {
    const body = "P-1\t10\t0\tNo\t\t\t\nP-2\t20.50\t20.50\tYes\t\t\t";
    for (const text of [body, `${IMPORT_HEADERS.join("\t")}\r\n${body}`]) {
      const result = parsePastedRows(text, ids());
      expect(result.errors).toEqual([]);
      expect(result.rows.map((row) => [row.invoiceId, row.total, row.delivered])).toEqual([["P-1", "10", false], ["P-2", "20.50", true]]);
    }
    expect(parsePastedRows("P-1\t10\t0\tNo\t\t\t\textra").errors[0].message).toBe("Row 2: has values outside the template columns.");
  });

  it("writes a template that opens through the read library and imports nothing by itself", async () => {
    const sheets = await readXlsxFile(await writeXlsxFile(importTemplateSheets()).toBlob());
    expect(sheets.map((sheet) => sheet.sheet)).toEqual([IMPORT_SHEET_NAME, "Instructions"]);
    const invoices = sheets[0].data;
    expect(invoices).toEqual([[...IMPORT_HEADERS]]);
    expect(parseImportSheet(invoices).errors[0].message).toBe("The workbook has no invoice rows.");
    // The illustrative rows on the instructions sheet are themselves valid template rows.
    const examples = sheets[1].data.slice(8);
    const parsed = parseImportSheet(examples, ids());
    expect(parsed.errors).toEqual([]);
    expect(validate(parsed.rows).errors).toEqual([]);
  });

  it("round-trips a filled workbook through write and read into identical draft rows", async () => {
    const data = [[...IMPORT_HEADERS], ["0042", 80.5, 20, "Yes", "Mary", "55512345", "note"], ["RT-2", 19.99, null, "No", null, null, null]];
    const [sheet] = await readXlsxFile(await writeXlsxFile([{ sheet: IMPORT_SHEET_NAME, data }]).toBlob());
    const result = parseImportSheet(sheet.data, ids());
    expect(result.errors).toEqual([]);
    expect(result.rows.map((row) => [row.invoiceId, row.total, row.received, row.delivered])).toEqual([["0042", "80.50", "20.00", true], ["RT-2", "19.99", "", false]]);
  });
});
