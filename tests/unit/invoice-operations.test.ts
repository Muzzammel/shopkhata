import { describe, expect, it } from "vitest";
import { correctionInput, replacementInput, decisionInput, operationError, normalizeInvoiceNumber } from "@/lib/invoice-operations";
import { can, type Actor } from "@/lib/auth/permissions";
import { readAllPages } from "@/lib/read-all-pages";

const base = { shop_id: "10000000-0000-4000-8000-000000000001", invoice_id: "a1000000-0000-4000-8000-000000000001", idempotency_key: "10000000-0000-4000-8000-000000000009", reason: " Fix mistake " };
describe("invoice operation inputs", () => {
  it("requires a signed safe nonzero delta and a reason", () => {
    expect(correctionInput.parse({ ...base, amount_delta_dirham: -100, payment_id: null }).reason).toBe("Fix mistake");
    for (const amount_delta_dirham of [0, 1.1, Number.MAX_SAFE_INTEGER + 1]) expect(correctionInput.safeParse({ ...base, amount_delta_dirham, payment_id: null }).success).toBe(false);
    expect(correctionInput.safeParse({ ...base, amount_delta_dirham: 100, payment_id: null, reason: " " }).success).toBe(false);
  });
  it("requires an expected revision, explicit customer and boolean delivered", () => {
    const input = { ...base, expected_revision: 0, invoice_number: " NEW-1 ", customer_id: null, delivered: false };
    expect(replacementInput.parse(input).invoice_number).toBe("NEW-1");
    for (const bad of [{ expected_revision: -1 }, { customer_id: undefined }, { delivered: "false" }, { invoice_number: " " }, { total_amount_dirham: 1 }]) expect(replacementInput.safeParse({ ...input, ...bad }).success).toBe(false);
  });
  it("normalizes historical and current numbers consistently", () => {
    expect(normalizeInvoiceNumber(" AbC-123 ")).toBe("abc-123");
  });
  it("requires separately keyed decisions with an expected revision", () => {
    expect(decisionInput.safeParse({ shop_id: base.shop_id, request_id: base.invoice_id, idempotency_key: base.idempotency_key, expected_revision: 0, decision: "approved", reason: "" }).success).toBe(true);
    expect(decisionInput.safeParse({ ...base, decision: "approved" }).success).toBe(false);
  });
  it("maps allowed errors and never reveals SQL", () => {
    expect(operationError("NUMBER_ALREADY_REGISTERED")).toContain("another invoice");
    expect(operationError("STALE_REVISION")).toContain("changed");
    expect(operationError("duplicate key secret table")).toBe("The operation could not be completed.");
    expect(operationError("constructor")).toBe("The operation could not be completed.");
  });
  it("enforces the locked new capability matrix", () => {
    for (const role of ["staff", "manager", "owner"] as const) {
      const actor: Actor = { id: "actor", role, isActive: true, shopIds: [base.shop_id] };
      expect(can(actor, "correction.request", base.shop_id)).toBe(true);
      expect(can(actor, "invoice.replacement.request", base.shop_id)).toBe(true);
      expect(can(actor, "invoice.replacement.approve", base.shop_id)).toBe(role !== "staff");
      expect(can({ ...actor, isActive: false }, "invoice.replacement.request", base.shop_id)).toBe(false);
      expect(can(actor, "invoice.replacement.request", "unassigned")).toBe(role === "owner");
    }
  });
  it("reads complete history across API page caps and fails closed on a missing page", async () => {
    const rows = Array.from({ length: 1201 }, (_, n) => n);
    const result = await readAllPages(async (offset, end) => ({ data: rows.slice(offset, end + 1), error: null }));
    expect(result.data).toEqual(rows);
    expect((await readAllPages(async (offset) => offset ? { data: null, error: "failed" } : { data: rows.slice(0, 500), error: null })).data).toBeNull();
  });
});
