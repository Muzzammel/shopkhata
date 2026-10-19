import { HandCoinsIcon, PlusIcon, WalletIcon, type LucideIcon } from "lucide-react";

export type QuickPermissions = Record<string, { payment: boolean; expense: boolean }>;
export type QuickAction = { key: string; label: string; href: string; icon: LucideIcon; primary?: boolean };

/** New Sale / Record Payment / Add Expense, each only where the person may do it in the current shop. */
export function quickActions(shopId: string | null, permissions: QuickPermissions): QuickAction[] {
  const allowed = shopId ? permissions[shopId] : undefined;
  return [
    { key: "sale", label: "New sale", href: shopId ? `/?shop=${shopId}` : "/", icon: PlusIcon, primary: true },
    ...(allowed?.payment ? [{ key: "payment", label: "Record payment", href: `/payments?shop=${shopId}`, icon: HandCoinsIcon }] : []),
    ...(allowed?.expense ? [{ key: "expense", label: "Add expense", href: `/expenses?shop=${shopId}#add-expense`, icon: WalletIcon }] : []),
  ];
}
