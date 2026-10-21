"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { CircleAlertIcon, EllipsisIcon, HandCoinsIcon, PencilLineIcon, PrinterIcon, RepeatIcon, TruckIcon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Drawer } from "@/components/shell/drawer";
import { ui } from "@/components/sales/ui";
import { qar } from "@/lib/dashboard-view";
import type { InvoiceDetail } from "@/lib/invoice-detail";
import { parseQar, formatQar } from "@/lib/domain/money";
import { previewTotalCorrection, type InvoiceOperation } from "@/lib/invoice-operations";
import { customerLabel, personLabel, qatarDateTime, signedQar } from "@/lib/sales-view";
import { cn } from "@/lib/utils";
import { runInvoiceOperation } from "./invoice-operation-actions";
import { CustomerSearch } from "./customer-search";
import { InvoicePayment } from "./invoice-payment";

type FieldErrors = { total?: string; amount?: string; reason?: string };
type RequestKind = "correction" | "replacement" | "delivery";
// Server refusals that are about one field are shown on that field as well as in the alert.
const FIELD_OF_CODE: Record<string, keyof FieldErrors> = { INVALID_FINANCIAL_RESULT: "total", CORRECTION_NO_CHANGE: "total" };
const TITLE: Record<RequestKind, string> = { correction: "Request correction", replacement: "Request replacement", delivery: "Request delivery change" };
const FORM_NAME: Record<RequestKind, string> = { correction: "Correction request", replacement: "Replacement request", delivery: "Delivery change request" };
const deliveryText = (delivered: boolean) => delivered ? "Delivered" : "Not delivered";
const noSubscription = () => () => {};

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <p id={id} data-slot="field-error" className={ui.fieldError}>{message}</p> : null;
}

/** Current, requested and difference side by side, so a reviewer never has to work it out. */
export function Comparison({ rows, label }: { rows: { label: string; current: string; requested: string }[]; label: string }) {
  return <table data-slot="comparison" aria-label={label} className="w-full border-separate border-spacing-0 overflow-hidden rounded-2xl border border-border text-sm tabular-nums">
    <thead><tr className="bg-muted text-xs text-muted-foreground"><th data-slot="cell" scope="col" className="px-3 py-2 text-left font-medium"><span className="sr-only">Field</span></th><th data-slot="cell" scope="col" className="px-3 py-2 text-left font-medium">Current</th><th data-slot="cell" scope="col" className="px-3 py-2 text-left font-medium">Requested</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.label}><th data-slot="cell" scope="row" className="border-t border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground">{row.label}</th><td data-slot="cell" className="border-t border-border px-3 py-2">{row.current}</td><td data-slot="cell" className={cn("border-t border-border px-3 py-2 font-semibold", row.current !== row.requested && "bg-yellow-soft/60")}>{row.requested}</td></tr>)}</tbody>
  </table>;
}

