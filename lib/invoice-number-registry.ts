import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeInvoiceNumber } from "@/lib/invoice-operations";
import type { Database } from "@/lib/supabase/database.types";

// Keeps each request URL short even for a full 100-row batch of long numbers.
const LOOKUP_CHUNK_SIZE = 20;

/**
 * Which of these invoice numbers are already registered in the shop, as
 * normalized numbers. An exact lookup on (shop_id, normalized_invoice_number),
 * the registry's unique key, so the cost follows the numbers asked about, not
 * the size of the registry. A convenience pre-check only: submit_batch stays
 * authoritative. Null when the lookup failed, which never means "available".
 */
export async function findRegisteredInvoiceNumbers(supabase: SupabaseClient<Database>, shopId: string, numbers: readonly string[]): Promise<string[] | null> {
  const normalized = [...new Set(numbers.map(normalizeInvoiceNumber))].filter(Boolean);
  const registered: string[] = [];
  for (let start = 0; start < normalized.length; start += LOOKUP_CHUNK_SIZE) {
    // supabase-js `.in()` does not escape quotes or backslashes, so every value is quoted here.
    const list = normalized.slice(start, start + LOOKUP_CHUNK_SIZE).map((number) => `"${number.replace(/[\\"]/g, "\\$&")}"`).join(",");
    const { data, error } = await supabase.from("invoice_number_registry").select("normalized_invoice_number")
      .eq("shop_id", shopId).filter("normalized_invoice_number", "in", `(${list})`);
    if (error || !data) return null;
    registered.push(...data.flatMap((row) => row.normalized_invoice_number ?? []));
  }
  return registered;
}
