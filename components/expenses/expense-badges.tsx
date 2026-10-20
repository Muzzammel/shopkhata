import { categorySlot } from "@/lib/dashboard-view";
import { categoryLabel, FLAG_LABEL, type ExpenseFlag } from "@/lib/expense-view";
import { ui } from "@/components/sales/ui";
import { cn } from "@/lib/utils";

/** The category's Dashboard colour as a small swatch; the word carries the meaning. */
export function ExpenseCategoryBadge({ category, className }: { category: string; className?: string }) {
  return <span data-category={category} className={cn("inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap", className)}>
    <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: `var(--category-${categorySlot(category)})` }} />
    {categoryLabel(category)}
  </span>;
}

const TONE: Record<ExpenseFlag, string> = {
  pending: "bg-warning-soft text-warning",
  corrected: "bg-card text-foreground ring-1 ring-border ring-inset",
  backdated: "bg-muted text-muted-foreground",
};

export function ExpenseFlags({ flags, className }: { flags: readonly ExpenseFlag[]; className?: string }) {
  if (flags.length === 0) return null;
  return <span className={cn("inline-flex flex-wrap gap-1", className)}>
    {flags.map((flag) => <span key={flag} data-flag={flag} className={cn(ui.badge, TONE[flag])}>{FLAG_LABEL[flag]}</span>)}
  </span>;
}
