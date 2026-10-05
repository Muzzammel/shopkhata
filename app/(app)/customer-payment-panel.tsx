"use client";

import { useMemo, useState } from "react";
import { formatQar, parseQar } from "@/lib/domain/money";
import { previewCustomerPaymentAllocation, type OutstandingInvoice } from "@/lib/customer-operations";
import { applyCustomerCredit, recordCustomerPayment } from "./customer-actions";
import styles from "@/app/ui.module.css";

export function CustomerPaymentPanel({ shopId, customerId, invoices, availableCreditDirham, businessDate }: {
  shopId: string; customerId: string; invoices: OutstandingInvoice[]; availableCreditDirham: number; businessDate: string;
}) {
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"payment" | "credit">("payment");
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

  async function submit() {
    if (busy || !review || !allocation.length) return;
    setBusy(true); setMessage("");
    try {
      const command = { shop_id: shopId, customer_id: customerId, amount_dirham: amountDirham, business_date: businessDate, idempotency_key: key };
      const result = mode === "payment" ? await recordCustomerPayment(command) : await applyCustomerCredit(command);
      if (!result.ok) { setMessage(result.message); setUncertain(result.uncertain); return; }
      setMessage(mode === "payment" ? "Payment recorded and allocated." : "Credit applied to invoice due.");
      setAmount(""); setReview(false); setUncertain(false); setKey(crypto.randomUUID()); window.location.reload();
    } catch { setMessage("Status is uncertain. Retry this exact request before starting another."); setUncertain(true); }
    finally { setBusy(false); }
  }

  return <section className={styles.panel}>
    <h2>Reduce outstanding due</h2>
    {invoices.length === 0 ? <p className={styles.empty}>No outstanding invoices.</p> : <>
      <div className={styles.formGrid}><label>Operation<select value={mode} disabled={uncertain} onChange={(e) => { setMode(e.target.value as typeof mode); setReview(false); setKey(crypto.randomUUID()); }}><option value="payment">Record cash payment</option>{availableCreditDirham > 0 && <option value="credit">Apply available credit</option>}</select></label>
      <label>{mode === "payment" ? "Payment amount (QAR)" : `Credit amount (QAR) · available ${formatQar(availableCreditDirham)}`}<input inputMode="decimal" value={amount} disabled={uncertain || busy} onChange={(e) => { setAmount(e.target.value); setReview(false); setMessage(""); setKey(crypto.randomUUID()); }}/></label>
      </div>
      {amount && !allocation.length && <p role="alert">Enter a valid positive amount that does not exceed current due{mode === "credit" ? " or available credit" : ""}.</p>}
      {!review && <button disabled={!allocation.length || busy || uncertain} onClick={() => setReview(true)}>Review allocation</button>}
      {review && <div className={styles.review}><h3>Allocation preview</h3><p>{mode === "payment" ? "Cash payment" : "Customer credit"}: QAR {formatQar(amountDirham)}</p><ul>{allocation.map((item) => <li key={item.invoiceId}>{item.invoiceNumber}: apply QAR {formatQar(item.amountDirham)} · remaining due QAR {formatQar(item.dueAfterDirham)}</li>)}</ul>
        <div className={styles.actions}><button disabled={busy} onClick={submit}>{busy ? "Saving…" : uncertain ? "Retry exact request" : "Confirm"}</button><button className={styles.secondary} disabled={busy || uncertain} onClick={() => setReview(false)}>Edit</button></div>
      </div>}
      {message && <p role={uncertain ? "alert" : "status"}>{message}</p>}
    </>}
  </section>;
}
