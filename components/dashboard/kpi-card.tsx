"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode, Ref } from "react";

import { groupedQar } from "@/lib/dashboard-view";
import { cn } from "@/lib/utils";

import { MetricCounter } from "./metric-counter";

export type KpiTone = "ink" | "plain" | "success" | "warning" | "accent";

// Only Sales gets a heavy fill. Accent sits on the card surface with a yellow chip and hairline;
// in dark mode the status tones do the same, so no card turns into a large brown or olive block.
const SURFACE: Record<KpiTone, string> = {
  ink: "bg-ink text-ink-foreground border-ink-border",
  plain: "bg-card text-card-foreground border-border",
  success: "bg-success-soft text-foreground border-success/20 dark:bg-card dark:border-success/35",
  warning: "bg-warning-soft text-foreground border-warning/25 dark:bg-card dark:border-warning/40",
  accent: "bg-card text-card-foreground border-yellow/70 dark:border-yellow/35",
};
const CHIP: Record<KpiTone, string> = {
  ink: "bg-yellow text-on-yellow",
  plain: "bg-muted text-foreground",
  success: "bg-success text-primary-foreground",
  warning: "bg-warning text-on-warning",
  accent: "bg-yellow text-on-yellow",
};

/**
 * One headline figure; the number counts up. When the card acts (`href` navigates, `onClick`
 * changes the page in place) a stretched link/button covers it, so anything interactive placed
 * inside `children` (wrap it in `relative z-20`) stays separately clickable.
 */
export function KpiCard({ label, value, kind = "money", tone = "plain", icon: Icon, caption, href, onClick, pressed, size = "md", index = 0, className, children, ref }: {
  label: string; value: number; kind?: "money" | "count"; tone?: KpiTone; icon: LucideIcon; caption?: ReactNode;
  href?: string; onClick?: () => void; pressed?: boolean; size?: "md" | "xl"; index?: number; className?: string; children?: ReactNode; ref?: Ref<HTMLDivElement>;
}) {
  const acts = Boolean(href || onClick);
  const stretched = cn("absolute inset-0 z-10 rounded-3xl outline-offset-2", tone === "ink" && "focus-visible:outline-yellow");
  return <div
    ref={ref} data-slot="kpi" style={{ "--sk-delay": `${index * 60}ms` } as CSSProperties}
    className={cn(
      "relative flex min-w-0 flex-col justify-between gap-3 rounded-3xl border p-4 text-left sk-enter sk-lift sm:p-5",
      SURFACE[tone], acts && "cursor-pointer sk-lift-hover active:scale-[0.985]", size === "xl" && "gap-5 p-5 sm:p-7", className,
    )}
  >
    <span className="flex items-center gap-2.5">
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-full", CHIP[tone])}><Icon aria-hidden className="size-4" /></span>
      <span className={cn("text-[13px] font-medium", tone === "ink" ? "text-ink-muted" : "text-muted-foreground")}>{label}</span>
    </span>
    <span className={cn("block font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere]", size === "xl" ? "text-4xl sm:text-5xl lg:text-[3.5rem] lg:leading-none" : "text-xl sm:text-2xl xl:text-3xl")}>
      {kind === "money" && <><span className="text-[0.42em] font-medium tracking-normal opacity-65">QAR</span>{" "}</>}
      <MetricCounter value={value} format={kind === "money" ? groupedQar : String} duration={size === "xl" ? 700 : 550} />
    </span>
    {caption && <span className={cn("block text-xs leading-snug", tone === "ink" ? "text-ink-muted" : "text-muted-foreground")}>{caption}</span>}
    {children}
    {href && <Link href={href} className={stretched}><span className="sr-only">{label}: open</span></Link>}
    {onClick && <button type="button" data-slot="kpi-action" className={stretched} onClick={onClick} aria-pressed={pressed}><span className="sr-only">Show {label} on the chart</span></button>}
  </div>;
}
