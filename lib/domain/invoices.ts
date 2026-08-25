import type { MoneyDirham } from "@/lib/domain/money";

export type InvoiceType = "ADVANCE" | "READYMADE";

export type InvoiceState = "ADVANCE" | "DELIVERED_PAID" | "DELIVERED_DUE";

export type InvoiceStateInput = {
  type: InvoiceType;
  total: MoneyDirham;
  received: MoneyDirham;
  delivered?: boolean;
};

export function invoiceState(input: InvoiceStateInput): InvoiceState {
  const isDelivered = input.type === "READYMADE" || input.delivered === true;

  if (!isDelivered) {
    return "ADVANCE";
  }

  return input.received >= input.total ? "DELIVERED_PAID" : "DELIVERED_DUE";
}
