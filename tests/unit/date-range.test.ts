import { describe, expect, it } from "vitest";

import { addDays, last30Days, parseDateRangeFilter } from "@/lib/date-range";

describe("addDays / last30Days", () => {
  it("steps a business date forward or backward without crossing a time zone", () => {
    expect(addDays("2026-10-04", 1)).toBe("2026-10-05");
    expect(addDays("2026-10-04", -1)).toBe("2026-10-03");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
  it("is Qatar-today minus 29 through Qatar-today, inclusive", () => {
    expect(last30Days("2026-10-04")).toEqual({ from: "2026-09-05", to: "2026-10-04" });
    expect(last30Days("2026-01-01")).toEqual({ from: "2025-12-03", to: "2026-01-01" });
  });
});

describe("parseDateRangeFilter", () => {
  const today = "2026-10-04";
  it("defaults to the last 30 days when no range is given", () => {
    expect(parseDateRangeFilter({}, today)).toEqual({ from: "2026-09-05", to: "2026-10-04", error: null });
  });
  it("accepts an ordered range within today", () => {
    expect(parseDateRangeFilter({ from: "2026-09-01", to: "2026-10-04" }, today)).toEqual({ from: "2026-09-01", to: "2026-10-04", error: null });
  });
  it("rejects an invalid, reversed, future or overlong range and falls back to the default", () => {
    expect(parseDateRangeFilter({ from: "2026-13-01", to: today }, today)).toMatchObject({ from: "2026-09-05", error: "Choose a valid date range." });
    expect(parseDateRangeFilter({ from: "2026-10-04", to: "2026-10-01" }, today).error).toBe("The start date must not be after the end date.");
    expect(parseDateRangeFilter({ from: "2026-10-01", to: "2026-10-05" }, today).error).toBe("A future business date has no records.");
    expect(parseDateRangeFilter({ from: "2025-01-01", to: today }, today, 30).error).toBe("Choose a range of at most 30 days.");
  });
  it("takes the first value when a param repeats", () => {
    expect(parseDateRangeFilter({ from: ["2026-10-01", "x"], to: ["2026-10-04", "y"] }, today)).toEqual({ from: "2026-10-01", to: "2026-10-04", error: null });
  });
});
