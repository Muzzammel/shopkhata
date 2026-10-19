import { Skeleton } from "@/components/ui/skeleton";

/** Header, financial summary and history placeholders while the customer's history is read. */
export function CustomerDetailSkeleton() {
  return <div aria-busy="true" aria-label="Loading customer" className="grid gap-4 sm:gap-5">
    <div className="flex items-start gap-4 rounded-3xl border border-border bg-card p-5 sm:p-6"><Skeleton className="size-14 rounded-full" /><div className="grid flex-1 gap-2"><Skeleton className="h-3 w-32" /><Skeleton className="h-9 w-56 max-w-full" /><Skeleton className="h-4 w-40" /></div></div>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>
    <Skeleton className="h-10 w-96 max-w-full rounded-full" />
    <div className="grid gap-3 rounded-3xl border border-border bg-card p-5">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10 rounded-xl" />)}</div>
  </div>;
}
