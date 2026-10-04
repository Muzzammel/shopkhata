import readXlsxFile from "read-excel-file/universal";
import writeXlsxFile from "write-excel-file/universal";
import { describe, expect, it } from "vitest";

import { canReopenDate, closeInput, closingError, dayState, reopenInput } from "@/lib/closing";
import type { ExportSheet } from "@/lib/excel/exports";
import { prepareInvoiceBatch, qatarBusinessDate } from "@/lib/invoice-entry";
import { classifySaveResult, draftStatusLabel, newSubmission, nextSubmission } from "@/lib/offline/draft-state";
import {
  CUSTOMER_DUE_HEADERS, DAILY_METRICS, DAILY_SUMMARY_HEADERS, EXPENSE_REPORT_HEADERS, PAYMENT_REPORT_HEADERS, REPORT_TITLES,
  customerDueSheet, dailySummarySheet, emptyDailySummary, expenseReportSheet, mapDailySummary, mapExpenseTotals, mapPaymentTotals,
  parseReportFilter, paymentReportSheet, salesReportSheet,
} from "@/lib/reports";

const SHOP = "10000000-0000-4000-8000-000000000001";
async function roundTrip(sheet: ExportSheet) {
  const [read] = await readXlsxFile(await writeXlsxFile([sheet]).toBlob());
  return read.data;
}
const summaryRow = {
  business_date: "2026-10-04", invoice_count: 3, gross_invoice_dirham: 180000, initial_received_dirham: 90000, due_created_dirham: 90000,
  followup_payments_dirham: 40000, customer_payments_dirham: 20000, payment_corrections_dirham: -1000, invoice_corrections_dirham: -3000,
  credit_created_dirham: 5000, credit_applied_dirham: 5000, expense_count: 2, expenses_dirham: 23000, cash_received_dirham: 154000,
  net_cash_movement_dirham: 131000, net_due_movement_dirham: 23000,
};

describe("Qatar business date", () => {
  it("is a day ahead of the UTC calendar date between 00:00 and 03:00 Qatar time", () => {
    expect(qatarBusinessDate(new Date("2026-10-03T20:59:59Z"))).toBe("2026-10-03");
    expect(qatarBusinessDate(new Date("2026-10-03T21:00:00Z"))).toBe("2026-10-04");
    expect(qatarBusinessDate(new Date("2026-10-03T23:59:59Z"))).toBe("2026-10-04");
    expect(qatarBusinessDate(new Date("2026-10-04T00:00:00Z"))).toBe("2026-10-04");
    expect(qatarBusinessDate(new Date("2026-12-31T21:30:00Z"))).toBe("2027-01-01");
  });
});

describe("report filters", () => {
  const today = "2026-10-04";
  it("defaults to the daily summary for today", () => {
    expect(parseReportFilter({}, today)).toEqual({ kind: "daily", from: today, to: today, error: null });
    expect(parseReportFilter({ report: "unknown" }, today).kind).toBe("daily");
  });
  it("maps a single business date to a one-day range and keeps it as typed", () => {
    expect(parseReportFilter({ report: "daily", date: "2026-10-01" }, today)).toEqual({ kind: "daily", from: "2026-10-01", to: "2026-10-01", error: null });
    expect(parseReportFilter({ report: ["daily"], date: ["2026-10-02", "x"] }, today).from).toBe("2026-10-02");
  });
  it("rejects invalid and future dates and falls back to today", () => {
    expect(parseReportFilter({ report: "daily", date: "2026-02-30" }, today)).toMatchObject({ from: today, error: "Choose a valid business date." });
    expect(parseReportFilter({ report: "daily", date: "2026-10-05" }, today)).toMatchObject({ from: today, error: "A future business date has no report." });
    expect(parseReportFilter({ report: "sales", from: "2026-10-01", to: "2026-10-05" }, today)).toMatchObject({ from: today, to: today, error: "A future business date has no report." });
  });
  it("accepts an ordered range within the limit", () => {
    expect(parseReportFilter({ report: "payments", from: "2026-09-01", to: "2026-10-04" }, today)).toEqual({ kind: "payments", from: "2026-09-01", to: "2026-10-04", error: null });
    expect(parseReportFilter({ report: "expenses", from: "2025-10-03", to: "2026-10-04" }, today).error).toBeNull();
  });
  it("rejects a reversed, incomplete or overlong range", () => {
    expect(parseReportFilter({ report: "sales", from: "2026-10-03", to: "2026-10-01" }, today).error).toBe("The start date must not be after the end date.");
    expect(parseReportFilter({ report: "sales", from: "2026-10-03" }, today).error).toBe("Choose a valid date range.");
    expect(parseReportFilter({ report: "sales", from: "2025-10-02", to: "2026-10-04" }, today).error).toBe("Choose a range of at most 366 days.");
  });
});

