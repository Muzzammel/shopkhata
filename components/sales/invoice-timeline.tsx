import { CircleCheckIcon, CircleDotIcon, CircleXIcon, FilePlusIcon, HandCoinsIcon, HistoryIcon, PencilLineIcon, RepeatIcon, type LucideIcon } from "lucide-react";

import { qatarDateTime, type TimelineEvent } from "@/lib/sales-view";
import { cn } from "@/lib/utils";

const ICON: Record<TimelineEvent["kind"], LucideIcon> = { created: FilePlusIcon, payment: HandCoinsIcon, correction: PencilLineIcon, replacement: RepeatIcon, applied: PencilLineIcon };
const STATUS = {
  pending: { label: "Pending approval", icon: CircleDotIcon, className: "bg-warning-soft text-warning" },
  approved: { label: "Approved", icon: CircleCheckIcon, className: "bg-success-soft text-success" },
  rejected: { label: "Rejected", icon: CircleXIcon, className: "bg-muted text-muted-foreground" },
} as const;

/** The invoice's full history, collapsed by default. Read-only: decisions are taken in "Awaiting approval". */
export function InvoiceTimeline({ events, open = false }: { events: TimelineEvent[]; open?: boolean }) {
  return <section aria-labelledby="history-heading" data-print="hide" className="rounded-3xl border border-border bg-card">
    <details className="group/history" open={open || undefined}>
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-3xl px-5 sk-press [&::-webkit-details-marker]:hidden sm:px-6">
        <span className="flex items-center gap-2.5">
          <HistoryIcon aria-hidden className="size-4 text-muted-foreground" />
          <h2 id="history-heading" data-slot="heading" className="text-base font-semibold">History</h2>
          <span className="text-xs text-muted-foreground tabular-nums">{events.length} event{events.length === 1 ? "" : "s"}</span>
        </span>
        <span aria-hidden className="text-muted-foreground transition-transform duration-200 group-open/history:rotate-180">⌄</span>
      </summary>
      <ol className="grid list-none gap-0 px-5 pb-6 pl-5 sm:px-6">
        {events.map((event, index) => {
          const Icon = ICON[event.kind];
          const status = event.status ? STATUS[event.status] : null;
          return <li key={event.id} data-event={event.kind} className="relative grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 pb-5 last:pb-0">
            {index < events.length - 1 && <span aria-hidden className="absolute top-8 bottom-0 left-4 w-px bg-border" />}
            <span className="grid size-8 place-items-center rounded-full border border-border bg-muted"><Icon aria-hidden className="size-4 text-foreground" /></span>
            <div className="grid min-w-0 gap-1.5 pt-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3 data-slot="heading" className="text-[15px] font-semibold tracking-tight">{event.title}</h3>
                {status && <span className={cn("inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-semibold", status.className)}><status.icon aria-hidden className="size-3" />{status.label}</span>}
                {event.version !== undefined && <span className="text-[11px] font-medium text-muted-foreground">Version {event.version}</span>}
              </div>
              <p className="text-xs text-muted-foreground">{event.kind === "applied" ? "Approved by" : event.kind === "created" || event.kind === "payment" ? "By" : "Requested by"} {event.actor} · <time dateTime={event.at}>{qatarDateTime(event.at)}</time></p>
              {/* Labels share one column and values one right-aligned column, across every row. */}
              {event.changes.length > 0 && <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-xl bg-muted/60 px-3 py-2 text-[13px] tabular-nums">
                {event.changes.map((change) => <div key={change.label} className="col-span-2 grid grid-cols-subgrid items-baseline">
                  <dt className="text-muted-foreground">{change.label}</dt>
                  <dd className="flex flex-wrap items-baseline justify-end gap-x-2 text-right font-semibold [overflow-wrap:anywhere]">{change.from !== undefined && <><span className="font-normal text-muted-foreground line-through decoration-1">{change.from}</span><span aria-label="changed to" className="text-muted-foreground">→</span></>}<span>{change.to}</span></dd>
                </div>)}
              </dl>}
              {event.reason && <p className="text-[13px]"><span className="text-muted-foreground">Reason: </span>{event.reason}</p>}
              {event.decidedAt && <div className={cn("mt-1 grid gap-0.5 border-l-2 py-0.5 pl-3", event.status === "approved" ? "border-success/50" : "border-border")}>
                <p className="text-[13px] font-semibold">{event.status === "approved" ? "Approved" : "Rejected"}</p>
                <p className="text-xs text-muted-foreground">By {event.decidedBy} · <time dateTime={event.decidedAt}>{qatarDateTime(event.decidedAt)}</time></p>
                {event.decisionReason && <p className="text-[13px]"><span className="text-muted-foreground">Decision reason: </span>{event.decisionReason}</p>}
              </div>}
            </div>
          </li>;
        })}
      </ol>
    </details>
  </section>;
}
