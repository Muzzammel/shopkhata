export function invoiceKey(shopId: string, invoiceId: string): string {
  return JSON.stringify([shopId, invoiceId.trim().toLowerCase()]);
}