describe("close and reopen input", () => {
  it("accepts a close with or without a note and trims it", () => {
    expect(closeInput.safeParse({ shop_id: SHOP, business_date: "2026-10-04" }).success).toBe(true);
    expect(closeInput.parse({ shop_id: SHOP, business_date: "2026-10-04", note: "  counted  " }).note).toBe("counted");
  });
  it("rejects a bad date, a blank note and unknown fields", () => {
    expect(closeInput.safeParse({ shop_id: SHOP, business_date: "04/10/2026" }).success).toBe(false);
    expect(closeInput.safeParse({ shop_id: SHOP, business_date: "2026-10-04", note: "   " }).success).toBe(false);
    expect(closeInput.safeParse({ shop_id: SHOP, business_date: "2026-10-04", reason: "x" }).success).toBe(false);
    expect(closeInput.safeParse({ shop_id: "shop", business_date: "2026-10-04" }).success).toBe(false);
  });
  it("requires a non-blank reopen reason", () => {
    expect(reopenInput.safeParse({ shop_id: SHOP, business_date: "2026-10-04" }).success).toBe(false);
    expect(reopenInput.safeParse({ shop_id: SHOP, business_date: "2026-10-04", reason: "   " }).success).toBe(false);
    expect(reopenInput.safeParse({ shop_id: SHOP, business_date: "2026-10-04", reason: "x".repeat(2001) }).success).toBe(false);
    expect(reopenInput.parse({ shop_id: SHOP, business_date: "2026-10-04", reason: " late delivery " }).reason).toBe("late delivery");
  });
  it("derives the state from the latest event, whatever order the events arrive in", () => {
    expect(dayState([])).toBe("open");
    expect(dayState([{ sequence: 1, type: "closed" }])).toBe("closed");
    expect(dayState([{ sequence: 3, type: "closed" }, { sequence: 1, type: "closed" }, { sequence: 2, type: "reopened" }])).toBe("closed");
    expect(dayState([{ sequence: 1, type: "closed" }, { sequence: 2, type: "reopened" }])).toBe("open");
  });
  it("lets an owner reopen any date and a manager only the current date", () => {
    expect(canReopenDate("owner", "2026-09-01", "2026-10-04")).toBe(true);
    expect(canReopenDate("manager", "2026-10-04", "2026-10-04")).toBe(true);
    expect(canReopenDate("manager", "2026-10-03", "2026-10-04")).toBe(false);
    expect(canReopenDate("staff", "2026-10-04", "2026-10-04")).toBe(false);
  });
  it("explains every close error code and has a safe default", () => {
    expect(closingError("REASON_REQUIRED")).toBe("Enter a reason for reopening this date.");
    expect(closingError("ALREADY_CLOSED")).toContain("already closed");
    expect(closingError("INSUFFICIENT_ROLE")).toContain("manager or owner");
    expect(closingError("constructor")).toBe("The date could not be changed. Refresh and try again.");
  });
});

describe("backdate reason", () => {
  const row = { rowId: "11111111-1111-4111-8111-111111111111", invoiceId: "B-1", total: "10.00", received: "", delivered: false, customerId: "", customerName: "", customerMobile: "" };
  const input = { shopId: SHOP, businessDate: "2026-10-01", isBackdated: true, idempotencyKey: "22222222-2222-4222-8222-222222222222", rows: [row] };
  it("refuses a backdated batch without a reason and accepts one with it", () => {
    expect(prepareInvoiceBatch({ ...input, backdatedReason: "   " }, [], false, "2026-10-04").errors).toContainEqual({ rowId: "", field: "backdatedReason", message: "Enter a reason for the backdated batch." });
    const prepared = prepareInvoiceBatch({ ...input, backdatedReason: " missed sale " }, [], false, "2026-10-04");
    expect(prepared.errors).toEqual([]);
    expect(prepared.command).toMatchObject({ business_date: "2026-10-01", is_backdated: true, backdated_reason: "missed sale" });
  });
  it("does not let a draft prepared for an earlier day pass as a current-date batch", () => {
    expect(prepareInvoiceBatch({ ...input, isBackdated: false, backdatedReason: "" }, [], false, "2026-10-04").errors)
      .toContainEqual({ rowId: "", field: "businessDate", message: "Refresh the business date and review the batch again." });
  });
});

