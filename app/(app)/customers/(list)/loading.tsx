import { Skeleton } from "@/components/ui/skeleton";

export default function CustomersLoading() {
  return <main aria-busy="true" aria-label="Loading customers" className="mx-auto grid w-full max-w-[1280px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6">
    <div className="flex items-end justify-between px-1"><div className="grid gap-2"><Skeleton className="h-3 w-24" /><Skeleton className="h-9 w-44" /></div><Skeleton className="h-10 w-36 rounded-full" /></div>
    <Skeleton className="h-[4.5rem] rounded-3xl" />
    <div className="grid gap-3 sm:max-lg:grid-cols-2 lg:rounded-3xl lg:border lg:border-border lg:bg-card lg:p-4">{Array.from({ length: 8 }, (_, i) => <div key={i} className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 lg:border-0 lg:p-1"><Skeleton className="size-10 rounded-full" /><div className="grid flex-1 gap-1.5"><Skeleton className="h-4 w-40 max-w-full" /><Skeleton className="h-3 w-24" /></div><Skeleton className="h-5 w-20" /></div>)}</div>
  </main>;
}
