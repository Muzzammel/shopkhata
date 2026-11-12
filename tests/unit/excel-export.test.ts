import readXlsxFile from "read-excel-file/universal";
import writeXlsxFile from "write-excel-file/universal";
import { describe, expect, it } from "vitest";

import {
  EXPENSE_EXPORT_HEADERS, INVOICE_EXPORT_HEADERS, LEDGER_EXPORT_HEADERS, expenseExportSheet, invoiceExportSheet, ledgerExportSheet,
  type ExportSheet,
} from "@/lib/excel/exports";

async function roundTrip(sheet: ExportSheet) {
  const [read] = await readXlsxFile(await writeXlsxFile([sheet]).toBlob());
  return read;
}

describe("Excel exports", () => {
  it("exports invoices with effective values as QAR numbers and round-trips through the read library", async () => {
    const read = await roundTrip(invoiceExportSheet([{
      invoiceNumber: "NEW-7", businessDate: "2026-10-03", totalDirham: 10500, paidDirham: 2800, creditAppliedDirham: 0, dueDirham: 7700,
      delivery: "full", customerName: "Mary", customerMobile: "55512345", recordedAt: "2026-10-03T09:15:30.000Z", originalNumber: "OLD-7",
      invoiceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", originalTotalDirham: 10000,
    }, {
      invoiceNumber: "A-2", businessDate: "2026-10-03", totalDirham: 1999, paidDirham: 1999, creditAppliedDirham: 0, dueDirham: 0,
      delivery: "none", customerName: "", customerMobile: "", recordedAt: null, originalNumber: "A-2", invoiceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", originalTotalDirham: 1999,
    }]));
    expect(read.sheet).toBe("Invoices");
    expect(read.data[0]).toEqual(INVOICE_EXPORT_HEADERS);
    // Recorded time is Qatar local time (UTC+3), not the browser's or server's zone.
    expect(read.data[1]).toEqual(["NEW-7", "2026-10-03", 105, 28, 0, 77, "Yes", "Mary", "55512345", "2026-10-03 12:15:30", "OLD-7", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "ACTIVE", 100]);
    expect(read.data[2].slice(0, 7)).toEqual(["A-2", "2026-10-03", 19.99, 19.99, 0, 0, "No"]);
  });

  it("writes money cells with a two-decimal number format and refuses a non-integer dirham value", () => {
    const sheet = invoiceExportSheet([{
      invoiceNumber: "A", businessDate: "2026-10-03", totalDirham: 8050, paidDirham: 0, creditAppliedDirham: 0, dueDirham: 8050,
      delivery: "none", customerName: "", customerMobile: "", recordedAt: null, originalNumber: "A", invoiceId: "x", originalTotalDirham: 8050,
    }]);
    expect(sheet.data[1][2]).toEqual({ value: 80.5, type: Number, format: "0.00" });
    expect(() => expenseExportSheet([{ businessDate: "2026-10-03", category: "other", description: "x", amountDirham: 10.5, createdBy: "", recordedAt: null, expenseId: "x" }]))
      .toThrow("EXPORT_AMOUNT_INVALID");
  });

  it("exports the customer ledger in ledger order with the same running balance as the screen", async () => {
    const base = { invoiceId: "i", invoiceNumber: "L-1", actorName: null };
    const read = await roundTrip(ledgerExportSheet([
      { ...base, businessDate: "2026-10-02", recordedAt: "2026-10-02T08:00:00.000Z", sequenceId: "2", type: "payment", reference: "PAY-1", debitDirham: 0, creditDirham: 4000 },
      { ...base, businessDate: "2026-10-01", recordedAt: "2026-10-01T08:00:00.000Z", sequenceId: "1", type: "invoice", reference: "L-1", debitDirham: 10000, creditDirham: 0 },
      { ...base, businessDate: "2026-10-03", recordedAt: "2026-10-03T08:00:00.000Z", sequenceId: "3", type: "invoice_correction", reference: "COR-1", debitDirham: 0, creditDirham: 1050 },
    ]));
    expect(read.data[0]).toEqual(LEDGER_EXPORT_HEADERS);
    expect(read.data.slice(1).map((row) => [row[0], row[1], row[2], row[4], row[5], row[6]])).toEqual([
      ["2026-10-01", "invoice", "L-1", 100, 0, 100],
      ["2026-10-02", "payment", "PAY-1", 0, 40, 60],
      ["2026-10-03", "invoice correction", "COR-1", 0, 10.5, 49.5],
    ]);
  });

  it("exports expenses with the effective amount and creator", async () => {
    const read = await roundTrip(expenseExportSheet([{
      businessDate: "2026-10-03", category: "utilities", description: "Corrected utility receipt", amountDirham: 30000,
      createdBy: "Local Shop 1 Staff", recordedAt: "2026-10-03T20:59:59.000Z", expenseId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    }]));
    expect(read.data).toEqual([
      EXPENSE_EXPORT_HEADERS,
      ["2026-10-03", "utilities", "Corrected utility receipt", 300, "Local Shop 1 Staff", "2026-10-03 23:59:59", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
    ]);
  });

  it("produces a header-only workbook when there is nothing to export", async () => {
    expect((await roundTrip(invoiceExportSheet([]))).data).toEqual([INVOICE_EXPORT_HEADERS]);
  });
});
