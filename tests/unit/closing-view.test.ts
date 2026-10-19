import { describe, expect, it } from "vitest";

import { closeAttention, dailyGroups, hasActivity, metricTone } from "@/lib/closing-view";
import { DAILY_METRICS, emptyDailySummary } from "@/lib/reports";

describe("daily close view", () => {
  it("places every daily metric in exactly one group", () => {
    const grouped = dailyGroups().flatMap((group) => group.metrics.map((metric) => metric.key));
    expect(grouped.sort()).toEqual(DAILY_METRICS.map((metric) => metric.key).sort());
  });

  it("leads each group with its headline figure and tones only received and due money", () => {
    expect(dailyGroups().map((group) => group.metrics[0].key)).toEqual(["grossInvoiceDirham", "cashReceivedDirham", "expensesDirham", "netDueMovementDirham"]);
    expect(metricTone("cashReceivedDirham")).toBe("received");
    expect(metricTone("netDueMovementDirham")).toBe("due");
    expect(metricTone("expensesDirham")).toBeNull();
  });

  it("reports activity only when a recorded figure is non-zero", () => {
    expect(hasActivity(emptyDailySummary("2026-10-19"))).toBe(false);
    expect(hasActivity({ ...emptyDailySummary("2026-10-19"), expenseCount: 1 })).toBe(true);
  });

  it("describes attention items without ever calling them blockers", () => {
    expect(closeAttention({ pendingCount: 0, backdatedCount: 0 })).toEqual([]);
    const notes = closeAttention({ pendingCount: 2, backdatedCount: 1 });
    expect(notes).toEqual([
      "2 decisions are still waiting for records dated this day. They do not stop a close.",
      "1 backdated entry was recorded for this date.",
    ]);
  });
});
