import Link from "next/link";
import { CircleCheckIcon, TriangleAlertIcon, ClockIcon, ArrowUpRightIcon, HandCoinsIcon, ReceiptTextIcon, PencilLineIcon, WalletIcon, LockIcon, UserPlusIcon, ShieldIcon, type LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { activityKind, activityWhen, categorySlot, initials, qar, type ActivityKind, type AttentionItem } from "@/lib/dashboard-view";
import type { ActivityEvent, TopCustomer } from "@/lib/dashboard";
import { cn } from "@/lib/utils";

const stagger = (index: number) => ({ "--sk-delay": `${Math.min(index, 10) * 55}ms` }) as CSSProperties;

/** Frame for the small list cards. */
export function ListCard({ title, description, action, children, className }: { title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section aria-label={title} className={cn("flex min-w-0 flex-col gap-4 rounded-3xl border border-border bg-card p-4 sk-enter sm:p-6", className)}>
    <header className="flex items-start justify-between gap-3">
      <div><h2 className="text-base font-semibold tracking-tight">{title}</h2>{description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}</div>
      {action}
    </header>
    {children}
  </section>;
}

const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-2xl bg-muted px-4 py-6 text-center text-sm text-muted-foreground">{children}</p>;

export function TopCustomers({ rows, shopId }: { rows: TopCustomer[]; shopId: string }) {
  const max = Math.max(1, ...rows.map((row) => row.amountDirham));
  return <ListCard title="Top Customers" description="By sales in the period" className="lg:col-span-6">
    {rows.length === 0 ? <Empty>No invoices with a customer in this period.</Empty> : <ol className="grid grid-cols-1 list-none gap-1 pl-0">
      {rows.map((row, index) => <li key={row.customerId} className="sk-enter" style={stagger(index)}>
        <Link href={`/customers/${row.customerId}?shop=${shopId}`} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 rounded-2xl px-2 py-2 no-underline transition-colors duration-150 hover:bg-muted">
          <span aria-hidden className="grid size-9 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{initials(row.name)}</span>
          <span className="min-w-0 truncate text-sm font-medium text-foreground"><span className="sr-only">{index + 1}. </span>{row.name || "Unnamed customer"}</span>
          <strong className="text-sm font-semibold tabular-nums text-foreground">{qar(row.amountDirham)}</strong>
          <span aria-hidden className="col-span-2 col-start-2 h-1 overflow-hidden rounded-full bg-muted"><span className="block h-full origin-left rounded-full bg-yellow animate-[sk-grow-x_var(--dur-chart)_var(--ease-out)_both]" style={{ width: `${Math.max(4, (row.amountDirham / max) * 100)}%`, animationDelay: `${index * 60}ms` }} /></span>
        </Link>
      </li>)}
    </ol>}
  </ListCard>;
}

export function ExpenseCategories({ rows, totalDirham, className }: { rows: { category: string; amountDirham: number; count: number }[]; totalDirham: number; className?: string }) {
  const sorted = [...rows].sort((a, b) => b.amountDirham - a.amountDirham);
  const total = Math.max(1, sorted.reduce((sum, row) => sum + row.amountDirham, 0));
  return <ListCard title="Top Expense Categories" description={`${qar(totalDirham)} in the period`} className={cn("lg:col-span-6", className)}>
    {sorted.length === 0 ? <Empty>No expenses in this period.</Empty> : <>
      <div aria-hidden className="flex h-2.5 gap-0.5 overflow-hidden rounded-full">
        {sorted.map((row, index) => <span key={row.category} className="origin-left animate-[sk-grow-x_var(--dur-chart)_var(--ease-out)_both]" style={{ width: `${(row.amountDirham / total) * 100}%`, background: `var(--category-${categorySlot(row.category)})`, animationDelay: `${index * 50}ms` }} />)}
      </div>
      <ul className="grid grid-cols-1 list-none gap-3 pl-0">
        {sorted.map((row, index) => <li key={row.category} className="sk-enter" style={stagger(index)}>
          <div className="flex items-center gap-2.5 text-sm">
            <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: `var(--category-${categorySlot(row.category)})` }} />
            <span className="min-w-0 flex-1 truncate font-medium capitalize">{row.category}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{Math.round((row.amountDirham / total) * 100)}%</span>
            <strong className="font-semibold tabular-nums">{qar(row.amountDirham)}</strong>
          </div>
        </li>)}
      </ul>
    </>}
  </ListCard>;
}

