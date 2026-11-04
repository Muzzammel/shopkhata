// Compares two release-window snapshots (scripts/window-snapshot.sql) RECORD BY RECORD and sorts every difference:
//   release_control    inserted maintenance.* audit rows, checked against the expected sequence, and the maintenance state,
//                      which must follow from that sequence (and equal --expect-maintenance when given)
//   migration_metadata applied migration versions, and tables a migration created (they must start empty)
//   operator_smoke     each inserted/changed/deleted record that matched exactly one record DECLARED by the operator
//   unexpected         everything else: any other record of any table (including a declared smoke table), any business
//                      audit row nobody declared, a declared record that is missing, has the wrong content or is
//                      ambiguous, a receipt or account that moved, rewritten migration history or maintenance audit
// A table is never "allowed to change": only the declared records are.
//
// Declaration file (JSON): {"records": [{"as"?, "table", "op": "insert"|"update"|"delete", "key"?, "match": {...}}]}
//   table   a public table, or "storage.objects" for receipts
//   key     the primary key (as text) when it is known in advance
//   match   column values the record must have (after the change; for a delete, before it). "@S1.id" refers to the
//           column `id` of the record declared earlier with "as": "S1", so relationships are checked too.
//   Placeholders {{NAME}} in the file are replaced by --set NAME=value (see scripts/ops-01b-smoke-declaration.json).
//
// Usage: node scripts/window-compare.mjs before.json after.json [--declare file.json [--set NAME=value]...]
//          [--expect-migrations v1,v2] [--expect-maintenance-audit a,b] [--expect-maintenance off|on|bypass]
// Exit 1 if anything is unexpected.
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const list = (value) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const isMaintenanceAudit = (diff) => diff.table === "audit_events" && String((diff.after ?? diff.before)?.action ?? "").startsWith("maintenance.");
const describe = (d) => `${d.table} ${d.op} ${d.key}${d.table === "audit_events" ? ` (${(d.after ?? d.before)?.action})` : ""}`;
const maintenanceLabel = (m) => (!m ? "absent" : !m.enabled ? "off" : m.bypass_user_id ? "bypass" : "on");

function rowDiffs(table, was, now) {
  const out = [];
  for (const key of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
    const a = was[key]; const b = now[key];
    if (isDeepStrictEqual(a, b)) continue;
    out.push({ table, key, op: a === undefined ? "insert" : b === undefined ? "delete" : "update", before: a, after: b });
  }
  return out;
}

function resolve(value, aliases) {
  if (typeof value !== "string" || !value.startsWith("@")) return value;
  const [alias, column] = value.slice(1).split(".");
  if (!aliases[alias]) throw new Error(`declaration refers to @${alias}, which is not declared earlier (or did not match)`);
  return aliases[alias][column];
}
const same = (actual, expected) => (expected === null ? actual === null || actual === undefined : actual !== undefined && actual !== null && String(actual) === String(expected));

