import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon, DownloadIcon } from "lucide-react";

import { BalanceBadges, CustomerAvatar } from "@/components/customers/customer-status";
import { CustomerDetailSkeleton } from "@/components/customers/customer-detail-skeleton";
import { CustomerSummary } from "@/components/customers/customer-summary";
import { CustomerTabs } from "@/components/customers/customer-tabs";
import { ui } from "@/components/sales/ui";
import { can, getCurrentActor, type Actor } from "@/lib/auth/permissions";
import { readCustomerDetail } from "@/lib/customer-detail";
import { balanceStatuses, buildActivity, CUSTOMER_TABS, customerTotals, groupPayments, type CustomerTab } from "@/lib/customer-view";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { getReadableShops, shopViewer } from "@/lib/shop-switching";
import { longDate } from "@/lib/sales-view";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { CustomerPaymentPanel } from "../../customer-payment-panel";

export default async function CustomerDetailPage({ params, searchParams }: PageProps<"/customers/[customerId]">) {
  const [{ customerId }, query] = await Promise.all([params, searchParams]);
  const actor = await getCurrentActor();
  const shopId = (Array.isArray(query.shop) ? query.shop[0] : query.shop) ?? actor.shopIds[0];
  if (!shopId || !can(actor, "records.view_assigned", shopId)) notFound();
  // Decided before anything streams, so a customer outside the actor's shops is still a real 404.
  const supabase = await createServerSupabaseClient();
  // An inactive shop opens read-only, and only for an owner; anyone else gets a 404 as for any other unreadable shop.
  const { data: shopRow } = await supabase.from("shops").select("id,name,is_active").eq("id", shopId).maybeSingle();
  const shop = shopRow ? getReadableShops(actor, [shopRow])[0] : undefined;
  if (!shop) notFound();
  const { data: exists, error } = await supabase.from("customers").select("id").eq("shop_id", shopId).eq("id", customerId).maybeSingle();
  if (error || !exists) notFound();
  const rawTab = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  const initialTab: CustomerTab = CUSTOMER_TABS.find((tab) => tab === rawTab) ?? "overview";

  return <main className="mx-auto grid w-full max-w-[1100px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6">
    <Link href={`/customers?shop=${shopId}`} className="inline-flex min-h-9 items-center gap-1.5 justify-self-start rounded-full px-1 text-[13px] font-semibold text-muted-foreground no-underline hover:text-foreground"><ArrowLeftIcon aria-hidden className="size-4" />Customers</Link>
    <Suspense fallback={<CustomerDetailSkeleton />}><CustomerDetailBody actor={shopViewer(actor, shop)} shopId={shopId} customerId={customerId} initialTab={initialTab} /></Suspense>
  </main>;
}

async function CustomerDetailBody({ actor, shopId, customerId, initialTab }: { actor: Actor; shopId: string; customerId: string; initialTab: CustomerTab }) {
  const detail = await readCustomerDetail(actor, shopId, customerId);
  if (!detail) notFound();
  const name = detail.customer.name || "Unnamed customer";
  const totals = customerTotals(detail.invoices);
  // Oldest first: the order record_customer_payment settles them in.
  const openInvoices = detail.invoices.filter((invoice) => invoice.dueDirham > 0).sort((a, b) => a.businessDate.localeCompare(b.businessDate) || a.invoiceId.localeCompare(b.invoiceId));
  const invoiceNumbers = Object.fromEntries(detail.invoices.map((invoice) => [invoice.invoiceId, invoice.invoiceNumber]));
  const creditUses = detail.ledger.filter((entry) => entry.type === "credit_application").reverse().map((entry) => ({
    id: entry.sequenceId, invoiceId: entry.invoiceId, invoiceNumber: entry.invoiceNumber ?? entry.reference, amountDirham: entry.creditDirham,
    businessDate: entry.businessDate, recordedAt: entry.recordedAt, actorId: entry.actorName,
  }));

  return <>
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 rounded-3xl border border-border bg-card p-5 sk-enter sm:p-6">
      <div className="flex min-w-0 items-start gap-4">
        <CustomerAvatar name={name} className="size-14 text-lg max-sm:size-12 max-sm:text-base" />
        <div className="grid min-w-0 gap-1.5">
          <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Customer · {detail.shopName}</p>
          <h1 data-slot="heading" className="text-3xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-4xl">{name}</h1>
          <p className="text-sm text-muted-foreground">{detail.customer.mobile || "No mobile number"} · {detail.customer.publicId}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <BalanceBadges states={balanceStatuses({ dueDirham: detail.dueDirham, creditDirham: detail.creditDirham })} />
            <span className="text-xs text-muted-foreground">Last activity {detail.lastActivityDate ? longDate(detail.lastActivityDate) : "—"}</span>
          </div>
        </div>
      </div>
      <div className="flex w-full flex-wrap gap-2 sm:w-auto">
        {can(actor, "payment.record", shopId) && detail.dueDirham > 0 && <CustomerPaymentPanel shopId={shopId} customerId={customerId} customerName={name}
          invoices={openInvoices.map(({ invoiceId, invoiceNumber, businessDate, dueDirham }) => ({ invoiceId, invoiceNumber, businessDate, dueDirham }))}
          dueDirham={detail.dueDirham} availableCreditDirham={detail.creditDirham} businessDate={qatarBusinessDate(new Date())} className="max-sm:flex-1" />}
        <a href={`/exports/customer-ledger?shop=${shopId}&customer=${customerId}`} aria-label="Export ledger (.xlsx)" className={cn(ui.secondary, "max-sm:flex-1")}><DownloadIcon aria-hidden />Export ledger</a>
      </div>
    </header>

    <CustomerSummary salesDirham={totals.salesDirham} paidDirham={totals.paidDirham} creditAppliedDirham={totals.creditAppliedDirham} dueDirham={detail.dueDirham} creditDirham={detail.creditDirham} invoiceCount={detail.invoiceCount} />

    <CustomerTabs shopId={shopId} initialTab={initialTab} people={detail.people}
      invoices={detail.invoices.map((invoice) => ({ ...invoice, recordedAt: null, customerId, customerName: name }))}
      openInvoices={openInvoices} payments={groupPayments(detail.ledger, detail.paymentMeta, detail.credits)}
      credits={detail.credits} creditUses={creditUses} creditDirham={detail.creditDirham} invoiceNumbers={invoiceNumbers}
      activity={buildActivity({ ledger: detail.ledger, meta: detail.paymentMeta, credits: detail.credits, customerCreatedAt: detail.customer.createdAt, customerCreatedBy: detail.customer.createdBy })}
      details={{ publicId: detail.customer.publicId, mobile: detail.customer.mobile, shopName: detail.shopName, createdAt: detail.customer.createdAt, createdBy: detail.customer.createdBy }} />
  </>;
}
