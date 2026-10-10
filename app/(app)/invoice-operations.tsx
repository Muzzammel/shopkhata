"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlertIcon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { InvoiceDetail } from "@/lib/invoice-detail";
import { parseQar, formatQar } from "@/lib/domain/money";
import { previewTotalCorrection, type InvoiceOperation } from "@/lib/invoice-operations";
import { runInvoiceOperation } from "./invoice-operation-actions";
import { CustomerSearch } from "./customer-search";
import { InvoicePayment } from "./invoice-payment";
import styles from "@/app/ui.module.css";

type FieldErrors = { total?: string; amount?: string; reason?: string };
const qar = (dirham: number) => `QAR ${formatQar(dirham)}`;
const signedQar = (dirham: number) => `${dirham < 0 ? "−" : "+"}QAR ${formatQar(Math.abs(dirham))}`;
// Server refusals that are about one field are shown on that field as well as in the alert.
const FIELD_OF_CODE: Record<string, keyof FieldErrors> = { INVALID_FINANCIAL_RESULT: "total", CORRECTION_NO_CHANGE: "total" };

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <p id={id} data-slot="field-error" className="text-sm font-medium text-destructive">{message}</p> : null;
}

export function InvoiceOperations({ detail, permissions }: { detail: InvoiceDetail; permissions: { payment: boolean; requestCorrection: boolean; requestReplacement: boolean; approveCorrection: boolean; approveReplacement: boolean } }) {
  const router = useRouter();
  const [tab, setTab] = useState<"correction" | "replacement" | null>(null);
  const [reason, setReason] = useState("");
  const [corrected, setCorrected] = useState("");
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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState<{ operation: InvoiceOperation; command: Record<string, unknown> } | null>(null);
  const [paymentGuard, setPaymentGuard] = useState({ hasDraft: false, uncertain: false });
  const locked = busy || uncertain || paymentGuard.uncertain;

  // Preview only. The database derives and validates the correction from its own figures.
  const current = { totalDirham: detail.effectiveTotalDirham, paidDirham: detail.effectivePaidDirham, creditAppliedDirham: detail.effectiveCreditAppliedDirham };
  let correctedDirham: number | null = null;
  try { if (corrected.trim()) correctedDirham = parseQar(corrected.trim()); } catch { correctedDirham = null; }
  const preview = correctedDirham === null ? null : previewTotalCorrection(current, correctedDirham);

  async function execute(operation: InvoiceOperation, command: Record<string, unknown>) {
    if (active.current || (uncertain && pending?.command !== command)) return;
    active.current = true;
    setBusy(true); setMessage(""); setFieldErrors({}); setPending({ operation, command });
    try {
      const result = await runInvoiceOperation(operation, command, detail.id);
      if (result.ok) {
        setUncertain(false); setPending(null);
        toast.success("Operation confirmed and saved.");
        setTab(null); setReason(""); setCorrected(""); setDelta(""); router.refresh();
      } else {
        setUncertain(uncertain || result.uncertain); setMessage(result.message);
        const field = result.code ? FIELD_OF_CODE[result.code] : undefined;
        if (field) setFieldErrors({ [field]: result.message });
        // The figures on screen are out of date: reload them so the next request starts from the truth.
        if (result.code === "STALE_TOTAL" || result.code === "STALE_REVISION") router.refresh();
        toast.error(result.uncertain ? "Saving could not be confirmed." : "The request was not saved.");
        if (!uncertain && !result.uncertain) setPending(null);
      }
    } catch {
      setUncertain(true); setMessage("Status is uncertain. Retry the exact saved command.");
      toast.error("Saving could not be confirmed.");
    } finally { active.current = false; setBusy(false); }
  }

  function invalid(errors: FieldErrors) { setMessage(""); setFieldErrors(errors); }

  function request() {
    if (!reason.trim()) return invalid({ reason: "Enter the reason for this request." });
    const base = { shop_id: detail.shopId, invoice_id: detail.id, reason, idempotency_key: crypto.randomUUID() };
    if (tab === "replacement") {
      void execute("request_invoice_replacement", { ...base, expected_revision: detail.revision, invoice_number: number, customer_id: customer?.id ?? null, delivered });
    } else if (paymentId) {
      let amount: number;
      try { amount = parseQar(delta.trim()); } catch { return invalid({ amount: "Enter an amount in QAR with at most two decimals." }); }
      if (amount <= 0) return invalid({ amount: "Enter an amount greater than zero." });
      void execute("request_invoice_correction", { ...base, payment_id: paymentId, amount_delta_dirham: direction === "decrease" ? -amount : amount });
    } else {
      if (!preview || correctedDirham === null) return invalid({ total: "Enter the corrected invoice total in QAR with at most two decimals." });
      if (preview.error === "UNCHANGED") return invalid({ total: `The corrected total is the same as the current total (${qar(current.totalDirham)}).` });
      if (preview.error === "BELOW_SETTLED") return invalid({ total: `The corrected total cannot be less than the ${qar(current.paidDirham + current.creditAppliedDirham)} already paid on this invoice.` });
      // The corrected total is sent, never a difference: the database works out the difference itself.
      void execute("request_invoice_correction", { ...base, payment_id: null, expected_total_dirham: current.totalDirham, corrected_total_dirham: correctedDirham });
    }
  }

  function open(next: "correction" | "replacement") {
    setTab(next); setReason(""); setMessage(""); setFieldErrors({}); setCorrected(""); setDelta(""); setPaymentId("");
    setNumber(detail.invoiceNumber); setCustomer(detail.customer); setDelivered(detail.delivered);
  }

  return <>
    {permissions.payment && detail.effectiveDueDirham > 0 && <div id="record-payment">
      <InvoicePayment shopId={detail.shopId} disabled={busy || uncertain} initialInvoice={{ id: detail.id, invoiceNumber: detail.invoiceNumber, effectiveTotal: detail.effectiveTotalDirham, effectivePaid: detail.effectivePaidDirham, effectiveDue: detail.effectiveDueDirham }}
        onSaved={() => router.refresh()} onActivityChange={setBusy} onStateChange={setPaymentGuard} />
    </div>}
    <section className={styles.panel} aria-labelledby="invoice-operations-heading">
      <h2 id="invoice-operations-heading">Invoice operations</h2>
      <p className={styles.muted}>Committed records stay immutable. Requests take effect only after manager or owner approval.</p>
      <div className={styles.actions}>
        {permissions.requestCorrection && <Button variant="outline" disabled={locked || paymentGuard.hasDraft} onClick={() => open("correction")}>Request financial correction</Button>}
        {permissions.requestReplacement && <Button variant="outline" disabled={locked || paymentGuard.hasDraft} onClick={() => open("replacement")}>Request non-financial replacement</Button>}
      </div>
      {message && <Alert variant="destructive" className="border-destructive/50 bg-danger-soft">
        <CircleAlertIcon />
        <AlertTitle>{uncertain ? "Saving could not be confirmed" : "The request was not saved"}</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>}
      {uncertain && pending && <Button className="justify-self-start" disabled={busy} onClick={() => void execute(pending.operation, pending.command)}>Retry exact operation</Button>}
      {tab && <form noValidate aria-label={tab === "correction" ? "Financial correction request" : "Replacement request"} onSubmit={(event) => { event.preventDefault(); request(); }}>
        <fieldset disabled={locked} className="grid gap-4 rounded-lg border p-4">
          <legend className="px-1.5 text-sm font-semibold">{tab === "correction" ? "Financial correction request" : "Replacement request"}</legend>
          {tab === "correction" ? <>
            {detail.payments.length > 0 && <div className="grid gap-1.5 sm:max-w-sm">
              <Label htmlFor="correction-record">Correct record</Label>
              <NativeSelect id="correction-record" className="w-full" value={paymentId} onChange={(e) => { setPaymentId(e.target.value); setFieldErrors({}); }}>
                <NativeSelectOption value="">Invoice total</NativeSelectOption>
                {detail.payments.map((p) => <NativeSelectOption key={p.id} value={p.id}>Payment of {qar(p.amountDirham)} on {p.businessDate}</NativeSelectOption>)}
              </NativeSelect>
            </div>}
            {paymentId ? <div className="grid gap-4 sm:grid-cols-2 sm:max-w-xl">
              <div className="grid gap-1.5">
                <Label htmlFor="correction-direction">Adjustment direction</Label>
                <NativeSelect id="correction-direction" className="w-full" value={direction} onChange={(e) => setDirection(e.target.value)}>
                  <NativeSelectOption value="decrease">Decrease the payment by</NativeSelectOption>
                  <NativeSelectOption value="increase">Increase the payment by</NativeSelectOption>
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="correction-amount">Adjustment amount (QAR)</Label>
                <Input id="correction-amount" inputMode="decimal" className="text-right tabular-nums" value={delta} onChange={(e) => setDelta(e.target.value)} aria-invalid={Boolean(fieldErrors.amount)} aria-describedby={fieldErrors.amount ? "correction-amount-error" : undefined} />
                <FieldError id="correction-amount-error" message={fieldErrors.amount} />
              </div>
            </div> : <>
              <div className="grid gap-1.5 sm:max-w-sm">
                <Label htmlFor="correction-total">Corrected invoice total (QAR)</Label>
                <Input id="correction-total" inputMode="decimal" className="text-right tabular-nums" placeholder={formatQar(current.totalDirham)} value={corrected} onChange={(e) => { setCorrected(e.target.value); setFieldErrors({}); }} aria-invalid={Boolean(fieldErrors.total)} aria-describedby={fieldErrors.total ? "correction-total-error correction-total-hint" : "correction-total-hint"} />
                <p id="correction-total-hint" className="text-sm text-muted-foreground">Enter the total the invoice should have, not the amount to add or subtract.</p>
                <FieldError id="correction-total-error" message={fieldErrors.total} />
              </div>
              <dl aria-label="Correction summary" className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg bg-muted p-3 tabular-nums sm:grid-cols-5">
                {[
                  ["Current invoice total", qar(current.totalDirham), ""],
                  ["Corrected invoice total", correctedDirham === null ? "—" : qar(correctedDirham), ""],
                  ["Calculated difference", preview ? signedQar(preview.differenceDirham) : "—", ""],
                  ["Current payments", qar(current.paidDirham + current.creditAppliedDirham), ""],
                  ["Resulting due after correction", preview ? qar(preview.resultingDueDirham) : "—", preview && preview.resultingDueDirham < 0 ? "text-destructive" : ""],
                ].map(([label, value, tone]) => <div key={label} className="grid gap-0.5">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className={`text-base font-semibold ${tone}`}>{value}</dd>
                </div>)}
              </dl>
              {current.creditAppliedDirham > 0 && <p className="text-sm text-muted-foreground">Current payments include {qar(current.creditAppliedDirham)} of customer credit applied to this invoice.</p>}
            </>}
          </> : <div className={styles.operationFields}>
            <p>Based on approved version {detail.revision}. Financial amounts stay unchanged.</p>
            <label>Replacement invoice number<input value={number} onChange={(e) => setNumber(e.target.value)} maxLength={120} required /></label>
            <p>Requested customer: {customer ? `${customer.name ?? "Unnamed customer"} · ${customer.publicId}` : "No customer"}</p>
            <CustomerSearch key={tab} shopId={detail.shopId} disabled={locked} onSelect={(c) => setCustomer(c ? { id: c.id, name: c.name, mobile: c.mobile, publicId: c.public_id } : null)} />
            <button type="button" className={styles.secondary} onClick={() => setCustomer(null)}>Use no customer</button>
            <label><input type="checkbox" checked={delivered} onChange={(e) => setDelivered(e.target.checked)} />Replacement delivered</label>
          </div>}
          <div className="grid gap-1.5 sm:max-w-xl">
            <Label htmlFor="request-reason">Request reason</Label>
            <Textarea id="request-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} aria-invalid={Boolean(fieldErrors.reason)} aria-describedby={fieldErrors.reason ? "request-reason-error" : undefined} />
            <FieldError id="request-reason-error" message={fieldErrors.reason} />
          </div>
          <div className={styles.actions}>
            <Button type="submit">Submit request</Button>
            <Button type="button" variant="ghost" onClick={() => { setTab(null); setFieldErrors({}); }}>Cancel draft</Button>
          </div>
        </fieldset>
      </form>}
    </section>
    <section className={styles.panel} aria-labelledby="change-history-heading">
      <h2 id="change-history-heading">Requests and version history</h2>
      <p className={styles.muted}>Original version 0: {detail.originalInvoiceNumber}; customer {detail.originalCustomerId ?? "none"}; {detail.originalDelivered ? "delivered" : "advance"}. Current approved version {detail.revision}.</p>
      {!detail.changes.length && <p className={styles.empty}>No correction or replacement requests.</p>}
      <div className={styles.detailList}>{detail.changes.map((change) => <article key={change.id} aria-label={`${change.kind} request ${change.id}`}>
        <strong>{change.kind === "replacement" ? "Non-financial replacement" : "Financial correction"} — {change.decision?.outcome ?? "Pending approval"}</strong>
        <span>{change.reason}</span>
        {change.kind === "replacement" ? <span>Requested number {change.invoiceNumber}; customer {change.customerId ?? "none"}; {change.delivered ? "delivered" : "advance"}; based on version {change.expectedRevision}</span>
          : change.correctedTotal !== null && change.expectedTotal !== null ? <span>Invoice total: {qar(change.expectedTotal)} → {qar(change.correctedTotal)} ({signedQar(change.amountDelta!)})
            {!change.decision && change.expectedTotal !== detail.effectiveTotalDirham && <> <Badge variant="destructive">Out of date: total is now {qar(detail.effectiveTotalDirham)}</Badge></>}</span>
          : <span>{change.paymentId ? `Payment ${change.paymentId}` : "Invoice total"}: {signedQar(change.amountDelta!)}</span>}
        <span>Requested by {change.requestedBy} at {change.requestedAt}</span>
        {change.decision && <span>{change.decision.outcome} by {change.decision.actor} at {change.decision.at}{change.decision.revision !== null ? ` · version ${change.decision.revision}` : ""}{change.decision.reason ? ` · ${change.decision.reason}` : ""}</span>}
        {!change.decision && (change.kind === "replacement" ? permissions.approveReplacement : permissions.approveCorrection) && <form onSubmit={(e) => { e.preventDefault(); const data = new FormData(e.currentTarget); void execute(change.kind === "replacement" ? "decide_invoice_replacement" : "decide_invoice_correction", { shop_id: detail.shopId, request_id: change.id, expected_revision: detail.revision, decision: data.get("decision"), reason: data.get("decisionReason") || null, idempotency_key: crypto.randomUUID() }); }}>
          <fieldset disabled={locked || paymentGuard.hasDraft} className={styles.operationFields}>
            <label>Decision<select name="decision"><option value="approved">Approve</option><option value="rejected">Reject</option></select></label>
            <label>Decision reason (optional)<input name="decisionReason" maxLength={2000} /></label>
            <Button type="submit">Save decision</Button>
          </fieldset>
        </form>}
      </article>)}</div>
    </section>
  </>;
}
