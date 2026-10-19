import { describe, expect, it } from "vitest";

import { parseDashboardPeriod } from "@/lib/dashboard";

describe("parseDashboardPeriod", () => {
  const today = "2026-10-04";
  it("defaults to today when no period is given or it is unrecognized", () => {
    expect(parseDashboardPeriod({}, today)).toEqual({ period: "today", from: today, to: today, error: null });
    expect(parseDashboardPeriod({ period: "bogus" }, today)).toEqual({ period: "today", from: today, to: today, error: null });
  });
  it("resolves the last 7-day, 30-day and 365-day windows against Qatar-today", () => {
    expect(parseDashboardPeriod({ period: "7d" }, today)).toEqual({ period: "7d", from: "2026-09-28", to: today, error: null });
    expect(parseDashboardPeriod({ period: "30d" }, today)).toEqual({ period: "30d", from: "2026-09-05", to: today, error: null });
    expect(parseDashboardPeriod({ period: "year" }, today)).toEqual({ period: "year", from: "2025-10-05", to: today, error: null });
  });
  it("validates a custom range the same way every other history screen does", () => {
    expect(parseDashboardPeriod({ period: "custom", from: "2026-09-01", to: "2026-09-10" }, today)).toEqual({ period: "custom", from: "2026-09-01", to: "2026-09-10", error: null });
    expect(parseDashboardPeriod({ period: "custom", from: "2026-10-05", to: "2026-10-05" }, today)).toMatchObject({ period: "custom", error: "A future business date has no records." });
    expect(parseDashboardPeriod({ period: "custom", from: "2026-10-05", to: "2026-10-01" }, today)).toMatchObject({ period: "custom", from: "2026-09-05", to: today });
  });
});
