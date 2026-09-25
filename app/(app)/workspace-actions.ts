"use server";

import { can, getCurrentActor } from "@/lib/auth/permissions";
import { readShopWorkspace } from "@/lib/shop-workspace";

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
