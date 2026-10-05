"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "@/app/ui.module.css";

// `group` starts a visual group; `under` is the path prefix that marks the link as current.
const LINKS = [
  { href: "/", label: "Overview", under: "/" },
  { href: "/invoices", label: "Invoices", under: "/invoices" },
  { href: "/customers", label: "Customers", under: "/customers", group: true },
  { href: "/payments", label: "Payments", under: "/payments", group: true },
  { href: "/expenses", label: "Expenses", under: "/expenses" },
  { href: "/closing", label: "Daily close", under: "/closing", group: true },
  { href: "/dashboard", label: "Dashboard", under: "/dashboard" },
  { href: "/reports", label: "Reports", under: "/reports" },
  { href: "/admin", label: "Accounts", under: "/admin", group: true, admin: true },
];

export function MainNav({ showAccounts }: { showAccounts: boolean }) {
  const pathname = usePathname();
  return <nav aria-label="Main navigation" className={styles.nav}>
    {LINKS.filter((link) => !link.admin || showAccounts).map((link) => {
      const current = link.under === "/" ? pathname === "/" : Boolean(link.under) && pathname.startsWith(link.under!);
      return <Link key={link.href} href={link.href} data-group={link.group || undefined} aria-current={current ? "page" : undefined}>{link.label}</Link>;
    })}
  </nav>;
}
