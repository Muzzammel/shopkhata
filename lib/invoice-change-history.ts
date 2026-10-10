import { createServerSupabaseClient } from "@/lib/supabase/server";

export type ChangeRequest = {
  id: string; kind: "correction" | "replacement"; reason: string; requestedBy: string; requestedAt: string;
  amountDelta: number | null; correctedTotal: number | null; expectedTotal: number | null; paymentId: string | null; invoiceNumber: string | null;
  customerId: string | null; delivered: boolean | null; expectedRevision: number | null;
  decision: { outcome: string; actor: string; at: string; reason: string | null; revision: number | null } | null;
};

export async function readInvoiceChanges(shopId: string, invoiceId: string): Promise<ChangeRequest[]> {
  const supabase = await createServerSupabaseClient();
  async function all<T>(page: (offset: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await page(offset);
      if (error || !data) throw new Error("HISTORY_UNAVAILABLE");
      rows.push(...data);
      if (data.length < 500) return rows;
    }
  }
  const [corrections, replacements, financialDecisions, replacementDecisions] = await Promise.all([
    all((o) => supabase.from("correction_requests").select("*").eq("shop_id",shopId).eq("invoice_id",invoiceId).order("id").range(o,o+499)),
    all((o) => supabase.from("replacement_requests").select("*").eq("shop_id",shopId).eq("invoice_id",invoiceId).order("id").range(o,o+499)),
    all((o) => supabase.from("correction_decisions").select("*").eq("shop_id",shopId).eq("invoice_id",invoiceId).order("id").range(o,o+499)),
    all((o) => supabase.from("replacement_decisions").select("*").eq("shop_id",shopId).eq("invoice_id",invoiceId).order("id").range(o,o+499)),
  ]);
  const decisions = new Map([...financialDecisions, ...replacementDecisions].map((d) => [d.request_id, { outcome: d.decision, actor: d.decided_by, at: d.decided_at, reason: d.reason, revision: d.revision }]));
  return [
    ...corrections.map((r): ChangeRequest => ({ id: r.id, kind: "correction", reason: r.reason, requestedBy: r.requested_by, requestedAt: r.requested_at, amountDelta: r.amount_delta_dirham, correctedTotal: r.corrected_total_dirham, expectedTotal: r.expected_total_dirham, paymentId: r.payment_id, invoiceNumber: null, customerId: null, delivered: null, expectedRevision: null, decision: decisions.get(r.id) ?? null })),
    ...replacements.map((r): ChangeRequest => ({ id: r.id, kind: "replacement", reason: r.reason, requestedBy: r.requested_by, requestedAt: r.requested_at, amountDelta: null, correctedTotal: null, expectedTotal: null, paymentId: null, invoiceNumber: r.invoice_number, customerId: r.customer_id, delivered: r.delivered, expectedRevision: r.expected_revision, decision: decisions.get(r.id) ?? null })),
  ].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id));
}
