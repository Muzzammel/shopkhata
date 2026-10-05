"use client";

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import Link from "next/link";

import { formatQar } from "@/lib/domain/money";
import { prepareInvoiceBatch, qatarBusinessDate, selectInvoiceAttempt, type EntryError, type EntryRow } from "@/lib/invoice-entry";
import {
  classifySaveResult, draftStatusLabel, isBlankRows, newSubmission, nextSubmission, restoreBusinessDate, retryDelayMs, serializeDraft,
  type DraftConflict, type DraftCustomer, type DraftSubmission, type SaveOutcome, type StoredDraft,
} from "@/lib/offline/draft-state";
import { deleteDraft, listDraftShopIds, loadDraft, saveDraft, writeSessionMarker } from "@/lib/offline/draft-store";
import { isOnline, useOnline } from "@/lib/offline/use-online";
import { getShopSwitchDisposition, type ShopChoice } from "@/lib/shop-switching";
import type { WorkspaceInvoice } from "@/lib/shop-workspace";
import { createBrowserClient } from "@/lib/supabase/browser";

import { DuplicateInvoiceWarning } from "./duplicate-invoice-warning";
import { normalizeInvoiceNumber } from "@/lib/invoice-operations";
import { CustomerSearch } from "./customer-search";
import { ExcelImport } from "./excel-import";
import { saveInvoiceBatch, type SaveResult } from "./invoice-actions";
import { InvoicePayment } from "./invoice-payment";
import { loadShopWorkspace } from "./workspace-actions";
import styles from "@/app/ui.module.css";

const REAUTH_MESSAGE = "Sign in again to continue. Your draft is kept on this device and has not been confirmed as saved.";

/** True only when the browser definitely has no usable session; a network failure is not that. */
async function sessionMissing(): Promise<boolean> {
  try {
    const { error } = await createBrowserClient().auth.getUser();
    return Boolean(error) && (error?.name === "AuthSessionMissingError" || [400, 401, 403].includes(error?.status ?? 0));
  } catch {
    return false;
  }
}

function emptyRow(): EntryRow {
  return { rowId: crypto.randomUUID(), invoiceId: "", total: "", received: "", delivered: false, customerId: "", customerName: "", customerMobile: "", note: "" };
}

