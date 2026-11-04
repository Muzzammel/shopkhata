import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareSnapshots, loadDeclarations } from "../../scripts/window-compare.mjs";

// Record-level release-window comparison (runbook W12/W15): only the DECLARED smoke records may change, with the declared
// content; the maintenance state must follow from its audit trail. Every negative below must FAIL the comparison.

const SHOP = "shop-1"; const OTHER_SHOP = "shop-2"; const OWNER = "owner-1"; const DATE = "2026-11-05";
const at = (s: number) => `2026-11-05T10:00:${String(s).padStart(2, "0")}Z`;
type Rows = Record<string, Record<string, Record<string, unknown>>>;
type Snap = { rows: Rows; receipts: Record<string, unknown>; auth_users: string; migrations: string[]; maintenance: Record<string, unknown> | null };
const clone = <T>(v: T): T => structuredClone(v);
const on = { id: true, enabled: true, enabled_at: at(0), enabled_by: OWNER, reason: "window", release_ref: "ref", bypass_user_id: null, bypass_expires_at: null, bypass_enabled_by: null, bypass_reason: null };
const off = { id: true, enabled: false, enabled_at: null, enabled_by: null, reason: null, release_ref: null, bypass_user_id: null, bypass_expires_at: null, bypass_enabled_by: null, bypass_reason: null };

const baseline: Snap = {
  rows: {
    invoices: { "inv-old": { id: "inv-old", invoice_id: "100", shop_id: SHOP, business_date: "2026-11-01", total_amount_dirham: 5000, batch_id: "b-old", created_by: "staff" } },
    batches: { "b-old": { id: "b-old", shop_id: SHOP, business_date: "2026-11-01", created_by: "staff" } },
    invoice_number_registry: {}, payments: { "p-old": { id: "p-old", invoice_id: "inv-old", amount_dirham: 1000, shop_id: SHOP, business_date: "2026-11-01", created_by: "staff" } },
    corrections: {}, invoice_voids: {}, expenses: { "e-old": { id: "e-old", shop_id: SHOP, amount_dirham: 700 } },
    audit_events: { "a-old": { id: "a-old", action: "batch.submit", entity_id: "b-old", shop_id: SHOP, actor_id: "staff", metadata: {} },
      "m-1": { id: "m-1", action: "maintenance.enabled", metadata: { at: at(0) } } },
  },
  receipts: {}, auth_users: "4:abc", migrations: ["35", "36"], maintenance: on,
};

// After the W11 smoke and the full W13/W14 reopen: S1 + payment, S2 + void, the four business audit rows, maintenance trail.
function smoked(): Snap {
  const s = clone(baseline);
  const inv = (id: string, no: string, total: number, batch: string) => ({ id, invoice_id: no, shop_id: SHOP, business_date: DATE, total_amount_dirham: total, batch_id: batch, created_by: OWNER });
  Object.assign(s.rows.invoices, { "inv-s1": inv("inv-s1", "S1", 10000, "b-s1"), "inv-s2": inv("inv-s2", "S2", 20000, "b-s2") });
  Object.assign(s.rows.batches, { "b-s1": { id: "b-s1", shop_id: SHOP, business_date: DATE, created_by: OWNER }, "b-s2": { id: "b-s2", shop_id: SHOP, business_date: DATE, created_by: OWNER } });
  Object.assign(s.rows.invoice_number_registry, { "r1": { id: "r1", canonical_invoice_id: "inv-s1", invoice_number: "S1", shop_id: SHOP }, "r2": { id: "r2", canonical_invoice_id: "inv-s2", invoice_number: "S2", shop_id: SHOP } });
  s.rows.payments["p-s1"] = { id: "p-s1", invoice_id: "inv-s1", amount_dirham: 2500, shop_id: SHOP, business_date: DATE, created_by: OWNER };
  s.rows.invoice_voids["v-s2"] = { id: "v-s2", invoice_id: "inv-s2", correction_id: "c-s2", shop_id: SHOP, business_date: DATE, actor_user_id: OWNER };
  s.rows.corrections["c-s2"] = { id: "c-s2", invoice_id: "inv-s2", amount_delta_dirham: -20000, shop_id: SHOP, business_date: DATE };
  const audit = (id: string, action: string, entity: string) => ({ id, action, entity_id: entity, shop_id: SHOP, actor_id: OWNER, metadata: {} });
  Object.assign(s.rows.audit_events, { "a1": audit("a1", "batch.submit", "b-s1"), "a2": audit("a2", "batch.submit", "b-s2"), "a3": audit("a3", "record_payment", "p-s1"), "a4": audit("a4", "invoice.void", "inv-s2"),
    "m-2": { id: "m-2", action: "maintenance.operator_bypass_enabled", metadata: { at: at(10), user_id: OWNER } },
    "m-3": { id: "m-3", action: "maintenance.operator_bypass_disabled", metadata: { at: at(20), user_id: OWNER } },
    "m-4": { id: "m-4", action: "maintenance.disabled", metadata: { at: at(30) } } });
  s.migrations = ["35", "36", "37", "38", "39"];
  s.maintenance = off;
  return s;
}

