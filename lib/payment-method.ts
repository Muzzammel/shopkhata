/** The tender channels ShopKhata accepts for money received. Stored values match the database check. */
export const PAYMENT_METHODS = ["cash", "bank"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const LABELS: Record<PaymentMethod, string> = { cash: "Cash", bank: "Bank" };

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
}

/** Display label. Applied customer credit is not a receipt, so it keeps its own label. */
export function paymentMethodLabel(method: string | null | undefined): string {
  if (isPaymentMethod(method)) return LABELS[method];
  if (method === "credit") return "Customer credit";
  return method ? method[0].toUpperCase() + method.slice(1) : LABELS.cash;
}
