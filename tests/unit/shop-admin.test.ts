import { describe, expect, it } from "vitest";

import { createShopInput, describeShopEvent, isDuplicateShopName, shopAdminError, updateShopInput } from "@/lib/shop-admin";

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

  it("maps database codes to plain messages and falls back safely", () => {
    expect(shopAdminError("SHOP_NAME_EXISTS")).toMatch(/already uses that name/);
    expect(shopAdminError("INSUFFICIENT_ROLE")).toMatch(/Only an owner/);
    expect(shopAdminError("boom")).toMatch(/not saved/);
  });
});
