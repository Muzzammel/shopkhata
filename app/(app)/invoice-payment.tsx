"use client";

import { useEffect, useState } from "react";

import { ui } from "@/components/sales/ui";
import { groupedQar, qar } from "@/lib/dashboard-view";
import { parseQar } from "@/lib/domain/money";
import { isValidPaymentReceipt, preparePaymentAttempt, type PaymentCommand } from "@/lib/invoice-payment";
import { cn } from "@/lib/utils";

import { lookupInvoiceForPayment, recordInvoicePayment, type PaymentLookup } from "./payment-actions";

type PaymentInvoice = Extract<PaymentLookup, { ok: true }>["invoice"];

export function InvoicePayment({ shopId, disabled, onSaved, onStateChange, onActivityChange, initialInvoice, variant = "card" }: {
  initialInvoice?: PaymentInvoice;
  /** "sheet": the bare flow, for a drawer that supplies its own title. */
  variant?: "card" | "sheet";
  shopId: string;
  disabled: boolean;
  onSaved: (payment: { invoiceId: string; effectiveDue: number }) => void;
  onStateChange: (state: { hasDraft: boolean; uncertain: boolean }) => void;
  onActivityChange: (active: boolean) => void;
}) {
  const preselected = Boolean(initialInvoice);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoice, setInvoice] = useState<PaymentInvoice | null>(initialInvoice ?? null);
  const [lookupMessage, setLookupMessage] = useState("");
  const [amount, setAmount] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [attempt, setAttempt] = useState<PaymentCommand | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);
  const sourceVersion = initialInvoice ? `${initialInvoice.id}:${initialInvoice.invoiceNumber}:${initialInvoice.effectiveTotal}:${initialInvoice.effectivePaid}:${initialInvoice.effectiveDue}` : "";
  const [lastSourceVersion, setLastSourceVersion] = useState(sourceVersion);
  if (sourceVersion !== lastSourceVersion && initialInvoice && !uncertain && !attempt && !busy) {
    setLastSourceVersion(sourceVersion);
    setInvoice(initialInvoice);
  }
  useEffect(() => {
    const hasDraft = !saved && Boolean(invoiceNumber.trim() || (!preselected && invoice) || amount.trim() || review);
    onStateChange({ hasDraft, uncertain });
  }, [amount, preselected, invoice, invoiceNumber, onStateChange, review, saved, uncertain]);

  // The number comes from the form field itself, so one typed before the page
  // finished loading (which never reached React state) is still looked up.
  async function lookup(typed: string) {
    if (disabled || busy || !typed.trim()) return;
    const invoiceNumber = typed;
    setInvoiceNumber(typed);
    const hasUncertainAttempt = uncertain && attempt !== null;
    if (!hasUncertainAttempt) {
      setInvoice(null);
      setAttempt(null);
      setReview(false);
      setMessage("");
      setSaved(false);
    }
    onActivityChange(true);
    setBusy(true);
    try {
      const result = await lookupInvoiceForPayment({ shopId, invoiceNumber });
      if (hasUncertainAttempt) {
        setLookupMessage("A payment is still pending. Retry that exact payment before starting another.");
        return;
      }
      if (result.ok) {
        setInvoice(result.invoice);
        setLookupMessage("");
        setAmount("");
        setIdempotencyKey(crypto.randomUUID());
      } else {
        setLookupMessage(result.message);
      }
    } finally {
      setBusy(false);
      onActivityChange(false);
    }
  }

  function editPayment() {
    if (uncertain) return;
    setAttempt(null);
    setReview(false);
    setMessage("");
    setSaved(false);
    setIdempotencyKey(crypto.randomUUID());
  }

  function reviewPayment() {
    if (!invoice || uncertain) return;
    const prepared = preparePaymentAttempt({
      shopId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      amount,
      idempotencyKey,
    }, invoice.effectiveDue, new Date(), attempt);
    if (!prepared.command) {
      setMessage(prepared.error ?? "Check the payment amount.");
      return;
    }
    setAttempt(prepared.command);
    setSaved(false);
    setMessage("");
    setReview(true);
  }

  async function savePayment() {
    if (!attempt || !invoice || busy || saved || disabled) return;
    onActivityChange(true);
    setBusy(true);
    try {
      const result = await recordInvoicePayment(attempt);
      if (!result.ok) {
        setUncertain(uncertain || result.uncertain);
        onStateChange({ hasDraft: true, uncertain: uncertain || result.uncertain });
        setMessage(result.message);
        return;
      }
      if (!isValidPaymentReceipt(result.receipt, attempt.invoice_id)) {
        setUncertain(true);
        onStateChange({ hasDraft: true, uncertain: true });
        setMessage("Payment status is uncertain. Retry the same payment command.");
        return;
      }
      setInvoice((current) => current?.id === attempt.invoice_id ? {
        ...current,
        effectivePaid: result.receipt.effective_paid,
        effectiveDue: result.receipt.effective_due,
      } : current);
      setAttempt(null);
      setUncertain(false);
      setReview(false);
      setAmount("");
      setIdempotencyKey(crypto.randomUUID());
      setSaved(true);
      setMessage("Payment recorded.");
      onStateChange({ hasDraft: false, uncertain: false });
      onSaved({ invoiceId: attempt.invoice_id, effectiveDue: result.receipt.effective_due });
    } catch {
      setUncertain(true);
      onStateChange({ hasDraft: true, uncertain: true });
      setMessage("Payment status is uncertain. Retry the same payment command.");
    } finally {
      setBusy(false);
      onActivityChange(false);
    }
  }

  // Display only: what would remain if the typed amount were paid. The amount itself is validated on review.
  let typedDirham: number | null = null;
  try { if (amount.trim()) typedDirham = parseQar(amount.trim()); } catch { typedDirham = null; }
  const remaining = (paid: number | null) => invoice && paid !== null ? invoice.effectiveDue - paid : null;

  const body = <div className="grid gap-4">
    {!initialInvoice && <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void lookup(String(new FormData(event.currentTarget).get("invoiceNumber") ?? "")); }}>
      <label data-slot="label" className="grid min-w-0 flex-[1_1_12rem] gap-1.5"><span className={ui.label}>Invoice number</span>
        <input data-slot="input" aria-label="Invoice number" name="invoiceNumber" required value={invoiceNumber} onChange={(event) => { if (!disabled && !busy) setInvoiceNumber(event.target.value); }} disabled={disabled || busy} maxLength={120} className={ui.field} />
      </label>
      <button data-slot="button" type="submit" className={ui.secondary} disabled={disabled || busy}>Find invoice</button>
    </form>}
    {lookupMessage && <p role="alert" className={ui.danger}>{lookupMessage}</p>}
    {invoice && <div className="grid gap-4">
      <div data-slot="payment-invoice" className="grid gap-3 rounded-2xl bg-muted p-4">
        <div className="flex items-baseline justify-between gap-3">
          {initialInvoice ? <p className="text-sm text-muted-foreground">Invoice <strong className="text-foreground">{invoice.invoiceNumber}</strong></p> : <h3 data-slot="heading" className="text-base font-semibold">{invoice.invoiceNumber}</h3>}
          <span className="text-xs text-muted-foreground">Outstanding now</span>
        </div>
        <p className={cn("text-3xl font-semibold tracking-tight tabular-nums", invoice.effectiveDue > 0 ? "text-warning" : "text-foreground")}><span className="text-sm font-medium opacity-70">QAR</span> {groupedQar(invoice.effectiveDue)}</p>
        <dl className="grid grid-cols-2 gap-2 text-xs text-muted-foreground tabular-nums">
          <div><dt>Invoice total</dt><dd className="text-sm font-semibold text-foreground">{qar(invoice.effectiveTotal)}</dd></div>
          <div><dt>Received so far</dt><dd className="text-sm font-semibold text-foreground">{qar(invoice.effectivePaid)}</dd></div>
        </dl>
      </div>
      {uncertain && attempt ? <div className="grid gap-3">
        <p role="alert" className={ui.warn}><strong className="block">Payment not confirmed yet</strong>Payment status is uncertain. This exact payment command is still pending. Retry it before starting another payment.</p>
        <button data-slot="button" type="button" className={ui.primary} onClick={savePayment} disabled={disabled || busy}>{busy ? "Retrying…" : "Retry payment"}</button>
      </div> : invoice.effectiveDue <= 0 ? <p role="alert" className={ui.ok}>Already paid — no amount due</p> : <>
        {!review && <div className="grid gap-4">
          <label data-slot="label" className="grid gap-1.5"><span className={ui.label}>Cash amount (QAR)</span>
            <input data-slot="input" aria-label="Cash amount (QAR)" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} disabled={disabled || busy} onChange={(event) => { if (disabled || busy) return; setAmount(event.target.value); if (attempt) editPayment(); }} className={cn(ui.field, ui.money, "h-14 text-2xl max-sm:h-14 max-sm:text-2xl")} />
          </label>
          <dl className="grid gap-2 rounded-2xl border border-border p-4 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Payment method</dt><dd className="font-semibold">Cash</dd></div>
            <div className="flex justify-between gap-3 tabular-nums"><dt className="text-muted-foreground">Remaining after payment</dt><dd className="font-semibold">{remaining(typedDirham) === null ? "—" : qar(Math.max(0, remaining(typedDirham)!))}</dd></div>
          </dl>
          <button data-slot="button" type="button" className={ui.primary} onClick={reviewPayment} disabled={disabled || busy}>Review payment</button>
        </div>}
        {review && attempt && <div className="grid gap-4">
          <h4 data-slot="heading" className="text-sm font-semibold">Review payment</h4>
          <dl className="grid gap-2 rounded-2xl border border-border p-4 text-sm tabular-nums">
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Invoice</dt><dd className="font-semibold">{invoice.invoiceNumber}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Payment method</dt><dd className="font-semibold">Cash</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Business date (Qatar)</dt><dd className="font-semibold">{attempt.business_date}</dd></div>
            <div className="flex justify-between gap-3 border-t border-border pt-2"><dt className="text-muted-foreground">Payment amount</dt><dd className="text-base font-semibold">{qar(attempt.amount_dirham)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Remaining after payment</dt><dd className="font-semibold">{qar(Math.max(0, invoice.effectiveDue - attempt.amount_dirham))}</dd></div>
          </dl>
          <p className="sr-only">Cash payment of {qar(attempt.amount_dirham)} for invoice {invoice.invoiceNumber}.</p>
          <div className="flex flex-wrap gap-2">
            <button data-slot="button" type="button" className={cn(ui.primary, "flex-1")} onClick={savePayment} disabled={disabled || busy || saved}>{busy ? "Saving…" : saved ? "Saved" : "Confirm payment"}</button>
            {!saved && <button data-slot="button" type="button" className={ui.secondary} onClick={editPayment} disabled={disabled || busy}>Edit</button>}
          </div>
        </div>}
      </>}
      {message && <p role={saved ? "status" : "alert"} className={saved ? ui.ok : ui.danger}>{message}</p>}
    </div>}
  </div>;

  if (variant === "sheet") return body;
  return <section id="invoice-payments" className={cn(ui.card, "grid content-start gap-4 p-5 sm:p-6")} aria-labelledby="payment-title">
    <div className="grid gap-1">
      <h2 id="payment-title" data-slot="heading" className="text-lg font-semibold tracking-tight">Record payment</h2>
      <p className="text-sm text-muted-foreground">Record cash against an existing invoice. This does not create an invoice.</p>
    </div>
    {body}
  </section>;
}
