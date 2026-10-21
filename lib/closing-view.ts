import { DAILY_METRICS, type DailySummary } from "@/lib/reports";

// Presentation only: groups and wording for the Daily Close screen. Every
// figure is a DAILY_METRICS value from report_daily_summary; nothing is derived here.

export const DAILY_GROUPS = [
  { title: "Sales", keys: ["grossInvoiceDirham", "invoiceCount", "dueCreatedDirham"] },
  { title: "Money received", keys: ["totalReceivedDirham", "cashReceivedDirham", "bankReceivedDirham", "initialReceivedDirham", "followupPaymentsDirham", "customerPaymentsDirham", "paymentCorrectionsDirham", "creditCreatedDirham"] },
  { title: "Expenses", keys: ["expensesDirham", "expenseCount", "netCashMovementDirham"] },
  { title: "Dues and credit", keys: ["netDueMovementDirham", "invoiceCorrectionsDirham", "creditAppliedDirham"] },
] as const;

export type DailyGroup = { title: string; metrics: (typeof DAILY_METRICS)[number][] };

/** Groups in display order; the first metric of each group is its headline figure. */
export function dailyGroups(): DailyGroup[] {
  return DAILY_GROUPS.map((group) => ({ title: group.title, metrics: group.keys.map((key) => DAILY_METRICS.find((metric) => metric.key === key)!) }));
}

/** V2 colour language: green for money received, orange for money still due. The label always carries the meaning too. */
export function metricTone(key: string): "received" | "due" | null {
  if (key === "cashReceivedDirham" || key === "bankReceivedDirham" || key === "totalReceivedDirham") return "received";
  if (key === "dueCreatedDirham" || key === "netDueMovementDirham") return "due";
  return null;
}

/** True when the day has any recorded figure, so the readiness card can say "nothing recorded yet". */
export function hasActivity(summary: DailySummary): boolean {
  return DAILY_METRICS.some((metric) => summary[metric.key] !== 0);
}

/** Things to look at before closing. None of them blocks a close: the database only refuses future dates. */
export function closeAttention({ pendingCount, backdatedCount }: { pendingCount: number; backdatedCount: number }): string[] {
  const notes: string[] = [];
  if (pendingCount > 0) notes.push(`${pendingCount} ${pendingCount === 1 ? "decision is" : "decisions are"} still waiting for records dated this day. They do not stop a close.`);
  if (backdatedCount > 0) notes.push(`${backdatedCount} backdated ${backdatedCount === 1 ? "entry was" : "entries were"} recorded for this date.`);
  return notes;
}
