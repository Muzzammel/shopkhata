import { describe, expect, it } from "vitest";

import { accessSummary, accountChanges, describeAccountEvent } from "@/lib/account-view";

const shops = [{ id: "s1", name: "Shop 1" }, { id: "s2", name: "Shop 2" }];
const staff = { role: "staff", isActive: true, shopIds: ["s1"] };

describe("account view", () => {
  it("states effective access in the directory's words", () => {
    expect(accessSummary(staff, shops)).toBe("Shop 1");
    expect(accessSummary({ ...staff, shopIds: [] }, shops)).toBe("No access (no shop assigned)");
    expect(accessSummary({ ...staff, role: "owner", shopIds: [] }, shops)).toBe("All shops (owner)");
    expect(accessSummary({ ...staff, isActive: false }, shops)).toBe("No access (inactive)");
  });

  it("reports no change when nothing differs", () => {
    expect(accountChanges("Ali", staff, { ...staff, shopIds: ["s1"] }, shops).changed).toBe(false);
  });

  it("compares current with requested values and explains a deactivation", () => {
    const { rows, notes, changed } = accountChanges("Ali", staff, { ...staff, isActive: false }, shops);
    expect(changed).toBe(true);
    expect(rows.find((row) => row.label === "Status")).toEqual({ label: "Status", current: "Active", requested: "Inactive" });
    expect(rows.find((row) => row.label === "Can reach")).toEqual({ label: "Can reach", current: "Shop 1", requested: "No access (inactive)" });
    expect(notes[0]).toMatch(/loses all access/);
  });

  it("explains role and shop changes, and warns when an active account is left without a shop", () => {
    const promote = accountChanges("Ali", staff, { role: "manager", isActive: true, shopIds: ["s2"] }, shops).notes;
    expect(promote.some((note) => /As a manager/.test(note))).toBe(true);
    expect(promote).toContain("Ali gains access to Shop 2 at their next page load.");
    expect(promote).toContain("Ali loses access to Shop 1 at their next page load.");
    expect(accountChanges("Ali", staff, { ...staff, shopIds: [] }, shops).notes.some((note) => /no shop access/.test(note))).toBe(true);
    expect(accountChanges("Ali", { ...staff, role: "owner" }, staff, shops).notes.some((note) => /loses Accounts, Backup/.test(note))).toBe(true);
  });

  it("describes audit events in words instead of raw JSON", () => {
    const names = new Map([["u1", "Ali"]]);
    const shopNames = new Map([["s2", "Shop 2"]]);
    expect(describeAccountEvent({ action: "account.update", entity_id: "u1", shop_id: null, metadata: { before: { role: "staff", is_active: true }, after: { role: "manager", is_active: false } } }, names, shopNames))
      .toEqual({ title: "Changed role or status · Ali", detail: "Role Staff → Manager · Active → Inactive" });
    expect(describeAccountEvent({ action: "assignment.remove", entity_id: "u1", shop_id: "s2", metadata: { shop_id: "s2" } }, names, shopNames))
      .toEqual({ title: "Removed shop access · Ali · Shop 2", detail: "" });
    expect(describeAccountEvent({ action: "account.deactivate", entity_id: "u1", shop_id: null, reason: "Left the business", metadata: { role: "staff", before: { is_active: true }, after: { is_active: false } } }, names, shopNames))
      .toEqual({ title: "Deactivated account · Ali", detail: "Reason: Left the business" });
    expect(describeAccountEvent({ action: "account.reactivate", entity_id: "u1", shop_id: null, reason: "Rehired", metadata: {} }, names, shopNames))
      .toEqual({ title: "Reactivated account · Ali", detail: "Reason: Rehired" });
  });
});
