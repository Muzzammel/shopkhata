"use server";

import { can, getCurrentActor } from "@/lib/auth/permissions";
import { findRegisteredInvoiceNumbers } from "@/lib/invoice-number-registry";
import { readShopWorkspace } from "@/lib/shop-workspace";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const CUSTOMER_SEARCH_PAGE_SIZE = 20;

export async function searchShopCustomers(shopId: unknown, rawQuery: unknown, rawOffset: unknown = 0) {
  if (typeof shopId !== "string" || typeof rawQuery !== "string") {
    return { ok: false as const, message: "Enter a customer search." };
  }
  const query = rawQuery.trim();
  const offset = typeof rawOffset === "number" && Number.isInteger(rawOffset) && rawOffset >= 0 && rawOffset <= 10_000
    ? rawOffset
    : 0;
  if (query.length < 2) return { ok: true as const, customers: [], hasMore: false, nextOffset: 0 };
  if (query.length > 100) return { ok: false as const, message: "Shorten the customer search." };
  const actor = await getCurrentActor();
  if (!can(actor, "records.view_assigned", shopId)) {
    return { ok: false as const, message: "You cannot access this shop." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { data: shop, error: shopError } = await supabase.from("shops")
      .select("id").eq("id", shopId).eq("is_active", true).maybeSingle();
    if (shopError) return { ok: false as const, message: "Customer search is unavailable." };
    if (!shop) return { ok: false as const, message: "You cannot access this shop." };
    const escapedQuery = query.replace(/[\\"%_]/g, "\\$&");
    const pattern = `"*${escapedQuery}*"`;
    const { data, error } = await supabase.from("customers")
      .select("id, name, mobile, public_id")
      .eq("shop_id", shopId)
      .or(`name.ilike.${pattern},mobile.ilike.${pattern},public_id.ilike.${pattern}`)
      .order("name", { ascending: true, nullsFirst: false })
      .order("public_id", { ascending: true })
      .range(offset, offset + CUSTOMER_SEARCH_PAGE_SIZE);
    if (error || !data) return { ok: false as const, message: "Customer search is unavailable." };
    const customers = data.slice(0, CUSTOMER_SEARCH_PAGE_SIZE);
    return {
      ok: true as const,
      customers,
      hasMore: data.length > CUSTOMER_SEARCH_PAGE_SIZE,
      nextOffset: offset + customers.length,
    };
  } catch {
    return { ok: false as const, message: "Customer search is unavailable." };
  }
}

/**
 * New Sale duplicate pre-check for the numbers on screen (draft rows plus an
 * import preview, so at most 200). Not ok means unknown, never "available";
 * the save re-checks and submit_batch decides.
 */
export async function findTakenInvoiceNumbers(shopId: unknown, numbers: unknown) {
  if (typeof shopId !== "string" || !Array.isArray(numbers) || numbers.length > 200
    || !numbers.every((number) => typeof number === "string" && number.length <= 120)) return { ok: false as const };
  const actor = await getCurrentActor();
  if (!can(actor, "records.view_assigned", shopId)) return { ok: false as const };
  try {
    const registered = await findRegisteredInvoiceNumbers(await createServerSupabaseClient(), shopId, numbers);
    return registered ? { ok: true as const, registered } : { ok: false as const };
  } catch {
    return { ok: false as const };
  }
}

export async function loadShopWorkspace(shopId: unknown) {
  if (typeof shopId !== "string") return { ok: false as const, message: "Choose an available shop." };
  const actor = await getCurrentActor();
  if (!can(actor, "records.view_assigned", shopId)) return { ok: false as const, message: "You cannot access this shop." };
  try {
    return { ok: true as const, workspace: await readShopWorkspace(actor, shopId) };
  } catch {
    return { ok: false as const, message: "The selected shop could not be loaded." };
  }
}