describe("closed-date conflict on a queued draft", () => {
  it("keeps the draft editable, releases the queued submission and says it is a conflict", () => {
    const outcome = classifySaveResult({ ok: false, code: "CLOSED_DATE", errors: [] });
    expect(outcome).toEqual({ kind: "rejected", conflict: "closed_date" });
    const queued = newSubmission({ shopId: SHOP, businessDate: "2026-10-04", isBackdated: false, backdatedReason: "", idempotencyKey: "k", rows: [] }, "2026-10-04T10:00:00Z");
    expect(nextSubmission(queued, outcome, "closed")).toBeNull();
    expect(draftStatusLabel({ online: true, reconnecting: false, sending: false, hasDraft: true, justSaved: false, storageAvailable: true, submission: null, conflict: { kind: "closed_date" } }))
      .toBe("Conflict — not saved to ShopKhata");
  });
});

describe("report mappers", () => {
  it("maps a daily summary row field by field without recalculating it", () => {
    const day = mapDailySummary(summaryRow);
    expect(day).toMatchObject({ businessDate: "2026-10-04", invoiceCount: 3, grossInvoiceDirham: 180000, cashReceivedDirham: 154000, netCashMovementDirham: 131000, netDueMovementDirham: 23000 });
    // A value the database did not compute consistently is passed through, not "fixed".
    expect(mapDailySummary({ ...summaryRow, net_cash_movement_dirham: 1 }).netCashMovementDirham).toBe(1);
    expect(Object.keys(day).sort()).toEqual(["businessDate", ...DAILY_METRICS.map((metric) => metric.key)].sort());
  });
  it("refuses an amount outside the safe integer range", () => {
    expect(() => mapDailySummary({ ...summaryRow, gross_invoice_dirham: 2 ** 53 })).toThrow("REPORT_AMOUNT_INVALID");
    expect(() => mapDailySummary({ ...summaryRow, expenses_dirham: 10.5 })).toThrow("REPORT_AMOUNT_INVALID");
  });
  it("reports zero for every metric on a day without activity", () => {
    const day = emptyDailySummary("2026-10-04");
    expect(DAILY_METRICS.every((metric) => day[metric.key] === 0)).toBe(true);
    expect(day.businessDate).toBe("2026-10-04");
  });
  it("never labels a figure as profit, margin or cost of goods", () => {
    const labels = [...DAILY_METRICS.map((metric) => metric.label), ...DAILY_SUMMARY_HEADERS, ...Object.values(REPORT_TITLES), ...PAYMENT_REPORT_HEADERS, ...EXPENSE_REPORT_HEADERS, ...CUSTOMER_DUE_HEADERS];
    expect(labels.filter((label) => /profit|margin|cogs|cost of goods|income/i.test(label))).toEqual([]);
    expect(DAILY_METRICS.find((metric) => metric.key === "netCashMovementDirham")?.meaning).toContain("not profit");
  });
  it("takes expense and payment totals from the database's own total rows", () => {
    expect(mapExpenseTotals([{ category: "rent", expense_count: 1, amount_dirham: 8000 }, { category: null, expense_count: 2, amount_dirham: 23000 }, { category: "supplies", expense_count: 1, amount_dirham: 15000 }]))
      .toEqual({ totalDirham: 23000, count: 2, byCategory: [{ category: "rent", count: 1, amountDirham: 8000 }, { category: "supplies", count: 1, amountDirham: 15000 }] });
    expect(mapExpenseTotals([{ category: null, expense_count: 0, amount_dirham: 0 }])).toEqual({ totalDirham: 0, count: 0, byCategory: [] });
    const totals = mapPaymentTotals([
      { source: "follow_up", method: "cash", entry_count: 2, amount_dirham: 40000 }, { source: "credit_application", method: "credit", entry_count: 1, amount_dirham: 5000 },
      { source: null, method: "cash", entry_count: 5, amount_dirham: 154000 }, { source: null, method: "credit", entry_count: 1, amount_dirham: 5000 },
      { source: null, method: null, entry_count: 6, amount_dirham: 159000 },
    ]);
    expect(totals.cashDirham).toBe(154000);
    expect(totals.creditDirham).toBe(5000);
    expect(totals.bySource).toEqual([{ source: "credit_application", method: "credit", count: 1, amountDirham: 5000 }, { source: "follow_up", method: "cash", count: 2, amountDirham: 40000 }]);
    expect(mapPaymentTotals([{ source: null, method: null, entry_count: 0, amount_dirham: 0 }])).toEqual({ cashDirham: 0, creditDirham: 0, bySource: [] });
  });
});

