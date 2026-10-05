import { z } from "zod";

// Shared Qatar business-date range helpers for the Invoices, Payments and
// Dashboard screens. Dates are compared and stepped as plain YYYY-MM-DD text;
// none of this goes through a time zone, so it cannot reintroduce the
// midnight-boundary defect that qatarBusinessDate() alone guards against.

export const isoDate = z.iso.date();

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Adds `delta` days to an ISO business date. Negative `delta` steps backward. */
export function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** The shared 30-day default window: Qatar-today minus 29 through Qatar-today, inclusive. */
export function last30Days(today: string): { from: string; to: string } {
  return { from: addDays(today, -29), to: today };
}

export type DateRangeFilter = { from: string; to: string; error: string | null };

/**
 * Validates an optional custom From/To against today, falling back to the
 * last-30-day default when absent or invalid. Mirrors parseReportFilter's
 * range rules so every history screen in the app validates dates the same way.
 */
export function parseDateRangeFilter(query: Record<string, string | string[] | undefined>, today: string, maxRangeDays = 366): DateRangeFilter {
  const fallback = last30Days(today);
  const from = first(query.from), to = first(query.to);
  if (from === undefined && to === undefined) return { ...fallback, error: null };
  if (!isoDate.safeParse(from).success || !isoDate.safeParse(to).success) return { ...fallback, error: "Choose a valid date range." };
  if (from! > to!) return { ...fallback, error: "The start date must not be after the end date." };
  if (to! > today) return { ...fallback, error: "A future business date has no records." };
  if (Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) > maxRangeDays) {
    return { ...fallback, error: `Choose a range of at most ${maxRangeDays} days.` };
  }
  return { from: from!, to: to!, error: null };
}
