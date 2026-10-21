"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type MouseEvent } from "react";
import { BanknoteIcon, ClipboardListIcon, HandCoinsIcon, ReceiptTextIcon, ScaleIcon, TrendingUpIcon, WalletIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import type { DashboardPeriod, TrendPoint } from "@/lib/dashboard";
import { bucketTrend, qar, shortDate } from "@/lib/dashboard-view";
import { cn } from "@/lib/utils";

import { AreaChart, GroupedBars } from "./charts";
import { ChartCard } from "./chart-card";
import { FilterPills, type PillItem } from "./filter-pills";
import { KpiCard } from "./kpi-card";

export type OverviewProps = {
  shopId: string;
  range: { period: DashboardPeriod; from: string; to: string; error: string | null };
  today: string;
  kpi: {
    salesDirham: number; invoiceCount: number; averageInvoiceDirham: number; paymentsReceivedDirham: number; bankReceivedDirham: number; totalReceivedDirham: number; expensesDirham: number;
    netCashMovementDirham: number; outstandingDueDirham: number; customersWithDue: number; unpaidInvoicesDirham: number; unpaidInvoiceCount: number;
  };
  days: TrendPoint[];
  /** The last day of the range, shown as meters when the range is a single day and a trend has nothing to plot. */
  lastDay: { grossInvoiceDirham: number; cashReceivedDirham: number; bankReceivedDirham: number; totalReceivedDirham: number; expensesDirham: number };
};

const PERIODS: { key: DashboardPeriod; label: string; title: string }[] = [
  { key: "today", label: "Today", title: "Today" }, { key: "7d", label: "Week", title: "Last 7 days" }, { key: "30d", label: "Month", title: "Last 30 days" },
  { key: "year", label: "Year", title: "Last 12 months" }, { key: "custom", label: "Custom", title: "Custom range" },
];
const METRICS = {
  sales: { label: "Sales", description: "Gross invoiced per day, before corrections", color: "var(--text)", pick: (d: TrendPoint) => d.salesDirham },
  cash: { label: "Cash", description: "Cash received per day", color: "var(--series-income)", pick: (d: TrendPoint) => d.paymentsDirham },
  expenses: { label: "Expenses", description: "Expenses per day", color: "var(--series-expense)", pick: (d: TrendPoint) => d.expensesDirham },
} as const;
type Metric = keyof typeof METRICS;
const UNIT_NOUN = { day: "day", week: "week", month: "month" } as const;

const money = (dirham: number) => qar(dirham);

export function DashboardOverview({ shopId, range, today, kpi, days, lastDay }: OverviewProps) {
  const [metric, setMetric] = useState<Metric>("sales");
  const [picked, setPicked] = useState<DashboardPeriod | null>(null);
  const [loading, startLoading] = useTransition();
  const router = useRouter();
  const [emphasized, setEmphasized] = useState(false);
  const chart = useRef<HTMLElement>(null);
  // A pill turns black the instant it is pressed; the figures dim until the new period's data arrives.
  const shownPeriod = loading && picked ? picked : range.period;
  function pickPeriod(key: string, event: MouseEvent) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;  // new tab / window: let the link do it
    event.preventDefault();
    setPicked(key as DashboardPeriod);
    startLoading(() => router.push(`/dashboard?shop=${shopId}&period=${key}`));
  }

  const periodItems: PillItem[] = PERIODS.map((item) => ({ key: item.key, label: item.label, title: item.title, href: `/dashboard?shop=${shopId}&period=${item.key}` }));
  const current = PERIODS.find((item) => item.key === range.period)!;
  const caption = range.from === range.to ? `${current.title} · ${shortDate(range.from)}` : `${current.title} · ${shortDate(range.from)} – ${shortDate(range.to)}`;

  const { unit, buckets } = bucketTrend(days, range.from, range.to, 31);
  const bars = bucketTrend(days, range.from, range.to, 10);
  const series = METRICS[metric];
  const salesPoints = buckets.map((bucket) => ({ label: bucket.label, value: bucket.salesDirham }));
  const points = buckets.map((bucket) => ({ label: bucket.label, value: series.pick({ businessDate: bucket.key, salesDirham: bucket.salesDirham, paymentsDirham: bucket.paymentsDirham, receivedDirham: bucket.receivedDirham, expensesDirham: bucket.expensesDirham }) }));

  function emphasize(next: Metric) {
    setMetric(next);
    setEmphasized(true);
    window.setTimeout(() => setEmphasized(false), 1100);
    chart.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  }

  const incomeShare = kpi.totalReceivedDirham + kpi.expensesDirham;
  const net = kpi.netCashMovementDirham;
  const unpaidHref = `/invoices?shop=${shopId}&from=${range.from}&to=${range.to}&status=with_due`;

  return <div className="grid grid-cols-1 gap-4 sm:gap-5">
    {range.error && <Alert variant="destructive" className="border-destructive/50 bg-danger-soft"><AlertDescription className="text-destructive">{range.error} Showing {current.title} instead.</AlertDescription></Alert>}
    {range.period === "custom" && <form className="flex flex-wrap items-end gap-3 rounded-3xl border border-border bg-card p-4" action="/dashboard">
      <input type="hidden" name="shop" value={shopId} /><input type="hidden" name="period" value="custom" />
      <label>From<input type="date" name="from" defaultValue={range.from} max={today} required /></label>
      <label>To<input type="date" name="to" defaultValue={range.to} max={today} required /></label>
      <button type="submit" data-slot="submit" className="min-h-10 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground sk-press">Show range</button>
    </form>}

    <div className={cn("grid grid-cols-2 gap-3 transition-opacity duration-200 sm:gap-4 lg:grid-cols-12", loading && "opacity-60")} aria-busy={loading || undefined}>
      <KpiCard
        tone="ink" size="xl" icon={TrendingUpIcon} label="Sales" kind="money" value={kpi.salesDirham} onClick={() => emphasize("sales")} pressed={emphasized && metric === "sales"}
        className="col-span-2 order-0 lg:col-span-5 lg:row-span-2" index={0}
        caption={<span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span>Effective sales · {caption}</span></span>}
      >
        <span className="flex flex-wrap gap-2">
          <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium">{kpi.invoiceCount} invoice{kpi.invoiceCount === 1 ? "" : "s"}</span>
          <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium">Average {qar(kpi.averageInvoiceDirham)}</span>
        </span>
        <span className="block lg:mt-auto">
          {buckets.length > 1 ? <AreaChart key={`${range.period}-${range.from}-${range.to}`} mini points={salesPoints} format={money} caption="Sales trend" color="var(--yellow)" />
            : <span aria-hidden className="relative block h-16 border-b border-dashed border-ink-border"><span className="absolute right-0 bottom-0 size-3 translate-y-1/2 rounded-full bg-yellow" /></span>}
        </span>
        <FilterPills tone="ink" label="Choose period" items={periodItems} value={shownPeriod} onPick={pickPeriod} className="relative z-20 self-start lg:hidden" />
      </KpiCard>

      <KpiCard tone="success" icon={HandCoinsIcon} label="Cash Received" value={kpi.paymentsReceivedDirham} onClick={() => emphasize("cash")} pressed={emphasized && metric === "cash"} caption={<>Cash only · Bank {money(kpi.bankReceivedDirham)} · Total {money(kpi.totalReceivedDirham)}</>} className="order-1 lg:order-none lg:col-span-4" index={1} />
      <KpiCard tone="plain" icon={WalletIcon} label="Expenses" value={kpi.expensesDirham} onClick={() => emphasize("expenses")} pressed={emphasized && metric === "expenses"} caption="Recorded this period" className="order-2 lg:order-none lg:col-span-3" index={2} />

      <KpiCard tone="accent" icon={ScaleIcon} label="Net Position" value={net} caption="Total received (cash + bank) − expenses. Not profit." className="order-5 lg:order-none lg:col-span-7" index={3}>
        {incomeShare > 0 && <span aria-hidden className="flex h-2 gap-0.5 overflow-hidden rounded-full">
          <span className="origin-left rounded-full bg-[var(--series-income)] animate-[sk-grow-x_var(--dur-chart)_var(--ease-out)_both]" style={{ flexGrow: kpi.totalReceivedDirham }} />
          <span className="origin-left rounded-full bg-[var(--series-expense)] animate-[sk-grow-x_var(--dur-chart)_var(--ease-out)_both]" style={{ flexGrow: kpi.expensesDirham }} />
        </span>}
      </KpiCard>

      <KpiCard
        tone="warning" icon={BanknoteIcon} label="Customer Due" value={kpi.outstandingDueDirham} href={`/customers?shop=${shopId}`} index={4}
        caption={<>{kpi.customersWithDue} customer{kpi.customersWithDue === 1 ? "" : "s"} · current balance, customer ledger only</>} className="order-3 lg:order-none lg:col-span-7"
      />
      <KpiCard
        tone="plain" icon={ClipboardListIcon} label="All Unpaid Invoices" value={kpi.unpaidInvoicesDirham} href={unpaidHref} index={5}
        caption={<>{kpi.unpaidInvoiceCount} invoice{kpi.unpaidInvoiceCount === 1 ? "" : "s"} dated in this period, with or without a customer</>} className="order-4 lg:order-none lg:col-span-5"
      />
      <KpiCard tone="plain" icon={ReceiptTextIcon} label="Invoices" kind="count" value={kpi.invoiceCount} caption="Entered this period" className="order-6 lg:hidden" index={6} />
    </div>

    <div className={cn("grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-12", loading && "opacity-60 transition-opacity duration-200")}>
      <ChartCard
        ref={chart} title="Sales Overview" className="lg:col-span-8" emphasized={emphasized} dimmed={loading}
        description={`${series.description} · ${caption}${buckets.length > 1 && unit !== "day" ? ` · by ${UNIT_NOUN[unit]}` : ""}`}
        actions={<FilterPills label="Choose period" items={periodItems} value={shownPeriod} onPick={pickPeriod} className="max-lg:hidden" />}
      >
        {buckets.length > 1 && <FilterPills label="Chart measure" items={Object.entries(METRICS).map(([key, item]) => ({ key, label: item.label }))} value={metric} onPick={(key) => setMetric(key as Metric)} className="mb-5 bg-transparent p-0 [&>*]:min-h-7 [&>*]:px-2.5 [&>*]:text-xs" />}
        {buckets.length > 1
          ? <AreaChart key={`${metric}-${range.period}-${range.from}-${range.to}`} points={points} format={money} caption={`${series.label} overview, ${caption}`} color={series.color} emptyMessage="Nothing recorded in this period" />
          : <div className="grid gap-4 py-2" role="group" aria-label="Today so far">
            <p className="text-sm text-muted-foreground">A single day has no trend to plot. Pick Week, Month or Year to see movement.</p>
            {([["Invoiced (gross)", lastDay.grossInvoiceDirham, "var(--text)"], ["Cash received", lastDay.cashReceivedDirham, "var(--series-income)"], ["Bank received", lastDay.bankReceivedDirham, "var(--series-income)"], ["Expenses", lastDay.expensesDirham, "var(--series-expense)"]] as const).map(([label, value, color], index) => {
              const top = Math.max(1, lastDay.grossInvoiceDirham, lastDay.cashReceivedDirham, lastDay.bankReceivedDirham, lastDay.expensesDirham);
              return <div key={label} className="grid gap-1.5">
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">{label}</span><strong className="tabular-nums">{money(value)}</strong></div>
                <span aria-hidden className="block h-2.5 overflow-hidden rounded-full bg-muted"><span className="block h-full origin-left rounded-full animate-[sk-grow-x_var(--dur-chart)_var(--ease-out)_both]" style={{ width: `${Math.max(value > 0 ? 2 : 0, (value / top) * 100)}%`, background: color, animationDelay: `${index * 70}ms` }} /></span>
              </div>;
            })}
          </div>}
      </ChartCard>

      <ChartCard
        title="Income vs Expense" className="lg:col-span-4" dimmed={loading}
        description={`Money received (cash and bank) against expenses${bars.unit === "day" ? "" : `, by ${UNIT_NOUN[bars.unit]}`}`}
        actions={<ul className="flex list-none gap-3 pl-0 text-xs text-muted-foreground">
          <li className="flex items-center gap-1.5"><i aria-hidden className="size-2.5 rounded-sm bg-[var(--series-income)]" />Income</li>
          <li className="flex items-center gap-1.5"><i aria-hidden className="size-2.5 rounded-sm bg-[var(--series-expense)]" />Expense</li>
        </ul>}
      >
        <GroupedBars
          key={`${range.period}-${range.from}-${range.to}`} names={["Income", "Expense"]} format={money} caption={`Income against expenses, ${caption}`}
          groups={range.from === range.to ? [{ label: shortDate(range.from), a: lastDay.totalReceivedDirham, b: lastDay.expensesDirham }] : bars.buckets.map((bucket) => ({ label: bucket.label, a: bucket.receivedDirham, b: bucket.expensesDirham }))}
        />
      </ChartCard>
    </div>
  </div>;
}
