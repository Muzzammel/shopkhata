"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { ArrowRightIcon, BadgeCheckIcon, FilePlusIcon, HandCoinsIcon, PencilLineIcon, ReceiptTextIcon, UserPlusIcon, WalletIcon, type LucideIcon } from "lucide-react";

import { SalesTable } from "@/components/sales/sales-table";
import { ui } from "@/components/sales/ui";
import { qar } from "@/lib/dashboard-view";
import { CUSTOMER_TABS, type ActivityEvent, type ActivityKind, type CustomerCredit, type CustomerInvoice, type CustomerTab, type PaymentGroup } from "@/lib/customer-view";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { paymentMethodLabel } from "@/lib/payment-method";
import type { InvoiceListRow } from "@/lib/invoice-list";
import { longDate, personLabel, qatarDateTime, signedQar } from "@/lib/sales-view";
import { cn } from "@/lib/utils";

const TAB_LABEL: Record<CustomerTab, string> = { overview: "Overview", invoices: "Invoices", payments: "Payments", credits: "Credits", activity: "Activity" };

type CreditUse = { id: string; invoiceId: string; invoiceNumber: string; amountDirham: number; businessDate: string; recordedAt: string; actorId: string | null };

export type CustomerTabsProps = {
  shopId: string; initialTab: CustomerTab; people: Record<string, string>;
  invoices: InvoiceListRow[]; openInvoices: CustomerInvoice[]; payments: PaymentGroup[];
  credits: CustomerCredit[]; creditUses: CreditUse[]; creditDirham: number; invoiceNumbers: Record<string, string>;
  activity: ActivityEvent[];
  details: { publicId: string; mobile: string | null; shopName: string; createdAt: string; createdBy: string | null };
};

const card = "rounded-3xl border border-border bg-card";
const Heading = ({ id, children, aside }: { id: string; children: ReactNode; aside?: ReactNode }) => <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
  <h2 id={id} data-slot="heading" className="text-base font-semibold tracking-tight">{children}</h2>{aside}
</div>;
const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-2xl bg-muted/60 px-4 py-6 text-center text-sm text-muted-foreground">{children}</p>;

/**
 * Overview, Invoices, Payments, Credits and Activity over data the page has already read: switching
 * tabs fetches nothing. The chosen tab is mirrored into ?tab= so a reload or a shared link keeps it.
 */
export function CustomerTabs(props: CustomerTabsProps) {
  const [tab, setTab] = useState<CustomerTab>(props.initialTab);
  const choose = (next: string) => {
    setTab(next as CustomerTab);
    const url = new URL(window.location.href);
    if (next === "overview") url.searchParams.delete("tab"); else url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url);
  };
  const counts: Partial<Record<CustomerTab, number>> = { invoices: props.invoices.length, payments: props.payments.length, credits: props.credits.length };
  const panel = "grid gap-4 outline-none data-[state=active]:sk-enter";

  return <TabsPrimitive.Root value={tab} onValueChange={choose} className="grid gap-4">
    <TabsPrimitive.List aria-label="Customer sections" className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
      {CUSTOMER_TABS.map((key) => <TabsPrimitive.Trigger key={key} value={key} data-slot="tab" className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-semibold whitespace-nowrap text-muted-foreground sk-press outline-offset-2 hover:bg-muted hover:text-foreground data-[state=active]:bg-primary data-[state=active]:text-primary-foreground max-sm:min-h-11">
        {TAB_LABEL[key]}{counts[key] !== undefined && <span className="text-xs font-medium tabular-nums opacity-70">{counts[key]}</span>}
      </TabsPrimitive.Trigger>)}
    </TabsPrimitive.List>

    <TabsPrimitive.Content value="overview" className={panel}><Overview {...props} onShow={choose} /></TabsPrimitive.Content>
    <TabsPrimitive.Content value="invoices" className={panel}>
      {props.invoices.length === 0 ? <Empty>No invoices for this customer yet.</Empty> : <SalesTable rows={props.invoices} shopId={props.shopId} showCustomer={false} />}
    </TabsPrimitive.Content>
    <TabsPrimitive.Content value="payments" className={panel}><Payments {...props} /></TabsPrimitive.Content>
    <TabsPrimitive.Content value="credits" className={panel}><Credits {...props} /></TabsPrimitive.Content>
    <TabsPrimitive.Content value="activity" className={panel}>
      <section aria-labelledby="activity-heading" className={cn(card, "grid gap-4 p-5 sm:p-6")}>
        <Heading id="activity-heading" aside={<span className="text-xs text-muted-foreground">Newest first · balance shown after each ledger event</span>}>Activity</Heading>
        <ActivityTimeline events={props.activity} people={props.people} shopId={props.shopId} />
      </section>
    </TabsPrimitive.Content>
  </TabsPrimitive.Root>;
}

