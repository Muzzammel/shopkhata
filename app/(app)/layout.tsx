import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { getCurrentActor } from "@/lib/auth/permissions";
import Link from "next/link";

export default async function AppLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  try {
    await getCurrentActor();
  } catch {
    redirect("/login");
  }

  return <><header style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:16,padding:"12px max(16px, calc((100vw - 1440px) / 2))",background:"#fff",borderBottom:"1px solid #d8e0e8"}}>
    <Link href="/" style={{fontWeight:800,color:"#155a7c",textDecoration:"none"}}>ShopKhata</Link>
    <nav aria-label="Main navigation" style={{display:"flex",flexWrap:"wrap",gap:16}}>
      <Link href="/">Overview</Link><Link href="/#recent-invoices">Invoices</Link><Link href="/#invoice-payments">Payments</Link><Link href="/customers">Customers</Link><Link href="/expenses">Expenses</Link>
    </nav>
  </header>{children}</>;
}
