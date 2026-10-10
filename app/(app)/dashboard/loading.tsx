import { Skeleton } from "@/components/ui/skeleton";

import styles from "@/app/ui.module.css";

/** Shown while the dashboard's figures are read; mirrors its layout so nothing jumps when they arrive. */
export default function DashboardLoading() {
  return <main className={styles.workspace} aria-busy="true">
    <header className={styles.header}><div className="grid gap-2"><Skeleton className="h-3 w-24" /><h1>Dashboard</h1><Skeleton className="h-4 w-72 max-w-full" /></div></header>
    <span role="status" className="sr-only">Loading dashboard</span>
    <section className={styles.panel}>
      <Skeleton className="h-8 w-80 max-w-full" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-[74px] rounded-xl" />)}</div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-[74px] rounded-xl" />)}</div>
    </section>
    {Array.from({ length: 3 }, (_, index) => <section key={index} className={styles.panel}><Skeleton className="h-5 w-40" /><Skeleton className="h-24 w-full" /></section>)}
  </main>;
}
