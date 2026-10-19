"use client";

import Link from "next/link";
import { BellIcon, MenuIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

import { MenuSheet } from "./mobile-bottom-nav";
import { navHref, type NavItem } from "./nav-items";
import { bellClass, NotificationsMenu } from "./notifications-menu";
import { ProfileMenu, type ShellUser } from "./profile-menu";
import { ShopSwitcher, type ShopOption } from "./shop-switcher";

/**
 * Sticky top bar. Wide screens: identity + shop on the left, the page pills centred, tools on the right.
 * Tablets fold the pills into a menu sheet; phones move navigation to the bottom bar.
 */
export function TopNav({ items, shops, shop, switcherLocked, user, pathname, onSearch }: {
  items: NavItem[]; shops: ShopOption[]; shop: ShopOption | null; switcherLocked: boolean; user: ShellUser; pathname: string; onSearch: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const icon = "grid size-10 cursor-pointer place-items-center rounded-full text-foreground sk-press hover:bg-muted";
  return <header className="sticky top-0 z-40 border-b border-border bg-background">
    <div className="mx-auto flex h-14 w-full max-w-[1480px] items-center gap-2 px-3 sm:px-5 md:h-16 min-[1280px]:grid min-[1280px]:grid-cols-[1fr_auto_1fr] min-[1280px]:gap-4">
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <button type="button" data-slot="menu" aria-label="Menu" onClick={() => setMenu(true)} className={cn(icon, "hidden md:grid min-[1280px]:hidden")}><MenuIcon aria-hidden className="size-5" /></button>
        <Link href="/" aria-label="ShopKhata" className="flex min-h-10 shrink-0 items-center gap-2 rounded-full text-[15px] font-bold tracking-tight text-foreground no-underline outline-offset-4">
          <span aria-hidden className="grid size-8 place-items-center rounded-[10px] bg-ink text-sm font-black text-yellow">S</span>
          <span className="max-[380px]:sr-only">ShopKhata</span>
        </Link>
        <ShopSwitcher shops={shops} current={shop} locked={switcherLocked} />
      </div>

      <nav aria-label="Main navigation" className="hidden items-center gap-0.5 rounded-full border border-border bg-card p-1 min-[1280px]:flex">
        {items.filter((item) => !item.secondary).map((item) => {
          const current = item.current(pathname);
          return <Link key={item.key} href={navHref(item, shop?.id ?? null)} aria-current={current ? "page" : undefined}
            className={cn("rounded-full px-3 py-1.5 text-[13px] min-[1360px]:px-3.5 font-medium whitespace-nowrap no-underline sk-press", current ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
            {item.label}
          </Link>;
        })}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1 min-[1280px]:justify-self-end">
        <button type="button" data-slot="search" aria-label="Quick find" onClick={onSearch} className={cn(icon, "hidden md:grid")}><SearchIcon aria-hidden className="size-5" /></button>
        <NotificationsMenu><button type="button" data-slot="bell" aria-label="Notifications" className={bellClass()}><BellIcon aria-hidden className="size-5" /></button></NotificationsMenu>
        <ThemeToggle className="hidden md:inline-flex" />
        <ProfileMenu user={user} />
      </div>
    </div>
    <MenuSheet open={menu} onOpenChange={setMenu} side="left" items={items} shopId={shop?.id ?? null} pathname={pathname} onSearch={onSearch} />
  </header>;
}
