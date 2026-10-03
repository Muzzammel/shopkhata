"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { formatQar } from "@/lib/domain/money";
import { prepareInvoiceBatch, qatarBusinessDate, selectInvoiceAttempt, type EntryError, type EntryRow, type InvoiceEntryInput } from "@/lib/invoice-entry";
import { getShopSwitchDisposition, type ShopChoice } from "@/lib/shop-switching";
import type { WorkspaceInvoice } from "@/lib/shop-workspace";

import { DuplicateInvoiceWarning } from "./duplicate-invoice-warning";
import { normalizeInvoiceNumber } from "@/lib/invoice-operations";
import { CustomerSearch } from "./customer-search";
import { saveInvoiceBatch, type SaveResult } from "./invoice-actions";
import { InvoicePayment } from "./invoice-payment";
import { loadShopWorkspace } from "./workspace-actions";
import styles from "./invoice-entry.module.css";

function emptyRow(): EntryRow {
  return { rowId: crypto.randomUUID(), invoiceId: "", total: "", received: "", delivered: false, customerId: "", customerName: "", customerMobile: "" };
}

export function InvoiceEntry({ appName, shop, shops, actorName, actorRole, invoices, duplicateInvoiceNumbers, businessDate }: {
  appName: string;
  shop: ShopChoice;
  shops: ShopChoice[];
  actorName: string;
  actorRole: string;
  invoices: WorkspaceInvoice[];
  duplicateInvoiceNumbers: string[];
  businessDate: string;
}) {
  const [currentShop, setCurrentShop] = useState(shop);
  const [currentInvoices, setCurrentInvoices] = useState(invoices);
  const [duplicateNumbers, setDuplicateNumbers] = useState(duplicateInvoiceNumbers);
  const [rows, setRows] = useState<EntryRow[]>(() => [emptyRow()]);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);
  const [currentDate, setCurrentDate] = useState(businessDate);
  const [selectedBusinessDate, setSelectedBusinessDate] = useState(businessDate);
  const [backdatedReason, setBackdatedReason] = useState("");
  const [attempt, setAttempt] = useState<InvoiceEntryInput | null>(null);
  const [batchUncertain, setBatchUncertain] = useState(false);
  const [paymentGuard, setPaymentGuard] = useState({ hasDraft: false, uncertain: false });
  const [paymentActivity, setPaymentActivity] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchMessage, setSwitchMessage] = useState("");
  const batchSavingRef = useRef(false);
  const paymentActivityRef = useRef(false);
  const paymentGuardRef = useRef(paymentGuard);
  const switchInProgressRef = useRef(false);
  const activeShopIdRef = useRef(shop.id);
  const workspaceGenerationRef = useRef(0);
  useEffect(() => {
    const refreshDate = () => {
      const today = qatarBusinessDate(new Date());
      setCurrentDate(today);
      setSelectedBusinessDate((selected) => selected === currentDate ? today : selected);
    };
    refreshDate();
    const timer = setInterval(refreshDate, 10_000);
    return () => clearInterval(timer);
  }, [currentDate]);
  const displayDate = attempt?.businessDate ?? selectedBusinessDate;
  const displayBackdated = attempt?.isBackdated ?? (displayDate < currentDate);
  const displayReason = attempt?.backdatedReason ?? backdatedReason;
  const preview = prepareInvoiceBatch({
    shopId: currentShop.id, businessDate: displayDate, isBackdated: displayBackdated,
    backdatedReason: displayReason, idempotencyKey: key, rows,
  }, duplicateNumbers, Boolean(attempt), currentDate);
  const invoiceDraft = rows.length > 1 || rows.some((row) => Boolean(row.invoiceId.trim() || row.total.trim() || row.received.trim() || row.delivered || row.customerId || row.customerName.trim() || row.customerMobile.trim()));
  const uncertain = batchUncertain || paymentGuard.uncertain;
  const workspaceLocked = switching || busy || paymentActivity;

  function workspaceIsCurrent(shopId: string, generation: number): boolean {
    return activeShopIdRef.current === shopId && workspaceGenerationRef.current === generation;
  }

  const reportPaymentActivity = useCallback((active: boolean) => {
    paymentActivityRef.current = active;
    setPaymentActivity(active);
  }, []);

  const reportPaymentGuard = useCallback((guard: { hasDraft: boolean; uncertain: boolean }) => {
    paymentGuardRef.current = guard;
    setPaymentGuard(guard);
  }, []);

  async function switchShop(nextShopId: string) {
    if (nextShopId === activeShopIdRef.current || switchInProgressRef.current) return;
    setSwitchMessage("");
    if (batchSavingRef.current || paymentActivityRef.current) {
      setSwitchMessage("Wait for the current operation to finish before switching shops.");
      return;
    }
    const disposition = getShopSwitchDisposition({
      hasDraft: invoiceDraft || paymentGuardRef.current.hasDraft,
      uncertain: batchUncertain || paymentGuardRef.current.uncertain,
      confirmedDiscard: false,
    });
    if (disposition === "blocked") {
      setSwitchMessage("Resolve the pending save by retrying its original command before switching shops.");
      return;
    }
    const sourceShopId = activeShopIdRef.current;
    const sourceGeneration = workspaceGenerationRef.current;
    switchInProgressRef.current = true;
    setSwitching(true);
    try {
      if (disposition === "confirm" && !window.confirm("Switch shops and discard the unsaved entry?")) return;
      // Recheck synchronous activity after confirmation. Handler state can be
      // stale while the modal is open or two events arrive in one render.
      if (batchSavingRef.current || paymentActivityRef.current) {
        setSwitchMessage("Wait for the current operation to finish before switching shops.");
        return;
      }
      const result = await loadShopWorkspace(nextShopId);
      if (!workspaceIsCurrent(sourceShopId, sourceGeneration)) return;
      if (!result.ok) {
        setSwitchMessage(result.message);
        return;
      }
      activeShopIdRef.current = result.workspace.shop.id;
      workspaceGenerationRef.current += 1;
      setCurrentShop(result.workspace.shop);
      setCurrentInvoices(result.workspace.invoices);
      setDuplicateNumbers(result.workspace.duplicateInvoiceNumbers);
      setRows([emptyRow()]);
      setKey(crypto.randomUUID());
      setAttempt(null);
      setBatchUncertain(false);
      setReview(false);
      setResult(null);
      const today = qatarBusinessDate(new Date());
      setCurrentDate(today);
      setSelectedBusinessDate(today);
      setBackdatedReason("");
      reportPaymentGuard({ hasDraft: false, uncertain: false });
    } catch {
      setSwitchMessage("The selected shop could not be loaded.");
    } finally {
      switchInProgressRef.current = false;
      setSwitching(false);
    }
  }

  async function refreshCurrentWorkspace(shopId: string, generation: number) {
    try {
      const result = await loadShopWorkspace(shopId);
      if (!result.ok || !workspaceIsCurrent(shopId, generation)) return;
      setCurrentInvoices(result.workspace.invoices);
      setDuplicateNumbers(result.workspace.duplicateInvoiceNumbers);
    } catch {
      // The save is already confirmed; a failed read does not make its outcome uncertain.
    }
  }

  function editDraft() {
    if (batchUncertain || switchInProgressRef.current || busy || paymentActivityRef.current) return;
    if (attempt) {
      setAttempt(null);
      setKey(crypto.randomUUID());
    }
    setReview(false);
    setResult(null);
  }

  function updateRow(rowId: string, patch: Partial<EntryRow>) {
    if (batchUncertain || switchInProgressRef.current || busy || paymentActivityRef.current) return;
    setRows((current) => current.map((row) => row.rowId === rowId ? { ...row, ...patch } : row));
    editDraft();
  }

  async function save() {
    if (!preview.command || busy || switchInProgressRef.current || paymentActivityRef.current || batchSavingRef.current) return;
    const commandShopId = activeShopIdRef.current;
    const commandGeneration = workspaceGenerationRef.current;
    if (currentShop.id !== commandShopId) return;
    const submission = selectInvoiceAttempt({
      shopId: commandShopId, businessDate: displayDate, isBackdated: displayBackdated,
      backdatedReason: displayReason, idempotencyKey: key, rows,
    }, attempt);
    setAttempt(submission);
    batchSavingRef.current = true;
    setBusy(true);
    try {
      const saved = await saveInvoiceBatch(submission);
      if (!workspaceIsCurrent(commandShopId, commandGeneration)) return;
      setResult(saved);
      setBatchUncertain(Boolean(saved.uncertain));
      if (saved.ok) {
        setRows([emptyRow()]);
        setKey(crypto.randomUUID());
        setAttempt(null);
        setBatchUncertain(false);
        const today = qatarBusinessDate(new Date());
        setCurrentDate(today);
        setSelectedBusinessDate(today);
        setBackdatedReason("");
        setReview(false);
        await refreshCurrentWorkspace(commandShopId, commandGeneration);
      }
    } catch {
      if (!workspaceIsCurrent(commandShopId, commandGeneration)) return;
      setBatchUncertain(true);
      setResult({ ok: false, message: "Batch was not saved. Try again with the same draft.", errors: [] });
    } finally {
      batchSavingRef.current = false;
      setBusy(false);
    }
  }

  function rowErrors(rowId: string): EntryError[] {
    return [...preview.errors, ...(result?.errors ?? [])].filter((error) => error.rowId === rowId);
  }

  return <main className={styles.workspace}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>Daily workspace</p><h1>{appName}</h1></div>
      <div className={styles.identity}><h2>{currentShop.name}</h2><span>{actorName} · {actorRole} · {displayDate}</span>{actorRole === "owner" && shops.length > 1 && <label>Current shop<select aria-label="Current shop" value={currentShop.id} disabled={workspaceLocked || uncertain} onChange={(event) => void switchShop(event.target.value)}>{shops.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}</div>
    </header>
    {switchMessage && <p role="alert">{switchMessage}</p>}
    <section className={styles.panel} aria-labelledby="entry-title">
      <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>Invoice operations</p><h2 id="entry-title">New invoice batch</h2></div><p>One save commits every row together.</p></div>
      <div className={styles.batchDate}>
        <label>Business date<input aria-label="Business date" type="date" max={currentDate} value={displayDate} disabled={actorRole !== "owner" || workspaceLocked || batchUncertain} onChange={(event) => { editDraft(); setSelectedBusinessDate(event.target.value); }} /></label>
        {displayBackdated && <label>Reason for backdated entry<input aria-label="Backdate reason" required maxLength={1000} value={displayReason} disabled={workspaceLocked || batchUncertain} onChange={(event) => { editDraft(); setBackdatedReason(event.target.value); }} /></label>}
      </div>
      <div className={styles.rows}>
        {rows.map((row, index) => <div className={styles.row} data-entry-row key={row.rowId}>
            <div className={styles.rowHeading}><strong>Invoice {index + 1}</strong>{rows.length > 1 && <button type="button" className={styles.textButton} disabled={workspaceLocked || batchUncertain} onClick={() => { setRows((current) => current.filter((item) => item.rowId !== row.rowId)); editDraft(); }}>Remove</button>}</div>
          <div className={styles.rowFields}>
            <label>Invoice ID<input disabled={workspaceLocked || batchUncertain} value={row.invoiceId} onChange={(event) => updateRow(row.rowId, { invoiceId: event.target.value })} /></label>
            <label>Total QAR<input disabled={workspaceLocked || batchUncertain} inputMode="decimal" value={row.total} onChange={(event) => updateRow(row.rowId, { total: event.target.value })} /></label>
            <label>Received QAR<input disabled={workspaceLocked || batchUncertain} inputMode="decimal" value={row.received} onChange={(event) => updateRow(row.rowId, { received: event.target.value })} placeholder="0.00" /></label>
            <label className={styles.checkbox}>Delivered<input disabled={workspaceLocked || batchUncertain} type="checkbox" checked={row.delivered} onChange={(event) => updateRow(row.rowId, { delivered: event.target.checked })} /></label>
          </div>
          <div className={styles.customerFields}>
            <CustomerSearch key={`${currentShop.id}-${row.rowId}`} shopId={currentShop.id} disabled={workspaceLocked || batchUncertain} onSelect={(customer) => updateRow(row.rowId, { customerId: customer?.id ?? "", customerName: "", customerMobile: "" })} />
            <label>New customer name<input value={row.customerName} disabled={workspaceLocked || batchUncertain || Boolean(row.customerId)} onChange={(event) => updateRow(row.rowId, { customerName: event.target.value })} /></label>
            <label>New customer mobile<input value={row.customerMobile} disabled={workspaceLocked || batchUncertain || Boolean(row.customerId)} onChange={(event) => updateRow(row.rowId, { customerMobile: event.target.value })} /></label>
          </div>
          {duplicateNumbers.some((n) => normalizeInvoiceNumber(n) === normalizeInvoiceNumber(row.invoiceId)) && <DuplicateInvoiceWarning key={`${currentShop.id}:${row.invoiceId}`} shopId={currentShop.id} number={row.invoiceId} />}
          {rowErrors(row.rowId).length > 0 && <ul className={styles.errors}>{rowErrors(row.rowId).map((error, i) => <li key={`${error.field}-${i}`}>{error.message}</li>)}</ul>}
        </div>)}
      </div>
      <div className={styles.actions}><button type="button" className={styles.secondary} disabled={workspaceLocked || batchUncertain} onClick={() => { setRows((current) => [...current, emptyRow()]); editDraft(); }}>Add row</button><button type="button" disabled={workspaceLocked} onClick={() => setReview(true)}>Review batch</button></div>
      {review && <div className={styles.review}>
        <h3>Batch review</h3>
        <p>Business date: <strong>{displayDate}</strong>{displayBackdated && <> · <strong>Backdated</strong> · Reason: {displayReason.trim()}</>}</p>
        {preview.command && <div className={styles.reviewRows}>{preview.command.rows.map((row) => <div key={row.row_id}>
          <strong>{row.invoice_number}</strong><span>{row.delivered ? "Delivered" : "Advance"}</span>
          <span>QAR {formatQar(row.total_dirham)}</span><span>Received QAR {formatQar(row.received_dirham)}</span>
          <span>Due QAR {formatQar(row.total_dirham - row.received_dirham)}</span>
        </div>)}</div>}
        {preview.totals && <div className={styles.totals}><span>Invoiced <strong>QAR {formatQar(preview.totals.invoiced)}</strong></span><span>Received <strong>QAR {formatQar(preview.totals.received)}</strong></span><span>Due <strong>QAR {formatQar(preview.totals.due)}</strong></span></div>}
        {preview.errors.length ? <p role="alert">{preview.errors.find((error) => error.field === "rows")?.message ?? `Fix ${preview.errors.length} row error${preview.errors.length === 1 ? "" : "s"} before saving.`}</p> : <button type="button" disabled={workspaceLocked} onClick={save}>{busy ? "Saving…" : batchUncertain ? "Retry same batch" : "Save batch"}</button>}
      </div>}
      {result && <p role={result.ok ? "status" : "alert"} className={result.ok ? styles.success : styles.errors}>{result.message}</p>}
    </section>
    <section id="recent-invoices" className={styles.panel} aria-labelledby="recent-title">
      <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>Saved records</p><h2 id="recent-title">Recent invoices</h2></div><p>{currentShop.name}</p></div>
      {currentInvoices.length === 0 ? <p>No invoices saved yet.</p> : <div className={styles.savedList}>{currentInvoices.map((invoice) => <Link className={styles.saved} href={`/shops/${currentShop.id}/invoices/${invoice.id}`} key={invoice.id} aria-label={`View invoice ${invoice.invoice_id}`}>
        <strong>{invoice.invoice_id}</strong><span>{invoice.business_date}</span><span>{invoice.delivered ? invoice.effective_due_dirham <= 0 ? "Delivered · paid" : "Delivered · due" : "Advance"}</span><span>QAR {formatQar(invoice.effective_total_dirham)}</span><span>Due QAR {formatQar(invoice.effective_due_dirham)}</span>
      </Link>)}</div>}
    </section>
    <InvoicePayment key={currentShop.id} shopId={currentShop.id} disabled={switching || busy} onActivityChange={reportPaymentActivity} onSaved={({ invoiceId, effectiveDue }) => {
      const generation = workspaceGenerationRef.current;
      if (!workspaceIsCurrent(currentShop.id, generation)) return;
      setCurrentInvoices((current) => current.map((invoice) => invoice.id === invoiceId
        ? { ...invoice, effective_due_dirham: effectiveDue }
        : invoice));
    }} onStateChange={reportPaymentGuard} />
  </main>;
}
