import { describe, expect, it } from "vitest";

import { canSwitchShop, getReadableShops, getShopSwitchDisposition, getVisibleShops, pickShop, shopViewer } from "@/lib/shop-switching";
import { can, type Actor } from "@/lib/auth/permissions";

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

  it("opens an inactive shop read-only to the owner only, and never by default", () => {
    const rows = [{ id: "a", name: "A", is_active: false }, { id: "b", name: "B", is_active: true }];
    const owner: Actor = { id: "owner", role: "owner", isActive: true, shopIds: [] };
    const staff: Actor = { id: "staff", role: "staff", isActive: true, shopIds: ["a", "b"] };
    const manager: Actor = { id: "manager", role: "manager", isActive: true, shopIds: ["a"] };
    expect(getReadableShops(owner, rows).map((s) => s.id)).toEqual(["a", "b"]);
    expect(getReadableShops(staff, rows).map((s) => s.id)).toEqual(["b"]);
    expect(getReadableShops(manager, rows)).toEqual([]);
    expect(pickShop(rows, undefined)?.id).toBe("b");
    expect(pickShop(rows, "a")?.id).toBe("a");
    expect(pickShop(getReadableShops(staff, rows), "a")?.id).toBe("b");

    const viewer = shopViewer(owner, rows[0]);
    expect(can(viewer, "records.view_assigned", "a")).toBe(true);
    expect(can(viewer, "audit.view_full", "a")).toBe(true);
    expect(can(viewer, "records.export", "a")).toBe(true);
    for (const write of ["batch.enter", "payment.record", "expense.create", "date.close", "date.reopen", "correction.request", "invoice.replacement.request", "correction.approve", "invoice.replacement.approve"] as const) {
      expect(can(viewer, write, "a")).toBe(false);
    }
    expect(shopViewer(owner, rows[1])).toBe(owner);
  });

  it("falls back to an inactive shop only for an owner, and only when no shop is active", () => {
    const owner: Actor = { id: "owner", role: "owner", isActive: true, shopIds: [] };
    const staff: Actor = { id: "staff", role: "staff", isActive: true, shopIds: ["a", "b", "c"] };
    const mixed = [{ id: "a", name: "A", is_active: false }, { id: "b", name: "B", is_active: true }, { id: "c", name: "C", is_active: true }];
    const allInactive = mixed.map((shop) => ({ ...shop, is_active: false }));
    // 1. Any active shop wins the default over an earlier inactive one.
    expect(pickShop(getReadableShops(owner, mixed), undefined)?.id).toBe("b");
    expect(pickShop(getReadableShops(owner, mixed), "missing")?.id).toBe("b");
    // 2. No active shop: the owner opens the first readable (inactive) shop.
    expect(pickShop(getReadableShops(owner, allInactive), undefined)?.id).toBe("a");
    // 3. An explicit inactive shop stays selected, whether or not active shops exist.
    expect(pickShop(getReadableShops(owner, mixed), "a")?.id).toBe("a");
    expect(pickShop(getReadableShops(owner, allInactive), "c")?.id).toBe("c");
    // 4. Staff gain nothing: no inactive shop is readable, so the fallback has nothing to reach.
    expect(pickShop(getReadableShops(staff, allInactive), undefined)).toBeUndefined();
    expect(pickShop(getReadableShops(staff, allInactive), "a")).toBeUndefined();
    expect(pickShop(getReadableShops(staff, mixed), "a")?.id).toBe("b");
  });

  it("requires confirmation for an ordinary draft and blocks uncertain commands", () => {
    expect(getShopSwitchDisposition({ hasDraft: true, uncertain: false, confirmedDiscard: false })).toBe("confirm");
    expect(getShopSwitchDisposition({ hasDraft: true, uncertain: false, confirmedDiscard: true })).toBe("switch");
    expect(getShopSwitchDisposition({ hasDraft: false, uncertain: true, confirmedDiscard: true })).toBe("blocked");
    expect(getShopSwitchDisposition({ hasDraft: false, uncertain: false, confirmedDiscard: false })).toBe("switch");
  });
});
