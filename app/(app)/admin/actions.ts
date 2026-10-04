"use server";

import { revalidatePath } from "next/cache";

import { ACCOUNT_ADMIN_RPCS, accountAdminError } from "@/lib/account-admin";
import { can, getCurrentActor, type Actor } from "@/lib/auth/permissions";
import { logFailure } from "@/lib/server-log";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type AccountAdminResult = { ok: true } | { ok: false; message: string };

// The database RPC is the authority (it rechecks the caller's stored role);
// the check here only gives a non-owner a clear answer without a round trip.
async function run(rpc: keyof typeof ACCOUNT_ADMIN_RPCS, raw: unknown): Promise<AccountAdminResult> {
  const parsed = ACCOUNT_ADMIN_RPCS[rpc].safeParse(raw);
  if (!parsed.success) return { ok: false, message: accountAdminError("INVALID_REQUEST") };
  let actor: Actor;
  try { actor = await getCurrentActor(); } catch { return { ok: false, message: accountAdminError("AUTHENTICATION_REQUIRED") }; }
  if (!can(actor, "users.manage")) return { ok: false, message: accountAdminError("INSUFFICIENT_ROLE") };
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc(rpc, { command: parsed.data });
    if (error) {
      logFailure(rpc, error, { actorId: actor.id });
      return { ok: false, message: accountAdminError(error.message) };
    }
  } catch {
    logFailure(rpc, null, { actorId: actor.id });
    return { ok: false, message: accountAdminError("") };
  }
  revalidatePath("/admin");
  return { ok: true };
}

export async function registerAccount(raw: unknown) { return run("admin_register_account", raw); }
export async function updateAccount(raw: unknown) { return run("admin_update_account", raw); }
export async function setShopAssignment(raw: unknown) { return run("admin_set_shop_assignment", raw); }
