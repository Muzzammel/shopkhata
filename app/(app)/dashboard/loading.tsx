import { Skeleton } from "@/components/ui/skeleton";

const card = "rounded-3xl border border-border bg-card p-5";

/** Shown while the dashboard's figures are read; mirrors the composition so nothing jumps when they arrive. */
export default function DashboardLoading() {
  return <main className="mx-auto grid w-full max-w-[1280px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6" aria-busy="true">
    <header className="grid gap-2 px-1"><Skeleton className="h-3 w-24" /><h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Dashboard</h1></header>
    <span role="status" className="sr-only">Loading dashboard</span>
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-12">
      <div className="col-span-2 grid min-h-56 content-between gap-6 rounded-3xl bg-ink p-6 lg:col-span-5 lg:row-span-2">
        <Skeleton className="h-4 w-24 bg-white/10" /><Skeleton className="h-14 w-3/4 bg-white/10" /><Skeleton className="h-16 w-full bg-white/10" />
      </div>
      {["lg:col-span-4", "lg:col-span-3", "col-span-2 lg:col-span-7", "lg:col-span-7", "lg:col-span-5"].map((span, index) => <div key={index} className={`${card} grid gap-4 ${span}`}>
        <Skeleton className="h-4 w-28" /><Skeleton className="h-8 w-2/3" />
      </div>)}
    </div>
    <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-12">
      <div className={`${card} grid gap-5 lg:col-span-8`}><Skeleton className="h-5 w-40" /><Skeleton className="h-52 w-full" /></div>
      <div className={`${card} grid gap-5 lg:col-span-4`}><Skeleton className="h-5 w-36" /><Skeleton className="h-52 w-full" /></div>
    </div>
    <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-12">
      {Array.from({ length: 3 }, (_, index) => <div key={index} className={`${card} grid gap-3 lg:col-span-4`}>
        <Skeleton className="h-5 w-36" />{Array.from({ length: 4 }, (_, row) => <Skeleton key={row} className="h-9 w-full" />)}
      </div>)}
    </div>
  </main>;
}
