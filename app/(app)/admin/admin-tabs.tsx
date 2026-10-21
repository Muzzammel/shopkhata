import { FilterPills } from "@/components/dashboard/filter-pills";

const TABS = [{ href: "/admin", label: "Users & access" }, { href: "/admin/shops", label: "Shops" }, { href: "/admin/backup", label: "Backup & Recovery" }] as const;

export function AdminTabs({ current }: { current: (typeof TABS)[number]["href"] }) {
  return <FilterPills label="Admin sections" value={current} className="justify-self-start" items={TABS.map((tab) => ({ key: tab.href, label: tab.label, href: tab.href }))} />;
}