describe("report Excel exports", () => {
  it("round-trips the daily summary with one QAR number per metric", async () => {
    const data = await roundTrip(dailySummarySheet([mapDailySummary(summaryRow)]));
    expect(data[0]).toEqual(DAILY_SUMMARY_HEADERS);
    expect(data[1]).toEqual(["2026-10-04", 3, 1800, 900, 900, 400, 200, -10, -30, 50, 50, 2, 230, 1540, 1310, 230]);
    expect((await roundTrip(dailySummarySheet([])))).toEqual([DAILY_SUMMARY_HEADERS]);
  });
  it("round-trips the sales report with the database totals as its last row", async () => {
    const data = await roundTrip(salesReportSheet([{
      invoiceNumber: "S-1", businessDate: "2026-10-04", totalDirham: 100000, paidDirham: 99000, creditAppliedDirham: 0, dueDirham: 1000, delivered: true,
      customerName: "Mary", customerMobile: "555", recordedAt: "2026-10-03T21:30:00.000Z", originalNumber: "S-1", invoiceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }], { invoiceCount: 3, totalDirham: 177000, paidDirham: 149000, creditAppliedDirham: 5000, dueDirham: 23000, deliveredCount: 2, undeliveredCount: 1 }));
    // Recorded at 00:30 Qatar time on the 4th, which is still the 3rd in UTC.
    expect(data[1].slice(0, 10)).toEqual(["S-1", "2026-10-04", 1000, 990, 0, 10, "Yes", "Mary", "555", "2026-10-04 00:30:00"]);
    expect(data[2].slice(0, 7)).toEqual(["Total", "3 invoices", 1770, 1490, 50, 230, "2 delivered, 1 not delivered"]);
  });
  it("round-trips customer dues, expenses and payments with their totals", async () => {
    const dues = await roundTrip(customerDueSheet(
      [{ customerId: "c", publicId: "CUS-00001", name: "Mary", mobile: "555", outstandingDueDirham: 23000, availableCreditDirham: 0, invoiceCount: 2, lastActivity: "2026-10-04" }],
      { customersWithDue: 1, outstandingDueDirham: 23000, availableCreditDirham: 0, unassignedDueDirham: 1500 }));
    expect(dues).toEqual([CUSTOMER_DUE_HEADERS, ["CUS-00001", "Mary", "555", 230, 0, 2, "2026-10-04"], ["Total", "1 customers with due", null, 230, 0, null, null], ["Due on invoices without a customer", null, null, 15, null, null, null]]);

    const expenses = await roundTrip(expenseReportSheet(
      [{ businessDate: "2026-10-04", category: "supplies", description: "Paper", amountDirham: 15000, createdBy: "Staff", recordedAt: "2026-10-04T09:00:00.000Z", expenseId: "e-1", corrected: true, backdatedReason: "" }],
      { totalDirham: 23000, count: 2, byCategory: [{ category: "rent", count: 1, amountDirham: 8000 }, { category: "supplies", count: 1, amountDirham: 15000 }] }));
    expect(expenses[0]).toEqual(EXPENSE_REPORT_HEADERS);
    expect(expenses[1]).toEqual(["2026-10-04", "supplies", "Paper", 150, "Corrected", "Staff", "2026-10-04 12:00:00", null, "e-1"]);
    expect(expenses.slice(2).map((row) => row.slice(0, 4))).toEqual([["Category total", "rent", "1 expenses", 80], ["Category total", "supplies", "1 expenses", 150], ["Total", null, "2 expenses", 230]]);

    const payments = await roundTrip(paymentReportSheet(
      [{ entryId: "p-1", businessDate: "2026-10-04", recordedAt: null, source: "credit_application", method: "credit", amountDirham: 5000, invoiceNumber: "S-3", customerName: "Mary", reference: "credit-1" },
        { entryId: "p-2", businessDate: "2026-10-04", recordedAt: null, source: "payment_correction", method: "cash", amountDirham: -1000, invoiceNumber: "S-1", customerName: "Mary", reference: "p-0" }],
      { cashDirham: 154000, creditDirham: 5000, bySource: [{ source: "credit_application", method: "credit", count: 1, amountDirham: 5000 }] }));
    expect(payments[0]).toEqual(PAYMENT_REPORT_HEADERS);
    expect(payments[1]).toEqual(["2026-10-04", null, "Customer credit applied", "credit", 50, "S-3", "Mary", "credit-1"]);
    expect(payments[2].slice(2, 5)).toEqual(["Payment correction", "cash", -10]);
    expect(payments.slice(3).map((row) => [row[0], row[3], row[4]])).toEqual([["Type total", "credit", 50], ["Total cash received", "cash", 1540], ["Total customer credit applied", "credit", 50]]);
  });
});
