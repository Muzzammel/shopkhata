import { describe, expect, it } from "vitest";

import { activePeriod, periodRange } from "@/lib/report-view";

describe("report period presets", () => {
  const today = "2026-10-19";

  it("maps each preset to an inclusive Qatar business-date window", () => {
    expect(periodRange("today", today)).toEqual({ from: "2026-10-19", to: "2026-10-19" });
    expect(periodRange("week", today)).toEqual({ from: "2026-10-13", to: "2026-10-19" });
    expect(periodRange("month", today)).toEqual({ from: "2026-09-20", to: "2026-10-19" });
  });

  it("recognises a preset only when the range matches it exactly", () => {
    expect(activePeriod("2026-10-13", "2026-10-19", today)).toBe("week");
    expect(activePeriod("2026-10-14", "2026-10-19", today)).toBe("custom");
    expect(activePeriod("2026-10-19", "2026-10-19", today)).toBe("today");
  });
});
