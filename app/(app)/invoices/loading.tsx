import { Skeleton } from "@/components/ui/skeleton";

export default function SalesLoading() {
  return <main aria-busy="true" aria-label="Loading sales" className="mx-auto grid w-full max-w-[1280px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6">
    <div className="flex items-end justify-between px-1"><div className="grid gap-2"><Skeleton className="h-3 w-24" /><Skeleton className="h-9 w-36" /></div><Skeleton className="h-10 w-32 rounded-full" /></div>
    <Skeleton className="h-28 rounded-3xl" />
    <Skeleton className="h-9 w-96 max-w-full rounded-full" />
    <div className="grid gap-3 rounded-3xl border border-border bg-card p-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-10 rounded-xl" />)}</div>
  </main>;
}
