"use client";

import Link from "next/link";
import { EllipsisIcon, HouseIcon, PlusIcon, ReceiptTextIcon, SearchIcon, UsersIcon, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { navHref, type NavItem } from "./nav-items";
import type { QuickAction } from "./quick-actions";

const sheetClass = "gap-0 rounded-t-[28px] border-0 bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] data-open:duration-[260ms]";

/** Every destination as a list: the phone's "More" sheet, and the menu behind the tablet hamburger. */
export function MenuSheet({ open, onOpenChange, side, items, shopId, pathname, onSearch }: {
  open: boolean; onOpenChange: (open: boolean) => void; side: "bottom" | "left"; items: NavItem[]; shopId: string | null; pathname: string; onSearch: () => void;
}) {
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side={side} className={side === "bottom" ? sheetClass : "gap-0 border-0 bg-background p-4"}>
      <SheetHeader className="px-1 pt-1 pb-3"><SheetTitle className="text-base font-semibold">Menu</SheetTitle><SheetDescription className="sr-only">All ShopKhata pages</SheetDescription></SheetHeader>
      <nav aria-label="All pages">
        <ul className={cn("grid list-none gap-1.5 pl-0", side === "bottom" && "grid-cols-2")}>
          {items.map((item) => {
            const Icon = item.icon, current = item.current(pathname);
            return <li key={item.key}>
              <Link href={navHref(item, shopId)} onClick={() => onOpenChange(false)} aria-current={current ? "page" : undefined}
                className={cn("flex min-h-12 items-center gap-3 rounded-2xl px-3.5 text-sm font-medium no-underline sk-press", current ? "bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-muted")}>
                <Icon aria-hidden className="size-4.5 shrink-0" />{item.label}
              </Link>
            </li>;
          })}
        </ul>
      </nav>
      <button type="button" data-slot="menu-search" onClick={() => { onOpenChange(false); onSearch(); }} className="mt-3 flex min-h-12 w-full items-center gap-3 rounded-2xl bg-card px-3.5 text-sm font-medium text-foreground sk-press hover:bg-muted">
        <SearchIcon aria-hidden className="size-4.5" />Quick find
      </button>
    </SheetContent>
  </Sheet>;
}

function Tab({ href, label, icon: Icon, current }: { href: string; label: string; icon: LucideIcon; current: boolean }) {
  return <Link href={href} aria-current={current ? "page" : undefined} className={cn("flex min-h-14 flex-col items-center justify-center gap-1 rounded-2xl text-[11px] font-medium no-underline sk-press", current ? "text-foreground" : "text-muted-foreground")}>
    <span className={cn("grid h-7 w-12 place-items-center rounded-full transition-colors duration-150", current && "bg-primary text-primary-foreground")}><Icon aria-hidden className="size-[18px]" /></span>{label}
  </Link>;
}

/** Phones only: Home | Sales | Add | Customers | More. Add opens the quick-action sheet. */
export function MobileBottomNav({ items, actions, shopId, pathname, onSearch }: { items: NavItem[]; actions: QuickAction[]; shopId: string | null; pathname: string; onSearch: () => void }) {
  const [adding, setAdding] = useState(false);
  const [more, setMore] = useState(false);
  const item = (key: string) => items.find((entry) => entry.key === key)!;
  const shown = ["dashboard", "sales", "customers"];
  return <>
    <nav aria-label="Mobile navigation" className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
      <div className="mx-auto grid h-16 max-w-md grid-cols-5 items-center px-2">
        <Tab href={navHref(item("dashboard"), shopId)} label="Home" icon={HouseIcon} current={item("dashboard").current(pathname)} />
        <Tab href={navHref(item("sales"), shopId)} label="Sales" icon={ReceiptTextIcon} current={item("sales").current(pathname)} />
        <div className="grid place-items-center">
          <button type="button" data-slot="add" aria-label="Add" aria-haspopup="dialog" aria-expanded={adding} onClick={() => setAdding(true)}
            className="-mt-7 grid size-14 cursor-pointer place-items-center rounded-full bg-yellow text-on-yellow shadow-[var(--shadow-lift)] ring-4 ring-background outline-offset-4 sk-press">
            <PlusIcon aria-hidden className={cn("size-6 transition-transform duration-200", adding && "rotate-45")} />
          </button>
        </div>
        <Tab href={navHref(item("customers"), shopId)} label="Customers" icon={UsersIcon} current={item("customers").current(pathname)} />
        <button type="button" data-slot="more" aria-haspopup="dialog" aria-expanded={more} onClick={() => setMore(true)}
          className={cn("flex min-h-14 cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl text-[11px] font-medium sk-press", items.some((entry) => !shown.includes(entry.key) && entry.current(pathname)) ? "text-foreground" : "text-muted-foreground")}>
          <span className="grid h-7 w-12 place-items-center rounded-full"><EllipsisIcon aria-hidden className="size-[18px]" /></span>More
        </button>
      </div>
    </nav>

    <Sheet open={adding} onOpenChange={setAdding}>
      <SheetContent side="bottom" showCloseButton={false} className={sheetClass}>
        <SheetHeader className="px-1 pt-1 pb-3"><SheetTitle className="text-base font-semibold">Quick actions</SheetTitle><SheetDescription className="sr-only">Start a new record</SheetDescription></SheetHeader>
        <ul className="grid list-none gap-2 pl-0">
          {actions.map(({ key, label, href, icon: Icon, primary }, index) => <li key={key} className="sk-pop" style={{ animationDelay: `${index * 50}ms` }}>
            <Link href={href} onClick={() => setAdding(false)} className={cn("flex min-h-14 items-center gap-3.5 rounded-2xl px-4 text-[15px] font-semibold no-underline sk-press", primary ? "bg-yellow text-on-yellow" : "bg-card text-foreground")}>
              <span className={cn("grid size-9 place-items-center rounded-full", primary ? "bg-on-yellow/10" : "bg-muted")}><Icon aria-hidden className="size-5" /></span>{label}
            </Link>
          </li>)}
        </ul>
      </SheetContent>
    </Sheet>
    <MenuSheet open={more} onOpenChange={setMore} side="bottom" items={items} shopId={shopId} pathname={pathname} onSearch={onSearch} />
  </>;
}
