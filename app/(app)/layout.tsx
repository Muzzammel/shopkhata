import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { can, getCurrentActor, type Actor } from "@/lib/auth/permissions";
import Link from "next/link";

import { SignOut } from "./sign-out";

export default async function AppLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  let actor: Actor;
  try {
    actor = await getCurrentActor();
  } catch {
    redirect("/login");
  }

  // The database already refuses a deactivated account every read and write;
  // this tells the person why instead of showing empty screens.
  if (!actor.isActive) {
    return <main style={{maxWidth:560,margin:"80px auto",padding:"0 16px",display:"grid",gap:12}}>
      <h1>Account deactivated</h1>
      <p role="alert">This account has been deactivated by an owner and can no longer view or record anything. Ask an owner if this is a mistake.</p>
      <SignOut userId={actor.id} />
    </main>;
  }

  return <><header style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:16,padding:"12px max(16px, calc((100vw - 1440px) / 2))",background:"#fff",borderBottom:"1px solid #d8e0e8"}}>
    <Link href="/" style={{fontWeight:800,color:"#155a7c",textDecoration:"none"}}>ShopKhata</Link>
    <nav aria-label="Main navigation" style={{display:"flex",flexWrap:"wrap",gap:16}}>
      <Link href="/">Overview</Link><Link href="/#recent-invoices">Invoices</Link><Link href="/#invoice-payments">Payments</Link><Link href="/customers">Customers</Link><Link href="/expenses">Expenses</Link><Link href="/closing">Daily close</Link><Link href="/reports">Reports</Link>{can(actor, "users.manage") && <Link href="/admin">Accounts</Link>}<SignOut userId={actor.id} />
    </nav>
  </header>{children}</>;
}
