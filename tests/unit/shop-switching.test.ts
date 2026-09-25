import { describe, expect, it } from "vitest";

import { canSwitchShop, getShopSwitchDisposition, getVisibleShops } from "@/lib/shop-switching";
import type { Actor } from "@/lib/auth/permissions";

const shops = [
  { id: "shop-1", name: "Shop 1" },
  { id: "shop-2", name: "Shop 2" },
];

describe("shop switching", () => {
  it("offers owners every visible shop and permits switching between them", () => {
    const owner: Actor = { id: "owner", role: "owner", isActive: true, shopIds: [] };
    expect(getVisibleShops(owner, shops)).toEqual(shops);
    expect(canSwitchShop(owner, "shop-2")).toBe(true);
  });

  it("limits staff to assigned shops and keeps a single-shop staff account fixed", () => {
    const staff: Actor = { id: "staff", role: "staff", isActive: true, shopIds: ["shop-1"] };
    expect(getVisibleShops(staff, shops)).toEqual([shops[0]]);
    expect(canSwitchShop(staff, "shop-2")).toBe(false);
    expect(canSwitchShop(staff, "shop-1")).toBe(true);
  });

  it("requires confirmation for an ordinary draft and blocks uncertain commands", () => {
    expect(getShopSwitchDisposition({ hasDraft: true, uncertain: false, confirmedDiscard: false })).toBe("confirm");
    expect(getShopSwitchDisposition({ hasDraft: true, uncertain: false, confirmedDiscard: true })).toBe("switch");
    expect(getShopSwitchDisposition({ hasDraft: false, uncertain: true, confirmedDiscard: true })).toBe("blocked");
    expect(getShopSwitchDisposition({ hasDraft: false, uncertain: false, confirmedDiscard: false })).toBe("switch");
  });
});
