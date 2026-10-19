import { addDays } from "@/lib/date-range";
import type { TrendPoint } from "@/lib/dashboard";
import { formatQar } from "@/lib/domain/money";

// Presentation helpers for the Dashboard. They only reshape numbers the dashboard
// already loaded (bucketing, ordering, labels); nothing here reads or changes money.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-04" -> "4 Oct". */
export function shortDate(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

export type Bucket = { key: string; label: string; salesDirham: number; paymentsDirham: number; expensesDirham: number };
export type BucketUnit = "day" | "week" | "month";

/**
 * Turns the sparse per-day rows (a day with no activity has no row) into a dense series and,
 * when it would exceed `maxPoints`, sums whole days into weeks or months. Sums of integers,
 * so no total changes.
 */
export function bucketTrend(days: readonly TrendPoint[], from: string, to: string, maxPoints: number): { unit: BucketUnit; buckets: Bucket[] } {
  const byDate = new Map(days.map((day) => [day.businessDate, day]));
  const dense: TrendPoint[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    dense.push(byDate.get(date) ?? { businessDate: date, salesDirham: 0, paymentsDirham: 0, expensesDirham: 0 });
  }
  const sum = (key: string, label: string, rows: readonly TrendPoint[]): Bucket => ({
    key, label,
    salesDirham: rows.reduce((total, row) => total + row.salesDirham, 0),
    paymentsDirham: rows.reduce((total, row) => total + row.paymentsDirham, 0),
    expensesDirham: rows.reduce((total, row) => total + row.expensesDirham, 0),
  });
  if (dense.length <= maxPoints) return { unit: "day", buckets: dense.map((day) => sum(day.businessDate, shortDate(day.businessDate), [day])) };
  if (Math.ceil(dense.length / 7) <= maxPoints) {
    const weeks: Bucket[] = [];
    for (let index = 0; index < dense.length; index += 7) {
      const rows = dense.slice(index, index + 7);
      weeks.push(sum(rows[0].businessDate, shortDate(rows[0].businessDate), rows));
    }
    return { unit: "week", buckets: weeks };
  }
  const months = new Map<string, TrendPoint[]>();
  for (const day of dense) months.set(day.businessDate.slice(0, 7), [...(months.get(day.businessDate.slice(0, 7)) ?? []), day]);
  return { unit: "month", buckets: [...months].map(([key, rows]) => sum(key, MONTHS[Number(key.slice(5, 7)) - 1], rows)) };
}

/** "QAR 1.2k" style for axis ticks; full precision stays in tooltips and cards. */
export function compactQar(dirham: number): string {
  const qar = Math.abs(dirham) / 100;
  const sign = dirham < 0 ? "-" : "";
  if (qar >= 1_000_000) return `${sign}${(qar / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (qar >= 1_000) return `${sign}${(qar / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${sign}${Math.round(qar)}`;
}

/** The highest value an axis should reach: the next 1/2/5 step above the data. */
export function niceMax(value: number): number {
  if (value <= 0) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((candidate) => candidate * magnitude >= value)!;
  return step * magnitude;
}

/** formatQar with thousands separators, for reading at a glance: "1,208,055.00". */
export const groupedQar = (dirham: number) => formatQar(dirham).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const qar = (dirham: number) => `QAR ${groupedQar(dirham)}`;

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const CATEGORY_ORDER = ["rent", "utilities", "supplies", "transport", "maintenance", "other"];
/** The same expense category always gets the same colour slot (1-6), here and on any later screen. */
export function categorySlot(category: string): number {
  const index = CATEGORY_ORDER.indexOf(category.toLowerCase());
  return index === -1 ? 6 : index + 1;
}

export type ActivityKind = "payment" | "invoice" | "correction" | "expense" | "close" | "customer" | "admin";
export function activityKind(action: string): ActivityKind {
  if (action === "batch.submit" || action === "submit_batch") return "invoice";
  if (action.includes("payment") || action.includes("credit") || action.includes("overpayment")) return "payment";
  if (action.startsWith("correction") || action.startsWith("replacement")) return "correction";
  if (action.includes("expense")) return "expense";
  if (action.startsWith("date.")) return "close";
  if (action === "create_customer") return "customer";
  return "admin";
}

const qatarParts = (iso: string) => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Qatar", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
};

/** "Today 14:32", "Yesterday 09:05" or "17 Oct 09:05", in Qatar time and independent of the viewer's clock. */
export function activityWhen(iso: string, today: string): string {
  const { date, time } = qatarParts(iso);
  if (date === today) return `Today ${time}`;
  if (date === addDays(today, -1)) return `Yesterday ${time}`;
  return `${shortDate(date)} ${time}`;
}

export type AttentionItem = { id: string; tone: "info" | "warning"; title: string; detail: string; href: string; cta: string };

/** Only conditions the dashboard already knows about; an empty list means "Everything looks good". */
export function deriveAttention(input: {
  shopId: string;
  dayOpenWithActivity: boolean;
  customersWithDue: number;
  outstandingDueDirham: number;
  backup: { freshness: "none" | "current" | "overdue"; ageHours: number | null } | null;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (input.dayOpenWithActivity) {
    items.push({ id: "close", tone: "info", title: "Daily Close pending", detail: "Today has activity and has not been closed yet.", href: `/closing?shop=${input.shopId}`, cta: "Open Daily Close" });
  }
  if (input.backup && input.backup.freshness !== "current") {
    items.push({
      id: "backup", tone: "warning", title: input.backup.freshness === "none" ? "No backup recorded" : "Backup overdue",
      detail: input.backup.ageHours === null ? "No backup has been recorded yet." : `The last backup is ${Math.round(input.backup.ageHours)} hours old.`,
      href: "/admin/backup", cta: "Open Backup",
    });
  }
  if (input.customersWithDue > 0) {
    items.push({
      id: "due", tone: "warning", title: "Customer due outstanding",
      detail: `${input.customersWithDue} customer${input.customersWithDue === 1 ? "" : "s"} owe ${qar(input.outstandingDueDirham)}.`,
      href: `/customers?shop=${input.shopId}`, cta: "View customers",
    });
  }
  return items;
}

/** Smooth curve through the points that never overshoots them (monotone cubic), as an SVG path. */
export function monotonePath(xs: readonly number[], ys: readonly number[]): string {
  const n = xs.length;
  if (n === 0) return "";
  if (n === 1) return `M${xs[0]},${ys[0]}`;
  const slope = Array.from({ length: n - 1 }, (_, i) => (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const tangent = Array.from({ length: n }, (_, i) => i === 0 ? slope[0] : i === n - 1 ? slope[n - 2] : slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { tangent[i] = 0; tangent[i + 1] = 0; continue; }
    const a = tangent[i] / slope[i], b = tangent[i + 1] / slope[i], size = a * a + b * b;
    if (size > 9) { const k = 3 / Math.sqrt(size); tangent[i] = k * a * slope[i]; tangent[i + 1] = k * b * slope[i]; }
  }
  let path = `M${xs[0]},${ys[0]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = (xs[i + 1] - xs[i]) / 3;
    path += ` C${xs[i] + h},${ys[i] + tangent[i] * h} ${xs[i + 1] - h},${ys[i + 1] - tangent[i + 1] * h} ${xs[i + 1]},${ys[i + 1]}`;
  }
  return path;
}
