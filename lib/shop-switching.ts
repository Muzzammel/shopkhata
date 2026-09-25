import type { Actor } from "@/lib/auth/permissions";

export type ShopChoice = { id: string; name: string };

export function canSwitchShop(actor: Actor, shopId: string): boolean {
  return actor.role === "owner" || actor.shopIds.includes(shopId);
}

export function getVisibleShops<T extends ShopChoice>(actor: Actor, shops: readonly T[]): T[] {
  return shops.filter((shop) => canSwitchShop(actor, shop.id));
}

export function getShopSwitchDisposition(input: {
  hasDraft: boolean;
  uncertain: boolean;
  confirmedDiscard: boolean;
}): "blocked" | "confirm" | "switch" {
  if (input.uncertain) return "blocked";
  if (input.hasDraft && !input.confirmedDiscard) return "confirm";
  return "switch";
}