const KIND: Record<ActivityKind, { icon: LucideIcon; chip: string; label: string }> = {
  payment: { icon: HandCoinsIcon, chip: "bg-success-soft text-success", label: "Payment" },
  invoice: { icon: ReceiptTextIcon, chip: "bg-yellow-soft text-foreground", label: "Invoice" },
  correction: { icon: PencilLineIcon, chip: "bg-warning-soft text-warning", label: "Correction" },
  expense: { icon: WalletIcon, chip: "bg-muted text-foreground", label: "Expense" },
  close: { icon: LockIcon, chip: "bg-primary text-primary-foreground", label: "Daily Close" },
  customer: { icon: UserPlusIcon, chip: "bg-muted text-foreground", label: "Customer" },
  admin: { icon: ShieldIcon, chip: "bg-muted text-foreground", label: "Account" },
};

/** Newest first. Rows rise in one after another so a fresh load reads as live; the rest sit behind "View all activity". */
export function ActivityTimeline({ events, shopName, today, visible = 5, className }: { events: ActivityEvent[]; shopName: string; today: string; visible?: number; className?: string }) {
  const row = (event: ActivityEvent, index: number) => {
    const kind = KIND[activityKind(event.action)];
    const Icon = kind.icon;
    const body = <>
      <span aria-hidden className={cn("grid size-9 place-items-center rounded-full", kind.chip)}><Icon className="size-4" /></span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground"><span className="sr-only">{kind.label}: </span>{event.label}</span>
        <span className="block truncate text-xs text-muted-foreground">{shopName} · {event.actorName}</span>
      </span>
      <time dateTime={event.recordedAt} className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">{activityWhen(event.recordedAt, today)}</time>
    </>;
    const classes = "grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-2xl px-2 py-2 no-underline transition-colors duration-150";
    return <li key={event.id} className="sk-enter" style={stagger(index)}>
      {event.href ? <Link href={event.href} className={cn(classes, "hover:bg-muted")}>{body}</Link> : <div className={classes}>{body}</div>}
    </li>;
  };
  const rest = events.slice(visible);
  return <ListCard title="Recent Activity" description="Newest first, from the audit trail" className={className}>
    {events.length === 0 ? <Empty>No recorded activity yet.</Empty> : <>
      <ol className="grid grid-cols-1 list-none gap-0.5 pl-0">{events.slice(0, visible).map(row)}</ol>
      {rest.length > 0 && <details className="group/all">
        {/* The summary stays put when opened, so keyboard focus is never dropped. */}
        <summary className="flex min-h-10 cursor-pointer list-none items-center justify-center rounded-full bg-muted text-[13px] font-semibold text-foreground sk-press [&::-webkit-details-marker]:hidden">
          <span className="group-open/all:hidden">View all activity ({events.length})</span><span className="hidden group-open/all:inline">Show fewer</span>
        </summary>
        <ol className="mt-1 grid grid-cols-1 list-none gap-0.5 pl-0">{rest.map((event, index) => row(event, index))}</ol>
      </details>}
    </>}
  </ListCard>;
}

/** Shows only what needs a person; otherwise one calm confirmation. */
export function AttentionCard({ items, className }: { items: AttentionItem[]; className?: string }) {
  return <ListCard title="Needs Attention" className={cn("lg:col-span-4", className)}>
    {items.length === 0
      ? <p role="status" className="flex items-center gap-3 rounded-2xl bg-success-soft px-4 py-4 text-sm font-medium text-success"><CircleCheckIcon aria-hidden className="size-5 shrink-0" />Everything looks good</p>
      : <ul className="grid grid-cols-1 list-none gap-2 pl-0">
        {items.map((item, index) => <li key={item.id} className="sk-enter" style={stagger(index)}>
          <Link href={item.href} className={cn("group/att flex items-start gap-3 rounded-2xl px-3.5 py-3 no-underline transition-colors duration-150", item.tone === "warning" ? "bg-warning-soft hover:bg-warning-soft/70" : "bg-yellow-soft hover:bg-yellow-soft/70")}>
            <span aria-hidden className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-full", item.tone === "warning" ? "bg-warning text-on-warning" : "bg-yellow text-on-yellow")}>
              {item.tone === "warning" ? <TriangleAlertIcon className="size-3.5" /> : <ClockIcon className="size-3.5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-semibold text-foreground">{item.title}{item.tone === "warning" && <span aria-hidden className="size-1.5 rounded-full bg-warning text-warning sk-pulse" />}</span>
              <span className="block text-xs text-muted-foreground">{item.detail}</span>
              <span className="mt-1.5 flex items-center gap-1 text-xs font-semibold text-foreground">{item.cta}<ArrowUpRightIcon aria-hidden className="size-3.5 transition-transform duration-150 group-hover/att:translate-x-0.5 group-hover/att:-translate-y-0.5" /></span>
            </span>
          </Link>
        </li>)}
      </ul>}
  </ListCard>;
}
