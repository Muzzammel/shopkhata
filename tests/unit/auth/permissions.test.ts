import { describe, expect, it } from "vitest";

import {
  can,
  getCurrentActor,
  type Actor,
  type Permission,
} from "@/lib/auth/permissions";

const SHOP_1 = "10000000-0000-4000-8000-000000000001";
const SHOP_2 = "10000000-0000-4000-8000-000000000002";

const ACTIONS = [
  "batch.enter",
  "payment.record",
  "expense.create",
  "invoice.deliver_due",
  "records.view_assigned",
  "reports.view_all",
  "payment.override_excess",
  "correction.approve",
  "date.close",
  "date.reopen",
  "users.manage",
  "records.export",
  "batch.import",
  "audit.view_full",
] as const;

type ActionName = (typeof ACTIONS)[number];
type SupportedRole = "owner" | "manager" | "staff";

const SCOPED_ACTIONS: readonly ActionName[] = [
  "batch.enter",
  "payment.record",
  "expense.create",
  "invoice.deliver_due",
  "records.view_assigned",
  "payment.override_excess",
  "correction.approve",
  "date.close",
  "date.reopen",
  "records.export",
  "batch.import",
  "audit.view_full",
];

const MUTATION_ACTIONS: readonly ActionName[] = [
  "batch.enter",
  "payment.record",
  "expense.create",
  "invoice.deliver_due",
  "payment.override_excess",
  "correction.approve",
  "date.close",
  "date.reopen",
  "users.manage",
  "batch.import",
];

const MANAGER_PERMISSIONS: readonly ActionName[] = [
  "batch.enter",
  "payment.record",
  "expense.create",
  "invoice.deliver_due",
  "records.view_assigned",
  "payment.override_excess",
  "correction.approve",
  "date.close",
  "date.reopen",
  "records.export",
  "batch.import",
  "audit.view_full",
];

const STAFF_PERMISSIONS: readonly ActionName[] = [
  "batch.enter",
  "payment.record",
  "expense.create",
  "invoice.deliver_due",
  "records.view_assigned",
  "records.export",
  "batch.import",
];

function makeActor(
  role: SupportedRole,
  overrides: Partial<Actor> = {},
): Actor {
  return {
    id: `${role}-actor`,
    role,
    isActive: true,
    shopIds: [SHOP_1],
    ...overrides,
  };
}

function decision(
  actor: Actor,
  action: ActionName,
  shopId?: string,
): boolean {
  return can(actor, action as Permission, shopId);
}

describe("trusted actor permission contract", () => {
  it("exposes asynchronous trusted actor resolution", () => {
    expect(getCurrentActor).toEqual(expect.any(Function));
  });

  it("gives an owner every approved Owner/Admin permission in either shop", () => {
    const owner = makeActor("owner", { shopIds: [] });

    for (const action of ACTIONS) {
      expect(decision(owner, action, SHOP_1), action).toBe(true);
      expect(decision(owner, action, SHOP_2), action).toBe(true);
    }
  });

  it("gives a manager only the approved Manager permissions in assigned shops", () => {
    const manager = makeActor("manager", { shopIds: [SHOP_1, SHOP_2] });

    for (const action of MANAGER_PERMISSIONS) {
      expect(decision(manager, action, SHOP_1), action).toBe(true);
      expect(decision(manager, action, SHOP_2), action).toBe(true);
    }

    for (const action of ACTIONS.filter(
      (candidate) => !MANAGER_PERMISSIONS.includes(candidate),
    )) {
      expect(decision(manager, action, SHOP_1), action).toBe(false);
      expect(decision(manager, action, SHOP_2), action).toBe(false);
    }
  });

  it("gives staff only the approved Staff permissions in the assigned shop", () => {
    const staff = makeActor("staff", { shopIds: [SHOP_1] });

    for (const action of STAFF_PERMISSIONS) {
      expect(decision(staff, action, SHOP_1), action).toBe(true);
    }

    for (const action of ACTIONS.filter(
      (candidate) => !STAFF_PERMISSIONS.includes(candidate),
    )) {
      expect(decision(staff, action, SHOP_1), action).toBe(false);
    }
  });

  it("denies manager and staff access to an unassigned shop", () => {
    for (const role of ["manager", "staff"] as const) {
      const actor = makeActor(role, { shopIds: [SHOP_1] });

      for (const action of SCOPED_ACTIONS) {
        expect(decision(actor, action, SHOP_2), `${role}:${action}`).toBe(
          false,
        );
      }
    }
  });

  it("does not restrict an owner by shop assignments", () => {
    const owner = makeActor("owner", { shopIds: [] });

    for (const action of SCOPED_ACTIONS) {
      expect(decision(owner, action, SHOP_1), action).toBe(true);
      expect(decision(owner, action, SHOP_2), action).toBe(true);
    }
  });

  it("requires a shop ID for shop-scoped permissions", () => {
    const owner = makeActor("owner", { shopIds: [] });
    const manager = makeActor("manager", { shopIds: [SHOP_1] });

    for (const action of SCOPED_ACTIONS) {
      expect(decision(owner, action), `owner:${action}`).toBe(false);
      expect(decision(manager, action), `manager:${action}`).toBe(false);
    }
  });

  it("does not require a shop ID for non-shop-scoped permissions", () => {
    const owner = makeActor("owner", { shopIds: [] });

    expect(decision(owner, "reports.view_all")).toBe(true);
    expect(decision(owner, "users.manage")).toBe(true);
  });

  it("blocks every mutation for a deactivated actor", () => {
    for (const role of ["owner", "manager", "staff"] as const) {
      const actor = makeActor(role, {
        isActive: false,
        shopIds: [SHOP_1, SHOP_2],
      });

      for (const action of MUTATION_ACTIONS) {
        const shopId = SCOPED_ACTIONS.includes(action) ? SHOP_1 : undefined;
        expect(decision(actor, action, shopId), `${role}:${action}`).toBe(
          false,
        );
      }
    }
  });

  it("uses the resolved actor rather than caller-supplied role or assignment claims", () => {
    const resolvedStaff = makeActor("staff", { shopIds: [SHOP_1] });
    const forgedClaims = {
      role: "owner",
      shopIds: [SHOP_2],
    };

    expect(
      decision(
        Object.assign(resolvedStaff, { claims: forgedClaims }),
        "records.view_assigned",
        SHOP_1,
      ),
    ).toBe(true);
    expect(
      decision(
        Object.assign(resolvedStaff, { claims: forgedClaims }),
        "records.view_assigned",
        SHOP_2,
      ),
    ).toBe(false);
  });

  it("does not let a caller-supplied shop ID expand the actor assignment", () => {
    const staff = makeActor("staff", { shopIds: [SHOP_1] });

    expect(decision(staff, "records.view_assigned", SHOP_1)).toBe(true);
    expect(decision(staff, "records.view_assigned", SHOP_2)).toBe(false);
  });

  it("fails closed for unknown actions and unknown roles", () => {
    const staff = makeActor("staff");
    const unknownRole = makeActor("staff", {
      role: "unrecognized-role" as Actor["role"],
    });

    expect(decision(staff, "unknown.action" as ActionName)).toBe(false);
    expect(
      can(unknownRole, "records.view_assigned" as Permission, SHOP_1),
    ).toBe(false);
  });
});
