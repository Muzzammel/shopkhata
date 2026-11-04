// Compares two release-window snapshots (scripts/window-snapshot.sql) and sorts every difference into one of four
// categories, so a release can tolerate what it is SUPPOSED to change and still fail on anything else:
//   release_control    maintenance.* audit rows (enable, bypass, disable)
//   migration_metadata applied migration versions, and tables a migration created (they must start empty)
//   operator_smoke     business writes the operator declared (--smoke <tables>) for the bypass smoke
//   unexpected         everything else: any business row, audit row, receipt or account that moved
// Usage: node scripts/window-compare.mjs before.json after.json [--smoke invoices,payments] [--expect-migrations v1,v2]
//        [--expect-maintenance-audit a,b]      Exit 1 if anything is unexpected.
import { readFileSync } from "node:fs";

const EMPTY = /^0:/;
const list = (value) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

export function compareSnapshots(before, after, options = {}) {
  const smoke = new Set(options.smokeTables ?? []);
  const report = { release_control: [], migration_metadata: [], operator_smoke: [], unexpected: [] };
  const add = (category, text) => report[category].push(text);

  // Migrations only ever append.
  const bm = before.migrations; const am = after.migrations;
  if (am.length < bm.length || bm.some((v, i) => am[i] !== v)) add("unexpected", `migration history changed: before ${bm.length} versions, after ${am.length}, prefix differs`);
  else {
    const added = am.slice(bm.length);
    if (added.length) add("migration_metadata", `migrations applied: ${added.join(", ")}`);
    if (options.expectMigrations && added.join() !== options.expectMigrations.join()) add("unexpected", `migrations applied [${added.join(", ")}], expected [${options.expectMigrations.join(", ")}]`);
  }

  // Maintenance audit rows are append-only release control.
  const bma = before.audit_maintenance; const ama = after.audit_maintenance;
  if (ama.length < bma.length || bma.some((a, i) => ama[i] !== a)) add("unexpected", "maintenance audit trail was rewritten");
  else {
    const added = ama.slice(bma.length);
    if (added.length) add("release_control", `maintenance audit rows: ${added.join(", ")}`);
    if (options.expectMaintenanceAudit && added.join() !== options.expectMaintenanceAudit.join()) add("unexpected", `maintenance audit rows [${added.join(", ")}], expected [${options.expectMaintenanceAudit.join(", ")}]`);
  }

  // Business tables: equal, unless the operator declared a smoke write to that table.
  for (const name of [...new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])].sort()) {
    const was = before.tables[name]; const now = after.tables[name];
    if (was === now) continue;
    if (was === undefined) {
      if (EMPTY.test(now)) add("migration_metadata", `table created by a migration, empty: ${name}`);
      else add(smoke.has(name) ? "operator_smoke" : "unexpected", `new table ${name} holds rows (${now.split(":")[0]})`);
    } else if (now === undefined) add("unexpected", `table dropped: ${name}`);
    else add(smoke.has(name) ? "operator_smoke" : "unexpected", `${name}: ${was.split(":")[0]} -> ${now.split(":")[0]} rows (content changed)`);
  }
  for (const key of ["receipts", "auth_users"]) {
    if (before[key] !== after[key]) add(smoke.has(key) ? "operator_smoke" : "unexpected", `${key}: ${before[key].split(":")[0]} -> ${after[key].split(":")[0]}`);
  }
  // A declared smoke writes business audit rows (invoice.void, payment.recorded, ...); otherwise they must not move.
  if (before.audit_business !== after.audit_business) add(smoke.size ? "operator_smoke" : "unexpected", `business audit rows: ${before.audit_business.split(":")[0]} -> ${after.audit_business.split(":")[0]}`);

  return { ok: report.unexpected.length === 0, report };
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/window-compare.mjs")) {
  const [beforePath, afterPath, ...rest] = process.argv.slice(2);
  if (!beforePath || !afterPath) { console.error("usage: node scripts/window-compare.mjs before.json after.json [--smoke a,b] [--expect-migrations v1,v2] [--expect-maintenance-audit a,b]"); process.exit(2); }
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const read = (path) => JSON.parse(readFileSync(path, "utf8").trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop());
  const { ok, report } = compareSnapshots(read(beforePath), read(afterPath), {
    smokeTables: list(flag("--smoke")), expectMigrations: list(flag("--expect-migrations")), expectMaintenanceAudit: list(flag("--expect-maintenance-audit")),
  });
  for (const [category, lines] of Object.entries(report)) { console.log(`${category.toUpperCase()} (${lines.length})`); for (const line of lines) console.log(`  - ${line}`); }
  console.log(ok ? "COMPARE PASS: no unexpected change" : "COMPARE FAIL: unexpected change");
  process.exit(ok ? 0 : 1);
}
