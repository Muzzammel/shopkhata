"use server";

import { revalidatePath } from "next/cache";

import { can, getCurrentActor, type Actor } from "@/lib/auth/permissions";
import { logFailure } from "@/lib/server-log";
import { SHOP_ADMIN_RPCS, shopAdminError } from "@/lib/shop-admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type ShopAdminResult = { ok: true; shopId: string | null } | { ok: false; message: string };

// The database RPC is the authority (it rechecks the caller's stored role and takes the
// administration lock); the check here only gives a non-owner a clear answer without a round trip.
async function run(rpc: keyof typeof SHOP_ADMIN_RPCS, raw: unknown): Promise<ShopAdminResult> {
  const parsed = SHOP_ADMIN_RPCS[rpc].safeParse(raw);
  if (!parsed.success) return { ok: false, message: shopAdminError("INVALID_REQUEST") };
  let actor: Actor;
  try { actor = await getCurrentActor(); } catch { return { ok: false, message: shopAdminError("AUTHENTICATION_REQUIRED") }; }
  if (!can(actor, "users.manage")) return { ok: false, message: shopAdminError("INSUFFICIENT_ROLE") };
  let shopId: string | null = null;
  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc(rpc, { command: parsed.data });
    if (error) {
      logFailure(rpc, error, { actorId: actor.id });
      return { ok: false, message: shopAdminError(error.message) };
    }
    const id = (data as { shop_id?: unknown } | null)?.shop_id;
    shopId = typeof id === "string" ? id : null;
  } catch {
    logFailure(rpc, null, { actorId: actor.id });
    return { ok: false, message: shopAdminError("") };
  }
  // The shop list feeds the switcher in the shared layout, so refresh from the root.
  revalidatePath("/", "layout");
  return { ok: true, shopId };
}

export async function createShop(raw: unknown) { return run("admin_create_shop", raw); }
export async function updateShop(raw: unknown) { return run("admin_update_shop", raw); }
export async function setShopStatus(raw: unknown) { return run("admin_set_shop_status", raw); }
