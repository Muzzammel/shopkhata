"use client";

import Link from "next/link";
import type { MouseEvent } from "react";

import { cn } from "@/lib/utils";

export type PillItem = { key: string; label: string; title?: string; href?: string };

/**
 * A row of pills; the selected one is the black (or, in dark mode, cream) pill. Items with an `href`
 * are links (period switches that reload the data); items without are toggle buttons.
 */
export function FilterPills({ items, value, label, onPick, tone = "default", className }: {
  items: readonly PillItem[]; value: string; label: string; onPick?: (key: string, event: MouseEvent) => void; tone?: "default" | "ink"; className?: string;
}) {
  const base = "inline-flex min-h-8 items-center rounded-full px-3 text-[13px] font-medium whitespace-nowrap no-underline sk-press outline-offset-2 max-sm:min-h-9";
  const look = (selected: boolean) => tone === "ink"
    ? selected ? "bg-yellow text-on-yellow font-semibold" : "text-ink-muted hover:bg-white/10 hover:text-ink-foreground"
    : selected ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground";
  return <nav aria-label={label} className={cn("inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full p-0.5", tone === "ink" ? "bg-white/8" : "bg-muted", className)}>
    {items.map((item) => {
      const selected = item.key === value;
      const classes = cn(base, look(selected), tone === "ink" && "focus-visible:outline-yellow");
      return item.href
        ? <Link key={item.key} href={item.href} title={item.title} aria-current={selected ? "page" : undefined} onClick={(event) => onPick?.(item.key, event)} className={classes}>{item.label}</Link>
        : <button key={item.key} type="button" title={item.title} aria-pressed={selected} onClick={(event) => onPick?.(item.key, event)} className={classes} data-slot="pill">{item.label}</button>;
    })}
  </nav>;
}