const template = readFileSync("scripts/ops-01b-smoke-declaration.json", "utf8");
const declarations = loadDeclarations(template, { SHOP_ID: SHOP, BUSINESS_DATE: DATE, OWNER_ID: OWNER, S1_NUMBER: "S1", S1_TOTAL: 10000, S2_NUMBER: "S2", S2_TOTAL: 20000, PAYMENT_AMOUNT: 2500 });
const options = { declarations, expectMigrations: ["37", "38", "39"], expectMaintenanceAudit: ["maintenance.operator_bypass_enabled", "maintenance.operator_bypass_disabled", "maintenance.disabled"], expectMaintenance: "off" };
const run = (after: Snap, opts: object = options) => compareSnapshots(baseline, after, opts);

describe("window comparator: record-level smoke reconciliation", () => {
  it("passes the declared smoke exactly, with the maintenance transition on -> bypass -> revoked -> off", () => {
    const result = run(smoked());
    expect(result.report.unexpected).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.report.operator_smoke).toHaveLength(13);
    expect(result.report.release_control.join("|")).toContain("on -> off");
  });

  it("an unfilled placeholder is refused", () => {
    expect(() => loadDeclarations(template, { SHOP_ID: SHOP })).toThrow(/placeholder/);
  });

  const negatives: Record<string, (s: Snap) => void> = {
    "1 unrelated invoice rewrite in a declared invoice table": (s) => { s.rows.invoices["inv-old"].total_amount_dirham = 1; },
    "2 unrelated payment": (s) => { s.rows.payments["p-x"] = { id: "p-x", invoice_id: "inv-old", amount_dirham: 2500, shop_id: SHOP, business_date: DATE, created_by: OWNER }; },
    "3 unrelated expense": (s) => { s.rows.expenses["e-x"] = { id: "e-x", shop_id: SHOP, amount_dirham: 1 }; },
    "4 unexpected business audit event": (s) => { s.rows.audit_events["a-x"] = { id: "a-x", action: "create_customer", entity_id: "c", shop_id: SHOP, actor_id: OWNER, metadata: {} }; },
    "5 unexpected deletion": (s) => { delete s.rows.payments["p-old"]; },
    "6 unexpected extra smoke-like row": (s) => { s.rows.invoices["inv-s3"] = { ...s.rows.invoices["inv-s1"], id: "inv-s3", invoice_id: "S3" }; },
    "7 incorrect amount on an expected smoke record": (s) => { s.rows.payments["p-s1"].amount_dirham = 2600; },
    "8 wrong shop on an expected smoke record": (s) => { s.rows.invoices["inv-s1"].shop_id = OTHER_SHOP; },
    "9 wrong business date on an expected smoke record": (s) => { s.rows.invoice_voids["v-s2"].business_date = "2026-11-04"; },
    "10 incorrect final maintenance state (still on after the disable)": (s) => { s.maintenance = on; },
    "a duplicated smoke record (ambiguous)": (s) => { s.rows.invoice_number_registry["r1b"] = { ...s.rows.invoice_number_registry["r1"], id: "r1b" }; },
    "a declared record that is missing": (s) => { delete s.rows.invoice_voids["v-s2"]; },
    "a broken relationship (payment on the wrong invoice)": (s) => { s.rows.payments["p-s1"].invoice_id = "inv-s2"; },
    "a rewritten maintenance audit row": (s) => { s.rows.audit_events["m-1"].action = "maintenance.disabled"; },
    "an unexpected receipt object": (s) => { s.receipts["shop-1/e/x.pdf"] = { size: "1" }; },
    "an account change": (s) => { s.auth_users = "5:def"; },
  };
  for (const [name, mutate] of Object.entries(negatives)) {
    it(`FAILS on ${name}`, () => {
      const after = smoked(); mutate(after);
      const result = run(after);
      expect(result.ok, JSON.stringify(result.report)).toBe(false);
      expect(result.report.unexpected.length).toBeGreaterThan(0);
    });
  }

  it("FAILS when the final state does not follow from the audit trail even with no explicit expectation (bypass left on)", () => {
    const after = smoked(); after.maintenance = { ...on, bypass_user_id: OWNER };
    const result = run(after, { ...options, expectMaintenance: undefined });
    expect(result.ok).toBe(false);
    expect(result.report.unexpected.join("|")).toContain("does not follow from its audit trail");
  });

  it("FAILS the same smoke when nothing is declared, and a business table is never tolerated wholesale", () => {
    expect(run(smoked(), { ...options, declarations: undefined }).ok).toBe(false);
  });

  it("an unchanged database with maintenance unchanged passes with nothing declared (W6 stability check)", () => {
    expect(compareSnapshots(baseline, clone(baseline), { expectMaintenance: "on" }).report).toEqual({ release_control: [], migration_metadata: [], operator_smoke: [], unexpected: [] });
  });
});
