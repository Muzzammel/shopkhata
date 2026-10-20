import type { ReactNode } from "react";

/** A page that cannot show its content (not found, unavailable, deactivated, failed to load): one calm card, one way on. */
export function Notice({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <main className="mx-auto grid w-full max-w-xl content-start px-4 pt-12 pb-10 sm:px-6 sm:pt-16">
    <div className="grid gap-3 rounded-3xl border border-border bg-card p-6 sm:p-8">
      <h1 data-slot="heading" className="text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="grid gap-2 text-sm text-muted-foreground">{children}</div>
      {action && <div className="flex flex-wrap gap-2 pt-2">{action}</div>}
    </div>
  </main>;
}
