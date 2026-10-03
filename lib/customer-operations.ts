export type OutstandingInvoice = {
  invoiceId: string;
  invoiceNumber: string;
  businessDate: string;
  dueDirham: number;
};

export type PaymentAllocation = {
  invoiceId: string;
  invoiceNumber: string;
  amountDirham: number;
  dueBeforeDirham: number;
  dueAfterDirham: number;
};

export function previewCustomerPaymentAllocation(
  invoices: readonly OutstandingInvoice[],
  amountDirham: number,
): PaymentAllocation[] {
  if (!Number.isSafeInteger(amountDirham) || amountDirham <= 0) {
    throw new Error("Enter a positive whole-dirham amount.");
  }
  const ordered = [...invoices]
    .filter((invoice) => Number.isSafeInteger(invoice.dueDirham) && invoice.dueDirham > 0)
    .sort((left, right) => left.businessDate.localeCompare(right.businessDate)
      || left.invoiceId.localeCompare(right.invoiceId));
  const totalDue = ordered.reduce((sum, invoice) => sum + invoice.dueDirham, 0);
  if (amountDirham > totalDue) throw new Error("Amount exceeds the current outstanding due.");

  let remaining = amountDirham;
  const allocations: PaymentAllocation[] = [];
  for (const invoice of ordered) {
    if (remaining === 0) break;
    const amount = Math.min(remaining, invoice.dueDirham);
    allocations.push({ invoiceId: invoice.invoiceId, invoiceNumber: invoice.invoiceNumber, amountDirham: amount, dueBeforeDirham: invoice.dueDirham, dueAfterDirham: invoice.dueDirham - amount });
    remaining -= amount;
  }
  return allocations;
}

export type CustomerLedgerSource = {
  businessDate: string;
  recordedAt: string;
  sequenceId: string;
  invoiceId: string;
  type: "invoice" | "payment" | "invoice_correction" | "payment_correction" | "credit_application";
  reference: string;
  invoiceNumber: string | null;
  actorName: string | null;
  debitDirham: number;
  creditDirham: number;
};

export function mapCustomerLedger(rows: readonly CustomerLedgerSource[]) {
  let balanceDirham = 0;
  return [...rows]
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate)
      || a.recordedAt.localeCompare(b.recordedAt)
      || a.sequenceId.localeCompare(b.sequenceId))
    .map((row) => {
      balanceDirham += row.debitDirham - row.creditDirham;
      return { ...row, balanceDirham };
    });
}