export function InvoiceOperations({ detail, permissions }: {
  detail: InvoiceDetail;
  permissions: { payment: boolean; requestCorrection: boolean; requestReplacement: boolean; approveCorrection: boolean; approveReplacement: boolean };
}) {
  const router = useRouter();
  const [tab, setTab] = useState<RequestKind | null>(null);
  const [paying, setPaying] = useState(false);
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
  // Until hydrated a click would do nothing, so the controls start disabled instead of silently dead.
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);
  const locked = busy || uncertain || paymentGuard.uncertain || !hydrated;
  const canPay = permissions.payment && detail.effectiveDueDirham > 0;
  const awaiting = detail.changes.filter((change) => !change.decision);

  // Preview only. The database derives and validates the correction from its own figures.
  const current = { totalDirham: detail.effectiveTotalDirham, paidDirham: detail.effectivePaidDirham, creditAppliedDirham: detail.effectiveCreditAppliedDirham };
  let correctedDirham: number | null = null;
  try { if (corrected.trim()) correctedDirham = parseQar(corrected.trim()); } catch { correctedDirham = null; }
  const preview = correctedDirham === null ? null : previewTotalCorrection(current, correctedDirham);

  // "Record payment" links elsewhere in the app land here with #record-payment.
  useEffect(() => {
    const sync = () => { if (canPay && window.location.hash === "#record-payment") setPaying(true); };
    const frame = requestAnimationFrame(sync);
    window.addEventListener("hashchange", sync);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("hashchange", sync); };
  }, [canPay]);

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
    if (tab === "replacement" || tab === "delivery") {
      // A delivery change is an ordinary replacement request that keeps the current number and customer.
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

  function open(next: RequestKind) {
    setTab(next); setReason(""); setMessage(""); setFieldErrors({}); setCorrected(""); setDelta(""); setPaymentId("");
    setNumber(detail.invoiceNumber); setCustomer(detail.customer);
    // The shortcut arrives with the opposite delivery state already chosen; it is still only a request.
    setDelivered(next === "delivery" ? !detail.delivered : detail.delivered);
  }

  // An in-flight save, or a payment whose outcome is unknown, keeps its drawer open: closing would lose the exact command to retry.
  const closeRequest = (next: boolean) => { if (!next && !busy) { setTab(null); setFieldErrors({}); } };
  const closePayment = (next: boolean) => { if (next || !(busy || paymentGuard.uncertain)) setPaying(next); };

  const failure = message && <Alert variant="destructive" className="border-destructive/40 bg-danger-soft">
    <CircleAlertIcon />
    <AlertTitle>{uncertain ? "Saving could not be confirmed" : "The request was not saved"}</AlertTitle>
    <AlertDescription>{message}</AlertDescription>
  </Alert>;
  const retry = uncertain && pending && <button data-slot="button" type="button" className={ui.primary} disabled={busy} onClick={() => void execute(pending.operation, pending.command)}>Retry exact operation</button>;
  const actionClass = cn(ui.secondary, "min-h-10 px-4 max-sm:min-h-11");
  const requestsBlocked = locked || paymentGuard.hasDraft;
  const moreButton = useRef<HTMLButtonElement>(null);
  const menuItem = "min-h-10 gap-2.5 rounded-xl px-3 text-sm font-medium";

  // Record payment leads; the two common requests sit beside it on wide screens. Everything
  // else, and on phones every request, is under More actions. Nothing is removed.
  return <>
    <nav aria-label="Invoice actions" data-print="hide" className="sticky top-[57px] z-20 -mx-4 flex flex-wrap items-center gap-2 bg-background/92 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-6 sm:px-6 md:top-[65px]">
      {canPay && <button data-slot="button" type="button" className={cn(ui.primary, "min-h-10 px-4 max-sm:min-h-11 max-md:flex-1")} disabled={busy || uncertain || !hydrated} onClick={() => setPaying(true)}><HandCoinsIcon aria-hidden />Record payment</button>}
      {permissions.requestCorrection && <button data-slot="button" type="button" className={cn(actionClass, "max-md:hidden")} disabled={requestsBlocked} onClick={() => open("correction")}><PencilLineIcon aria-hidden />Request correction</button>}
      {permissions.requestReplacement && <button data-slot="button" type="button" className={cn(actionClass, "max-md:hidden")} disabled={requestsBlocked} onClick={() => open("delivery")}><TruckIcon aria-hidden />Request delivery change</button>}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild><button ref={moreButton} data-slot="button" type="button" className={cn(ui.ghost, "min-h-10 px-4 max-sm:min-h-11")} disabled={!hydrated}><EllipsisIcon aria-hidden />More actions</button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-print="hide" className="w-auto min-w-56 rounded-2xl p-1.5">
          {permissions.requestCorrection && <DropdownMenuItem className={cn(menuItem, "md:hidden")} disabled={requestsBlocked} onSelect={() => open("correction")}><PencilLineIcon aria-hidden />Request correction</DropdownMenuItem>}
          {permissions.requestReplacement && <DropdownMenuItem className={menuItem} disabled={requestsBlocked} onSelect={() => open("replacement")}><RepeatIcon aria-hidden />Request replacement</DropdownMenuItem>}
          {permissions.requestReplacement && <DropdownMenuItem className={cn(menuItem, "md:hidden")} disabled={requestsBlocked} onSelect={() => open("delivery")}><TruckIcon aria-hidden />Request delivery change</DropdownMenuItem>}
          <DropdownMenuItem className={menuItem} onSelect={() => window.print()}><PrinterIcon aria-hidden />Print</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>

    {!tab && (failure || retry) && <div className="grid justify-items-start gap-3" data-print="hide">{failure}{retry}</div>}

    {awaiting.length > 0 && <section aria-labelledby="awaiting-heading" data-print="hide" className="grid gap-2.5 rounded-3xl border border-warning/30 bg-card p-4 sm:px-5">
      <div className="grid gap-0.5">
        <h2 id="awaiting-heading" data-slot="heading" className="text-base font-semibold">Awaiting approval</h2>
        <p className="text-[13px] text-muted-foreground">Requests change nothing until a manager or owner approves them. The invoice below shows the current approved values.</p>
      </div>
      <ul className="grid list-none gap-2.5 pl-0">{awaiting.map((change) => {
        const canDecide = change.kind === "replacement" ? permissions.approveReplacement : permissions.approveCorrection;
        // A replacement that keeps the current number and customer is the delivery-change shortcut.
        const deliveryOnly = change.kind === "replacement" && change.invoiceNumber === detail.invoiceNumber && change.customerId === (detail.customer?.id ?? null) && Boolean(change.delivered) !== detail.delivered;
        const kindLabel = deliveryOnly ? "Delivery change" : change.kind === "replacement" ? "Replacement" : change.paymentId ? "Payment correction" : "Correction";
        const stale = change.kind === "correction" && change.expectedTotal !== null && change.expectedTotal !== detail.effectiveTotalDirham;
        return <li key={change.id} aria-label={`${kindLabel} request`} className="grid gap-2.5 rounded-2xl border border-border p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 data-slot="heading" className="text-sm font-semibold">{kindLabel} — Pending approval</h3>
            <span className="text-xs text-muted-foreground">Requested by <span className="font-medium text-foreground">{personLabel(detail.people, change.requestedBy)}</span> · {qatarDateTime(change.requestedAt)}</span>
          </div>
          {change.kind === "replacement" ? <Comparison label="Requested replacement" rows={[
            { label: "Invoice number", current: detail.invoiceNumber, requested: change.invoiceNumber ?? "" },
            { label: "Customer", current: detail.customer ? `${detail.customer.name ?? "Unnamed customer"} · ${detail.customer.publicId}` : "No customer", requested: customerLabel(detail.customerNames, change.customerId) },
            { label: "Delivery", current: deliveryText(detail.delivered), requested: deliveryText(Boolean(change.delivered)) },
          ]} /> : change.correctedTotal !== null && change.expectedTotal !== null ? <>
            <Comparison label="Requested correction" rows={[{ label: "Invoice total", current: qar(change.expectedTotal), requested: qar(change.correctedTotal) }]} />
            <p className="text-sm tabular-nums">Invoice total: {qar(change.expectedTotal)} → {qar(change.correctedTotal)} ({signedQar(change.amountDelta!)})</p>
          </> : <p className="text-sm tabular-nums">{change.paymentId ? "Payment adjustment" : "Invoice total"}: <strong>{signedQar(change.amountDelta!)}</strong></p>}
          {stale && <p className={ui.warn}>Out of date: the invoice total is now {qar(detail.effectiveTotalDirham)}. Approving will be refused; ask for a new request.</p>}
          <p className="text-sm"><span className="text-muted-foreground">Reason: </span>{change.reason}</p>
          {canDecide ? <form className="border-t border-border pt-2.5" onSubmit={(e) => e.preventDefault()}>
            <fieldset disabled={locked || paymentGuard.hasDraft} className="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <label data-slot="label" className="grid gap-1.5"><span className={ui.label}>Decision reason (optional)</span><input data-slot="input" name="decisionReason" maxLength={2000} className={ui.field} /></label>
              <div className="flex flex-wrap gap-2">
                {(["approved", "rejected"] as const).map((decision) => <button key={decision} data-slot="button" type="button" className={cn(decision === "approved" ? ui.primary : ui.secondary, "min-h-11")} onClick={(e) => {
                  const data = new FormData(e.currentTarget.form!);
                  void execute(change.kind === "replacement" ? "decide_invoice_replacement" : "decide_invoice_correction", { shop_id: detail.shopId, request_id: change.id, expected_revision: detail.revision, decision, reason: data.get("decisionReason") || null, idempotency_key: crypto.randomUUID() });
                }}>{decision === "approved" ? "Approve" : "Reject"}</button>)}
              </div>
            </fieldset>
          </form> : <p className="text-xs text-muted-foreground">A manager or owner will review this request.</p>}
        </li>;
      })}</ul>
    </section>}

    {permissions.payment && <Drawer open={paying} onOpenChange={closePayment} fallbackFocus={moreButton} title="Record payment" description={<>Cash or bank payment against invoice {detail.invoiceNumber}. Saved only after ShopKhata confirms it.</>}>
      <InvoicePayment variant="sheet" shopId={detail.shopId} disabled={busy || uncertain} initialInvoice={{ id: detail.id, invoiceNumber: detail.invoiceNumber, effectiveTotal: detail.effectiveTotalDirham, effectivePaid: detail.effectivePaidDirham, effectiveDue: detail.effectiveDueDirham }}
        onSaved={() => router.refresh()} onActivityChange={setBusy} onStateChange={setPaymentGuard} />
    </Drawer>}

    <Drawer open={tab !== null} onOpenChange={closeRequest} fallbackFocus={moreButton} title={tab ? TITLE[tab] : ""} description={<>This is a request. Nothing changes until a manager or owner approves it.</>}>
      {tab && <form noValidate aria-label={FORM_NAME[tab]} className="grid gap-5" onSubmit={(event) => { event.preventDefault(); request(); }}>
        <fieldset disabled={locked} className="grid gap-5">
          <legend className="sr-only">{FORM_NAME[tab]}</legend>
          {tab === "correction" ? <>
            {detail.payments.length > 0 && <label data-slot="label" htmlFor="correction-record" className="grid gap-1.5">
              <span className={ui.label}>Correct record</span>
              <select data-slot="select" id="correction-record" className={ui.field} value={paymentId} onChange={(e) => { setPaymentId(e.target.value); setFieldErrors({}); }}>
                <option value="">Invoice total</option>
                {detail.payments.map((p) => <option key={p.id} value={p.id}>Payment of {qar(p.amountDirham)} on {p.businessDate}</option>)}
              </select>
            </label>}
            {paymentId ? <div className="grid gap-4 sm:grid-cols-2">
              <label data-slot="label" htmlFor="correction-direction" className="grid gap-1.5">
                <span className={ui.label}>Adjustment direction</span>
                <select data-slot="select" id="correction-direction" className={ui.field} value={direction} onChange={(e) => setDirection(e.target.value)}>
                  <option value="decrease">Decrease the payment by</option>
                  <option value="increase">Increase the payment by</option>
                </select>
              </label>
              <div className="grid gap-1.5">
                <label data-slot="label" htmlFor="correction-amount" className={ui.label}>Adjustment amount (QAR)</label>
                <input data-slot="input" id="correction-amount" inputMode="decimal" className={cn(ui.field, ui.money)} value={delta} onChange={(e) => setDelta(e.target.value)} aria-invalid={Boolean(fieldErrors.amount)} aria-describedby={fieldErrors.amount ? "correction-amount-error" : undefined} />
                <FieldError id="correction-amount-error" message={fieldErrors.amount} />
              </div>
            </div> : <>
              <div className="grid gap-1.5">
                <label data-slot="label" htmlFor="correction-total" className={ui.label}>Corrected invoice total (QAR)</label>
                <input data-slot="input" id="correction-total" inputMode="decimal" className={cn(ui.field, ui.money, "h-12 text-lg")} placeholder={formatQar(current.totalDirham)} value={corrected} onChange={(e) => { setCorrected(e.target.value); setFieldErrors({}); }} aria-invalid={Boolean(fieldErrors.total)} aria-describedby={fieldErrors.total ? "correction-total-error correction-total-hint" : "correction-total-hint"} />
                <p id="correction-total-hint" className="text-[13px] text-muted-foreground">Enter the total the invoice should have, not the amount to add or subtract.</p>
                <FieldError id="correction-total-error" message={fieldErrors.total} />
              </div>
              <dl aria-label="Correction summary" className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-2xl bg-muted p-4 tabular-nums">
                {[
                  ["Current invoice total", qar(current.totalDirham), ""],
                  ["Corrected invoice total", correctedDirham === null ? "—" : qar(correctedDirham), ""],
                  ["Calculated difference", preview ? signedQar(preview.differenceDirham) : "—", ""],
                  ["Current payments", qar(current.paidDirham + current.creditAppliedDirham), ""],
                  ["Resulting due after correction", preview ? qar(preview.resultingDueDirham) : "—", preview && preview.resultingDueDirham < 0 ? "text-destructive" : ""],
                ].map(([label, value, tone]) => <div key={label} className="grid gap-0.5 last:col-span-2 last:border-t last:border-border last:pt-3">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className={`text-base font-semibold ${tone}`}>{value}</dd>
                </div>)}
              </dl>
              {current.creditAppliedDirham > 0 && <p className="text-[13px] text-muted-foreground">Current payments include {qar(current.creditAppliedDirham)} of customer credit applied to this invoice.</p>}
            </>}
          </> : tab === "delivery" ? <>
            <Comparison label="Requested delivery change" rows={[{ label: "Delivery", current: deliveryText(detail.delivered), requested: deliveryText(delivered) }]} />
            <label data-slot="label" className="flex min-h-12 items-center gap-3 rounded-2xl border border-border px-4 text-sm font-medium">
              <input data-slot="checkbox" type="checkbox" className="size-5 accent-[var(--primary)]" checked={delivered} onChange={(e) => setDelivered(e.target.checked)} />Delivered
            </label>
            <p className={ui.warn}>Requires manager or owner approval. Delivery stays <strong>{deliveryText(detail.delivered).toLowerCase()}</strong> until then. Number, customer and amounts stay unchanged.</p>
            {/* The same rule the database applies on approval, shown before anyone asks. */}
            {delivered && !detail.customer && detail.effectiveDueDirham > 0 && <p className={ui.danger}>This invoice has {qar(detail.effectiveDueDirham)} due and no customer. A delivered invoice with due requires a customer, so approval would be refused. Use Request replacement to add the customer at the same time.</p>}
          </> : <>
            <p className="text-[13px] text-muted-foreground">Based on approved version {detail.revision}. Financial amounts stay unchanged.</p>
            <label data-slot="label" className="grid gap-1.5"><span className={ui.label}>Replacement invoice number</span><input data-slot="input" className={ui.field} value={number} onChange={(e) => setNumber(e.target.value)} maxLength={120} required /></label>
            <div className="grid gap-2 rounded-2xl border border-border p-4">
              <p className="text-sm">Requested customer: <strong>{customer ? `${customer.name ?? "Unnamed customer"} · ${customer.publicId}` : "No customer"}</strong></p>
              <CustomerSearch key={tab} shopId={detail.shopId} disabled={locked} onSelect={(c) => setCustomer(c ? { id: c.id, name: c.name, mobile: c.mobile, publicId: c.public_id } : null)} />
              <button data-slot="button" type="button" className={cn(ui.quiet, "justify-self-start")} onClick={() => setCustomer(null)}>Use no customer</button>
            </div>
            <label data-slot="label" className="flex min-h-12 items-center gap-3 rounded-2xl border border-border px-4 text-sm font-medium">
              <input data-slot="checkbox" type="checkbox" className="size-5 accent-[var(--primary)]" checked={delivered} onChange={(e) => setDelivered(e.target.checked)} />Replacement delivered
            </label>
            <p className={ui.warn}>Requires manager or owner approval. The invoice keeps its current number, customer and delivery until then.</p>
          </>}
          <div className="grid gap-1.5">
            <label data-slot="label" htmlFor="request-reason" className={ui.label}>Request reason</label>
            <textarea data-slot="textarea" id="request-reason" rows={3} className={cn(ui.field, "h-auto min-h-24 py-2.5")} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} aria-invalid={Boolean(fieldErrors.reason)} aria-describedby={fieldErrors.reason ? "request-reason-error" : undefined} />
            <FieldError id="request-reason-error" message={fieldErrors.reason} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button data-slot="button" type="submit" className={cn(ui.primary, "flex-1")}>{busy ? "Sending…" : "Submit request"}</button>
            <button data-slot="button" type="button" className={ui.secondary} onClick={() => closeRequest(false)}>Cancel</button>
          </div>
        </fieldset>
        {(failure || retry) && <div className="grid gap-3">{failure}{retry}</div>}
      </form>}
    </Drawer>
  </>;
}
