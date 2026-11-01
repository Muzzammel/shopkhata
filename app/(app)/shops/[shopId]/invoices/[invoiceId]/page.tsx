import { InvoiceOperations } from "../../../../invoice-operations";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";

import { InvoiceBadges } from "@/components/sales/invoice-badges";
import { InvoiceTimeline } from "@/components/sales/invoice-timeline";
import { ui } from "@/components/sales/ui";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { groupedQar, qar } from "@/lib/dashboard-view";
import { readInvoiceDetail } from "@/lib/invoice-detail";
import { paymentMethodLabel } from "@/lib/payment-method";
import { getReadableShops, shopViewer } from "@/lib/shop-switching";
import { buildTimeline, invoiceBadges, longDate, personLabel, qatarDateTime } from "@/lib/sales-view";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export default async function InvoiceDetailPage({ params }: PageProps<"/shops/[shopId]/invoices/[invoiceId]">) {
  const { shopId, invoiceId } = await params;
  const user = await getCurrentActor();
  const supabase = await createServerSupabaseClient();
  // An inactive shop opens read-only, and only for an owner; anyone else gets a 404 as for any other unreadable shop.
  const { data: shopRow } = await supabase.from("shops").select("id,name,is_active").eq("id", shopId).maybeSingle();
  const shop = shopRow ? getReadableShops(user, [shopRow])[0] : undefined;
  if (!shop) notFound();
  const actor = shopViewer(user, shop);
  const detail = await readInvoiceDetail(actor, shopId, invoiceId);
  if (!detail) notFound();

  const corrected = detail.corrections.length > 0;
  const badges = invoiceBadges({ dueDirham: detail.effectiveDueDirham, delivered: detail.delivered, corrected, revision: detail.revision });
  const customerHref = detail.customer ? `/customers/${detail.customer.id}?shop=${shopId}` : null;
  const figure = "grid content-start gap-1 rounded-2xl p-4";

  return <main className="mx-auto grid w-full max-w-[1100px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6 print:max-w-none print:p-0">
    <Link href={`/invoices?shop=${shopId}`} data-print="hide" className="inline-flex min-h-9 items-center gap-1.5 justify-self-start rounded-full px-1 text-[13px] font-semibold text-muted-foreground no-underline hover:text-foreground"><ArrowLeftIcon aria-hidden className="size-4" />Sales</Link>

    <InvoiceOperations detail={detail} permissions={{ payment: can(actor, "payment.record", shopId), requestCorrection: can(actor, "correction.request", shopId), requestReplacement: can(actor, "invoice.replacement.request", shopId), approveCorrection: can(actor, "correction.approve", shopId), approveReplacement: can(actor, "invoice.replacement.approve", shopId) }} />

    <section aria-labelledby="invoice-heading" data-print="document" className="grid gap-6 rounded-3xl border border-border bg-card p-5 sk-enter sm:p-8 print:border-0 print:p-0">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="grid gap-1.5">
          <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Invoice · {shop.name}</p>
          <h1 id="invoice-heading" data-slot="heading" className="text-3xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-4xl">{detail.invoiceNumber}</h1>
          <InvoiceBadges badges={badges} />
        </div>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:text-right">
          <div><dt className="text-xs text-muted-foreground">Business date</dt><dd className="font-semibold">{longDate(detail.businessDate)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Recorded (Qatar)</dt><dd className="font-semibold">{qatarDateTime(detail.recordedAt)}</dd></div>
        </dl>
      </header>

      <div className="grid grid-cols-2 gap-3 tabular-nums lg:grid-cols-4" aria-label="Financial summary" role="group">
        <div className={cn(figure, "bg-ink text-ink-foreground print:bg-transparent print:text-foreground print:ring-1 print:ring-border")}>
          <span className="text-xs text-ink-muted print:text-muted-foreground">Invoice total</span>
          <strong className="text-2xl font-semibold tracking-tight sm:text-3xl"><span className="text-xs font-medium opacity-65">QAR</span> {groupedQar(detail.effectiveTotalDirham)}</strong>
          {detail.effectiveTotalDirham !== detail.originalTotalDirham && <span className="text-xs text-ink-muted print:text-muted-foreground">Recorded as {qar(detail.originalTotalDirham)}</span>}
        </div>
        <div className={cn(figure, "bg-muted")}>
          <span className="text-xs text-muted-foreground">Received</span>
          <strong className="text-2xl font-semibold tracking-tight sm:text-3xl"><span className="text-xs font-medium opacity-65">QAR</span> {groupedQar(detail.effectivePaidDirham)}</strong>
          {detail.effectiveCreditAppliedDirham > 0 && <span className="text-xs text-muted-foreground">+ {qar(detail.effectiveCreditAppliedDirham)} customer credit applied</span>}
        </div>
        <div className={cn(figure, detail.effectiveDueDirham > 0 ? "bg-warning-soft" : "bg-success-soft")}>
          <span className="text-xs text-muted-foreground">Outstanding due</span>
          <strong className={cn("text-2xl font-semibold tracking-tight sm:text-3xl", detail.effectiveDueDirham > 0 ? "text-warning" : "text-success")}><span className="text-xs font-medium opacity-65">QAR</span> {groupedQar(detail.effectiveDueDirham)}</strong>
          <span className="text-xs text-muted-foreground">{detail.effectiveDueDirham > 0 ? "Still to collect" : "Nothing left to collect"}</span>
        </div>
        <div className={cn(figure, "bg-muted")}>
          <span className="text-xs text-muted-foreground">Delivery</span>
          <strong className="text-lg font-semibold">{detail.delivered ? "Delivered" : "Not delivered"}</strong>
          <span className="text-xs text-muted-foreground">{detail.delivered ? "Goods handed over" : "Advance — goods not handed over yet"}</span>
        </div>
      </div>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-border pt-5 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Customer</dt><dd className="font-semibold [overflow-wrap:anywhere]">{detail.customer && customerHref
          ? <Link href={customerHref} className="text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">{detail.customer.name ?? "Unnamed customer"} · {detail.customer.publicId}</Link>
          : <span className="font-normal text-muted-foreground">No customer</span>}{detail.customer?.mobile && <span className="block text-xs font-normal text-muted-foreground">{detail.customer.mobile}</span>}
          {customerHref && <Link href={customerHref} data-print="hide" className="mt-1 flex min-h-8 w-fit items-center gap-1 text-[13px] font-semibold text-muted-foreground no-underline hover:text-foreground">View customer <ArrowRightIcon aria-hidden className="size-3.5" /></Link>}</dd></div>
        <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Created by</dt><dd className="font-semibold">{personLabel(detail.people, detail.createdBy)}</dd></div>
        <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Shop</dt><dd className="font-semibold">{shop.name}</dd></div>
        {detail.revision > 0 && <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Original invoice number</dt><dd className="font-semibold">{detail.originalInvoiceNumber} <span className="font-normal text-muted-foreground">· now version {detail.revision}</span></dd></div>}
        {detail.effectiveTotalDirham !== detail.originalTotalDirham && <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Original total</dt><dd className="font-semibold tabular-nums">{qar(detail.originalTotalDirham)}</dd></div>}
        <div className="grid gap-0.5 sm:col-span-2 lg:col-span-1"><dt className="text-xs text-muted-foreground">Reference</dt><dd className="font-mono text-xs break-all text-muted-foreground">{detail.id}</dd></div>
      </dl>

      <section aria-labelledby="payment-history-heading" className="grid gap-3 border-t border-border pt-5">
        <h2 id="payment-history-heading" data-slot="heading" className="text-base font-semibold">Payments received</h2>
        {detail.payments.length === 0 ? <p className="text-sm text-muted-foreground">No payments recorded.</p> : <ul className="grid list-none divide-y divide-border pl-0">
          {detail.payments.map((payment) => <li key={payment.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5 text-sm first:pt-0 last:pb-0">
            <span className="min-w-0"><span data-payment-method={payment.paymentMethod} className={cn(ui.badge, "mr-1 bg-muted text-foreground")}>{paymentMethodLabel(payment.paymentMethod)}</span> <span className="text-muted-foreground">· {longDate(payment.businessDate)} · by {personLabel(detail.people, payment.createdBy)}</span></span>
            <strong className="font-semibold tabular-nums">{qar(payment.amountDirham)}</strong>
          </li>)}
        </ul>}
      </section>
    </section>


    <InvoiceTimeline events={buildTimeline(detail)} />
  </main>;
}
