"use client";

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { ChevronDownIcon, CircleCheckIcon, PencilLineIcon, PlusIcon, StoreIcon, Trash2Icon } from "lucide-react";

import { InvoiceBadges } from "@/components/sales/invoice-badges";
import { ui } from "@/components/sales/ui";
import { groupedQar, qar } from "@/lib/dashboard-view";

import { prepareInvoiceBatch, qatarBusinessDate, selectInvoiceAttempt, type EntryRow } from "@/lib/invoice-entry";
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
import { invoiceBadges } from "@/lib/sales-view";
import { parseQar } from "@/lib/domain/money";
import { cn } from "@/lib/utils";

/** Errors shown on their own input; any other row error is listed under the invoice. */
const ROW_FIELDS = ["invoiceId", "total", "received", "customer"];

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

/** Display only: a typed amount in dirham, or null while it is not a valid amount yet. */
function typedDirham(value: string): number | null {
  try { return value.trim() ? parseQar(value.trim()) : null; } catch { return null; }
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
  // Presentation only: which fields to show errors on, and what the last confirmed save created.
  const [touched, setTouched] = useState<Record<string, true>>({});
  const [attempted, setAttempted] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [lastSaved, setLastSaved] = useState<{ numbers: string[]; invoiced: number; received: number; due: number } | null>(null);
  // With several invoices only one form is open; the others show as summary cards.
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
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
    setTouched({});
    setAttempted(false);
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
      // Keep the address (and so the shell's shop label) on the shop now shown.
      window.history.replaceState(null, "", `/?shop=${result.workspace.shop.id}`);
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
        // Shown on the success panel: exactly what the confirmed submission contained.
        const sent = prepareInvoiceBatch(before.payload, [], true).totals;
        setLastSaved({ numbers: before.payload.rows.map((row) => row.invoiceId.trim()), invoiced: sent?.invoiced ?? 0, received: sent?.received ?? 0, due: sent?.due ?? 0 });
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
      const message = signedOut ? REAUTH_MESSAGE : "Sale was not saved. Try again with the same draft.";
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

  // Errors show on a field once it has been left, after a review attempt, or when the server reported them.
  const allErrors = [...preview.errors.filter((error) => attempted || touched[`${error.rowId}:${error.field}`]), ...(notice?.errors ?? [])];
  function fieldErrors(rowId: string, field: string): string[] {
    return [...new Set(allErrors.filter((error) => error.rowId === rowId && error.field === field).map((error) => error.message))];
  }
  function otherRowErrors(rowId: string): string[] {
    return [...new Set(allErrors.filter((error) => error.rowId === rowId && !ROW_FIELDS.includes(error.field)).map((error) => error.message))];
  }
  const blur = (rowId: string, field: string) => () => setTouched((current) => current[`${rowId}:${field}`] ? current : { ...current, [`${rowId}:${field}`]: true });
  const customerRequired = (rowId: string) => preview.errors.some((error) => error.rowId === rowId && error.field === "customer");
  const isDuplicate = (number: string) => duplicateNumbers.some((n) => normalizeInvoiceNumber(n) === normalizeInvoiceNumber(number));
  const locked = workspaceLocked || batchUncertain;
  const multiple = rows.length > 1;
  const deliveredCount = rows.filter((row) => row.delivered).length;
  const dateError = attempted ? preview.errors.find((error) => error.field === "backdatedReason" || error.field === "businessDate")?.message : undefined;
  const showSaved = Boolean(result?.ok && lastSaved);
  const activeId = rows.some((row) => row.rowId === activeRowId) ? activeRowId : rows[rows.length - 1]?.rowId;
  // Read from the workspace list already refreshed after the save; no link when it is not there.
  const savedInvoice = lastSaved?.numbers.length === 1 ? currentInvoices.find((invoice) => normalizeInvoiceNumber(invoice.invoice_id) === normalizeInvoiceNumber(lastSaved.numbers[0])) : undefined;

  function expandRow(rowId: string, index: number) {
    flushSync(() => setActiveRowId(rowId));
    document.getElementById(fid(index, "invoiceId"))?.focus();
  }

  function startReview() {
    setAttempted(true);
    if (preview.errors.length) {
      const firstInvalid = preview.errors.find((error) => rows.some((row) => row.rowId === error.rowId));
      if (firstInvalid) setActiveRowId(firstInvalid.rowId ?? null);
      setReview(false);
      setFocusRequest((n) => n + 1);
      return;
    }
    setReview(true);
  }

  // Move to the first invalid field; one short shake, skipped when motion is reduced.
  useEffect(() => {
    if (!focusRequest) return;
    const target = document.querySelector<HTMLElement>('[data-sale-entry] [aria-invalid="true"], [data-sale-entry] [data-invalid="true"] input:not(:disabled)');
    if (!target) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
    if (!still) target.animate?.([{ transform: "none" }, { transform: "translateX(-5px)" }, { transform: "translateX(5px)" }, { transform: "translateX(-3px)" }, { transform: "none" }], { duration: 280, easing: "ease-out" });
  }, [focusRequest]);

  // Ids follow the row position: row ids are random, so they would differ between server and client render.
  const fid = (index: number, field: string) => `sale-${index}-${field}`;
  const fieldProps = (row: EntryRow, index: number, field: string) => {
    const errors = fieldErrors(row.rowId, field);
    return {
      id: fid(index, field), "data-slot": "input", onBlur: blur(row.rowId, field), disabled: locked,
      "aria-invalid": errors.length > 0 || undefined, "aria-describedby": errors.length ? `${fid(index, field)}-error` : undefined,
      className: cn(ui.field, errors.length && "border-destructive"),
    };
  };
  const errorText = (row: EntryRow, index: number, field: string) => {
    const errors = fieldErrors(row.rowId, field);
    return errors.length ? <p id={`${fid(index, field)}-error`} className={ui.fieldError}>{errors.join(" ")}</p> : null;
  };
  const section = "grid min-w-0 grid-cols-1 content-start gap-3";
  const sectionTitle = "text-[11px] font-semibold tracking-widest text-muted-foreground uppercase";

  return <main className="mx-auto grid w-full max-w-[1280px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6">
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-1">
      <div>
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">{appName} · {actorName} · {actorRole}</p>
        <h1 id="entry-title" data-slot="heading" className="text-3xl font-semibold tracking-tight sm:text-4xl">New sale</h1>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-full border border-border bg-card py-1.5 pr-1.5 pl-4">
        <StoreIcon aria-hidden className="size-4 text-muted-foreground" />
        <h2 data-slot="heading" className="text-sm font-semibold">{currentShop.name}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">· {displayDate}</span>
        {actorRole === "owner" && shops.length > 1 && <label data-slot="label" className="ml-1 flex items-center">
          <span className="sr-only">Current shop</span>
          <select data-slot="select" aria-label="Current shop" value={currentShop.id} disabled={workspaceLocked || uncertain || offlineShell} onChange={(event) => void switchShop(event.target.value)} className="h-8 rounded-full border border-input bg-background px-3 text-[13px] font-medium disabled:opacity-60">{shops.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        </label>}
      </div>
    </header>
    {switchMessage && <p role="alert" className={ui.danger}>{switchMessage}</p>}
    {otherDraftShops.length > 0 && !offlineShell && <p className="flex flex-wrap gap-3 px-1 text-sm">{otherDraftShops.map((item) => <Link key={item.id} href={`/?shop=${item.id}`} className="font-semibold text-foreground">Unsaved draft in {item.name}</Link>)}</p>}

    <div role="region" aria-label="Sale entry" data-sale-entry className="grid min-w-0 grid-cols-1 items-start gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
      <div className="grid min-w-0 grid-cols-1 gap-4 [&>*]:min-w-0">
        <div className="flex min-h-6 flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[13px] text-muted-foreground empty:hidden">
          {statusLabel && <p role="status" data-draft-status className="inline-flex items-center gap-1.5 font-semibold text-foreground"><span aria-hidden className={cn("size-2 rounded-full", online ? "bg-success" : "bg-warning")} />{statusLabel}</p>}
          {restored && invoiceDraft && <span>Unsaved draft restored from this device.</span>}
          {(invoiceDraft || submission) && <button data-slot="button" type="button" className={cn(ui.quiet, "text-destructive hover:bg-danger-soft hover:text-destructive")} disabled={busy || switching} onClick={discardDraft}>Discard draft</button>}
        </div>

        <div className={cn(ui.card, "grid gap-4 p-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:p-5", displayBackdated && "border-warning/40")}>
          <label data-slot="label" className="grid content-start gap-1.5"><span className={ui.label}>Business date</span>
            <input data-slot="input" aria-label="Business date" type="date" max={currentDate} value={displayDate} disabled={actorRole !== "owner" || workspaceLocked || batchUncertain} onChange={(event) => { editDraft(); setSelectedBusinessDate(event.target.value); }} className={ui.field} />
            {actorRole !== "owner" && <span className="text-xs text-muted-foreground">Today in Qatar. Only an owner can record an earlier date.</span>}
          </label>
          {displayBackdated ? <label data-slot="label" className="grid content-start gap-1.5"><span className={ui.label}>Reason for backdated entry</span>
            <input data-slot="input" aria-label="Backdate reason" required maxLength={1000} value={displayReason} disabled={workspaceLocked || batchUncertain} aria-invalid={Boolean(dateError) || undefined} onChange={(event) => { editDraft(); setBackdatedReason(event.target.value); }} className={ui.field} />
            <span className={dateError ? ui.fieldError : "text-xs text-warning"}>{dateError ?? `Backdated to ${displayDate}. The reason is kept on the record.`}</span>
          </label> : <p className="self-center text-[13px] text-muted-foreground">Every invoice below is recorded on this business date.</p>}
        </div>

        {rows.map((row, index) => {
          const required = customerRequired(row.rowId);
          const customerErrors = fieldErrors(row.rowId, "customer");
          const others = otherRowErrors(row.rowId);
          const heading = <h3 data-slot="heading" className="flex min-w-0 items-center gap-2.5 text-base font-semibold">
            {multiple && <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground tabular-nums">{index + 1}</span>}
            <span className="truncate">{row.invoiceId.trim() || (multiple ? `Invoice ${index + 1}` : "Invoice details")}</span>
          </h3>;
          const remove = multiple && <button data-slot="button" type="button" className={cn(ui.quiet, "text-destructive hover:bg-danger-soft hover:text-destructive")} disabled={locked} aria-label={`Remove invoice ${index + 1}`} onClick={() => { setRows((current) => current.filter((item) => item.rowId !== row.rowId)); editDraft(); }}><Trash2Icon aria-hidden />Remove</button>;
          const duplicate = isDuplicate(row.invoiceId) && <DuplicateInvoiceWarning key={`${currentShop.id}:${row.invoiceId}`} shopId={currentShop.id} number={row.invoiceId} />;

          if (multiple && row.rowId !== activeId) {
            // Collapsed: the figures at a glance, with every error and warning still shown.
            const total = typedDirham(row.total);
            const received = typedDirham(row.received) ?? 0;
            const customer = customers[row.rowId]?.name ?? (row.customerName.trim() || null);
            const errors = [...new Set(allErrors.filter((error) => error.rowId === row.rowId).map((error) => error.message))];
            return <article key={row.rowId} data-entry-row data-compact data-row-id={hydrated ? row.rowId : undefined} aria-label={`Invoice ${index + 1}`} className={cn(ui.card, "grid grid-cols-1 gap-3 p-4 sm:px-6", errors.length > 0 && "border-destructive/40")}>
              <div className="flex items-center justify-between gap-3">
                {heading}
                <div className="flex shrink-0 items-center gap-1">
                  <button data-slot="button" type="button" className={ui.quiet} disabled={locked} aria-label={`Edit invoice ${index + 1}`} onClick={() => expandRow(row.rowId, index)}><PencilLineIcon aria-hidden />Edit</button>
                  {remove}
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm tabular-nums sm:grid-cols-4">
                <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Total</dt><dd className="font-semibold">{total === null ? "—" : qar(total)}</dd></div>
                <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Received</dt><dd className="font-semibold">{qar(received)}</dd></div>
                <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Due</dt><dd className={cn("font-semibold", total !== null && total - received > 0 && "text-warning")}>{total === null ? "—" : qar(total - received)}</dd></div>
                <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Delivery</dt><dd className="font-semibold">{row.delivered ? "Delivered" : "Not delivered"}</dd></div>
              </dl>
              {customer && <p className="text-[13px] text-muted-foreground">Customer <strong className="font-semibold text-foreground">{customer}</strong></p>}
              {duplicate}
              {errors.length > 0 && <ul className="grid list-none gap-1 pl-0">{errors.map((message, i) => <li key={i} className={ui.fieldError}>{message}</li>)}</ul>}
            </article>;
          }

          return <article key={row.rowId} data-entry-row data-row-id={hydrated ? row.rowId : undefined} aria-label={multiple ? `Invoice ${index + 1}` : "Invoice"} className={cn(ui.card, "grid grid-cols-1 gap-5 p-4 sk-enter sm:p-6")}>
            <div className="flex items-center justify-between gap-3">
              {heading}
              {remove}
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <div className={section}>
                <p className={sectionTitle}>Invoice identity</p>
                <div className="grid gap-1.5"><label htmlFor={fid(index, "invoiceId")} className={ui.label} data-slot="label">Invoice ID</label>
                  <input {...fieldProps(row, index, "invoiceId")} autoComplete="off" value={row.invoiceId} onChange={(event) => updateRow(row.rowId, { invoiceId: event.target.value })} />
                  {errorText(row, index, "invoiceId")}
                </div>
              </div>
              <div className={section}>
                <p className={sectionTitle}>Amount</p>
                <div className="grid gap-1.5"><label htmlFor={fid(index, "total")} className={ui.label} data-slot="label">Total QAR</label>
                  <input {...fieldProps(row, index, "total")} inputMode="decimal" autoComplete="off" placeholder="0.00" value={row.total} onChange={(event) => updateRow(row.rowId, { total: event.target.value })} className={cn(fieldProps(row, index, "total").className, ui.money, "text-lg")} />
                  {errorText(row, index, "total")}
                </div>
              </div>
              <div className={section}>
                <p className={sectionTitle}>Payment</p>
                <div className="grid gap-1.5"><label htmlFor={fid(index, "received")} className={ui.label} data-slot="label">Received QAR</label>
                  <input {...fieldProps(row, index, "received")} inputMode="decimal" autoComplete="off" placeholder="0.00" value={row.received} onChange={(event) => updateRow(row.rowId, { received: event.target.value })} className={cn(fieldProps(row, index, "received").className, ui.money)} />
                  {errorText(row, index, "received")}
                </div>
                <p className="flex items-center justify-between rounded-xl bg-muted px-3.5 py-2.5 text-sm"><span className="text-muted-foreground">Payment method</span><strong className="font-semibold">Cash</strong></p>
              </div>
              <div className={section}>
                <p className={sectionTitle}>Delivery</p>
                <label data-slot="label" className={cn("flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-input px-3.5 text-sm font-medium sk-press has-[:checked]:border-foreground has-[:checked]:bg-muted max-sm:min-h-12", locked && "cursor-not-allowed opacity-60")}>
                  <input data-slot="checkbox" type="checkbox" className="size-5 accent-[var(--primary)]" disabled={locked} checked={row.delivered} onChange={(event) => updateRow(row.rowId, { delivered: event.target.checked })} />Delivered
                </label>
                <p className="text-xs text-muted-foreground">{row.delivered ? "Goods handed over with this sale." : "Not delivered yet — recorded as an advance."}</p>
              </div>
            </div>

            <div className={section} data-invalid={customerErrors.length > 0 || undefined}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className={sectionTitle}>Customer</p>
                {required && <span className={cn("text-xs font-semibold", customerErrors.length ? "text-destructive" : "text-warning")}>Customer required</span>}
              </div>
              <div className="grid grid-cols-1 gap-4 rounded-2xl border border-border p-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <CustomerSearch key={`${currentShop.id}-${row.rowId}`} shopId={currentShop.id} disabled={locked} initial={row.customerId ? customers[row.rowId] ?? null : null} onSelect={(customer) => {
                    setCustomers((current) => {
                      const next = { ...current };
                      if (customer) next[row.rowId] = customer; else delete next[row.rowId];
                      return next;
                    });
                    updateRow(row.rowId, { customerId: customer?.id ?? "", customerName: "", customerMobile: "" });
                  }} />
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">Or add a new customer:</p>
                <div className="grid gap-1.5"><label htmlFor={fid(index, "customerName")} className={ui.label} data-slot="label">New customer name</label>
                  <input id={fid(index, "customerName")} data-slot="input" className={ui.field} value={row.customerName} disabled={locked || Boolean(row.customerId)} onChange={(event) => updateRow(row.rowId, { customerName: event.target.value })} />
                </div>
                <div className="grid gap-1.5"><label htmlFor={fid(index, "customerMobile")} className={ui.label} data-slot="label">New customer mobile</label>
                  <input id={fid(index, "customerMobile")} data-slot="input" inputMode="tel" className={ui.field} value={row.customerMobile} disabled={locked || Boolean(row.customerId)} onChange={(event) => updateRow(row.rowId, { customerMobile: event.target.value })} />
                </div>
              </div>
              {customerErrors.length > 0 && <p className={ui.fieldError}>{customerErrors.join(" ")}</p>}
            </div>

            <div className={section}>
              <p className={sectionTitle}>Notes</p>
              <div className="grid gap-1.5"><label htmlFor={fid(index, "note")} className="sr-only" data-slot="label">Note</label>
                <input id={fid(index, "note")} data-slot="input" placeholder="Optional note for this invoice" className={ui.field} value={row.note ?? ""} maxLength={1000} disabled={locked} onChange={(event) => updateRow(row.rowId, { note: event.target.value })} />
              </div>
            </div>

            {duplicate}
            {others.length > 0 && <ul className="grid list-none gap-1 pl-0">{others.map((message, i) => <li key={i} className={ui.fieldError}>{message}</li>)}</ul>}
          </article>;
        })}

        <button data-slot="button" type="button" className="flex min-h-14 items-center justify-center gap-2 rounded-3xl border border-dashed border-input bg-transparent text-sm font-semibold text-foreground sk-press hover:border-foreground hover:bg-card disabled:pointer-events-none disabled:opacity-50" disabled={locked} onClick={() => { const next = emptyRow(); setRows((current) => [...current, next]); setActiveRowId(next.rowId); editDraft(); }}><PlusIcon aria-hidden className="size-4" />Add another invoice</button>
      </div>

      <aside id="sale-summary" aria-label="Sale summary" className="grid min-w-0 gap-4 lg:sticky lg:top-[81px]">
        {showSaved && lastSaved && <section role="status" aria-live="polite" className="grid gap-3 rounded-3xl border border-success/30 bg-success-soft p-5 sk-pop">
          <p className="flex items-center gap-2 text-sm font-semibold text-success"><CircleCheckIcon aria-hidden className="size-5" />{lastSaved.numbers.length === 1 ? "Sale saved" : `${lastSaved.numbers.length} invoices saved`}</p>
          <p className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">{lastSaved.numbers.join(", ")}</p>
          <p className="text-sm text-muted-foreground tabular-nums">{qar(lastSaved.invoiced)} invoiced · {qar(lastSaved.received)} received · {qar(lastSaved.due)} due. Confirmed by ShopKhata.</p>
          <div className="flex flex-wrap gap-2">
            <button data-slot="button" type="button" className={ui.primary} onClick={() => { setResult(null); document.getElementById(fid(0, "invoiceId"))?.focus(); }}>New sale</button>
            {!offlineShell && savedInvoice && <Link href={`/shops/${currentShop.id}/invoices/${savedInvoice.id}`} aria-label={`View invoice ${savedInvoice.invoice_id}`} className={ui.secondary}>View invoice</Link>}
            {!offlineShell && <Link href={`/invoices?shop=${currentShop.id}`} className={ui.secondary}>View sales</Link>}
          </div>
        </section>}

        <section aria-labelledby="summary-title" className={cn(ui.card, "grid gap-4 p-5")}>
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="summary-title" data-slot="heading" className="text-base font-semibold">Summary</h2>
            {multiple && <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold tabular-nums">{rows.length} invoices</span>}
          </div>
          <div className="grid gap-1 rounded-2xl bg-ink p-4 text-ink-foreground">
            <span className="text-xs text-ink-muted">Total invoiced</span>
            <strong className="text-3xl font-semibold tracking-tight tabular-nums"><span className="text-sm font-medium opacity-65">QAR</span> {groupedQar(preview.totals?.invoiced ?? 0)}</strong>
          </div>
          <dl className="grid gap-2 text-sm tabular-nums">
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Received (cash)</dt><dd className="font-semibold">{qar(preview.totals?.received ?? 0)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Due</dt><dd className={cn("font-semibold", (preview.totals?.due ?? 0) > 0 && "text-warning")}>{qar(preview.totals?.due ?? 0)}</dd></div>
            <div className="flex justify-between gap-3 border-t border-border pt-2"><dt className="text-muted-foreground">Delivery</dt><dd className="font-semibold">{deliveredCount === 0 ? "Not delivered" : deliveredCount === rows.length ? "Delivered" : `${deliveredCount} of ${rows.length} delivered`}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Customer</dt><dd className="text-right font-semibold">{rows.some((row) => customerRequired(row.rowId)) ? <span className="text-warning">Required{multiple ? ` for ${rows.map((row, i) => customerRequired(row.rowId) ? `#${i + 1}` : "").filter(Boolean).join(", ")}` : ""}</span> : "Optional"}</dd></div>
          </dl>
          {multiple && <ol className="grid list-none gap-1 border-t border-border pt-3 pl-0 text-[13px] tabular-nums">
            {rows.map((row, i) => <li key={row.rowId}><button data-slot="button" type="button" className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-muted" onClick={() => expandRow(row.rowId, i)}>
              <span className="truncate"><span className="text-muted-foreground">#{i + 1}</span> {row.invoiceId.trim() || "No number yet"}</span><span className="text-muted-foreground">{row.total.trim() ? `QAR ${row.total.trim()}` : "—"}</span>
            </button></li>)}
          </ol>}
          {displayBackdated && <p className={ui.warn}>Backdated to <strong>{displayDate}</strong>. Owner-only, with a recorded reason.</p>}
          {rows.some((row) => isDuplicate(row.invoiceId)) && <p className={ui.warn}>An invoice number here already exists in {currentShop.name}. It cannot be created again.</p>}
          {attempted && preview.errors.length > 0 && <p role="alert" className={ui.danger}>{preview.errors.find((error) => error.field === "rows")?.message ?? `Fix ${preview.errors.length} row error${preview.errors.length === 1 ? "" : "s"} before saving.`}</p>}
          {!review && <button data-slot="button" type="button" className={cn(ui.primary, "w-full")} disabled={workspaceLocked} onClick={startReview}>Review sale</button>}
        </section>

        {review && <section aria-label="Sale review" className={cn(ui.card, "grid gap-4 border-foreground/25 p-5 sk-enter")}>
          <div className="grid gap-0.5">
            <h3 data-slot="heading" className="text-base font-semibold">Review before saving</h3>
            <p className="text-[13px] text-muted-foreground">Business date <strong className="text-foreground">{displayDate}</strong>{displayBackdated && <> · <strong className="text-foreground">Backdated</strong> · Reason: {displayReason.trim()}</>}</p>
          </div>
          {preview.command && <ul className="grid list-none divide-y divide-border pl-0 text-sm tabular-nums">{preview.command.rows.map((row) => <li key={row.row_id} className="grid gap-0.5 py-2 first:pt-0">
            <div className="flex justify-between gap-3"><strong className="[overflow-wrap:anywhere]">{row.invoice_number}</strong><span>{qar(row.total_dirham)}</span></div>
            <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground"><span>{row.delivered ? "Delivered" : "Not delivered"} · Cash</span><span>Received {qar(row.received_dirham)}</span><span>Due {qar(row.total_dirham - row.received_dirham)}</span></div>
          </li>)}</ul>}
          {preview.totals && <dl className="grid grid-cols-3 gap-2 rounded-2xl bg-muted p-3 text-center tabular-nums">
            <div><dt className="text-[11px] text-muted-foreground">Invoiced</dt><dd className="text-sm font-semibold">{qar(preview.totals.invoiced)}</dd></div>
            <div><dt className="text-[11px] text-muted-foreground">Received</dt><dd className="text-sm font-semibold">{qar(preview.totals.received)}</dd></div>
            <div><dt className="text-[11px] text-muted-foreground">Due</dt><dd className="text-sm font-semibold">{qar(preview.totals.due)}</dd></div>
          </dl>}
          {preview.errors.length ? <p role="alert" className={ui.danger}>{preview.errors.find((error) => error.field === "rows")?.message ?? `Fix ${preview.errors.length} row error${preview.errors.length === 1 ? "" : "s"} before saving.`}</p> : <div className="flex flex-wrap gap-2">
            <button data-slot="button" type="button" className={cn(ui.primary, "flex-1")} disabled={workspaceLocked} onClick={save}>{busy ? "Saving…" : submission ? "Retry same sale" : online ? (multiple ? `Save ${rows.length} invoices` : "Save sale") : "Save when back online"}</button>
            {submission?.status === "queued" ? <button data-slot="button" type="button" className={ui.secondary} disabled={workspaceLocked} onClick={editDraft}>Edit draft</button>
              : !submission && <button data-slot="button" type="button" className={ui.secondary} disabled={workspaceLocked} onClick={() => setReview(false)}>Back</button>}
          </div>}
        </section>}

        {notice && !showSaved && <p role={notice.ok ? "status" : "alert"} className={notice.ok ? ui.ok : ui.danger}>{notice.message}{conflict?.kind === "reauth" && <> <a href={`/login?next=${encodeURIComponent(`/?shop=${currentShop.id}`)}`} className="font-semibold text-foreground">Sign in again</a></>}</p>}
      </aside>
    </div>

    {/* Phones: totals stay in reach while scrolling the invoices. */}
    {!review && invoiceDraft && <div className="sticky bottom-[calc(5.75rem+env(safe-area-inset-bottom))] z-20 flex items-center justify-between gap-3 rounded-full border border-border bg-card/95 py-2 pr-2 pl-5 shadow-[var(--shadow-lift)] backdrop-blur lg:hidden">
      <span className="grid text-xs text-muted-foreground tabular-nums">{multiple ? `${rows.length} invoices` : "Total"}<strong className="text-base text-foreground">{qar(preview.totals?.invoiced ?? 0)}</strong></span>
      <a href="#sale-summary" className={cn(ui.primary, "min-h-10 px-4 max-sm:min-h-11")}>Go to summary</a>
    </div>}

    {/* Secondary utilities stay mounted while collapsed, so payment state and guards keep working. */}
    <details data-sale-tools open={toolsOpen} onToggle={(event) => setToolsOpen(event.currentTarget.open)} className="group/tools">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-3xl border border-border bg-card px-5 sk-press hover:bg-muted/60 [&::-webkit-details-marker]:hidden sm:px-6">
        <span className="grid min-w-0 gap-0.5">
          <span className="text-[15px] font-semibold"><span className="lg:hidden">More tools</span><span className="max-lg:hidden">Other tools</span></span>
          <span className="truncate text-xs text-muted-foreground">{offlineShell ? "Import Excel" : "Import Excel · Record payment · Recent invoices · Export"}</span>
        </span>
        <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open/tools:rotate-180" />
      </summary>
      <div className="mt-4 grid grid-cols-1 items-start gap-4 sm:mt-5 sm:gap-5 lg:grid-cols-2">
      <div className="min-w-0 lg:col-span-2"><ExcelImport disabled={locked} currentRows={rows} draftIsBlank={!invoiceDraft} onApply={applyImport} validate={(candidate) => prepareInvoiceBatch({
        shopId: currentShop.id, businessDate: displayDate, isBackdated: displayBackdated, backdatedReason: displayReason, idempotencyKey: key, rows: candidate,
      }, duplicateNumbers, false, currentDate).errors} /></div>
      {!offlineShell && <>
      <InvoicePayment key={currentShop.id} shopId={currentShop.id} disabled={switching || busy} onActivityChange={reportPaymentActivity} onSaved={({ invoiceId, effectiveDue }) => {
        const generation = workspaceGenerationRef.current;
        if (!workspaceIsCurrent(currentShop.id, generation)) return;
        setCurrentInvoices((current) => current.map((invoice) => invoice.id === invoiceId
          ? { ...invoice, effective_due_dirham: effectiveDue }
          : invoice));
      }} onStateChange={reportPaymentGuard} />
      <section id="recent-invoices" className={cn(ui.card, "grid content-start gap-4 p-5 sm:p-6")} aria-labelledby="recent-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="recent-title" data-slot="heading" className="text-lg font-semibold tracking-tight">Recent invoices</h2>
          <p className="text-xs text-muted-foreground">{currentShop.name} · last 30 days</p>
        </div>
        {!online && <p className={ui.warn}>Offline — this list was loaded earlier and may be out of date.</p>}
        {currentInvoices.length === 0 ? <p className="py-4 text-sm text-muted-foreground">No invoices in the last 30 days.</p> : <ul className="-mx-2 grid max-h-[26rem] list-none overflow-y-auto pl-0">{currentInvoices.map((invoice) => <li key={invoice.id}>
          <Link href={`/shops/${currentShop.id}/invoices/${invoice.id}`} aria-label={`View invoice ${invoice.invoice_id}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-xl px-2 py-2.5 text-foreground no-underline transition-colors duration-150 hover:bg-muted">
            <strong className="truncate font-semibold">{invoice.invoice_id}</strong>
            <span className="text-right text-sm font-semibold tabular-nums">{qar(invoice.effective_total_dirham)}</span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{invoice.business_date}<InvoiceBadges badges={invoiceBadges({ dueDirham: invoice.effective_due_dirham, delivered: invoice.delivered, corrected: false, revision: 0 })} /></span>
            <span className={cn("text-right text-xs tabular-nums", invoice.effective_due_dirham > 0 ? "font-semibold text-warning" : "text-muted-foreground")}>Due {qar(invoice.effective_due_dirham)}</span>
          </Link>
        </li>)}</ul>}
        <Link href={`/invoices?shop=${currentShop.id}`} className="justify-self-start text-sm font-semibold text-foreground">View all sales</Link>
        <form className="flex flex-wrap items-end gap-2 border-t border-border pt-4" action="/exports/invoices" method="get">
          <input type="hidden" name="shop" value={currentShop.id} />
          <label data-slot="label" className="grid gap-1"><span className="text-xs text-muted-foreground">Export from</span><input data-slot="input" type="date" name="from" defaultValue={currentDate} max={currentDate} required className={cn(ui.field, "h-10 w-40")} /></label>
          <label data-slot="label" className="grid gap-1"><span className="text-xs text-muted-foreground">Export to</span><input data-slot="input" type="date" name="to" defaultValue={currentDate} max={currentDate} required className={cn(ui.field, "h-10 w-40")} /></label>
          <button data-slot="button" type="submit" className={cn(ui.secondary, "min-h-10")} disabled={!online}>Export invoices (.xlsx)</button>
        </form>
      </section>
      </>}
      </div>
    </details>
  </main>;
}
