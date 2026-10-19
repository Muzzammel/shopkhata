"use client";

import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { compactQar, monotonePath, niceMax } from "@/lib/dashboard-view";
import { cn } from "@/lib/utils";

// Charts are plain SVG/HTML: no chart library, no data re-fetching. Values arrive already
// computed by the dashboard; a chart only draws them, shows them on hover/touch/arrow keys,
// and exposes the same numbers to screen readers as a table.

export type ChartPoint = { label: string; value: number };

function useActive(count: number) {
  const [active, setActive] = useState<number | null>(null);
  const keys = (event: KeyboardEvent) => {
    if (count === 0) return;
    const next = event.key === "ArrowRight" ? Math.min(count - 1, (active ?? -1) + 1) : event.key === "ArrowLeft" ? Math.max(0, (active ?? count) - 1)
      : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : event.key === "Escape" ? null : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
  };
  return { active, setActive, keys };
}

function SrTable({ caption, columns, rows }: { caption: string; columns: string[]; rows: { label: string; cells: string[] }[] }) {
  return <table className="sr-only"><caption>{caption}</caption>
    <thead><tr><th scope="col">Period</th>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
    <tbody>{rows.map((row) => <tr key={row.label}><th scope="row">{row.label}</th>{row.cells.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
  </table>;
}

function YAxis({ max }: { max: number }) {
  return <div aria-hidden className="flex flex-col justify-between text-right text-[11px] leading-none text-muted-foreground tabular-nums">
    {[max, max / 2, 0].map((tick) => <span key={tick}>{compactQar(tick)}</span>)}
  </div>;
}

function XLabels({ labels }: { labels: string[] }) {
  // Never more than five labels, always including the first and last.
  const picks = labels.length <= 5 ? labels : Array.from({ length: 5 }, (_, i) => labels[Math.round((i * (labels.length - 1)) / 4)]);
  return <div aria-hidden className="mt-2 flex justify-between text-[11px] text-muted-foreground">{picks.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</div>;
}

function Tooltip({ left, children }: { left: number; children: ReactNode }) {
  const shift = left < 18 ? "0%" : left > 82 ? "-100%" : "-50%";
  return <div aria-hidden className="pointer-events-none absolute -top-1 z-10 rounded-xl bg-ink px-3 py-2 text-xs whitespace-nowrap text-ink-foreground shadow-[var(--shadow-lift)] sk-fade" style={{ left: `${left}%`, transform: `translate(${shift}, -100%)` }}>{children}</div>;
}

/** The smooth line/area chart. `mini` is the borderless sparkline drawn inside the Sales card. */
export function AreaChart({ points, format, caption, color = "var(--text)", mini = false, emptyMessage, className }: {
  points: ChartPoint[]; format: (value: number) => string; caption: string; color?: string; mini?: boolean; emptyMessage?: string; className?: string;
}) {
  const plot = useRef<HTMLDivElement>(null);
  const { active, setActive, keys } = useActive(points.length);
  const max = mini ? Math.max(1, ...points.map((p) => p.value)) * 1.1 : niceMax(Math.max(0, ...points.map((p) => p.value)));
  const xs = points.map((_, i) => points.length === 1 ? 50 : (i / (points.length - 1)) * 100);
  const ys = points.map((p) => 100 - (Math.max(0, p.value) / max) * 96 - 2);
  const line = monotonePath(xs, ys);
  const empty = points.every((p) => p.value === 0);
  const at = (event: PointerEvent) => {
    const box = plot.current!.getBoundingClientRect();
    setActive(Math.max(0, Math.min(points.length - 1, Math.round(((event.clientX - box.left) / box.width) * (points.length - 1)))));
  };
  const svg = <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
    <g className="[animation:sk-reveal_var(--dur-chart)_var(--ease-out)_both]">
      {points.length > 1 && <path d={`${line} L100,100 L0,100 Z`} fill={mini ? "var(--ink-foreground)" : color} fillOpacity={mini ? 0.06 : 0.07} />}
      <path d={line} fill="none" stroke={color} strokeWidth={mini ? 2 : 2.25} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </g>
  </svg>;
  if (mini) return <div className={cn("relative h-16 w-full", className)} aria-hidden>{svg}</div>;

  const shown = active === null ? null : points[active];
  return <div className={cn("grid grid-cols-[auto_1fr] gap-x-2", className)}>
    <YAxis max={max} />
    <div>
      <div
        ref={plot} role="group" tabIndex={0} aria-label={`${caption}. Use the left and right arrow keys to read each value.`}
        className="relative h-44 touch-pan-y rounded-lg outline-offset-4 sm:h-56"
        onPointerMove={at} onPointerDown={at} onPointerLeave={(event) => event.pointerType === "mouse" && setActive(null)} onKeyDown={keys} onBlur={() => setActive(null)}
      >
        {[0, 50, 100].map((top) => <div key={top} aria-hidden className="absolute inset-x-0 border-t border-dashed border-border" style={{ top: `${top}%` }} />)}
        {svg}
        {empty && emptyMessage && <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">{emptyMessage}</p>}
        {shown && active !== null && <>
          <div aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-foreground/25" style={{ left: `${xs[active]}%` }} />
          <span aria-hidden className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-foreground bg-yellow" style={{ left: `${xs[active]}%`, top: `${ys[active]}%` }} />
          <Tooltip left={xs[active]}><span className="block text-ink-muted">{shown.label}</span><strong className="text-sm font-semibold tabular-nums">{format(shown.value)}</strong></Tooltip>
        </>}
        <span className="sr-only" aria-live="polite">{shown ? `${shown.label}: ${format(shown.value)}` : ""}</span>
      </div>
      <XLabels labels={points.map((p) => p.label)} />
    </div>
    <SrTable caption={caption} columns={["Amount"]} rows={points.map((p) => ({ label: p.label, cells: [format(p.value)] }))} />
  </div>;
}

export type BarGroup = { label: string; a: number; b: number };

/** Grouped bars, two per period. */
export function GroupedBars({ groups, names, format, caption, className }: {
  groups: BarGroup[]; names: [string, string]; format: (value: number) => string; caption: string; className?: string;
}) {
  const { active, setActive, keys } = useActive(groups.length);
  const max = niceMax(Math.max(0, ...groups.flatMap((g) => [g.a, g.b])));
  const bar = (value: number, color: string, index: number): { style: CSSProperties } => ({ style: { height: `${Math.max(value > 0 ? 2 : 0, (value / max) * 100)}%`, background: color, "--sk-delay": `${index * 28}ms` } as CSSProperties });
  const shown = active === null ? null : groups[active];
  return <div className={cn("grid grid-cols-[auto_1fr] gap-x-2", className)}>
    <YAxis max={max} />
    <div>
      <div
        role="group" tabIndex={0} aria-label={`${caption}. Use the left and right arrow keys to read each period.`}
        className="relative h-44 rounded-lg outline-offset-4 sm:h-48"
        onKeyDown={keys} onBlur={() => setActive(null)} onPointerLeave={(event) => event.pointerType === "mouse" && setActive(null)}
      >
        {[0, 50, 100].map((top) => <div key={top} aria-hidden className="absolute inset-x-0 border-t border-dashed border-border" style={{ top: `${top}%` }} />)}
        <div className="absolute inset-0 flex items-end justify-around gap-1">
          {groups.map((group, index) => <div
            key={group.label} aria-hidden onPointerEnter={() => setActive(index)} onPointerDown={() => setActive(index)}
            className={cn("flex h-full w-full max-w-14 items-end justify-center gap-[3px] rounded-lg px-0.5 transition-colors duration-150", active === index && "bg-muted")}
          >
            <span className="w-1/2 origin-bottom rounded-t-md animate-[sk-grow-y_var(--dur-chart)_var(--ease-out)_both] [animation-delay:var(--sk-delay)]" {...bar(group.a, "var(--series-income)", index)} />
            <span className="w-1/2 origin-bottom rounded-t-md animate-[sk-grow-y_var(--dur-chart)_var(--ease-out)_both] [animation-delay:var(--sk-delay)]" {...bar(group.b, "var(--series-expense)", index)} />
          </div>)}
        </div>
        {shown && active !== null && <Tooltip left={groups.length === 1 ? 50 : ((active + 0.5) / groups.length) * 100}>
          <span className="block text-ink-muted">{shown.label}</span>
          <span className="flex items-center gap-1.5"><i className="size-2 rounded-sm bg-[var(--series-income)] ring-1 ring-white/40" />{names[0]} <strong className="tabular-nums">{format(shown.a)}</strong></span>
          <span className="flex items-center gap-1.5"><i className="size-2 rounded-sm bg-[var(--series-expense)] ring-1 ring-white/40" />{names[1]} <strong className="tabular-nums">{format(shown.b)}</strong></span>
        </Tooltip>}
        <span className="sr-only" aria-live="polite">{shown ? `${shown.label}: ${names[0]} ${format(shown.a)}, ${names[1]} ${format(shown.b)}` : ""}</span>
      </div>
      <XLabels labels={groups.map((g) => g.label)} />
    </div>
    <SrTable caption={caption} columns={names} rows={groups.map((g) => ({ label: g.label, cells: [format(g.a), format(g.b)] }))} />
  </div>;
}