const invoiceLink = (shopId: string, id: string, number: string) => <Link key={id} href={`/shops/${shopId}/invoices/${id}`} className="font-semibold text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">{number}</Link>;

function Overview({ shopId, openInvoices, activity, people, details, onShow }: CustomerTabsProps & { onShow: (tab: CustomerTab) => void }) {
  const more = "inline-flex min-h-9 items-center gap-1 rounded-full px-2 text-[13px] font-semibold text-muted-foreground sk-press hover:text-foreground";
  return <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
    <section aria-labelledby="open-heading" className={cn(card, "grid content-start gap-3 p-5 sm:p-6")}>
      <Heading id="open-heading" aside={<span className="text-xs text-muted-foreground">Payments settle the oldest first</span>}>Open invoices</Heading>
      {openInvoices.length === 0 ? <Empty>No invoice has an outstanding due.</Empty> : <ul className="grid list-none divide-y divide-border pl-0">
        {openInvoices.slice(0, 6).map((invoice) => <li key={invoice.invoiceId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5 text-sm first:pt-0 last:pb-0">
          <span className="min-w-0">{invoiceLink(shopId, invoice.invoiceId, invoice.invoiceNumber)} <span className="text-muted-foreground">· {longDate(invoice.businessDate)} · of {qar(invoice.totalDirham)}</span></span>
          <strong className="font-semibold text-warning tabular-nums">{qar(invoice.dueDirham)}</strong>
        </li>)}
      </ul>}
      {openInvoices.length > 6 && <button type="button" data-slot="button" className={cn(more, "justify-self-start")} onClick={() => onShow("invoices")}>All {openInvoices.length} open invoices <ArrowRightIcon aria-hidden className="size-3.5" /></button>}
    </section>
    <section aria-labelledby="recent-heading" className={cn(card, "grid content-start gap-3 p-5 sm:p-6")}>
      <Heading id="recent-heading">Recent activity</Heading>
      <ActivityTimeline events={activity.slice(0, 4)} people={people} shopId={shopId} compact />
      {activity.length > 4 && <button type="button" data-slot="button" className={cn(more, "justify-self-start")} onClick={() => onShow("activity")}>All activity <ArrowRightIcon aria-hidden className="size-3.5" /></button>}
    </section>
    <section aria-labelledby="details-heading" className={cn(card, "grid gap-3 p-5 sm:p-6 lg:col-span-2")}>
      <Heading id="details-heading">Details</Heading>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Customer ID</dt><dd className="font-semibold">{details.publicId}</dd></div>
        <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Mobile</dt><dd className="font-semibold">{details.mobile || <span className="font-normal text-muted-foreground">No mobile number</span>}</dd></div>
        <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Shop</dt><dd className="font-semibold">{details.shopName}</dd></div>
        <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Added</dt><dd className="font-semibold">{qatarDateTime(details.createdAt)} <span className="block text-xs font-normal text-muted-foreground">by {personLabel(people, details.createdBy)}</span></dd></div>
      </dl>
    </section>
  </div>;
}

function Payments({ shopId, payments, people }: CustomerTabsProps) {
  return <section aria-labelledby="payments-heading" className={cn(card, "grid gap-4 p-5 sm:p-6")}>
    <Heading id="payments-heading" aside={<span className="text-xs text-muted-foreground">Newest first · credit applications are under Credits</span>}>Payments</Heading>
    {payments.length === 0 ? <Empty>No payments recorded for this customer.</Empty> : <ul className="grid list-none divide-y divide-border pl-0">
      {payments.map((payment) => {
        const cash = payment.kind !== "correction";
        const method = paymentMethodLabel(payment.method);
        const title = payment.kind === "payment" ? `${method} payment` : payment.kind === "overpayment" ? "Overpayment kept as credit" : "Payment correction (approved)";
        return <li key={payment.id} data-payment={payment.kind} className="grid gap-2 py-4 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="flex min-w-0 items-center gap-2.5">
              <span className={cn("grid size-8 shrink-0 place-items-center rounded-full", cash ? "bg-success-soft text-success" : "bg-yellow-soft text-foreground")}>{cash ? <HandCoinsIcon aria-hidden className="size-4" /> : <PencilLineIcon aria-hidden className="size-4" />}</span>
              <span className="grid min-w-0">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-semibold">{title}{payment.method && <span data-payment-method={payment.method} className={cn(ui.badge, "bg-muted text-foreground")}>{method}</span>}</span>
                <span className="text-xs text-muted-foreground">Business date {longDate(payment.businessDate)} · <time dateTime={payment.recordedAt}>{qatarDateTime(payment.recordedAt)}</time> · by {personLabel(people, payment.actorId)}</span>
              </span>
            </span>
            <strong className={cn("text-lg font-semibold tabular-nums", cash ? "text-success" : "text-foreground")}>{cash ? qar(payment.amountDirham) : signedQar(payment.amountDirham)}{payment.kind === "overpayment" && <span className="block text-right text-xs font-medium text-muted-foreground">applied to invoice</span>}</strong>
          </div>
          <div className="ml-[2.625rem] grid gap-1 text-[13px]">
            <span className="text-muted-foreground">{payment.kind === "correction" ? "On invoice" : payment.allocations.length > 1 ? `Allocated across ${payment.allocations.length} invoices, oldest first:` : "Applied to"}</span>
            <ul className="flex list-none flex-wrap gap-1.5 pl-0">{payment.allocations.map((share, index) => <li key={`${share.invoiceId}-${index}`} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 tabular-nums">{invoiceLink(shopId, share.invoiceId, share.invoiceNumber)}<span className="text-muted-foreground">{cash ? qar(share.amountDirham) : signedQar(share.amountDirham)}</span></li>)}</ul>
            {payment.creditDirham !== undefined && <span className="tabular-nums"><strong className="font-semibold">{qar(payment.creditDirham)}</strong> <span className="text-muted-foreground">kept as customer credit, not counted as paid</span></span>}
            <span className="text-xs text-muted-foreground tabular-nums">Customer due after: {qar(payment.balanceAfterDirham)}</span>
          </div>
        </li>;
      })}
    </ul>}
  </section>;
}

function Credits({ shopId, credits, creditUses, creditDirham, invoiceNumbers, people }: CustomerTabsProps) {
  const issued = credits.reduce((sum, credit) => sum + credit.amountDirham, 0);
  const used = credits.reduce((sum, credit) => sum + credit.usedDirham, 0);
  return <section aria-labelledby="credits-heading" className={cn(card, "grid gap-5 p-5 sm:p-6")}>
    <Heading id="credits-heading" aside={<span className="text-xs text-muted-foreground">Credit is held for the customer and can only settle their due. It is not counted as paid.</span>}>Credits</Heading>
    <dl className="grid grid-cols-3 gap-3 text-sm tabular-nums">
      <div className="grid gap-0.5 rounded-2xl bg-muted p-3"><dt className="text-xs text-muted-foreground">Issued</dt><dd className="font-semibold">{qar(issued)}</dd></div>
      <div className="grid gap-0.5 rounded-2xl bg-muted p-3"><dt className="text-xs text-muted-foreground">Applied</dt><dd className="font-semibold">{qar(used)}</dd></div>
      <div className="grid gap-0.5 rounded-2xl p-3 ring-1 ring-success/40 ring-inset"><dt className="text-xs text-muted-foreground">Available</dt><dd className="font-semibold">{qar(creditDirham)}</dd></div>
    </dl>
    {credits.length === 0 ? <Empty>No approved credit has been issued to this customer.</Empty> : <div className="grid gap-2">
      <h3 data-slot="heading" className="text-sm font-semibold">Credit issued</h3>
      <ul className="grid list-none divide-y divide-border pl-0">{credits.map((credit) => <li key={credit.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 text-sm first:pt-0 last:pb-0">
        <span className="grid min-w-0 gap-0.5">
          <span className="font-semibold">{credit.reason || "Approved overpayment"}</span>
          <span className="text-xs text-muted-foreground">{longDate(credit.businessDate)} · approved by {personLabel(people, credit.approvedBy)}{credit.sourceInvoiceId && <> · from {invoiceLink(shopId, credit.sourceInvoiceId, invoiceNumbers[credit.sourceInvoiceId] ?? "source invoice")}</>}</span>
        </span>
        <span className="grid text-right tabular-nums">
          <strong className="font-semibold">{qar(credit.amountDirham)}</strong>
          <span className="text-xs text-muted-foreground">Used {qar(credit.usedDirham)} · remaining {qar(credit.amountDirham - credit.usedDirham)}</span>
        </span>
      </li>)}</ul>
    </div>}
    {creditUses.length > 0 && <div className="grid gap-2">
      <h3 data-slot="heading" className="text-sm font-semibold">Credit applied to invoices</h3>
      <ul className="grid list-none divide-y divide-border pl-0">{creditUses.map((use) => <li key={use.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 text-sm first:pt-0 last:pb-0">
        <span className="min-w-0">{invoiceLink(shopId, use.invoiceId, use.invoiceNumber)} <span className="text-xs text-muted-foreground">· {longDate(use.businessDate)} · by {personLabel(people, use.actorId)}</span></span>
        <strong className="font-semibold tabular-nums">{qar(use.amountDirham)}</strong>
      </li>)}</ul>
    </div>}
  </section>;
}

const ICON: Record<ActivityKind, LucideIcon> = { customer: UserPlusIcon, invoice: FilePlusIcon, payment: HandCoinsIcon, invoice_correction: PencilLineIcon, payment_correction: PencilLineIcon, credit_issued: BadgeCheckIcon, credit_application: WalletIcon };

export function ActivityTimeline({ events, people, shopId, compact = false }: { events: ActivityEvent[]; people: Record<string, string>; shopId: string; compact?: boolean }) {
  if (events.length === 0) return <Empty>No activity recorded.</Empty>;
  return <ol className="grid list-none gap-0 pl-0">
    {events.map((event, index) => {
      const Icon = ICON[event.kind] ?? ReceiptTextIcon;
      const effect = event.dueEffectDirham;
      return <li key={event.id} data-activity={event.kind} className={cn("relative grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 last:pb-0", compact ? "pb-4" : "pb-5")}>
        {index < events.length - 1 && <span aria-hidden className="absolute top-8 bottom-0 left-4 w-px bg-border" />}
        <span className={cn("grid size-8 place-items-center rounded-full border border-border", event.kind === "payment" ? "bg-success-soft text-success" : "bg-muted text-foreground")}><Icon aria-hidden className="size-4" /></span>
        <div className="grid min-w-0 gap-1 pt-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <h3 data-slot="heading" className="text-[15px] font-semibold tracking-tight">{event.title}</h3>
            {effect !== undefined ? <span className={cn("text-sm font-semibold tabular-nums", effect < 0 ? "text-success" : "text-foreground")}><span className="sr-only">{effect < 0 ? "Due reduced by" : "Due increased by"} </span>{signedQar(effect)}</span>
              : event.amountDirham !== undefined && <span className="text-sm font-semibold tabular-nums">{qar(event.amountDirham)}<span className="text-xs font-normal text-muted-foreground"> credit</span></span>}
          </div>
          {event.invoices.length > 0 && <p className="text-[13px] text-muted-foreground">{event.invoices.length > 1 ? "Invoices " : "Invoice "}{event.invoices.map((invoice, i) => <span key={`${invoice.invoiceId}-${i}`}>{i > 0 && ", "}{invoiceLink(shopId, invoice.invoiceId, invoice.invoiceNumber)}</span>)}{event.note && ` · ${event.note}`}</p>}
          {event.invoices.length === 0 && event.note && <p className="text-[13px] text-muted-foreground">{event.note}</p>}
          <p className="text-xs text-muted-foreground">By {personLabel(people, event.actorId)} · <time dateTime={event.recordedAt}>{qatarDateTime(event.recordedAt)}</time>{event.businessDate !== qatarBusinessDate(new Date(event.recordedAt)) && !compact && ` · business date ${longDate(event.businessDate)}`}{event.balanceAfterDirham !== undefined && !compact && <> · <span className="tabular-nums">due after {qar(event.balanceAfterDirham)}</span></>}</p>
        </div>
      </li>;
    })}
  </ol>;
}
