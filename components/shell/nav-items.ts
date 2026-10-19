import {
  CalendarCheckIcon, ChartColumnIcon, DatabaseBackupIcon, HandCoinsIcon, LayoutDashboardIcon, ReceiptTextIcon, UserCogIcon, UsersIcon, WalletIcon,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  key: string;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Pages that read ?shop= get the current shop appended. */
  shopScoped: boolean;
  /** Shown in the top bar and the "More" sheet only for owners. */
  ownerOnly?: boolean;
  /** Only listed in the More sheet / search, not in the top bar. */
  secondary?: boolean;
  current: (pathname: string) => boolean;
};

export const NAV_ITEMS: NavItem[] = [
  { key: "dashboard", label: "Dashboard", href: "/dashboard", icon: LayoutDashboardIcon, shopScoped: true, current: (p) => p.startsWith("/dashboard") },
  // "/" is the invoice entry screen, so it belongs to Sales as well.
  { key: "sales", label: "Sales", href: "/invoices", icon: ReceiptTextIcon, shopScoped: true, current: (p) => p === "/" || p.startsWith("/invoices") || p.startsWith("/shops/") },
  { key: "customers", label: "Customers", href: "/customers", icon: UsersIcon, shopScoped: true, current: (p) => p.startsWith("/customers") },
  { key: "payments", label: "Payments", href: "/payments", icon: HandCoinsIcon, shopScoped: true, secondary: true, current: (p) => p.startsWith("/payments") },
  { key: "expenses", label: "Expenses", href: "/expenses", icon: WalletIcon, shopScoped: true, current: (p) => p.startsWith("/expenses") },
  { key: "closing", label: "Daily Close", href: "/closing", icon: CalendarCheckIcon, shopScoped: true, current: (p) => p.startsWith("/closing") },
  { key: "reports", label: "Reports", href: "/reports", icon: ChartColumnIcon, shopScoped: true, current: (p) => p.startsWith("/reports") },
  { key: "accounts", label: "Accounts", href: "/admin", icon: UserCogIcon, shopScoped: false, ownerOnly: true, current: (p) => p.startsWith("/admin") && !p.startsWith("/admin/backup") },
  { key: "backup", label: "Backup", href: "/admin/backup", icon: DatabaseBackupIcon, shopScoped: false, ownerOnly: true, current: (p) => p.startsWith("/admin/backup") },
];

export function navHref(item: Pick<NavItem, "href" | "shopScoped">, shopId: string | null): string {
  return item.shopScoped && shopId ? `${item.href}?shop=${shopId}` : item.href;
}

/** Where the same page lives under another shop. Detail pages return to their list: a record belongs to one shop. */
export function hrefForShop(pathname: string, search: string, shopId: string): string {
  const segments = pathname.split("/").filter(Boolean);
  const root = pathname.startsWith("/shops/") ? "/invoices" : segments.length > 1 ? `/${segments[0]}` : pathname;
  const params = new URLSearchParams(root === pathname ? search : "");
  params.set("shop", shopId);
  params.delete("offset");
  return `${root}?${params}`;
}
