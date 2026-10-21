import { groupedQar, qar } from "@/lib/dashboard-view";
import { cn } from "@/lib/utils";

const figure = "grid content-start gap-1 rounded-2xl p-4";
const amount = "text-2xl font-semibold tracking-tight sm:text-3xl";
const Qar = ({ dirham }: { dirham: number }) => <><span className="text-xs font-medium opacity-65">QAR</span> {groupedQar(dirham)}</>;

/** Four figures from existing truth: sums of the customer's effective invoices, and the balance view's due and credit. */
export function CustomerSummary({ salesDirham, paidDirham, creditAppliedDirham, dueDirham, creditDirham, invoiceCount }: {
  salesDirham: number; paidDirham: number; creditAppliedDirham: number; dueDirham: number; creditDirham: number; invoiceCount: number;
}) {
  return <section aria-labelledby="summary-heading" className="grid gap-2">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 px-1">
      <h2 id="summary-heading" data-slot="heading" className="sr-only">Financial summary</h2>
      <p className="text-xs text-muted-foreground">All {invoiceCount} invoice{invoiceCount === 1 ? "" : "s"}, all dates · current approved values</p>
    </div>
    <div role="group" aria-label="Financial summary" className="grid grid-cols-2 gap-3 tabular-nums lg:grid-cols-4">
      <div className={cn(figure, "bg-ink text-ink-foreground")}>
        <span className="text-xs text-ink-muted">Total sales</span>
        <strong className={amount}><Qar dirham={salesDirham} /></strong>
        <span className="text-xs text-ink-muted">Invoice totals</span>
      </div>
      <div className={cn(figure, "bg-success-soft")}>
        <span className="text-xs text-muted-foreground">Total paid</span>
        <strong className={cn(amount, "text-success")}><Qar dirham={paidDirham} /></strong>
        <span className="text-xs text-muted-foreground">{creditAppliedDirham > 0 ? `Received · plus ${qar(creditAppliedDirham)} settled with credit` : "Received (cash and bank)"}</span>
      </div>
      <div className={cn(figure, dueDirham > 0 ? "bg-warning-soft" : "bg-muted")}>
        <span className="text-xs text-muted-foreground">Current due</span>
        <strong className={cn(amount, dueDirham > 0 && "text-warning")}><Qar dirham={dueDirham} /></strong>
        <span className="text-xs text-muted-foreground">{dueDirham > 0 ? "Still to collect" : "Nothing to collect"}</span>
      </div>
      <div className={cn(figure, "bg-card ring-1 ring-border ring-inset")}>
        <span className="text-xs text-muted-foreground">Available credit</span>
        <strong className={amount}><Qar dirham={creditDirham} /></strong>
        <span className="text-xs text-muted-foreground">{creditDirham > 0 ? "Not cash · can settle future due" : "No credit held"}</span>
      </div>
    </div>
  </section>;
}
