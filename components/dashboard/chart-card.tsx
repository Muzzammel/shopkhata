import { useId, type ReactNode, type Ref } from "react";

import { cn } from "@/lib/utils";

/** The frame every dashboard chart sits in: title, one-line description, optional controls, body. */
export function ChartCard({ title, description, actions, children, className, emphasized = false, dimmed = false, ref }: {
  title: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string; emphasized?: boolean; dimmed?: boolean; ref?: Ref<HTMLElement>;
}) {
  const id = useId();
  return <section
    ref={ref} aria-labelledby={id}
    className={cn("flex min-w-0 scroll-mt-24 flex-col gap-5 rounded-3xl border border-border bg-card p-4 transition-shadow duration-300 sk-enter sm:p-6", emphasized && "shadow-[0_0_0_3px_var(--yellow)]", className)}
  >
    <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0"><h2 id={id} className="text-base font-semibold tracking-tight">{title}</h2>{description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}</div>
      {actions}
    </header>
    <div className={cn("min-w-0 transition-opacity duration-200", dimmed && "opacity-50")} aria-busy={dimmed || undefined}>{children}</div>
  </section>;
}
