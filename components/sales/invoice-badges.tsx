import { BADGE_LABEL, type InvoiceBadge } from "@/lib/sales-view";
import { ui } from "@/components/sales/ui";
import { cn } from "@/lib/utils";

const TONE: Record<InvoiceBadge, string> = {
  void: "bg-danger-soft text-destructive ring-1 ring-destructive/40 ring-inset",
  paid: "bg-success-soft text-success",
  due: "bg-warning-soft text-warning",
  delivered: "bg-muted text-foreground",
  corrected: "bg-yellow-soft text-foreground ring-1 ring-yellow/60 ring-inset",
  replaced: "bg-card text-foreground ring-1 ring-input ring-inset",
};

export function InvoiceBadges({ badges, className }: { badges: readonly InvoiceBadge[]; className?: string }) {
  return <span className={cn("inline-flex flex-wrap gap-1", className)}>
    {badges.map((badge) => <span key={badge} data-badge={badge} className={cn(ui.badge, TONE[badge])}>{BADGE_LABEL[badge]}</span>)}
  </span>;
}
