"use client";

import { useState } from "react";

import { formatQar } from "@/lib/domain/money";
import { isValidPaymentReceipt, preparePaymentAttempt, type PaymentCommand } from "@/lib/invoice-payment";

import { lookupInvoiceForPayment, recordInvoicePayment, type PaymentLookup } from "./payment-actions";
import styles from "./invoice-entry.module.css";

type PaymentInvoice = Extract<PaymentLookup, { ok: true }>["invoice"];

export function InvoicePayment({ shopId }: { shopId: string }) {
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoice, setInvoice] = useState<PaymentInvoice | null>(null);
  const [lookupMessage, setLookupMessage] = useState("");
  const [amount, setAmount] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [attempt, setAttempt] = useState<PaymentCommand | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);

  async function lookup() {
    const hasUncertainAttempt = uncertain && attempt !== null;
    if (!hasUncertainAttempt) {
      setInvoice(null);
      setAttempt(null);
      setReview(false);
      setMessage("");
      setSaved(false);
    }
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
    if (!attempt || !invoice || busy || saved) return;
    setBusy(true);
    try {
      const result = await recordInvoicePayment(attempt);
      if (!result.ok) {
        setUncertain(result.uncertain);
        setMessage(result.message);
        return;
      }
      if (!isValidPaymentReceipt(result.receipt, attempt.invoice_id)) {
        setUncertain(true);
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
    } catch {
      setUncertain(true);
      setMessage("Payment status is uncertain. Retry the same payment command.");
    } finally {
      setBusy(false);
    }
  }

  return <section className={styles.panel} aria-labelledby="payment-title">
    <div className={styles.sectionHeading}>
      <div><p className={styles.eyebrow}>Existing invoice</p><h2 id="payment-title">Record Payment</h2></div>
      <p>Record cash against an existing invoice. This does not create an invoice.</p>
    </div>
    <form className={styles.lookup} onSubmit={(event) => { event.preventDefault(); void lookup(); }}>
      <label>Invoice number<input aria-label="Invoice number" value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} maxLength={120} /></label>
      <button type="submit" disabled={!invoiceNumber.trim() || busy}>Find invoice</button>
    </form>
    {lookupMessage && <p role="alert">{lookupMessage}</p>}
    {invoice && <div className={styles.paymentDetails}>
      <h3>{invoice.invoiceNumber}</h3>
      <div className={styles.totals}>
        <span>Effective total<strong>QAR {formatQar(invoice.effectiveTotal)}</strong></span>
        <span>Paid<strong>QAR {formatQar(invoice.effectivePaid)}</strong></span>
        <span>Due<strong>QAR {formatQar(invoice.effectiveDue)}</strong></span>
      </div>
      {uncertain && attempt ? <div className={styles.paymentReview}>
        <p role="alert">Payment status is uncertain. This exact payment command is still pending. Retry it before starting another payment.</p>
        <button type="button" onClick={savePayment} disabled={busy}>{busy ? "Retrying…" : "Retry payment"}</button>
      </div> : invoice.effectiveDue <= 0 ? <p role="alert" className={styles.paidWarning}>Already paid — no amount due</p> : <>
        {!review && <>
          <label className={styles.paymentAmount}>Cash amount (QAR)
            <input aria-label="Cash amount (QAR)" inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); if (attempt) editPayment(); }} />
          </label>
          <button type="button" onClick={reviewPayment}>Review payment</button>
        </>}
        {review && attempt && <div className={styles.paymentReview}>
          <h4>Review payment</h4>
          <p>Cash payment of QAR {formatQar(attempt.amount_dirham)} for invoice {invoice.invoiceNumber}.</p>
          <p>Business date: {attempt.business_date} (Qatar)</p>
          <div className={styles.actions}>
            <button type="button" onClick={savePayment} disabled={busy || saved}>{busy ? "Saving…" : saved ? "Saved" : "Confirm payment"}</button>
            {!saved && <button type="button" className={styles.secondary} onClick={editPayment} disabled={busy}>Edit</button>}
          </div>
        </div>}
      </>}
      {message && <p role={saved ? "status" : "alert"}>{message}</p>}
    </div>}
  </section>;
}
