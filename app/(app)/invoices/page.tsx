import Link from "next/link";

import { can, getCurrentActor } from "@/lib/auth/permissions";
import { formatQar } from "@/lib/domain/money";
import { fetchInvoiceList, findInvoiceByNumber, INVOICE_PAGE_SIZE, INVOICE_STATUSES, INVOICE_STATUS_LABELS, parseInvoiceListFilter } from "@/lib/invoice-list";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { getVisibleShops } from "@/lib/shop-switching";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import styles from "@/app/ui.module.css";

const qar = (dirham: number) => `QAR ${formatQar(dirham)}`;
const qatarTime = (iso: string | null) => iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Qatar" }) : "—";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function InvoicesPage({ searchParams }: PageProps<"/invoices">) {
  const actor = await getCurrentActor();
  const query = await searchParams;
  const supabase = await createServerSupabaseClient();
  const { data: allShops, error: shopsError } = await supabase.from("shops").select("id,name,is_active").eq("is_active", true).order("name");
  if (shopsError || !allShops) throw new Error("INVOICE_LIST_UNAVAILABLE");
  const shops = getVisibleShops(actor, allShops);
  const requestedShop = first(query.shop);
  const shop = shops.find((item) => item.id === requestedShop) ?? shops[0];
  if (!shop || !can(actor, "records.view_assigned", shop.id)) return <main className={styles.workspace}><h1>Invoices unavailable</h1></main>;

  const today = qatarBusinessDate(new Date());
  const filter = parseInvoiceListFilter(query, today);
  const searchTerm = (first(query.q) ?? "").trim().slice(0, 120);
  const baseQS = `shop=${shop.id}&from=${filter.from}&to=${filter.to}&status=${filter.status}`;

  const [{ rows, hasMore }, searchResult] = await Promise.all([
    fetchInvoiceList(supabase, shop.id, filter),
    searchTerm ? findInvoiceByNumber(supabase, shop.id, searchTerm) : Promise.resolve(undefined),
  ]);

  return <main className={styles.workspace}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>{shop.name}</p><h1>Invoices</h1><p>Default view shows the last 30 days. Search by invoice number to find an older invoice.</p></div>
      <Link href="/">Back to overview</Link>
    </header>
    {shops.length > 1 && <nav className={styles.shops} aria-label="Choose shop">{shops.map((item) => <Link key={item.id} aria-current={item.id === shop.id ? "page" : undefined} href={`/invoices?shop=${item.id}`}>{item.name}</Link>)}</nav>}

    <section className={styles.panel}>
      <h2>Find an invoice by number</h2>
      <p className={styles.muted}>This search is not limited to the last 30 days, but stays within {shop.name}.</p>
      <form className={styles.lookup} action="/invoices">
        <input type="hidden" name="shop" value={shop.id} />
        <label>Invoice number<input name="q" defaultValue={searchTerm} maxLength={120} /></label>
        <button className={styles.secondary}>Search</button>
        {searchTerm && <Link className={styles.ghost} href={`/invoices?shop=${shop.id}`}>Clear</Link>}
      </form>
      {searchTerm && (searchResult ? <div className={styles.paymentDetails}>
        <p role="status">Found invoice <strong>{searchResult.invoiceNumber}</strong>, business date {searchResult.businessDate}{(searchResult.businessDate < filter.from || searchResult.businessDate > filter.to) && " (outside the current date filter below)"}.</p>
        <div className={styles.totals}>
          <span>Total<strong>{qar(searchResult.totalDirham)}</strong></span><span>Paid<strong>{qar(searchResult.paidDirham)}</strong></span>
          <span>Due<strong className={searchResult.dueDirham > 0 ? styles.due : undefined}>{qar(searchResult.dueDirham)}</strong></span>
        </div>
        <p><Link href={`/shops/${shop.id}/invoices/${searchResult.invoiceId}`}>View invoice {searchResult.invoiceNumber}</Link></p>
      </div> : <p role="alert">No invoice numbered &quot;{searchTerm}&quot; was found in {shop.name}.</p>)}
    </section>

    <section className={styles.panel}>
      <div className={styles.sectionHeading}><h2>Invoice history</h2><p>{shop.name}</p></div>
      <div className={styles.toolbar}>
        <form className={styles.search} action="/invoices">
          <input type="hidden" name="shop" value={shop.id} /><input type="hidden" name="status" value={filter.status} />
          <label>From<input type="date" name="from" defaultValue={filter.from} max={today} required /></label>
          <label>To<input type="date" name="to" defaultValue={filter.to} max={today} required /></label>
          <button className={styles.secondary}>Show range</button>
          <Link className={styles.ghost} href={`/invoices?shop=${shop.id}`}>Reset to last 30 days</Link>
        </form>
      </div>
      <nav className={styles.shops} aria-label="Filter by status">{INVOICE_STATUSES.map((item) => <Link key={item} aria-current={item === filter.status ? "page" : undefined} href={`/invoices?shop=${shop.id}&from=${filter.from}&to=${filter.to}&status=${item}`}>{INVOICE_STATUS_LABELS[item]}</Link>)}</nav>
      {filter.error && <p role="alert">{filter.error} Showing the last 30 days instead.</p>}
      <div className={styles.tableWrap}>
        <table>
          <thead><tr><th scope="col">Invoice</th><th scope="col">Business date</th><th scope="col">Recorded (Qatar)</th><th scope="col">Customer</th><th scope="col" className={styles.num}>Total</th><th scope="col" className={styles.num}>Paid</th><th scope="col" className={styles.num}>Credit applied</th><th scope="col" className={styles.num}>Due</th><th scope="col">Status</th><th scope="col">View</th></tr></thead>
          <tbody>{rows.length === 0 ? <tr><td colSpan={10}>No invoices in this range.</td></tr> : rows.map((row) => <tr key={row.invoiceId}>
            <td><strong>{row.invoiceNumber}</strong></td><td>{row.businessDate}</td><td>{qatarTime(row.recordedAt)}</td><td>{row.customerName || "—"}</td>
            <td className={styles.num}>{qar(row.totalDirham)}</td><td className={styles.num}>{qar(row.paidDirham)}</td><td className={styles.num}>{qar(row.creditAppliedDirham)}</td>
            <td className={styles.num}>{qar(row.dueDirham)}</td>
            <td><span className={styles.badge} data-tone={row.delivered ? row.dueDirham <= 0 ? "success" : "warning" : undefined}>{row.delivered ? row.dueDirham <= 0 ? "Delivered · paid" : "Delivered · due" : "Advance"}</span></td>
            <td><Link href={`/shops/${shop.id}/invoices/${row.invoiceId}`}>View</Link></td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className={styles.pager}>
        {filter.offset > 0 && <Link href={`/invoices?${baseQS}&offset=${Math.max(0, filter.offset - INVOICE_PAGE_SIZE)}`}>Previous</Link>}
        {hasMore && <Link href={`/invoices?${baseQS}&offset=${filter.offset + INVOICE_PAGE_SIZE}`}>Next</Link>}
      </div>
    </section>
  </main>;
}
