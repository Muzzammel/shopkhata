"use server";

import { revalidatePath } from "next/cache";

import { can, getCurrentActor, type Actor } from "@/lib/auth/permissions";
import { closeInput, closingError, reopenInput } from "@/lib/closing";
import { logFailure } from "@/lib/server-log";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type ClosingResult = { ok: true } | { ok: false; message: string };

async function run(rpc: "close_business_date" | "reopen_business_date", raw: unknown): Promise<ClosingResult> {
  const parsed = (rpc === "close_business_date" ? closeInput : reopenInput).safeParse(raw);
  if (!parsed.success) return { ok: false, message: closingError(rpc === "reopen_business_date" ? "REASON_REQUIRED" : "INVALID_REQUEST") };
  let actor: Actor;
  try { actor = await getCurrentActor(); } catch { return { ok: false, message: closingError("AUTHENTICATION_REQUIRED") }; }
  if (!can(actor, rpc === "close_business_date" ? "date.close" : "date.reopen", parsed.data.shop_id)) {
    return { ok: false, message: closingError(actor.role === "staff" ? "INSUFFICIENT_ROLE" : "UNAUTHORIZED_SHOP") };
  }
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc(rpc, { command: parsed.data });
    // Close and reopen are state changes, not retried commands: after an
    // unclear answer the screen simply shows the state the server now holds.
    if (error) {
      logFailure(rpc, error, { shopId: parsed.data.shop_id, actorId: actor.id });
      return { ok: false, message: error.code ? closingError(error.message) : "The result is not confirmed. Refresh to see the current state of this date." };
    }
  } catch {
    logFailure(rpc, null, { shopId: parsed.data.shop_id, actorId: actor.id });
    return { ok: false, message: "The result is not confirmed. Refresh to see the current state of this date." };
  }
  revalidatePath("/closing");
  revalidatePath("/reports");
  return { ok: true };
}

export async function closeBusinessDate(raw: unknown) { return run("close_business_date", raw); }
export async function reopenBusinessDate(raw: unknown) { return run("reopen_business_date", raw); }
