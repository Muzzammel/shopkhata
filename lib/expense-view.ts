import { qar } from "@/lib/dashboard-view";
import { EXPENSE_CATEGORIES } from "@/lib/expense-operations";
import { longDate, type TimelineEvent } from "@/lib/sales-view";

// Presentation helpers for the V2 Expenses screens. Nothing here decides money: totals come from
// report_expense_totals and effective_expenses, this only labels and arranges them.

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const categoryLabel = (category: string) => category ? category[0].toUpperCase() + category.slice(1) : "Uncategorised";

export function parseCategoryFilter(value: string | undefined): ExpenseCategory | "all" {
  return EXPENSE_CATEGORIES.find((category) => category === value) ?? "all";
}

/** Facts the list can show about one expense, in display order. Never a status the data does not hold. */
export type ExpenseFlag = "pending" | "corrected" | "backdated";
export const FLAG_LABEL: Record<ExpenseFlag, string> = { pending: "Pending approval", corrected: "Corrected", backdated: "Backdated" };
export function expenseFlags(expense: { pendingCount: number; corrected: boolean; backdated: boolean }): ExpenseFlag[] {
  return [
    ...(expense.pendingCount > 0 ? ["pending" as const] : []),
    ...(expense.corrected ? ["corrected" as const] : []),
    ...(expense.backdated ? ["backdated" as const] : []),
  ];
}

export type ExpenseSummary = { totalDirham: number; count: number; averageDirham: number; top: { category: string; amountDirham: number } | null };
/** Period figures from the database's own per-category subtotals, narrowed to one category when filtered. */
export function summarizeExpenses(totals: { totalDirham: number; count: number; byCategory: { category: string; amountDirham: number; count: number }[] }, category: ExpenseCategory | "all"): ExpenseSummary {
  const rows = category === "all" ? totals.byCategory : totals.byCategory.filter((row) => row.category === category);
  const totalDirham = category === "all" ? totals.totalDirham : rows.reduce((sum, row) => sum + row.amountDirham, 0);
  const count = category === "all" ? totals.count : rows.reduce((sum, row) => sum + row.count, 0);
  const top = rows.reduce<ExpenseSummary["top"]>((best, row) => !best || row.amountDirham > best.amountDirham ? { category: row.category, amountDirham: row.amountDirham } : best, null);
  // ponytail: average is display-only, rounded to the nearest dirham.
  return { totalDirham, count, averageDirham: count ? Math.round(totalDirham / count) : 0, top };
}

export const RECEIPT_TYPE_LABEL: Record<string, string> = { "image/jpeg": "JPG image", "image/png": "PNG image", "image/webp": "WebP image", "application/pdf": "PDF" };
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type ExpenseRecord = { amountDirham: number; category: string; description: string };
export type ExpenseHistorySource = {
  original: ExpenseRecord & { recordedAt: string; createdBy: string | null; businessDate: string; backdatedReason: string | null };
  receipts: { id: string; fileName: string; createdAt: string; createdBy: string | null }[];
  requests: (ExpenseRecord & { id: string; reason: string; requestedBy: string | null; requestedAt: string; expectedRequestId: string | null })[];
  decisions: { requestId: string; decision: string; reason: string | null; decidedBy: string | null; decidedAt: string }[];
};

/**
 * The expense's story, oldest first. Each correction is compared with the values it was based on
 * (the original entry, or the approved correction it expected), so only real changes are listed.
 */
export function buildExpenseTimeline(source: ExpenseHistorySource, person: (id: string | null) => string): TimelineEvent[] {
  const show = (key: keyof ExpenseRecord, record: ExpenseRecord) => key === "amountDirham" ? qar(record.amountDirham) : key === "category" ? categoryLabel(record.category) : record.description;
  const labels = { amountDirham: "Amount", category: "Category", description: "Description" } as const;
  const byId = new Map(source.requests.map((request) => [request.id, request]));
  const decisions = new Map(source.decisions.map((decision) => [decision.requestId, decision]));
  const { original } = source;
  const events: TimelineEvent[] = [{
    id: "created", at: original.recordedAt, kind: "created", title: "Expense recorded", actor: person(original.createdBy),
    changes: [{ label: "Amount", to: qar(original.amountDirham) }, { label: "Category", to: categoryLabel(original.category) }, { label: "Business date", to: longDate(original.businessDate) }],
    reason: original.backdatedReason ?? undefined,
  }];
  for (const receipt of source.receipts) events.push({ id: `receipt-${receipt.id}`, at: receipt.createdAt, kind: "receipt", title: "Receipt attached", actor: person(receipt.createdBy), changes: [{ label: "File", to: receipt.fileName }] });
  for (const request of source.requests) {
    const base = (request.expectedRequestId && byId.get(request.expectedRequestId)) || original;
    const decision = decisions.get(request.id);
    const status = !decision ? "pending" : decision.decision === "approved" ? "approved" : "rejected";
    events.push({
      id: request.id, at: request.requestedAt, kind: "correction", title: "Correction requested", actor: person(request.requestedBy), status,
      decidedBy: decision ? person(decision.decidedBy) : undefined, decidedAt: decision?.decidedAt, decisionReason: decision?.reason,
      changes: (["amountDirham", "category", "description"] as const).filter((key) => base[key] !== request[key])
        .map((key) => ({ label: labels[key], from: show(key, base), to: show(key, request) })),
      reason: request.reason,
    });
  }
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
