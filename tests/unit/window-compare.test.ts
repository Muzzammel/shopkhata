import { describe, expect, it } from "vitest";
import { compareSnapshots } from "../../scripts/window-compare.mjs";

// The release-window comparison must tolerate exactly what a release is supposed to change and fail on anything else.
const base = () => ({
  tables: { invoices: "3:aaa", payments: "2:bbb", customers: "5:ccc" },
  audit_business: "9:ddd",
  audit_maintenance: ["maintenance.enabled"] as string[],
  receipts: "1:eee",
  auth_users: "4:fff",
  migrations: ["20261031165915", "20261103140000"],
  maintenance: "true:false",
});
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

describe("window snapshot comparison", () => {
  it("identical snapshots pass with nothing to report", () => {
    const { ok, report } = compareSnapshots(base(), base());
    expect(ok).toBe(true);
    expect(Object.values(report).flat()).toEqual([]);
  });

  it("expected release changes are categorized, not failed: migrations, new empty tables, maintenance audit", () => {
    const after = clone(base());
    after.migrations.push("20261103150000");
    (after.tables as Record<string, string>).invoice_voids = "0:";
    after.audit_maintenance.push("maintenance.operator_bypass_enabled", "maintenance.operator_bypass_disabled");
    const { ok, report } = compareSnapshots(base(), after, { expectMigrations: ["20261103150000"], expectMaintenanceAudit: ["maintenance.operator_bypass_enabled", "maintenance.operator_bypass_disabled"] });
    expect(ok).toBe(true);
    expect(report.migration_metadata.join("|")).toContain("20261103150000");
    expect(report.migration_metadata.join("|")).toContain("invoice_voids");
    expect(report.release_control).toHaveLength(1);
    expect(report.unexpected).toEqual([]);
  });

  it("an unannounced business write fails, and the same write passes once declared as operator smoke", () => {
    const after = clone(base());
    after.tables.invoices = "4:zzz";
    after.audit_business = "10:yyy";
    expect(compareSnapshots(base(), after).ok).toBe(false);
    expect(compareSnapshots(base(), after, { smokeTables: ["customers"] }).ok).toBe(false);   // declared for another table
    const declared = compareSnapshots(base(), after, { smokeTables: ["invoices"] });
    expect(declared.ok).toBe(true);
    expect(declared.report.operator_smoke.join("|")).toContain("invoices: 3 -> 4");
  });

  it("a row in a table a migration created is unexpected unless declared", () => {
    const after = clone(base());
    (after.tables as Record<string, string>).invoice_voids = "1:abc";
    expect(compareSnapshots(base(), after).ok).toBe(false);
    expect(compareSnapshots(base(), after, { smokeTables: ["invoice_voids"] }).ok).toBe(true);
  });

  it("rewritten history, dropped tables, moved receipts or accounts, and a wrong migration set all fail", () => {
    const rewritten = clone(base()); rewritten.migrations = ["20261031165915", "20269999999999"];
    expect(compareSnapshots(base(), rewritten).ok).toBe(false);
    const dropped = clone(base()); delete (dropped.tables as Record<string, string>).payments;
    expect(compareSnapshots(base(), dropped).ok).toBe(false);
    const receipts = clone(base()); receipts.receipts = "2:eee";
    expect(compareSnapshots(base(), receipts).ok).toBe(false);
    const users = clone(base()); users.auth_users = "4:other";
    expect(compareSnapshots(base(), users).ok).toBe(false);
    const extra = clone(base()); extra.migrations.push("20261103150000", "20261103190000");
    expect(compareSnapshots(base(), extra, { expectMigrations: ["20261103150000"] }).ok).toBe(false);
    const trail = clone(base()); trail.audit_maintenance = ["maintenance.disabled"];
    expect(compareSnapshots(base(), trail).ok).toBe(false);
  });
});
