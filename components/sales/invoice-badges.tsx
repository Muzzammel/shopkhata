import { BADGE_LABEL, type InvoiceBadge } from "@/lib/sales-view";
import { cn } from "@/lib/utils";

// The word carries the meaning; colour only repeats it.
const TONE: Record<InvoiceBadge, string> = {
  paid: "bg-success-soft text-success",
  due: "bg-warning-soft text-warning",
  delivered: "bg-muted text-foreground",
  corrected: "bg-yellow-soft text-foreground ring-1 ring-yellow/60 ring-inset",
  replaced: "bg-card text-foreground ring-1 ring-input ring-inset",
};

export function InvoiceBadges({ badges, className }: { badges: readonly InvoiceBadge[]; className?: string }) {
  return <span className={cn("inline-flex flex-wrap gap-1", className)}>
    {badges.map((badge) => <span key={badge} data-badge={badge} className={cn("inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold tracking-wide uppercase", TONE[badge])}>{BADGE_LABEL[badge]}</span>)}
  </span>;
}
