import { describe, expect, it } from "vitest";
import { buildExpenseTimeline, categoryLabel, expenseFlags, fileSize, parseCategoryFilter, summarizeExpenses } from "@/lib/expense-view";

describe("expense view helpers", () => {
  const totals = { totalDirham: 13_000, count: 3, byCategory: [{ category: "rent", amountDirham: 10_000, count: 1 }, { category: "transport", amountDirham: 3_000, count: 2 }] };

  it("summarises the period from the database subtotals, narrowed to one category when filtered", () => {
    expect(summarizeExpenses(totals, "all")).toEqual({ totalDirham: 13_000, count: 3, averageDirham: 4_333, top: { category: "rent", amountDirham: 10_000 } });
    expect(summarizeExpenses(totals, "transport")).toEqual({ totalDirham: 3_000, count: 2, averageDirham: 1_500, top: { category: "transport", amountDirham: 3_000 } });
    expect(summarizeExpenses({ totalDirham: 0, count: 0, byCategory: [] }, "all")).toEqual({ totalDirham: 0, count: 0, averageDirham: 0, top: null });
  });

  it("accepts only the fixed categories as a filter and labels them", () => {
    expect(parseCategoryFilter("rent")).toBe("rent");
    expect(parseCategoryFilter("payroll")).toBe("all");
    expect(parseCategoryFilter(undefined)).toBe("all");
    expect(categoryLabel("utilities")).toBe("Utilities");
  });

  it("shows only facts the data holds, pending first", () => {
    expect(expenseFlags({ pendingCount: 1, corrected: true, backdated: true })).toEqual(["pending", "corrected", "backdated"]);
    expect(expenseFlags({ pendingCount: 0, corrected: false, backdated: false })).toEqual([]);
  });

  it("formats receipt sizes", () => {
    expect([fileSize(900), fileSize(2_048), fileSize(204_800), fileSize(3_145_728)]).toEqual(["900 B", "2.0 KB", "200 KB", "3.0 MB"]);
  });

  it("compares each correction with the values it was based on, oldest event first", () => {
    const person = (id: string | null) => id ?? "Unknown";
    const events = buildExpenseTimeline({
      original: { amountDirham: 2_000, category: "transport", description: "Taxi", recordedAt: "2026-10-01T08:00:00+00:00", createdBy: "staff", businessDate: "2026-10-01", backdatedReason: null },
      receipts: [{ id: "a", fileName: "taxi.png", createdAt: "2026-10-01T08:00:01.5+00:00", createdBy: "staff" }],
      requests: [
        { id: "r2", amountDirham: 2_700, category: "transport", description: "Taxi and toll", reason: "Toll", requestedBy: "staff", requestedAt: "2026-10-03T08:00:00+00:00", expectedRequestId: "r1" },
        { id: "r1", amountDirham: 2_500, category: "transport", description: "Taxi", reason: "Receipt says 25", requestedBy: "staff", requestedAt: "2026-10-02T08:00:00+00:00", expectedRequestId: null },
      ],
      decisions: [{ requestId: "r1", decision: "approved", reason: null, decidedBy: "manager", decidedAt: "2026-10-02T09:00:00+00:00" }],
    }, person);
    expect(events.map((event) => event.id)).toEqual(["created", "receipt-a", "r1", "r2"]);
    expect(events[2]).toMatchObject({ status: "approved", decidedBy: "manager", changes: [{ label: "Amount", from: "QAR 20.00", to: "QAR 25.00" }] });
    expect(events[3]).toMatchObject({ status: "pending", changes: [{ label: "Amount", from: "QAR 25.00", to: "QAR 27.00" }, { label: "Description", from: "Taxi", to: "Taxi and toll" }] });
  });
});
