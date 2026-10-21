"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { HandCoinsIcon } from "lucide-react";
import { toast } from "sonner";

import { FilterPills } from "@/components/dashboard/filter-pills";
import { PaymentMethodField } from "@/components/sales/payment-method-field";
import { Drawer } from "@/components/shell/drawer";
import { ui } from "@/components/sales/ui";
import { groupedQar, qar } from "@/lib/dashboard-view";
import { parseQar } from "@/lib/domain/money";
import { previewCustomerPaymentAllocation, type OutstandingInvoice } from "@/lib/customer-operations";
import { paymentMethodLabel, type PaymentMethod } from "@/lib/payment-method";
import { cn } from "@/lib/utils";
import { applyCustomerCredit, recordCustomerPayment } from "./customer-actions";

/**
 * Record payment for a customer: the unchanged record_customer_payment / apply_customer_credit
 * flows in a drawer (full-screen sheet on phones). The preview is the same oldest-first allocation
 * the database applies; the database still decides, and nothing is reported saved until it confirms.
 */
export function CustomerPaymentPanel({ shopId, customerId, customerName, invoices, dueDirham, availableCreditDirham, businessDate, className }: {
  shopId: string; customerId: string; customerName: string; invoices: OutstandingInvoice[]; dueDirham: number; availableCreditDirham: number; businessDate: string; className?: string;
}) {
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"payment" | "credit">("payment");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const amountDirham = useMemo(() => { try { return parseQar(amount); } catch { return 0; } }, [amount]);
  const allocation = useMemo(() => {
    try { return amountDirham > 0 && (mode !== "credit" || amountDirham <= availableCreditDirham) ? previewCustomerPaymentAllocation(invoices, amountDirham) : []; }
    catch { return []; }
  }, [amountDirham, availableCreditDirham, invoices, mode]);
  const valid = allocation.length > 0;

  function edit() { setReview(false); setMessage(""); setKey(crypto.randomUUID()); }

  async function submit() {
    if (busy || !review || !valid) return;
    setBusy(true); setMessage("");
    try {
      const command = { shop_id: shopId, customer_id: customerId, amount_dirham: amountDirham, business_date: businessDate, idempotency_key: key };
      const result = mode === "payment" ? await recordCustomerPayment({ ...command, payment_method: method }) : await applyCustomerCredit(command);
      if (!result.ok) { setMessage(result.message); setUncertain(result.uncertain); return; }
      toast.success(mode === "payment" ? `Payment of ${qar(amountDirham)} recorded and allocated.` : `Credit of ${qar(amountDirham)} applied to invoice due.`);
      setAmount(""); setMethod("cash"); setReview(false); setUncertain(false); setKey(crypto.randomUUID()); setOpen(false);
      router.refresh();
    } catch { setMessage("Status is uncertain. Retry this exact request before starting another."); setUncertain(true); }
    finally { setBusy(false); }
  }

  // An in-flight save, or one whose outcome is unknown, keeps the drawer open: closing would lose the exact command to retry.
  const close = (next: boolean) => { if (next || !(busy || uncertain)) setOpen(next); };
  const resultingDue = valid ? dueDirham - amountDirham : null;
  const resultingCredit = mode === "credit" && valid ? availableCreditDirham - amountDirham : availableCreditDirham;
  const row = "flex justify-between gap-3";

  return <>
    <button ref={trigger} data-slot="button" type="button" className={cn(ui.primary, className)} onClick={() => setOpen(true)}><HandCoinsIcon aria-hidden />Record payment</button>
    <Drawer open={open} onOpenChange={close} fallbackFocus={trigger} title="Record payment" description={<>For <strong className="text-foreground">{customerName}</strong>. Applied to the oldest due invoice first.</>}>
      <div data-slot="payment-customer" className="grid gap-3 rounded-2xl bg-muted p-4">
        <div className="flex items-baseline justify-between gap-3"><span className="text-sm text-muted-foreground">Current due</span><span className="text-xs text-muted-foreground">{invoices.length} open invoice{invoices.length === 1 ? "" : "s"}</span></div>
        <p className="text-3xl font-semibold tracking-tight text-warning tabular-nums"><span className="text-sm font-medium opacity-70">QAR</span> {groupedQar(dueDirham)}</p>
        {availableCreditDirham > 0 && <p className="text-xs text-muted-foreground tabular-nums">Customer credit available: <strong className="text-foreground">{qar(availableCreditDirham)}</strong> · credit is not cash</p>}
      </div>

      {availableCreditDirham > 0 && <FilterPills label="Settle with" value={mode} className="justify-self-start" items={[{ key: "payment", label: "New payment" }, { key: "credit", label: "Apply credit" }]}
        onPick={(next) => { if (uncertain || busy) return; setMode(next as typeof mode); edit(); }} />}

      {!review && <div className="grid gap-4">
        <label data-slot="label" className="grid gap-1.5"><span className={ui.label}>{mode === "payment" ? "Payment amount (QAR)" : "Credit amount (QAR)"}</span>
          <input data-slot="input" aria-label={mode === "payment" ? "Payment amount (QAR)" : "Credit amount (QAR)"} inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} disabled={uncertain || busy} aria-invalid={amount !== "" && !valid} aria-describedby={amount !== "" && !valid ? "customer-payment-error" : undefined}
            onChange={(e) => { setAmount(e.target.value); edit(); }} className={cn(ui.field, ui.money, "h-14 text-2xl max-sm:h-14 max-sm:text-2xl")} />
        </label>
        {amount !== "" && !valid && <p id="customer-payment-error" role="alert" className={ui.fieldError}>Enter a positive amount with at most two decimals, no more than the current due{mode === "credit" ? " or the available credit" : ""}.</p>}
        {mode === "payment" && <PaymentMethodField name="customer-payment-method" value={method} disabled={uncertain || busy} onChange={(next) => { setMethod(next); edit(); }} />}
        <dl aria-label="Payment summary" className="grid gap-2 rounded-2xl border border-border p-4 text-sm tabular-nums">
          <div className={row}><dt className="text-muted-foreground">{mode === "payment" ? "Payment method" : "Settled with"}</dt><dd className="font-semibold">{mode === "payment" ? paymentMethodLabel(method) : "Customer credit"}</dd></div>
          <div className={row}><dt className="text-muted-foreground">Amount applied</dt><dd className="font-semibold">{valid ? qar(amountDirham) : "—"}</dd></div>
          <div className={row}><dt className="text-muted-foreground">Resulting due</dt><dd className="font-semibold">{resultingDue === null ? "—" : qar(resultingDue)}</dd></div>
          <div className={row}><dt className="text-muted-foreground">Resulting credit</dt><dd className="font-semibold">{qar(resultingCredit)}</dd></div>
        </dl>
        {mode === "payment" && <p className="text-xs text-muted-foreground">A customer payment cannot be more than the current due, so it never creates credit.</p>}
        <button data-slot="button" type="button" className={ui.primary} disabled={!valid || busy || uncertain} onClick={() => setReview(true)}>Review allocation</button>
      </div>}

      {review && <section aria-labelledby="allocation-heading" className="grid gap-4">
        <h3 id="allocation-heading" data-slot="heading" className="text-sm font-semibold">Allocation preview</h3>
        <p className="text-sm">{mode === "payment" ? `${paymentMethodLabel(method)} payment` : "Customer credit"} of <strong className="tabular-nums">{qar(amountDirham)}</strong>, business date {businessDate}.</p>
        <table data-slot="allocation" aria-label="Allocation by invoice" className="w-full border-separate border-spacing-0 overflow-hidden rounded-2xl border border-border text-sm tabular-nums">
          <thead><tr className="bg-muted text-xs text-muted-foreground"><th data-slot="cell" scope="col" className="px-3 py-2 text-left font-medium">Invoice</th><th data-slot="cell" scope="col" className="px-3 py-2 text-right font-medium">Applied</th><th data-slot="cell" scope="col" className="px-3 py-2 text-right font-medium">Due after</th></tr></thead>
          <tbody>{allocation.map((item) => <tr key={item.invoiceId} data-invoice={item.invoiceNumber}>
            <th data-slot="cell" scope="row" className="border-t border-border px-3 py-2 text-left font-semibold [overflow-wrap:anywhere]">{item.invoiceNumber}</th>
            <td data-slot="cell" className="border-t border-border px-3 py-2 text-right">{qar(item.amountDirham)}</td>
            <td data-slot="cell" className={cn("border-t border-border px-3 py-2 text-right", item.dueAfterDirham > 0 ? "text-warning" : "text-success")}>{qar(item.dueAfterDirham)}</td>
          </tr>)}</tbody>
        </table>
        <dl className="grid gap-2 rounded-2xl border border-border p-4 text-sm tabular-nums">
          <div className={row}><dt className="text-muted-foreground">Resulting due</dt><dd className="font-semibold">{qar(dueDirham - amountDirham)}</dd></div>
          <div className={row}><dt className="text-muted-foreground">Resulting credit</dt><dd className="font-semibold">{qar(resultingCredit)}</dd></div>
        </dl>
        {uncertain && <p role="alert" className={ui.warn}><strong className="block">Not confirmed yet</strong>{message || "Status is uncertain."} The drawer stays open until this exact request is retried.</p>}
        <div className="flex flex-wrap gap-2">
          <button data-slot="button" type="button" className={cn(ui.primary, "flex-1")} disabled={busy} onClick={submit}>{busy ? "Saving…" : uncertain ? "Retry exact request" : mode === "payment" ? "Confirm payment" : "Confirm credit"}</button>
          <button data-slot="button" type="button" className={ui.secondary} disabled={busy || uncertain} onClick={edit}>Edit</button>
        </div>
      </section>}
      {message && !uncertain && <p role="alert" className={ui.danger}>{message}</p>}
    </Drawer>
  </>;
}
