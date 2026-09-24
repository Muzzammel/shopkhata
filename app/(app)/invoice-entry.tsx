"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { formatQar } from "@/lib/domain/money";
import { prepareInvoiceBatch, qatarBusinessDate, selectInvoiceAttempt, type EntryError, type EntryRow, type InvoiceEntryInput } from "@/lib/invoice-entry";

import { saveInvoiceBatch, type SaveResult } from "./invoice-actions";
import styles from "./invoice-entry.module.css";

type Customer = { id: string; name: string | null; mobile: string | null; public_id: string };
type Invoice = { id: string; invoice_id: string; business_date: string; effective_total_dirham: number; effective_due_dirham: number; delivered: boolean; customer_id: string | null };

function emptyRow(): EntryRow {
  return { rowId: crypto.randomUUID(), invoiceId: "", total: "", received: "", delivered: false, customerId: "", customerName: "", customerMobile: "" };
}

export function InvoiceEntry({ appName, shop, actorName, actorRole, customers, invoices, businessDate }: {
  appName: string;
  shop: { id: string; name: string };
  actorName: string;
  actorRole: string;
  customers: Customer[];
  invoices: Invoice[];
  businessDate: string;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<EntryRow[]>(() => [emptyRow()]);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);
  const [currentDate, setCurrentDate] = useState(businessDate);
  const [attempt, setAttempt] = useState<InvoiceEntryInput | null>(null);
  useEffect(() => {
    const refreshDate = () => setCurrentDate(qatarBusinessDate(new Date()));
    refreshDate();
    const timer = setInterval(refreshDate, 10_000);
    return () => clearInterval(timer);
  }, []);
  const displayDate = attempt?.businessDate ?? currentDate;
  const preview = prepareInvoiceBatch({ shopId: shop.id, businessDate: displayDate, idempotencyKey: key, rows }, invoices.map((invoice) => invoice.invoice_id), Boolean(attempt));

  function editDraft() {
    if (attempt) {
      setAttempt(null);
      setKey(crypto.randomUUID());
      setCurrentDate(qatarBusinessDate(new Date()));
    }
    setReview(false);
    setResult(null);
  }

  function updateRow(rowId: string, patch: Partial<EntryRow>) {
    setRows((current) => current.map((row) => row.rowId === rowId ? { ...row, ...patch } : row));
    editDraft();
  }

  async function save() {
    if (!preview.command || busy) return;
    const submission = selectInvoiceAttempt({ shopId: shop.id, businessDate: displayDate, idempotencyKey: key, rows }, new Date(), attempt);
    setAttempt(submission);
    setCurrentDate(submission.businessDate);
    setBusy(true);
    try {
      const saved = await saveInvoiceBatch(submission);
      setResult(saved);
      if (saved.ok) {
        setRows([emptyRow()]);
        setKey(crypto.randomUUID());
        setAttempt(null);
        setCurrentDate(qatarBusinessDate(new Date()));
        setReview(false);
        router.refresh();
      }
    } catch {
      setResult({ ok: false, message: "Batch was not saved. Try again with the same draft.", errors: [] });
    } finally {
      setBusy(false);
    }
  }

  function rowErrors(rowId: string): EntryError[] {
    return [...preview.errors, ...(result?.errors ?? [])].filter((error) => error.rowId === rowId);
  }

  return <main className={styles.workspace}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>Daily workspace</p><h1>{appName}</h1></div>
      <div className={styles.identity}><h2>{shop.name}</h2><span>{actorName} · {actorRole} · {displayDate}</span></div>
    </header>
    <section className={styles.panel} aria-labelledby="entry-title">
      <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>Invoice operations</p><h2 id="entry-title">New invoice batch</h2></div><p>One save commits every row together.</p></div>
      <div className={styles.rows}>
        {rows.map((row, index) => <div className={styles.row} data-entry-row key={row.rowId}>
          <div className={styles.rowHeading}><strong>Invoice {index + 1}</strong>{rows.length > 1 && <button type="button" className={styles.textButton} onClick={() => { setRows((current) => current.filter((item) => item.rowId !== row.rowId)); editDraft(); }}>Remove</button>}</div>
          <div className={styles.rowFields}>
            <label>Invoice ID<input value={row.invoiceId} onChange={(event) => updateRow(row.rowId, { invoiceId: event.target.value })} /></label>
            <label>Total QAR<input inputMode="decimal" value={row.total} onChange={(event) => updateRow(row.rowId, { total: event.target.value })} /></label>
            <label>Received QAR<input inputMode="decimal" value={row.received} onChange={(event) => updateRow(row.rowId, { received: event.target.value })} placeholder="0.00" /></label>
            <label className={styles.checkbox}>Delivered<input type="checkbox" checked={row.delivered} onChange={(event) => updateRow(row.rowId, { delivered: event.target.checked })} /></label>
          </div>
          <div className={styles.customerFields}>
            <label>Existing customer<select value={row.customerId} onChange={(event) => updateRow(row.rowId, { customerId: event.target.value, customerName: "", customerMobile: "" })}><option value="">None</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name || customer.mobile || customer.public_id}</option>)}</select></label>
            <label>New customer name<input value={row.customerName} disabled={Boolean(row.customerId)} onChange={(event) => updateRow(row.rowId, { customerName: event.target.value })} /></label>
            <label>New customer mobile<input value={row.customerMobile} disabled={Boolean(row.customerId)} onChange={(event) => updateRow(row.rowId, { customerMobile: event.target.value })} /></label>
          </div>
          {rowErrors(row.rowId).length > 0 && <ul className={styles.errors}>{rowErrors(row.rowId).map((error, i) => <li key={`${error.field}-${i}`}>{error.message}</li>)}</ul>}
        </div>)}
      </div>
      <div className={styles.actions}><button type="button" className={styles.secondary} onClick={() => { setRows((current) => [...current, emptyRow()]); editDraft(); }}>Add row</button><button type="button" onClick={() => setReview(true)}>Review batch</button></div>
      {review && <div className={styles.review}>
        <h3>Batch review</h3>
        {preview.command && <div className={styles.reviewRows}>{preview.command.rows.map((row) => <div key={row.row_id}>
          <strong>{row.invoice_number}</strong><span>{row.delivered ? "Delivered" : "Advance"}</span>
          <span>QAR {formatQar(row.total_dirham)}</span><span>Received QAR {formatQar(row.received_dirham)}</span>
          <span>Due QAR {formatQar(row.total_dirham - row.received_dirham)}</span>
        </div>)}</div>}
        {preview.totals && <div className={styles.totals}><span>Invoiced <strong>QAR {formatQar(preview.totals.invoiced)}</strong></span><span>Received <strong>QAR {formatQar(preview.totals.received)}</strong></span><span>Due <strong>QAR {formatQar(preview.totals.due)}</strong></span></div>}
        {preview.errors.length ? <p role="alert">{preview.errors.find((error) => error.field === "rows")?.message ?? `Fix ${preview.errors.length} row error${preview.errors.length === 1 ? "" : "s"} before saving.`}</p> : <button type="button" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save batch"}</button>}
      </div>}
      {result && <p role={result.ok ? "status" : "alert"} className={result.ok ? styles.success : styles.errors}>{result.message}</p>}
    </section>
    <section className={styles.panel} aria-labelledby="recent-title">
      <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>Saved records</p><h2 id="recent-title">Recent invoices</h2></div><p>{shop.name}</p></div>
      {invoices.length === 0 ? <p>No invoices saved yet.</p> : <div className={styles.savedList}>{invoices.map((invoice) => <div className={styles.saved} key={invoice.id}>
        <strong>{invoice.invoice_id}</strong><span>{invoice.business_date}</span><span>{invoice.delivered ? invoice.effective_due_dirham <= 0 ? "Delivered · paid" : "Delivered · due" : "Advance"}</span><span>QAR {formatQar(invoice.effective_total_dirham)}</span><span>Due QAR {formatQar(invoice.effective_due_dirham)}</span>
      </div>)}</div>}
    </section>
  </main>;
}
