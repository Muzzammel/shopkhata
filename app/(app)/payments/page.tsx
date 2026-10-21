import Link from "next/link";

import { can, getCurrentActor } from "@/lib/auth/permissions";
import { formatQar } from "@/lib/domain/money";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { paymentMethodLabel } from "@/lib/payment-method";
import { fetchPaymentAllocation, fetchPaymentList, PAYMENT_PAGE_SIZE, PAYMENT_SOURCES, parsePaymentListFilter } from "@/lib/payment-list";
import { qatarDateTime } from "@/lib/sales-view";
import { getVisibleShops } from "@/lib/shop-switching";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import { PaymentEntry } from "./payment-entry";
import styles from "@/app/ui.module.css";

const qar = (dirham: number) => `QAR ${formatQar(dirham)}`;
const qatarTime = (iso: string | null) => iso ? qatarDateTime(iso) : "—";
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
/** A customer payment is recorded as one or more rows sharing this reference — the FIFO batch it was split across. */
const isAllocatable = (source: string) => source === "customer_payment";

export default async function PaymentsPage({ searchParams }: PageProps<"/payments">) {
  const actor = await getCurrentActor();
  const query = await searchParams;
  const supabase = await createServerSupabaseClient();
  const { data: allShops, error: shopsError } = await supabase.from("shops").select("id,name,is_active").eq("is_active", true).order("name");
  if (shopsError || !allShops) throw new Error("PAYMENT_LIST_UNAVAILABLE");
  const shops = getVisibleShops(actor, allShops);
  const requestedShop = first(query.shop);
  const shop = shops.find((item) => item.id === requestedShop) ?? shops[0];
  if (!shop || !can(actor, "records.view_assigned", shop.id)) return <main className={styles.workspace}><h1>Payments unavailable</h1></main>;

  const today = qatarBusinessDate(new Date());
  const filter = parsePaymentListFilter(query, today);
  const allocationRef = (first(query.allocation) ?? "").trim();
  const baseQS = `shop=${shop.id}&from=${filter.from}&to=${filter.to}${filter.invoiceQuery ? `&invoice=${encodeURIComponent(filter.invoiceQuery)}` : ""}`;

  const [{ rows, hasMore }, allocation] = await Promise.all([
    fetchPaymentList(supabase, shop.id, filter),
    allocationRef ? fetchPaymentAllocation(supabase, shop.id, allocationRef) : Promise.resolve(null),
  ]);

  return <main className={styles.workspace}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>{shop.name}</p><h1>Payments</h1><p>Default view shows the last 30 days. Search by invoice number to find an older payment.</p></div>
    </header>
    {shops.length > 1 && <nav className={styles.shops} aria-label="Choose shop">{shops.map((item) => <Link key={item.id} aria-current={item.id === shop.id ? "page" : undefined} href={`/payments?shop=${item.id}`}>{item.name}</Link>)}</nav>}

    {can(actor, "payment.record", shop.id) && <PaymentEntry shopId={shop.id} key={shop.id} />}

    <section className={styles.panel}>
      <div className={styles.sectionHeading}><h2>Payment history</h2><p>{shop.name}</p></div>
      <div className={styles.toolbar}>
        <form className={styles.search} action="/payments">
          <input type="hidden" name="shop" value={shop.id} />
          <label>Invoice number<input name="invoice" defaultValue={filter.invoiceQuery} maxLength={120} /></label>
          <label>From<input type="date" name="from" defaultValue={filter.from} max={today} required /></label>
          <label>To<input type="date" name="to" defaultValue={filter.to} max={today} required /></label>
          <button className={styles.secondary}>Show</button>
          <Link className={styles.ghost} href={`/payments?shop=${shop.id}`}>Reset to last 30 days</Link>
        </form>
      </div>
      {filter.invoiceQuery && <p className={styles.muted}>Showing every payment on invoice &quot;{filter.invoiceQuery}&quot; in {shop.name}, regardless of date.</p>}
      {filter.error && <p role="alert">{filter.error} Showing the last 30 days instead.</p>}
      {/* The table scrolls sideways on a phone; the region is focusable so keyboard users can scroll to Method and the rest. */}
      <div className={styles.tableWrap} role="region" aria-label="Payment history table (scrolls sideways on narrow screens)" tabIndex={0}>
        <table>
          <thead><tr><th scope="col">Business date</th><th scope="col">Recorded (Qatar)</th><th scope="col">Type</th><th scope="col">Method</th><th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col" className={styles.num}>Amount</th><th scope="col">Recorded by</th><th scope="col">Allocation</th></tr></thead>
          <tbody>{rows.length === 0 ? <tr><td colSpan={9}>No payments match this search.</td></tr> : rows.map((row) => <tr key={row.entryId}>
            <td>{row.businessDate}</td><td>{qatarTime(row.recordedAt)}</td>
            <td><span className={styles.badge} data-tone={row.source === "payment_correction" ? "warning" : undefined}>{PAYMENT_SOURCES[row.source]}</span></td>
            <td data-payment-method={row.method}>{paymentMethodLabel(row.method)}</td>
            <td>{row.invoiceId ? <Link href={`/shops/${shop.id}/invoices/${row.invoiceId}`}>{row.invoiceNumber}</Link> : "—"}</td>
            <td>{row.customerId ? <Link href={`/customers/${row.customerId}?shop=${shop.id}`}>{row.customerName}</Link> : row.customerName || "—"}</td>
            <td className={styles.num}>{qar(row.amountDirham)}</td><td>{row.createdByName || "—"}</td>
            <td>{isAllocatable(row.source) ? <Link href={`/payments?${baseQS}&allocation=${encodeURIComponent(row.reference)}#allocation`}>View</Link> : "—"}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className={styles.pager}>
        {filter.offset > 0 && <Link href={`/payments?${baseQS}&offset=${Math.max(0, filter.offset - PAYMENT_PAGE_SIZE)}`}>Previous</Link>}
        {hasMore && <Link href={`/payments?${baseQS}&offset=${filter.offset + PAYMENT_PAGE_SIZE}`}>Next</Link>}
      </div>
    </section>

    {allocationRef && <section id="allocation" className={styles.panel}>
      <div className={styles.sectionHeading}><h2>Payment allocation</h2><Link className={styles.ghost} href={`/payments?${baseQS}`}>Close</Link></div>
      {!allocation || allocation.length === 0 ? <p className={styles.empty}>This payment batch could not be found.</p> : <>
        <p className={styles.muted}>This customer payment was applied across {allocation.length} invoice{allocation.length === 1 ? "" : "s"} using the existing FIFO allocation.</p>
        <div className={styles.detailList}>{allocation.map((row) => <article key={row.entryId}>
          <strong>{qar(row.amountDirham)} {row.invoiceId ? <>applied to <Link href={`/shops/${shop.id}/invoices/${row.invoiceId}`}>{row.invoiceNumber}</Link></> : "unapplied"}</strong>
          <span>{paymentMethodLabel(row.method)} · {row.businessDate} · recorded {qatarTime(row.recordedAt)}</span>
        </article>)}</div>
      </>}
    </section>}
  </main>;
}
