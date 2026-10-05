"use client";

import { InvoicePayment } from "../invoice-payment";

/**
 * The Payments page's Record Payment capability: the same InvoicePayment
 * component and the same lookupInvoiceForPayment/recordInvoicePayment server
 * actions Overview uses. This stays the one authoritative payment-creation
 * path; nothing here recomputes or re-validates a payment differently.
 */
export function PaymentEntry({ shopId }: { shopId: string }) {
  return <InvoicePayment shopId={shopId} disabled={false} onSaved={() => {}} onStateChange={() => {}} onActivityChange={() => {}} />;
}
