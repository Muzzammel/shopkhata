import { Skeleton } from "@/components/ui/skeleton";

export default function ExpensesLoading() {
  return <main aria-busy="true" aria-label="Loading expenses" className="mx-auto grid w-full max-w-[1280px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6">
    <div className="flex items-end justify-between px-1"><div className="grid gap-2"><Skeleton className="h-3 w-24" /><Skeleton className="h-9 w-40" /></div><Skeleton className="h-10 w-36 rounded-full" /></div>
    <Skeleton className="h-28 rounded-3xl" />
    <div className="grid gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>
      <Skeleton className="h-28 rounded-3xl max-lg:hidden" />
    </div>
    <div className="grid gap-3 sm:max-lg:grid-cols-2 lg:rounded-3xl lg:border lg:border-border lg:bg-card lg:p-4">{Array.from({ length: 8 }, (_, i) => <div key={i} className="grid grid-cols-[1fr_auto] gap-2 rounded-2xl border border-border bg-card p-4 lg:flex lg:items-center lg:gap-6 lg:border-0 lg:p-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-5 w-24 lg:order-last" /><Skeleton className="col-span-2 h-4 w-56 max-w-full lg:flex-1" /></div>)}</div>
  </main>;
}
