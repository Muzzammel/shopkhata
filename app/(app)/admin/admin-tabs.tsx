import Link from "next/link";

import styles from "@/app/ui.module.css";

const TABS = [{ href: "/admin", label: "Users & access" }, { href: "/admin/backup", label: "Backup & Recovery" }] as const;

export function AdminTabs({ current }: { current: (typeof TABS)[number]["href"] }) {
  return <nav className={styles.shops} aria-label="Admin sections">
    {TABS.map((tab) => <Link key={tab.href} href={tab.href} aria-current={tab.href === current ? "page" : undefined}>{tab.label}</Link>)}
  </nav>;
}
