"use client";

import { ChevronDownIcon, StoreIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { hrefForShop } from "./nav-items";

export type ShopOption = { id: string; name: string; isActive?: boolean };

const chip = "inline-flex h-9 max-w-[11rem] min-w-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[13px] font-medium text-foreground sm:max-w-[14rem]";

/**
 * The shop the whole app is showing. Switching rewrites ?shop= on the current page. It is a plain
 * label when there is only one shop, and also on screens that guard unsaved work themselves
 * (invoice entry has its own switch with a draft check) or are not shop-scoped (Accounts).
 */
export function ShopSwitcher({ shops, current, locked }: { shops: ShopOption[]; current: ShopOption | null; locked: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  if (!current) return null;
  const name = <><StoreIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{current.name}</span></>;
  if (shops.length < 2 || locked) return <span className={chip} title={locked && shops.length > 1 ? "Switch shop from this screen's own shop selector" : undefined}><span className="sr-only">Current shop: </span>{name}</span>;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" data-slot="shop-switcher" aria-label={`Shop: ${current.name}. Change shop`} className={cn(chip, "cursor-pointer sk-press hover:bg-muted data-[state=open]:bg-muted")}>
        {name}<ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="min-w-52 rounded-2xl p-1.5">
      <DropdownMenuLabel>Shop</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={current.id} onValueChange={(id) => id !== current.id && router.push(hrefForShop(pathname, search, id))}>
        {shops.map((shop) => <DropdownMenuRadioItem key={shop.id} value={shop.id} className="min-h-9 rounded-xl">{shop.name}{shop.isActive === false && <span className="text-xs text-muted-foreground">(inactive, read only)</span>}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
