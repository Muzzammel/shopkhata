import { InvoiceOperations } from "../../../../invoice-operations";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can, getCurrentActor } from "@/lib/auth/permissions";
import { readInvoiceDetail } from "@/lib/invoice-detail";
import { formatQar } from "@/lib/domain/money";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import styles from "../../../../invoice-entry.module.css";

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Qatar",
  }).format(new Date(value));
}

function actorLabel(name: string | null, id: string | null) {
  return name ?? id ?? "Unknown";
}

export default async function InvoiceDetailPage({ params }: PageProps<"/shops/[shopId]/invoices/[invoiceId]">) {
  const { shopId, invoiceId } = await params;
  const actor = await getCurrentActor();
  const detail = await readInvoiceDetail(actor, shopId, invoiceId);
  if (!detail) notFound();
  const supabase = await createServerSupabaseClient();
  const { data: shop, error } = await supabase.from("shops").select("id, name").eq("id", shopId).maybeSingle();
  if (error || !shop) notFound();

  return <main className={styles.workspace}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>{shop.name}</p><h1>Invoice detail</h1></div>
      <Link href={`/?shop=${shopId}`}>Back to invoices</Link>
    </header>
    <section className={styles.panel} aria-labelledby="invoice-heading">
      <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>Saved invoice</p><h2 id="invoice-heading">{detail.invoiceNumber}</h2></div><p>{detail.delivered ? "Delivered" : "Advance"}</p></div>
      <dl className={styles.detailGrid}>
        <div><dt>Canonical invoice UUID</dt><dd>{detail.id}</dd></div>
        <div><dt>Effective invoice number</dt><dd>{detail.invoiceNumber}</dd></div>
        <div><dt>Original invoice number</dt><dd>{detail.originalInvoiceNumber}</dd></div>
        <div><dt>Original total</dt><dd>QAR {formatQar(detail.originalTotalDirham)}</dd></div>
        <div><dt>Business date</dt><dd>{detail.businessDate}</dd></div>
        <div><dt>Recorded at (Qatar)</dt><dd>{formatTimestamp(detail.recordedAt)}</dd></div>
        <div><dt>Created by</dt><dd>{actorLabel(detail.creatorName, detail.createdBy)}</dd></div>
        <div><dt>Customer</dt><dd>{detail.customer ? <><Link href={`/customers/${detail.customer.id}?shop=${shopId}`}>{detail.customer.name ?? "Unnamed customer"} · {detail.customer.publicId}</Link>{detail.customer.mobile ? ` · ${detail.customer.mobile}` : ""}</> : "No customer"}</dd></div>
        <div><dt>Delivery status</dt><dd>{detail.delivered ? "Delivered" : "Advance / not delivered"}</dd></div>
      </dl>
      <div className={`${styles.totals} ${styles.detailTotals}`}>
        <span>Effective total<strong>QAR {formatQar(detail.effectiveTotalDirham)}</strong></span>
        <span>Effective paid<strong>QAR {formatQar(detail.effectivePaidDirham)}</strong></span>
        <span>Customer credit applied<strong>QAR {formatQar(detail.effectiveCreditAppliedDirham)}</strong></span>
        <span>Effective due<strong>QAR {formatQar(detail.effectiveDueDirham)}</strong></span>
      </div>
    </section>

    <InvoiceOperations detail={detail} permissions={{ payment: can(actor, "payment.record", shopId), requestCorrection: can(actor, "correction.request", shopId), requestReplacement: can(actor, "invoice.replacement.request", shopId), approveCorrection: can(actor, "correction.approve", shopId), approveReplacement: can(actor, "invoice.replacement.approve", shopId) }} />

    <section className={styles.panel} aria-labelledby="payment-history-heading">
      <h2 id="payment-history-heading">Payment history</h2>
      {detail.payments.length === 0 ? <p>No payments recorded.</p> : <div className={styles.detailList}>
        {detail.payments.map((payment) => <article key={payment.id}>
          <strong>QAR {formatQar(payment.amountDirham)} · {payment.paymentMethod}</strong>
          <span>Business date {payment.businessDate} · recorded {formatTimestamp(payment.recordedAt)}</span>
          <span>Payment UUID {payment.id}</span>
          <span>Recorded by {actorLabel(payment.creatorName, payment.createdBy)}</span>
        </article>)}
      </div>}
    </section>

    <section className={styles.panel} aria-labelledby="correction-history-heading">
      <h2 id="correction-history-heading">Approved financial corrections</h2>
      {detail.corrections.length === 0 ? <p>No approved financial corrections.</p> : <div className={styles.detailList}>
        {detail.corrections.map((correction) => <article key={correction.id}>
          <strong>{correction.paymentId ? "Payment correction" : "Invoice correction"} · {correction.amountDeltaDirham < 0 ? "−" : "+"}QAR {formatQar(Math.abs(correction.amountDeltaDirham))}</strong>
          <span>{correction.reason}</span>
          <span>Business date {correction.businessDate} · recorded {formatTimestamp(correction.recordedAt)}</span>
          <span>Approved by {actorLabel(correction.actorName, correction.actorId)}</span>
        </article>)}
      </div>}
    </section>
  </main>;
}
