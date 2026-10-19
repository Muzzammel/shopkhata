import { addDays } from "@/lib/date-range";

// Presentation only: the period presets for Reports. Each preset is a plain
// Qatar business-date range, the same windows the Dashboard and history screens use.

export const REPORT_PERIODS = [
  { key: "today", label: "Today" },
  { key: "week", label: "7 days" },
  { key: "month", label: "30 days" },
] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number]["key"] | "custom";

export function periodRange(period: (typeof REPORT_PERIODS)[number]["key"], today: string): { from: string; to: string } {
  if (period === "today") return { from: today, to: today };
  return { from: addDays(today, period === "week" ? -6 : -29), to: today };
}

/** The preset whose window matches the range exactly; anything else is a custom range. */
export function activePeriod(from: string, to: string, today: string): ReportPeriod {
  const match = REPORT_PERIODS.find((period) => {
    const range = periodRange(period.key, today);
    return range.from === from && range.to === to;
  });
  return match?.key ?? "custom";
}
