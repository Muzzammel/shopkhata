import type { Actor } from "@/lib/auth/permissions";

export type ShopChoice = { id: string; name: string };

export function canSwitchShop(actor: Actor, shopId: string): boolean {
  return actor.role === "owner" || actor.shopIds.includes(shopId);
}

export function getVisibleShops<T extends ShopChoice>(actor: Actor, shops: readonly T[]): T[] {
  return shops.filter((shop) => canSwitchShop(actor, shop.id));
}

export type ShopState = ShopChoice & { is_active: boolean };

/**
 * Shops a page may open. An inactive shop stays readable as history, but only to an owner;
 * everyone else keeps seeing active shops only. Read with no is_active filter, then pass through here.
 */
export function getReadableShops<T extends ShopState>(actor: Actor, shops: readonly T[]): T[] {
  return getVisibleShops(actor, shops).filter((shop) => shop.is_active || actor.role === "owner");
}

/**
 * The requested shop when readable, otherwise the first active one, otherwise the first readable
 * (inactive, read-only) one. Pass getReadableShops() output: it already holds only active shops for
 * staff/managers, so the last fallback can only ever reach an inactive shop for an owner.
 * AppShell mirrors this pick so the switcher and page always agree.
 */
export function pickShop<T extends ShopState>(shops: readonly T[], requested: unknown): T | undefined {
  return shops.find((shop) => shop.id === requested) ?? shops.find((shop) => shop.is_active) ?? shops[0];
}

/**
 * The actor to check a page's controls against. An inactive shop is read-only: can() already
 * refuses every mutation permission to an inactive actor, while reads, audit and export stay.
 * Only for hiding controls; the database refuses the write regardless (SHOP_INACTIVE).
 */
export function shopViewer(actor: Actor, shop: { is_active: boolean }): Actor {
  return shop.is_active ? actor : { ...actor, isActive: false };
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
