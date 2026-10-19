"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { GlobalSearch } from "./global-search";
import { MobileBottomNav } from "./mobile-bottom-nav";
import { NAV_ITEMS } from "./nav-items";
import { QuickActionRail } from "./quick-action-rail";
import { quickActions, type QuickPermissions } from "./quick-actions";
import type { ShellUser } from "./profile-menu";
import type { ShopOption } from "./shop-switcher";
import { TopNav } from "./top-nav";

/** The frame around every signed-in screen: top bar, floating quick-action rail, phone bottom bar, search. */
export function AppShell({ shops, user, isOwner, permissions, children }: { shops: ShopOption[]; user: ShellUser; isOwner: boolean; permissions: QuickPermissions; children: ReactNode }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const [searching, setSearching] = useState(false);
  const requested = pathname.match(/^\/shops\/([^/]+)/)?.[1] ?? params.get("shop");
  const shop = shops.find((item) => item.id === requested) ?? shops[0] ?? null;
  const items = NAV_ITEMS.filter((item) => !item.ownerOnly || isOwner);
  const actions = quickActions(shop?.id ?? null, permissions);
  const openSearch = () => setSearching(true);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearching(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return <>
    <a href="#content" className="sr-only z-50 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3">Skip to content</a>
    {/* Invoice entry guards unsaved drafts with its own shop switch; Accounts is not shop-scoped. */}
    <TopNav items={items} shops={shops} shop={shop} switcherLocked={pathname === "/" || pathname.startsWith("/admin")} user={user} pathname={pathname} onSearch={openSearch} />
    <QuickActionRail actions={actions} onSearch={openSearch} />
    <div id="content" tabIndex={-1} className="pb-[calc(5.5rem+env(safe-area-inset-bottom))] outline-none md:pb-0 md:pl-[76px] lg:pl-[84px] min-[1480px]:pl-0">{children}</div>
    <MobileBottomNav items={items} actions={actions} shopId={shop?.id ?? null} pathname={pathname} onSearch={openSearch} />
    <GlobalSearch open={searching} onOpenChange={setSearching} shopId={shop?.id ?? null} items={items} />
  </>;
}
