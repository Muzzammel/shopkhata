import { z } from "zod";

// Mirrors the limits enforced inside admin_create_shop / admin_update_shop. The RPCs are the authority.
export const SHOP_NAME_MAX = 100;
const name = z.string().trim().min(1).max(SHOP_NAME_MAX);

export const createShopInput = z.strictObject({ name });
export const updateShopInput = z.strictObject({ shop_id: z.uuid(), name });

export const SHOP_ADMIN_RPCS = {
  admin_create_shop: createShopInput,
  admin_update_shop: updateShopInput,
} as const;

const MESSAGES: Record<string, string> = {
  AUTHENTICATION_REQUIRED: "Sign in again to manage shops.",
  INSUFFICIENT_ROLE: "Only an owner can manage shops.",
  INVALID_REQUEST: `Enter a shop name of 1 to ${SHOP_NAME_MAX} characters.`,
  SHOP_NAME_EXISTS: "Another active shop already uses that name. Choose a different name.",
  SHOP_NOT_FOUND: "That shop no longer exists.",
};

export function shopAdminError(code: string): string {
  return MESSAGES[code] ?? "The change was not saved. Refresh to see the current shops.";
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** True when another shop already uses the name, ignoring case and outer spaces (the RPC checks the same rule). */
export function isDuplicateShopName(candidate: string, shops: readonly { id: string; name: string }[], exceptId?: string): boolean {
  return shops.some((shop) => shop.id !== exceptId && sameName(shop.name, candidate));
}

/** Words for one shop audit event; never raw metadata. */
export function describeShopEvent(event: { action: string; metadata: unknown }): string {
  const meta = (event.metadata ?? {}) as { name?: string; old_name?: string; new_name?: string };
  if (event.action === "shop.create") return meta.name ? `Shop created: ${meta.name}` : "Shop created";
  if (event.action === "shop.update") return `Shop renamed: ${meta.old_name ?? "Unknown"} → ${meta.new_name ?? "Unknown"}`;
  return event.action;
}
