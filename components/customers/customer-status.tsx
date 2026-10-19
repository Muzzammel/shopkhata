import { initials } from "@/lib/dashboard-view";
import { BALANCE_LABEL, type BalanceStatus } from "@/lib/customer-view";
import { cn } from "@/lib/utils";

// The word carries the meaning; colour only repeats it. Credit is held back: it is not cash received.
const TONE: Record<BalanceStatus, string> = {
  due: "bg-warning-soft text-warning",
  credit: "bg-card text-foreground ring-1 ring-success/40 ring-inset",
  clear: "bg-success-soft text-success",
};

export function BalanceBadges({ states, className }: { states: readonly BalanceStatus[]; className?: string }) {
  return <span className={cn("inline-flex flex-wrap gap-1", className)}>
    {states.map((state) => <span key={state} data-balance={state} className={cn("inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold tracking-wide whitespace-nowrap uppercase", TONE[state])}>{BALANCE_LABEL[state]}</span>)}
  </span>;
}

export function CustomerAvatar({ name, className }: { name: string; className?: string }) {
  return <span aria-hidden className={cn("grid size-10 shrink-0 place-items-center rounded-full bg-muted text-[13px] font-semibold tracking-wide text-foreground", className)}>{initials(name)}</span>;
}
