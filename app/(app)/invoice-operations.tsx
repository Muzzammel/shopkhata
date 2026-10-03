"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { InvoiceDetail } from "@/lib/invoice-detail";
import { parseQar, formatQar } from "@/lib/domain/money";
import type { InvoiceOperation } from "@/lib/invoice-operations";
import { runInvoiceOperation } from "./invoice-operation-actions";
import { CustomerSearch } from "./customer-search";
import { InvoicePayment } from "./invoice-payment";
import styles from "./invoice-entry.module.css";

export function InvoiceOperations({ detail, permissions }: { detail: InvoiceDetail; permissions: { payment: boolean; requestCorrection: boolean; requestReplacement: boolean; approveCorrection: boolean; approveReplacement: boolean } }) {
  const router = useRouter();
  const [tab, setTab] = useState<"correction" | "replacement" | null>(null);
  const [reason, setReason] = useState("");
  const [delta, setDelta] = useState("");
  const [direction, setDirection] = useState("decrease");
  const [paymentId, setPaymentId] = useState("");
  const [number, setNumber] = useState(detail.invoiceNumber);
  const [customer, setCustomer] = useState(detail.customer);
  const [delivered, setDelivered] = useState(detail.delivered);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [pending, setPending] = useState<{ operation: InvoiceOperation; command: Record<string, unknown> } | null>(null);
  const [paymentGuard, setPaymentGuard] = useState({ hasDraft: false, uncertain: false });
  const locked = busy || uncertain || paymentGuard.uncertain;

  async function execute(operation: InvoiceOperation, command: Record<string, unknown>) {
    if (active.current || (uncertain && pending?.command !== command)) return;
    active.current = true;
    setBusy(true); setSuccess(false); setMessage(""); setPending({ operation, command });
    try {
      const result = await runInvoiceOperation(operation, command, detail.id);
      if (result.ok) {
        setUncertain(false); setPending(null); setSuccess(true); setMessage("Operation confirmed and saved.");
        setTab(null); setReason(""); setDelta(""); router.refresh();
      } else {
        setUncertain(uncertain || result.uncertain); setMessage(result.message);
        if (!uncertain && !result.uncertain) setPending(null);
      }
    } catch {
      setUncertain(true); setMessage("Status is uncertain. Retry the exact saved command.");
    } finally { active.current = false; setBusy(false); }
  }

  function request() {
    const base = { shop_id: detail.shopId, invoice_id: detail.id, reason, idempotency_key: crypto.randomUUID() };
    if (tab === "replacement") {
      void execute("request_invoice_replacement", { ...base, expected_revision: detail.revision, invoice_number: number, customer_id: customer?.id ?? null, delivered });
    } else {
      let amount: number;
      try { amount = parseQar(delta.trim()); } catch { setSuccess(false); setMessage("Enter a positive adjustment in QAR with at most two decimals."); return; }
      if (amount <= 0) { setSuccess(false); setMessage("Enter a positive adjustment amount."); return; }
      void execute("request_invoice_correction", { ...base, payment_id: paymentId || null, amount_delta_dirham: direction === "decrease" ? -amount : amount });
    }
  }

  return <>
    {permissions.payment && detail.effectiveDueDirham > 0 && <div id="record-payment">
      <InvoicePayment shopId={detail.shopId} disabled={busy || uncertain} initialInvoice={{ id: detail.id, invoiceNumber: detail.invoiceNumber, effectiveTotal: detail.effectiveTotalDirham, effectivePaid: detail.effectivePaidDirham, effectiveDue: detail.effectiveDueDirham }}
        onSaved={() => router.refresh()} onActivityChange={setBusy} onStateChange={setPaymentGuard} />
    </div>}
    <section className={styles.panel} aria-labelledby="invoice-operations-heading">
      <h2 id="invoice-operations-heading">Invoice operations</h2>
      <p>Committed records stay immutable. Requests take effect only after manager or owner approval.</p>
      <div className={styles.actions}>
        {permissions.requestCorrection && <button disabled={locked || paymentGuard.hasDraft} onClick={() => { setTab("correction"); setReason(""); setMessage(""); }}>Request financial correction</button>}
        {permissions.requestReplacement && <button disabled={locked || paymentGuard.hasDraft} onClick={() => { setTab("replacement"); setReason(""); setMessage(""); setNumber(detail.invoiceNumber); setCustomer(detail.customer); setDelivered(detail.delivered); }}>Request non-financial replacement</button>}
      </div>
      {tab && <form aria-label={tab === "correction" ? "Financial correction request" : "Replacement request"} onSubmit={(event) => { event.preventDefault(); request(); }}>
        <fieldset disabled={locked} className={styles.operationFields}>
          <legend>{tab === "correction" ? "Financial correction request" : "Replacement request"}</legend>
          {tab === "correction" ? <>
            <label>Correct record<select value={paymentId} onChange={(e) => setPaymentId(e.target.value)}><option value="">Invoice total</option>{detail.payments.map((p) => <option key={p.id} value={p.id}>Payment {p.id} — QAR {formatQar(p.amountDirham)}</option>)}</select></label>
            <label>Adjustment direction<select value={direction} onChange={(e) => setDirection(e.target.value)}><option value="decrease">Decrease</option><option value="increase">Increase</option></select></label>
            <label>Adjustment amount (QAR)<input inputMode="decimal" value={delta} onChange={(e) => setDelta(e.target.value)} required /></label>
          </> : <>
            <p>Based on approved version {detail.revision}. Financial amounts stay unchanged.</p>
            <label>Replacement invoice number<input value={number} onChange={(e) => setNumber(e.target.value)} maxLength={120} required /></label>
            <p>Requested customer: {customer ? `${customer.name ?? "Unnamed customer"} · ${customer.publicId}` : "No customer"}</p>
            <CustomerSearch key={tab} shopId={detail.shopId} disabled={locked} onSelect={(c) => setCustomer(c ? { id: c.id, name: c.name, mobile: c.mobile, publicId: c.public_id } : null)} />
            <button type="button" onClick={() => setCustomer(null)}>Use no customer</button>
            <label><input type="checkbox" checked={delivered} onChange={(e) => setDelivered(e.target.checked)} />Replacement delivered</label>
          </>}
          <label>Request reason<textarea value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={2000} /></label>
          <button type="submit">Submit request</button>
          <button type="button" onClick={() => setTab(null)}>Cancel draft</button>
        </fieldset>
      </form>}
      {message && <p role={success ? "status" : "alert"}>{message}</p>}
      {uncertain && pending && <button disabled={busy} onClick={() => void execute(pending.operation, pending.command)}>Retry exact operation</button>}
    </section>
    <section className={styles.panel} aria-labelledby="change-history-heading">
      <h2 id="change-history-heading">Requests and version history</h2>
      <p>Original version 0: {detail.originalInvoiceNumber}; customer {detail.originalCustomerId ?? "none"}; {detail.originalDelivered ? "delivered" : "advance"}. Current approved version {detail.revision}.</p>
      {!detail.changes.length && <p>No correction or replacement requests.</p>}
      <div className={styles.detailList}>{detail.changes.map((change) => <article key={change.id} aria-label={`${change.kind} request ${change.id}`}>
        <strong>{change.kind === "replacement" ? "Non-financial replacement" : "Financial correction"} — {change.decision?.outcome ?? "Pending approval"}</strong>
        <span>{change.reason}</span>
        {change.kind === "replacement" ? <span>Requested number {change.invoiceNumber}; customer {change.customerId ?? "none"}; {change.delivered ? "delivered" : "advance"}; based on version {change.expectedRevision}</span> : <span>{change.paymentId ? `Payment ${change.paymentId}` : "Invoice total"}: {change.amountDelta! < 0 ? "−" : "+"}QAR {formatQar(Math.abs(change.amountDelta!))}</span>}
        <span>Requested by {change.requestedBy} at {change.requestedAt}</span>
        {change.decision && <span>{change.decision.outcome} by {change.decision.actor} at {change.decision.at}{change.decision.revision !== null ? ` · version ${change.decision.revision}` : ""}{change.decision.reason ? ` · ${change.decision.reason}` : ""}</span>}
        {!change.decision && (change.kind === "replacement" ? permissions.approveReplacement : permissions.approveCorrection) && <form onSubmit={(e) => { e.preventDefault(); const data = new FormData(e.currentTarget); void execute(change.kind === "replacement" ? "decide_invoice_replacement" : "decide_invoice_correction", { shop_id: detail.shopId, request_id: change.id, expected_revision: detail.revision, decision: data.get("decision"), reason: data.get("decisionReason") || null, idempotency_key: crypto.randomUUID() }); }}>
          <fieldset disabled={locked || paymentGuard.hasDraft} className={styles.operationFields}>
            <label>Decision<select name="decision"><option value="approved">Approve</option><option value="rejected">Reject</option></select></label>
            <label>Decision reason (optional)<input name="decisionReason" maxLength={2000} /></label>
            <button type="submit">Save decision</button>
          </fieldset>
        </form>}
      </article>)}</div>
    </section>
  </>;
}
