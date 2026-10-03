"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { lookupInvoiceForPayment, type PaymentLookup } from "./payment-actions";
import { formatQar } from "@/lib/domain/money";
import { normalizeInvoiceNumber } from "@/lib/invoice-operations";

export function DuplicateInvoiceWarning({ shopId, number }: { shopId: string; number: string }) {
  const [result, setResult] = useState<PaymentLookup | null>(null);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void lookupInvoiceForPayment({ shopId, invoiceNumber: number }).then((r) => { if (active) setResult(r); }).catch(() => { if (active) setResult({ ok: false, message: "Existing invoice details are unavailable. Creation remains blocked." }); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [shopId, number]);
  if (!result) return <p role="status">Existing invoice — loading authoritative due…</p>;
  if (!result.ok) return <p role="alert">{result.message}</p>;
  const invoice = result.invoice;
  return <div role="alert">
    <p>{invoice.effectiveDue > 0 ? `Invoice already exists. Outstanding due QAR ${formatQar(invoice.effectiveDue)}.` : "Invoice already exists / fully paid."}</p>
    {normalizeInvoiceNumber(number) !== normalizeInvoiceNumber(invoice.invoiceNumber) && <p>Historical number. Current effective invoice number: {invoice.invoiceNumber}.</p>}
    <Link href={`/shops/${shopId}/invoices/${invoice.id}${invoice.effectiveDue > 0 ? "#record-payment" : ""}`}>{invoice.effectiveDue > 0 ? "Record payment" : "View invoice"}</Link>
  </div>;
}
