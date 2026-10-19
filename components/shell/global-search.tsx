"use client";

import { CornerDownLeftIcon, SearchIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { useRouter } from "next/navigation";
import { useId, useState, type KeyboardEvent } from "react";

import { cn } from "@/lib/utils";

import { navHref, type NavItem } from "./nav-items";

type Option = { id: string; label: string; hint: string; href: string };

function Panel({ shopId, items, onDone }: { shopId: string | null; items: NavItem[]; onDone: () => void }) {
  const router = useRouter();
  const list = useId();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const term = query.trim();
  const shop = shopId ? `shop=${shopId}&` : "";
  const options: Option[] = [
    ...(term ? [
      { id: "find-invoice", label: `Find invoice “${term}”`, hint: "Sales", href: `/invoices?${shop}q=${encodeURIComponent(term)}` },
      { id: "find-customer", label: `Find customer “${term}”`, hint: "Customers", href: `/customers?${shop}q=${encodeURIComponent(term)}` },
    ] : []),
    ...items.filter((item) => !term || item.label.toLowerCase().includes(term.toLowerCase())).map((item) => ({ id: item.key, label: item.label, hint: "Go to", href: navHref(item, shopId) })),
  ];
  const active = Math.min(cursor, options.length - 1);
  function go(option: Option | undefined) {
    if (!option) return;
    onDone();
    router.push(option.href);
  }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") { event.preventDefault(); setCursor((active + 1) % options.length); }
    if (event.key === "ArrowUp") { event.preventDefault(); setCursor((active - 1 + options.length) % options.length); }
    if (event.key === "Enter") { event.preventDefault(); go(options[active]); }
  }
  return <>
    <div className="flex items-center gap-3 border-b border-border px-4">
      <SearchIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      <input
        autoFocus role="combobox" aria-expanded aria-controls={list} aria-activedescendant={options[active] ? `${list}-${options[active].id}` : undefined} aria-label="Search ShopKhata"
        data-slot="search-input" value={query} onChange={(event) => { setQuery(event.target.value); setCursor(0); }} onKeyDown={onKeyDown}
        placeholder="Search an invoice, a customer, or jump to a page" autoComplete="off"
        className="h-14 w-full min-w-0 border-0 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
    <ul id={list} role="listbox" aria-label="Results" className="max-h-80 list-none overflow-y-auto p-2 pl-2">
      {options.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches “{term}”.</li>}
      {options.map((option, index) => <li
        key={option.id} id={`${list}-${option.id}`} role="option" aria-selected={index === active} onPointerMove={() => setCursor(index)} onClick={() => go(option)}
        className={cn("flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-2xl px-3 text-sm", index === active ? "bg-primary text-primary-foreground" : "text-foreground")}
      >
        <span className="truncate font-medium">{option.label}</span>
        <span className={cn("flex shrink-0 items-center gap-1.5 text-xs", index === active ? "opacity-80" : "text-muted-foreground")}>{option.hint}{index === active && <CornerDownLeftIcon aria-hidden className="size-3.5" />}</span>
      </li>)}
    </ul>
  </>;
}

/** Ctrl/⌘+K. Jumps to pages and hands a typed term to the existing invoice and customer searches. */
export function GlobalSearch({ open, onOpenChange, shopId, items }: { open: boolean; onOpenChange: (open: boolean) => void; shopId: string | null; items: NavItem[] }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
      <Dialog.Content aria-describedby={undefined} className="fixed top-[12vh] left-1/2 z-50 w-[calc(100%-1.5rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-3xl border border-border bg-popover text-popover-foreground shadow-[var(--shadow-lift)] outline-none sk-enter">
        <Dialog.Title className="sr-only">Quick find</Dialog.Title>
        <Panel shopId={shopId} items={items} onDone={() => onOpenChange(false)} />
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