export function compareSnapshots(before, after, options = {}) {
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

  // Every record of every table, and every receipt object.
  const diffs = [];
  for (const table of [...new Set([...Object.keys(before.rows), ...Object.keys(after.rows)])].sort()) {
    const was = before.rows[table]; const now = after.rows[table];
    if (now === undefined) { add("unexpected", `table dropped: ${table}`); continue; }
    if (was === undefined) add("migration_metadata", `table created by a migration: ${table}`);
    diffs.push(...rowDiffs(table, was ?? {}, now));
  }
  diffs.push(...rowDiffs("storage.objects", before.receipts, after.receipts));
  if (before.auth_users !== after.auth_users) add("unexpected", `accounts changed: ${before.auth_users.split(":")[0]} -> ${after.auth_users.split(":")[0]}`);

  // Maintenance audit rows: append-only, in the expected order, and the state must follow from them.
  const maintenance = diffs.filter(isMaintenanceAudit);
  for (const d of maintenance.filter((x) => x.op !== "insert")) add("unexpected", `maintenance audit row ${d.op}d: ${describe(d)}`);
  const appended = maintenance.filter((x) => x.op === "insert").map((x) => x.after)
    .sort((x, y) => Date.parse(x.metadata?.at) - Date.parse(y.metadata?.at) || String(x.id).localeCompare(String(y.id)));
  if (appended.length) add("release_control", `maintenance audit rows: ${appended.map((a) => a.action).join(", ")}`);
  if (options.expectMaintenanceAudit && appended.map((a) => a.action).join() !== options.expectMaintenanceAudit.join()) {
    add("unexpected", `maintenance audit rows [${appended.map((a) => a.action).join(", ")}], expected [${options.expectMaintenanceAudit.join(", ")}]`);
  }
  let state = before.maintenance ? { enabled: before.maintenance.enabled, bypass_user_id: before.maintenance.bypass_user_id } : null;
  for (const a of appended) {
    if (!state) { add("unexpected", `maintenance audit row ${a.action} without a maintenance state`); break; }
    if (a.action === "maintenance.enabled") state = { enabled: true, bypass_user_id: null };
    else if (a.action === "maintenance.disabled") state = { enabled: false, bypass_user_id: null };
    else if (a.action === "maintenance.operator_bypass_enabled") state = { ...state, bypass_user_id: a.metadata?.user_id ?? "?" };
    else if (a.action === "maintenance.operator_bypass_disabled") state = { ...state, bypass_user_id: null };
    else add("unexpected", `unknown maintenance audit action ${a.action}`);
  }
  const final = after.maintenance ?? null;
  if (!appended.length && !before.maintenance && final && !final.enabled && !final.bypass_user_id) add("migration_metadata", "maintenance state created (off) by migration 36");
  else if (!appended.length && !isDeepStrictEqual(before.maintenance ?? null, final)) add("unexpected", "maintenance state changed with no maintenance audit row");
  else if (state && (!final || final.enabled !== state.enabled || (final.bypass_user_id ?? null) !== (state.bypass_user_id ?? null))) {
    add("unexpected", `maintenance state ${maintenanceLabel(final)} does not follow from its audit trail (expected ${maintenanceLabel(state)})`);
  }
  if (appended.length || !isDeepStrictEqual(before.maintenance ?? null, final)) add("release_control", `maintenance state: ${maintenanceLabel(before.maintenance)} -> ${maintenanceLabel(final)}`);
  if (options.expectMaintenance && maintenanceLabel(final) !== options.expectMaintenance) add("unexpected", `final maintenance state is ${maintenanceLabel(final)}, expected ${options.expectMaintenance}`);

  // Everything else must be a declared record: exactly one match per declaration, and nothing left over.
  const open = diffs.filter((d) => !isMaintenanceAudit(d));
  const aliases = {};
  for (const [i, decl] of (options.declarations ?? []).entries()) {
    const label = `declared ${decl.as ?? `#${i + 1}`} (${decl.table} ${decl.op})`;
    let candidates;
    try {
      const match = Object.entries(decl.match ?? {}).map(([column, value]) => [column, resolve(value, aliases)]);
      candidates = open.filter((d) => !d.used && d.table === decl.table && d.op === decl.op && (decl.key === undefined || d.key === String(decl.key))
        && match.every(([column, value]) => same((d.op === "delete" ? d.before : d.after)?.[column], value)));
    } catch (error) { add("unexpected", `${label}: ${error.message}`); continue; }
    if (candidates.length !== 1) { add("unexpected", `${label}: ${candidates.length ? `ambiguous, matches ${candidates.length} records` : "no such record changed (missing, or different content)"}`); continue; }
    candidates[0].used = true;
    if (decl.as) aliases[decl.as] = candidates[0].after ?? candidates[0].before;
    add("operator_smoke", `${label}: ${describe(candidates[0])}`);
  }
  for (const d of open.filter((x) => !x.used)) add("unexpected", `undeclared ${describe(d)}`);

  return { ok: report.unexpected.length === 0, report };
}

/** Reads a declaration file and fills its {{NAME}} placeholders; an unfilled placeholder is an error. */
export function loadDeclarations(text, values = {}) {
  const filled = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name) => {
    if (values[name] === undefined) throw new Error(`declaration placeholder {{${name}}} has no --set value`);
    return String(values[name]).replace(/["\\]/g, "\\$&");
  });
  return JSON.parse(filled).records;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/window-compare.mjs")) {
  const [beforePath, afterPath, ...rest] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error("usage: node scripts/window-compare.mjs before.json after.json [--declare file.json [--set NAME=value]...] [--expect-migrations v1,v2] [--expect-maintenance-audit a,b] [--expect-maintenance off|on|bypass]");
    process.exit(2);
  }
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const sets = Object.fromEntries(rest.flatMap((arg, i) => (rest[i - 1] === "--set" ? [[arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]] : [])));
  // Accepts the raw `supabase db query --output-format json` output ([{"snapshot": {...}}]) or the snapshot object itself.
  const read = (path) => {
    const text = readFileSync(path, "utf8");
    const v = JSON.parse(text.slice(text.search(/[[{]/), Math.max(text.lastIndexOf("]"), text.lastIndexOf("}")) + 1));
    return Array.isArray(v) ? v[0].snapshot : v.snapshot ?? v;
  };
  const { ok, report } = compareSnapshots(read(beforePath), read(afterPath), {
    declarations: flag("--declare") ? loadDeclarations(readFileSync(flag("--declare"), "utf8"), sets) : undefined,
    expectMigrations: list(flag("--expect-migrations")), expectMaintenanceAudit: list(flag("--expect-maintenance-audit")), expectMaintenance: flag("--expect-maintenance"),
  });
  for (const [category, lines] of Object.entries(report)) { console.log(`${category.toUpperCase()} (${lines.length})`); for (const line of lines) console.log(`  - ${line}`); }
  console.log(ok ? "COMPARE PASS: no unexpected change" : "COMPARE FAIL: unexpected change");
  process.exit(ok ? 0 : 1);
}