export function InvoiceEntry({ appName, shop, shops, actorId, actorName, actorRole, invoices, duplicateInvoiceNumbers, businessDate, offlineShell = false }: {
  appName: string;
  shop: ShopChoice;
  shops: ShopChoice[];
  actorId: string;
  actorName: string;
  actorRole: string;
  invoices: WorkspaceInvoice[];
  duplicateInvoiceNumbers: string[];
  businessDate: string;
  /** Rendered by the service worker's offline page: local draft editing only, no server data. */
  offlineShell?: boolean;
}) {
  const online = useOnline();
  const [currentShop, setCurrentShop] = useState(shop);
  const [currentInvoices, setCurrentInvoices] = useState(invoices);
  const [duplicateNumbers, setDuplicateNumbers] = useState(duplicateInvoiceNumbers);
  const [rows, setRows] = useState<EntryRow[]>(() => [emptyRow()]);
  const [customers, setCustomers] = useState<Record<string, DraftCustomer>>({});
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);
  const [currentDate, setCurrentDate] = useState(businessDate);
  const [selectedBusinessDate, setSelectedBusinessDate] = useState(businessDate);
  const [backdatedReason, setBackdatedReason] = useState("");
  // The queued or in-doubt submission. Its payload and idempotency key are
  // frozen; a retry always sends exactly this.
  const [submission, setSubmission] = useState<DraftSubmission | null>(null);
  const [conflict, setConflict] = useState<DraftConflict | null>(null);
  const [createdAt, setCreatedAt] = useState(() => new Date().toISOString());
  const [hydratedShop, setHydratedShop] = useState<string | null>(null);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [restored, setRestored] = useState(false);
  const [otherDraftShops, setOtherDraftShops] = useState<ShopChoice[]>([]);
  const [syncAttempt, setSyncAttempt] = useState<number | null>(null);
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
  const attempt = submission?.payload ?? null;
  const batchUncertain = submission?.status === "uncertain";
  const hydrated = hydratedShop === currentShop.id;
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
  const invoiceDraft = !isBlankRows(rows);
  const uncertain = batchUncertain || paymentGuard.uncertain;
  const workspaceLocked = switching || busy || paymentActivity || !hydrated;
  const reconnecting = syncAttempt !== null && retryDelayMs(syncAttempt) !== null && !busy;
  const notice = result ?? (conflict ? { ok: false, message: conflict.message, errors: conflict.errors } : null);
  const statusLabel = draftStatusLabel({
    online, reconnecting, sending: busy, hasDraft: invoiceDraft, justSaved: Boolean(result?.ok), storageAvailable, submission, conflict,
  });

  function workspaceIsCurrent(shopId: string, generation: number): boolean {
    return activeShopIdRef.current === shopId && workspaceGenerationRef.current === generation;
  }

  function buildDraft(draftSubmission: DraftSubmission | null, draftConflict: DraftConflict | null) {
    return serializeDraft({
      userId: actorId, shopId: currentShop.id, businessDate: selectedBusinessDate, today: currentDate, backdatedReason, rows,
      customers, idempotencyKey: key, submission: draftSubmission, conflict: draftConflict, createdAt, now: new Date().toISOString(),
    });
  }

  function resetDraft() {
    setRows([emptyRow()]);
    setCustomers({});
    setKey(crypto.randomUUID());
    setSubmission(null);
    setConflict(null);
    setSyncAttempt(null);
    setRestored(false);
    setCreatedAt(new Date().toISOString());
    const today = qatarBusinessDate(new Date());
    setCurrentDate(today);
    setSelectedBusinessDate(today);
    setBackdatedReason("");
    setReview(false);
  }

  // Load this user's draft for this shop. Another user's draft is stored
  // under a different key and is never read here.
  const hydrate = useEffectEvent((shopId: string, draft: StoredDraft | null, available: boolean, draftShopIds: string[]) => {
    setStorageAvailable(available);
    setOtherDraftShops(shops.filter((item) => item.id !== shopId && draftShopIds.includes(item.id)));
    if (draft) {
      const today = qatarBusinessDate(new Date());
      setRows(draft.rows);
      setCustomers(draft.customers);
      setKey(draft.idempotencyKey);
      setBackdatedReason(draft.backdatedReason);
      setCurrentDate(today);
      setSelectedBusinessDate(restoreBusinessDate(draft, today));
      setSubmission(draft.submission);
      setConflict(draft.conflict as DraftConflict | null);
      setCreatedAt(draft.createdAt);
      setRestored(true);
      setReview(Boolean(draft.submission));
      // A reload or a fresh sign-in already revalidated the session and the
      // shop on the server, so an interrupted submission can resume.
      if (draft.submission && isOnline() && !offlineShell) setSyncAttempt(0);
    }
    setHydratedShop(shopId);
    if (!offlineShell) {
      void writeSessionMarker({ userId: actorId, name: actorName, role: actorRole, shops, shopId, savedAt: new Date().toISOString() });
    }
  });
  // Runs once per user and shop, never on a server re-render, so a draft that
  // was just committed and cleared cannot be read back.
  useEffect(() => {
    let active = true;
    const shopId = currentShop.id;
    void Promise.all([loadDraft(actorId, shopId), listDraftShopIds(actorId)]).then(([loaded, draftShopIds]) => {
      if (active) hydrate(shopId, loaded.draft, loaded.available, draftShopIds);
    });
    return () => { active = false; };
  }, [actorId, currentShop.id]);

  // Keep the local copy current. It is removed only when the draft is empty,
  // which after a submission happens only on a confirmed server receipt.
  useEffect(() => {
    if (hydratedShop !== currentShop.id) return;
    if (isBlankRows(rows) && !submission) {
      void deleteDraft(actorId, currentShop.id);
      return;
    }
    void saveDraft(serializeDraft({
      userId: actorId, shopId: currentShop.id, businessDate: selectedBusinessDate, today: currentDate, backdatedReason, rows,
      customers, idempotencyKey: key, submission, conflict, createdAt, now: new Date().toISOString(),
    })).then(setStorageAvailable);
  }, [actorId, backdatedReason, conflict, createdAt, currentDate, currentShop.id, customers, hydratedShop, key, rows, selectedBusinessDate, submission]);

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
      await deleteDraft(actorId, sourceShopId);
      activeShopIdRef.current = result.workspace.shop.id;
      workspaceGenerationRef.current += 1;
      setCurrentShop(result.workspace.shop);
      setCurrentInvoices(result.workspace.invoices);
      setDuplicateNumbers(result.workspace.duplicateInvoiceNumbers);
      resetDraft();
      setResult(null);
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
    if (submission) {
      // Queued but never sent: releasing it for editing cannot duplicate anything.
      setSubmission(null);
      setSyncAttempt(null);
      setKey(crypto.randomUUID());
    }
    setConflict(null);
    setReview(false);
    setResult(null);
  }

  function updateRow(rowId: string, patch: Partial<EntryRow>) {
    if (batchUncertain || switchInProgressRef.current || busy || paymentActivityRef.current) return;
    setRows((current) => current.map((row) => row.rowId === rowId ? { ...row, ...patch } : row));
    editDraft();
  }

  function applyImport(imported: EntryRow[], mode: "merge" | "replace") {
    if (batchUncertain || switchInProgressRef.current || busy || paymentActivityRef.current) return;
    if (mode === "replace" || !invoiceDraft) {
      setRows(imported);
      setCustomers({});
    } else {
      setRows((current) => [...current, ...imported]);
    }
    editDraft();
  }

  function discardDraft() {
    if (busy || switchInProgressRef.current) return;
    const warning = submission?.status === "uncertain"
      ? "The earlier submission may already be saved in ShopKhata. Discard the local copy anyway?"
      : "Discard this unsaved draft from this device?";
    if (!window.confirm(warning)) return;
    resetDraft();
    setResult(null);
  }

  /** Sends one frozen submission. Never changes its payload or idempotency key. */
  async function send(before: DraftSubmission): Promise<SaveOutcome["kind"] | "skipped"> {
    if (busy || switchInProgressRef.current || paymentActivityRef.current || batchSavingRef.current) return "skipped";
    const commandShopId = activeShopIdRef.current;
    const commandGeneration = workspaceGenerationRef.current;
    if (currentShop.id !== commandShopId || before.shopId !== commandShopId) return "skipped";
    batchSavingRef.current = true;
    setBusy(true);
    // Record "sent" before the request leaves, so closing the tab mid-flight
    // cannot turn an in-doubt submission back into an editable draft.
    const inFlight: DraftSubmission = { ...before, status: "uncertain" };
    setSubmission(inFlight);
    await saveDraft(buildDraft(inFlight, null));
    try {
      const saved = await saveInvoiceBatch(before.payload);
      if (!workspaceIsCurrent(commandShopId, commandGeneration)) return "skipped";
      const outcome = classifySaveResult(saved);
      setResult(saved);
      if (outcome.kind === "saved") {
        // Only a confirmed receipt clears the draft.
        resetDraft();
        await refreshCurrentWorkspace(commandShopId, commandGeneration);
      } else if (outcome.kind === "rejected") {
        setSubmission(null);
        setKey(crypto.randomUUID());
        setConflict({ kind: outcome.conflict, message: saved.message, errors: saved.errors });
        // Bring in the current registry so a taken number links to its existing invoice.
        await refreshCurrentWorkspace(commandShopId, commandGeneration);
      } else {
        setSubmission(nextSubmission(before, outcome, saved.message));
        setConflict(outcome.kind === "blocked" ? { kind: outcome.reason, message: saved.message, errors: [] } : null);
      }
      return outcome.kind;
    } catch {
      if (!workspaceIsCurrent(commandShopId, commandGeneration)) return "skipped";
      // No answer came back. Whatever the reason, the submission stays in doubt.
      const signedOut = await sessionMissing();
      const message = signedOut ? REAUTH_MESSAGE : "Batch was not saved. Try again with the same draft.";
      setSubmission(nextSubmission(before, { kind: "uncertain" }, message));
      setConflict(signedOut ? { kind: "reauth", message, errors: [] } : null);
      setResult({ ok: false, message, errors: [] });
      // Without a session, retrying cannot succeed; stop until the user signs in again.
      return signedOut ? "blocked" : "uncertain";
    } finally {
      batchSavingRef.current = false;
      setBusy(false);
    }
  }

  async function save() {
    if (!preview.command || busy || switchInProgressRef.current || paymentActivityRef.current || batchSavingRef.current) return;
    if (currentShop.id !== activeShopIdRef.current) return;
    const payload = selectInvoiceAttempt({
      shopId: currentShop.id, businessDate: displayDate, isBackdated: displayBackdated,
      backdatedReason: displayReason, idempotencyKey: key, rows,
    }, attempt);
    const before = submission ?? newSubmission(payload, new Date().toISOString());
    setSyncAttempt(null);
    if (!isOnline()) {
      // Nothing is sent and nothing is claimed as saved; it waits for a connection.
      setSubmission(before);
      setConflict(null);
      setResult(null);
      return;
    }
    await send(before);
  }

  // Reconnect: one controlled attempt at a time. The server action revalidates
  // the session, the shop access and the key before anything is written.
  const runAutoSync = useEffectEvent(async () => {
    if (!isOnline() || !submission) {
      setSyncAttempt(null);
      return;
    }
    const outcome = await send(submission);
    setSyncAttempt((current) => current !== null && outcome === "uncertain" ? current + 1 : null);
  });
  useEffect(() => {
    const delay = syncAttempt === null || !hydrated ? null : retryDelayMs(syncAttempt);
    if (delay === null) return;
    const timer = window.setTimeout(() => void runAutoSync(), delay);
    return () => window.clearTimeout(timer);
  }, [hydrated, syncAttempt]);
  const onReconnect = useEffectEvent(() => {
    // The offline page never sends; it returns to the real workspace by itself.
    // Repeated online events set the same value, so only one attempt is scheduled.
    if (!offlineShell && submission) setSyncAttempt(0);
  });
  useEffect(() => {
    const handler = () => onReconnect();
    window.addEventListener("online", handler);
    return () => window.removeEventListener("online", handler);
  }, []);

  function rowErrors(rowId: string): string[] {
    return [...new Set([...preview.errors, ...(notice?.errors ?? [])].filter((error: EntryError) => error.rowId === rowId).map((error) => error.message))];
  }

  return <main className={styles.workspace}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>Daily workspace</p><h1>{appName}</h1></div>
      <div className={styles.identity}><h2>{currentShop.name}</h2><span>{actorName} · {actorRole} · {displayDate}</span>{actorRole === "owner" && shops.length > 1 && <label>Current shop<select aria-label="Current shop" value={currentShop.id} disabled={workspaceLocked || uncertain || offlineShell} onChange={(event) => void switchShop(event.target.value)}>{shops.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}</div>
    </header>
    {switchMessage && <p role="alert">{switchMessage}</p>}
    {otherDraftShops.length > 0 && !offlineShell && <p>{otherDraftShops.map((item) => <Link key={item.id} href={`/?shop=${item.id}`}>Unsaved draft in {item.name}</Link>)}</p>}
    <div className={styles.split}>
    <section className={styles.panel} aria-labelledby="entry-title">
      <div className={styles.sectionHeading}><h2 id="entry-title">New invoice batch</h2><p>One save commits every row together.</p></div>
      <div className={styles.draftBar}>
        {statusLabel && <p role="status" data-draft-status className={styles.draftStatus}>{statusLabel}</p>}
        {restored && invoiceDraft && <span>Unsaved draft restored from this device.</span>}
        {(invoiceDraft || submission) && <button type="button" className={styles.textButton} disabled={busy || switching} onClick={discardDraft}>Discard draft</button>}
      </div>
      <div className={styles.entryTopRow}>
        <div className={styles.batchDate}>
          <label>Business date<input aria-label="Business date" type="date" max={currentDate} value={displayDate} disabled={actorRole !== "owner" || workspaceLocked || batchUncertain} onChange={(event) => { editDraft(); setSelectedBusinessDate(event.target.value); }} /></label>
          {displayBackdated && <label>Reason for backdated entry<input aria-label="Backdate reason" required maxLength={1000} value={displayReason} disabled={workspaceLocked || batchUncertain} onChange={(event) => { editDraft(); setBackdatedReason(event.target.value); }} /></label>}
        </div>
        <ExcelImport disabled={workspaceLocked || batchUncertain} currentRows={rows} draftIsBlank={!invoiceDraft} onApply={applyImport} validate={(candidate) => prepareInvoiceBatch({
          shopId: currentShop.id, businessDate: displayDate, isBackdated: displayBackdated, backdatedReason: displayReason, idempotencyKey: key, rows: candidate,
        }, duplicateNumbers, false, currentDate).errors} />
      </div>
      <div className={styles.rows}>
        {rows.map((row, index) => <div className={styles.row} data-entry-row data-row-id={hydrated ? row.rowId : undefined} key={row.rowId}>
            <div className={styles.rowHeading}><strong>Invoice {index + 1}</strong>{rows.length > 1 && <button type="button" className={styles.textButton} disabled={workspaceLocked || batchUncertain} onClick={() => { setRows((current) => current.filter((item) => item.rowId !== row.rowId)); editDraft(); }}>Remove</button>}</div>
          <div className={styles.rowFields}>
            <label>Invoice ID<input disabled={workspaceLocked || batchUncertain} value={row.invoiceId} onChange={(event) => updateRow(row.rowId, { invoiceId: event.target.value })} /></label>
            <label>Total QAR<input disabled={workspaceLocked || batchUncertain} inputMode="decimal" value={row.total} onChange={(event) => updateRow(row.rowId, { total: event.target.value })} /></label>
            <label>Received QAR<input disabled={workspaceLocked || batchUncertain} inputMode="decimal" value={row.received} onChange={(event) => updateRow(row.rowId, { received: event.target.value })} placeholder="0.00" /></label>
            <label className={styles.checkbox}>Delivered<input disabled={workspaceLocked || batchUncertain} type="checkbox" checked={row.delivered} onChange={(event) => updateRow(row.rowId, { delivered: event.target.checked })} /></label>
          </div>
          <div className={styles.customerFields}>
            <CustomerSearch key={`${currentShop.id}-${row.rowId}`} shopId={currentShop.id} disabled={workspaceLocked || batchUncertain} initial={row.customerId ? customers[row.rowId] ?? null : null} onSelect={(customer) => {
              setCustomers((current) => {
                const next = { ...current };
                if (customer) next[row.rowId] = customer; else delete next[row.rowId];
                return next;
              });
              updateRow(row.rowId, { customerId: customer?.id ?? "", customerName: "", customerMobile: "" });
            }} />
            <label>New customer name<input value={row.customerName} disabled={workspaceLocked || batchUncertain || Boolean(row.customerId)} onChange={(event) => updateRow(row.rowId, { customerName: event.target.value })} /></label>
            <label>New customer mobile<input value={row.customerMobile} disabled={workspaceLocked || batchUncertain || Boolean(row.customerId)} onChange={(event) => updateRow(row.rowId, { customerMobile: event.target.value })} /></label>
            <label>Note<input value={row.note ?? ""} maxLength={1000} disabled={workspaceLocked || batchUncertain} onChange={(event) => updateRow(row.rowId, { note: event.target.value })} /></label>
          </div>
          {duplicateNumbers.some((n) => normalizeInvoiceNumber(n) === normalizeInvoiceNumber(row.invoiceId)) && <DuplicateInvoiceWarning key={`${currentShop.id}:${row.invoiceId}`} shopId={currentShop.id} number={row.invoiceId} />}
          {rowErrors(row.rowId).length > 0 && <ul className={styles.errors}>{rowErrors(row.rowId).map((message, i) => <li key={i}>{message}</li>)}</ul>}
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
        {preview.errors.length ? <p role="alert">{preview.errors.find((error) => error.field === "rows")?.message ?? `Fix ${preview.errors.length} row error${preview.errors.length === 1 ? "" : "s"} before saving.`}</p> : <div className={styles.actions}>
          <button type="button" disabled={workspaceLocked} onClick={save}>{busy ? "Saving…" : submission ? "Retry same batch" : online ? "Save batch" : "Save when back online"}</button>
          {submission?.status === "queued" && <button type="button" className={styles.secondary} disabled={workspaceLocked} onClick={editDraft}>Edit draft</button>}
        </div>}
      </div>}
      {notice && <p role={notice.ok ? "status" : "alert"} className={notice.ok ? styles.success : styles.errors}>{notice.message}{conflict?.kind === "reauth" && <> <a href={`/login?next=${encodeURIComponent(`/?shop=${currentShop.id}`)}`}>Sign in again</a></>}</p>}
    </section>
    {!offlineShell && <InvoicePayment key={currentShop.id} shopId={currentShop.id} disabled={switching || busy} onActivityChange={reportPaymentActivity} onSaved={({ invoiceId, effectiveDue }) => {
      const generation = workspaceGenerationRef.current;
      if (!workspaceIsCurrent(currentShop.id, generation)) return;
      setCurrentInvoices((current) => current.map((invoice) => invoice.id === invoiceId
        ? { ...invoice, effective_due_dirham: effectiveDue }
        : invoice));
    }} onStateChange={reportPaymentGuard} />}
    </div>
    {!offlineShell && <section id="recent-invoices" className={styles.panel} aria-labelledby="recent-title">
      <div className={styles.sectionHeading}><h2 id="recent-title">Recent invoices</h2><p>{currentShop.name} · last 30 days</p></div>
      {!online && <p className={styles.stale}>Offline — this list was loaded earlier and may be out of date.</p>}
      {currentInvoices.length === 0 ? <p className={styles.empty}>No invoices in the last 30 days.</p> : <div className={styles.savedList}><div className={styles.savedHead} aria-hidden="true"><span>Invoice</span><span>Date</span><span>Status</span><span>Total</span><span>Due</span></div>{currentInvoices.map((invoice) => <Link className={styles.saved} href={`/shops/${currentShop.id}/invoices/${invoice.id}`} key={invoice.id} aria-label={`View invoice ${invoice.invoice_id}`}>
        <strong>{invoice.invoice_id}</strong><span>{invoice.business_date}</span><span className={styles.badge} data-tone={invoice.delivered ? invoice.effective_due_dirham <= 0 ? "success" : "warning" : undefined}>{invoice.delivered ? invoice.effective_due_dirham <= 0 ? "Delivered · paid" : "Delivered · due" : "Advance"}</span><span>QAR {formatQar(invoice.effective_total_dirham)}</span><span className={invoice.effective_due_dirham > 0 ? styles.due : undefined}>Due QAR {formatQar(invoice.effective_due_dirham)}</span>
      </Link>)}</div>}
      <p><Link href={`/invoices?shop=${currentShop.id}`}>View all invoices</Link></p>
      <form className={styles.exportForm} action="/exports/invoices" method="get">
        <input type="hidden" name="shop" value={currentShop.id} />
        <label>Export from<input type="date" name="from" defaultValue={currentDate} max={currentDate} required /></label>
        <label>Export to<input type="date" name="to" defaultValue={currentDate} max={currentDate} required /></label>
        <button type="submit" className={styles.secondary} disabled={!online}>Export invoices (.xlsx)</button>
      </form>
    </section>}
  </main>;
}
