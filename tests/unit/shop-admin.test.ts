import { describe, expect, it } from "vitest";

import { createShopInput, describeShopEvent, isDuplicateShopName, setShopStatusInput, shopAdminError, updateShopInput } from "@/lib/shop-admin";

const shops = [{ id: "a", name: "Shop 1" }, { id: "b", name: "Doha Branch" }];

describe("shop admin input", () => {
  it("trims the name and rejects blank, over-long and unknown fields", () => {
    expect(createShopInput.parse({ name: "  Doha  " })).toEqual({ name: "Doha" });
    expect(createShopInput.safeParse({ name: "   " }).success).toBe(false);
    expect(createShopInput.safeParse({ name: "x".repeat(101) }).success).toBe(false);
    expect(createShopInput.safeParse({ name: "x".repeat(100) }).success).toBe(true);
    expect(createShopInput.safeParse({ name: "Doha", is_active: false }).success).toBe(false);
    expect(updateShopInput.safeParse({ shop_id: "not-a-uuid", name: "Doha" }).success).toBe(false);
    expect(updateShopInput.safeParse({ shop_id: "10000000-0000-4000-8000-000000000001", name: "Doha" }).success).toBe(true);
    // A rename never carries a status change; that needs a reason and its own RPC.
    expect(updateShopInput.safeParse({ shop_id: "10000000-0000-4000-8000-000000000001", name: "Doha", is_active: false }).success).toBe(false);
  });

  it("requires a non-blank reason of at most 2000 characters for a status change", () => {
    const shop_id = "10000000-0000-4000-8000-000000000001";
    expect(setShopStatusInput.parse({ shop_id, is_active: false, reason: "  Closed  " })).toEqual({ shop_id, is_active: false, reason: "Closed" });
    expect(setShopStatusInput.safeParse({ shop_id, is_active: false, reason: " " }).success).toBe(false);
    expect(setShopStatusInput.safeParse({ shop_id, is_active: true }).success).toBe(false);
    expect(setShopStatusInput.safeParse({ shop_id, is_active: true, reason: "x".repeat(2001) }).success).toBe(false);
    expect(setShopStatusInput.safeParse({ shop_id, is_active: true, reason: "x".repeat(2000) }).success).toBe(true);
    expect(setShopStatusInput.safeParse({ shop_id, is_active: true, reason: "x", name: "Other" }).success).toBe(false);
    expect(shopAdminError("REASON_REQUIRED")).toMatch(/reason/);
  });
});

describe("duplicate shop names", () => {
  it("matches case-insensitively with outer spaces ignored, and excludes the shop being renamed", () => {
    expect(isDuplicateShopName(" shop 1 ", shops)).toBe(true);
    expect(isDuplicateShopName("DOHA BRANCH", shops)).toBe(true);
    expect(isDuplicateShopName("Doha Central", shops)).toBe(false);
    expect(isDuplicateShopName("doha branch", shops, "b")).toBe(false);
  });
});

describe("shop audit wording", () => {
  it("describes creation and rename without raw metadata", () => {
    expect(describeShopEvent({ action: "shop.create", metadata: { name: "Doha Branch" } })).toBe("Shop created: Doha Branch");
    expect(describeShopEvent({ action: "shop.update", metadata: { old_name: "Doha Branch", new_name: "Doha Central" } })).toBe("Shop renamed: Doha Branch → Doha Central");
  });

  it("describes deactivation and reactivation by the shop's name", () => {
    expect(describeShopEvent({ action: "shop.deactivate", metadata: { name: "Doha Branch", before: { is_active: true }, after: { is_active: false } } })).toBe("Shop deactivated: Doha Branch");
    expect(describeShopEvent({ action: "shop.reactivate", metadata: { name: "Doha Branch" } })).toBe("Shop reactivated: Doha Branch");
  });

  it("maps database codes to plain messages and falls back safely", () => {
    expect(shopAdminError("SHOP_NAME_EXISTS")).toMatch(/already uses that name/);
    expect(shopAdminError("INSUFFICIENT_ROLE")).toMatch(/Only an owner/);
    expect(shopAdminError("boom")).toMatch(/not saved/);
  });
});
