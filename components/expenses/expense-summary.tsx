import { categorySlot, groupedQar, qar } from "@/lib/dashboard-view";
import { categoryLabel, type ExpenseSummary as Summary } from "@/lib/expense-view";
import { cn } from "@/lib/utils";

const figure = "grid content-start gap-1 rounded-2xl p-4";
const amount = "text-2xl font-semibold tracking-tight sm:text-3xl";
const Qar = ({ dirham }: { dirham: number }) => <><span className="text-xs font-medium opacity-65">QAR</span> {groupedQar(dirham)}</>;

/** Period figures from report_expense_totals: the same effective (corrected) amounts the reports use. */
export function ExpenseSummary({ summary, scope, beside = false }: { summary: Summary; scope: string; beside?: boolean }) {
  return <section aria-labelledby="expense-summary-heading" className="grid content-start gap-2">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 px-1">
      <h2 id="expense-summary-heading" data-slot="heading" className="sr-only">Expense summary</h2>
      <p className="text-xs text-muted-foreground">{scope} · current approved values</p>
    </div>
    <div role="group" aria-label="Expense summary" className={cn("grid grid-cols-2 gap-3 tabular-nums", !beside && "lg:grid-cols-4")}>
      <div className={cn(figure, "bg-ink text-ink-foreground")}>
        <span className="text-xs text-ink-muted">Total expenses</span>
        <strong className={amount}><Qar dirham={summary.totalDirham} /></strong>
        <span className="text-xs text-ink-muted">In this period</span>
      </div>
      <div className={cn(figure, "bg-card ring-1 ring-border ring-inset")}>
        <span className="text-xs text-muted-foreground">Expense count</span>
        <strong className={amount}>{summary.count}</strong>
        <span className="text-xs text-muted-foreground">{summary.count === 1 ? "expense recorded" : "expenses recorded"}</span>
      </div>
      <div className={cn(figure, "bg-card ring-1 ring-border ring-inset")}>
        <span className="text-xs text-muted-foreground">Top category</span>
        {summary.top ? <>
          <strong className={cn(amount, "flex items-center gap-2 capitalize")}><span aria-hidden className="size-3 shrink-0 rounded-sm" style={{ background: `var(--category-${categorySlot(summary.top.category)})` }} />{categoryLabel(summary.top.category)}</strong>
          <span className="text-xs text-muted-foreground">{qar(summary.top.amountDirham)}</span>
        </> : <><strong className={cn(amount, "text-muted-foreground")}>—</strong><span className="text-xs text-muted-foreground">No expenses yet</span></>}
      </div>
      <div className={cn(figure, "bg-card ring-1 ring-border ring-inset")}>
        <span className="text-xs text-muted-foreground">Average expense</span>
        <strong className={amount}>{summary.count ? <Qar dirham={summary.averageDirham} /> : <span className="text-muted-foreground">—</span>}</strong>
        <span className="text-xs text-muted-foreground">Total ÷ count</span>
      </div>
    </div>
  </section>;
}
