import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { prepareInvoiceBatch, qatarBusinessDate, type EntryRow } from "@/lib/invoice-entry";
import { compareSnapshots, loadDeclarations } from "../../../scripts/window-compare.mjs";
import { AS_MIGRATION_ROLE, POST36_DRIFTS, PREFLIGHT_DRIFTS } from "./preflight-drifts";
import {
  MANAGER, NEW_VERSIONS, OWNER, OWNER_ID, SHOP_1, STAFF1, STAFF1_ID, V35, bypassOff, bypassOn, lastJson, localEnv, maintenanceOff, maintenanceOn,
  observeQuiescence, psql, pushUpTo, runbookV3, session, sh, signIn, sleep, supabase, uid,
} from "./release-helpers";

// OPS-01B slice 1: the release window, rehearsed end to end on the local stack with the runbook's real commands
// (docs/operations/ops-01b-slice1-release-runbook.md). It models production at migration 35 and walks:
//   inventory gate (+ drift negatives) -> bootstrap under live traffic WITH a receipt upload in flight across the
//   migration-36 install (R) and an old pre-36 RPC transaction left open (S) -> post-36 gate -> lock -> W5 detects the
//   old transaction and the recovery backup refuses -> drain -> full W5 observation (T) -> AUTHORITATIVE recovery point
//   -> 37 -> 38 -> 39 -> bounded operator bypass smoke -> record-level comparison -> revoke -> reopen.
// The Vercel Firewall is the one control that cannot run locally (it was rehearsed on a disposable Vercel project).

const log: string[] = [];
const say = (line: string) => { log.push(line); console.log(`[window] ${line}`); if (process.env.WINDOW_TRANSCRIPT) appendFileSync(process.env.WINDOW_TRANSCRIPT, `${line}\n`); };
const snapshotSql = readFileSync("scripts/window-snapshot.sql", "utf8");
const preflightSql = readFileSync("scripts/ops-01b-preflight.sql", "utf8");
const post36Sql = readFileSync("scripts/ops-01b-post36-verify.sql", "utf8");
const snapshot = async () => { const s = lastJson(await psql(snapshotSql)); delete s.at; return s; };
const V4_TRIGGER = `select count(*) from pg_trigger where tgrelid = 'storage.objects'::regclass and tgname = 'expense_receipts_maintenance_guard' and tgenabled = 'O' and not tgisinternal;`;
const HOLD_KEY = 7770101;

/** Runs a gate script after a simulated drift inside a rolled-back transaction; returns the ids of the failing checks. */
async function gateUnder(sql: string, gate: string, admin = false): Promise<{ verdict: string; failed: string[] }> {
  const result = lastJson(await psql(`begin;\n${sql}\n${admin ? AS_MIGRATION_ROLE : ""}${gate}\nrollback;\n`, admin ? "supabase_admin" : "postgres"));
  return { verdict: result.verdict, failed: result.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id.split(" ")[0]) };
}

describe("OPS-01B release window (35 -> 39), rehearsed on the local stack", () => {
  it("walks the runbook: inventory, bootstrap with in-flight receipt and old RPC, post-36 gate, lock, drain, recovery point, 37-39, smoke, reopen", async () => {
    try { await rehearse(); } finally { await supabase(["db", "reset", "--local"], undefined, 240_000); }
  }, 1_800_000);
});

async function rehearse(): Promise<void> {
  const backups = mkdtempSync(join(tmpdir(), "ops01b-backups-"));
  const backupEnv = { SHOPKHATA_BACKUP_DIR: backups };

  // ---- PRE-WINDOW ------------------------------------------------------------------------------------------------
  await supabase(["db", "reset", "--local", "--version", V35], undefined, 240_000);
  const env = await localEnv();
  const staff = await signIn(env, STAFF1); const owner = await signIn(env, OWNER); const manager = await signIn(env, MANAGER);
  const today = qatarBusinessDate(new Date());
  const sale = async (client: SupabaseClient, total: string) => {
    const row: EntryRow = { rowId: `r-${uid()}`, invoiceId: `RH-${Date.now()}-${uid()}`, total, received: "", delivered: false, customerId: "", customerName: "", customerMobile: "" };
    const { command, errors } = prepareInvoiceBatch({ shopId: SHOP_1, businessDate: today, isBackdated: false, backdatedReason: "", idempotencyKey: `rh-${uid()}`, rows: [row] }, []);
    expect(errors).toEqual([]);
    const result = await client.rpc("submit_batch", { command });
    return { error: result.error?.message ?? null, invoiceId: result.data?.rows?.[0]?.invoice_id as string, number: row.invoiceId };
  };
  for (const n of [1, 2, 3]) expect((await staff.rpc("create_customer", { command: { shop_id: SHOP_1, name: `Existing ${n} ${uid()}`, mobile: null } })).error).toBeNull();
  expect((await sale(staff, "250.00")).error).toBeNull();
  const expense = await staff.rpc("create_expense", { command: { shop_id: SHOP_1, amount_dirham: 1500, business_date: today, category: "supplies", description: "Existing expense", idempotency_key: crypto.randomUUID() } });
  expect(expense.error).toBeNull();
  const expenseId = expense.data.expense_id as string;
  say("P0 production modeled at migration 35 with business data");

  // Inventory gate: PASS on the reviewed state; every simulated drift STOPs on the check that covers it.
  const gate = lastJson(await psql(preflightSql));
  expect(gate.verdict, JSON.stringify(gate.checks.filter((c: { ok: boolean }) => !c.ok))).toBe("PASS");
  expect(gate.evidence.session.current_user).toBe("postgres");
  say(`P1 inventory gate PASS (${gate.checks.length} checks; session ${gate.evidence.session.current_user})`);
  for (const [name, drift] of Object.entries(PREFLIGHT_DRIFTS)) {
    const result = await gateUnder(drift.sql, preflightSql, drift.admin);
    expect(result.verdict, `the gate must STOP on ${name}`).toBe("STOP");
    expect(result.failed, `${name} must fail ${drift.stops.join("+")}`).toEqual(expect.arrayContaining(drift.stops));
  }
  say(`P1 inventory gate STOP on all ${Object.keys(PREFLIGHT_DRIFTS).length} simulated drifts, each on its own check`);

  const rehearsalBackup = (await sh(["backup:db"], backupEnv)).match(/Backup complete: (.+)/)?.[1]?.trim();
  expect(rehearsalBackup).toBeTruthy();
  expect(await sh(["backup:verify", "--from", rehearsalBackup!], backupEnv, 480_000)).toContain("RESTORE VERIFIED");
  say("P2 backup capability proven (pre-window copy, not the recovery point)");

  // ---- WINDOW ----------------------------------------------------------------------------------------------------
  say("W1 Vercel firewall ON: modeled (rehearsed separately on a disposable Vercel project)");
  // Live ordinary direct-API writers through the install and the lock.
  const accepted: string[] = []; const refused: string[] = []; const other: string[] = [];
  let stop = false;
  const writer = (async () => {
    let n = 0;
    while (!stop) {
      const name = `Bootstrap ${n++} ${uid()}`;
      const { error } = await staff.rpc("create_customer", { command: { shop_id: SHOP_1, name, mobile: null } });
      if (!error) accepted.push(name); else if (error.message === "MAINTENANCE_ACTIVE") refused.push(name); else other.push(`${name}: ${error.message}`);
      await sleep(25);
    }
  })();
  while (accepted.length < 5) await sleep(100);

  // S: an old (pre-36) RPC transaction, opened before the install and left open (idle in transaction).
  const oldRpcName = `Old RPC ${uid()}`;
  const oldRpc = session();
  oldRpc.send(`begin;\nset local role authenticated;\nselect set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '${STAFF1_ID}')::text, true);\nselect (public.create_customer(jsonb_build_object('shop_id', '${SHOP_1}', 'name', '${oldRpcName}', 'mobile', null)) ->> 'customer_id') is not null as old_rpc_done;\nselect 'old-rpc-open';`);
  await oldRpc.until("old-rpc-open");
  expect(oldRpc.errors()).toBe("");

  // R: a receipt upload already in flight, its storage.objects row inserted and uncommitted, when 36 is installed.
  // A test-only AFTER INSERT hook (installed as the owner, private, no grant) parks the service-role commit transaction
  // of that one expense's upload on an advisory lock the test holds.
  expect(await psql(`create function private.zz_hold() returns trigger language plpgsql as $f$ begin
  if coalesce(current_setting('request.jwt.claims', true), '') like '%service_role%' and new.name like '%/${expenseId}/%' then perform pg_advisory_xact_lock(${HOLD_KEY}); end if;
  return new; end $f$;
revoke all on function private.zz_hold() from public;
create trigger zz_hold after insert on storage.objects for each row execute function private.zz_hold();`, "supabase_admin")).toBeDefined();
  const holder = session(); holder.send(`select pg_advisory_lock(${HOLD_KEY});\nselect 'held';`); await holder.until("held");
  const receiptPath = `${SHOP_1}/${expenseId}/${crypto.randomUUID()}.pdf`;
  const upload = staff.storage.from("expense-receipts").upload(receiptPath, new Blob(["%PDF-1.4 bootstrap receipt"], { type: "application/pdf" }), { contentType: "application/pdf" });
  const waitUntil = async (sql: string, expected: string, what: string, ms = 30_000) => {
    const end = Date.now() + ms;
    while ((await psql(sql)) !== expected) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(150); }
  };
  await waitUntil(`select count(*) from pg_locks where locktype = 'advisory' and not granted and objid = ${HOLD_KEY}`, "1", "the upload's commit transaction to park after its INSERT");

  // W2: install 36 while the upload transaction holds its row lock on storage.objects. CREATE TRIGGER needs SHARE ROW
  // EXCLUSIVE on storage.objects, which conflicts with the upload's ROW EXCLUSIVE: the migration must wait for it.
  const staged36 = NEW_VERSIONS[0];
  let pushed = false;
  const push = pushUpTo(staged36, staged36).then(() => { pushed = true; });
  await waitUntil(`select count(*) from pg_locks l where l.relation = 'storage.objects'::regclass and not l.granted and l.mode = 'ShareRowExclusiveLock'`, "1", "migration 36 to queue for the storage.objects lock");
  await sleep(1000);
  expect(pushed, "migration 36 cannot commit while the in-flight upload holds its row lock").toBe(false);
  const waitedOn = await psql(`select string_agg(distinct w.mode || ' blocked by ' || h.mode, ', ') from pg_locks w join pg_locks h on h.relation = w.relation and h.granted and h.pid <> w.pid where w.relation = 'storage.objects'::regclass and not w.granted`);
  say(`R  CREATE TRIGGER waits for the in-flight upload: ${waitedOn}`);
  await sleep(500); // nothing else moves meanwhile
  holder.send(`select pg_advisory_unlock(${HOLD_KEY});`); await holder.end();
  const uploaded = await upload;
  expect(uploaded.error, "the upload admitted at 35 (no guard yet) commits; the trigger is not retroactive").toBeNull();
  await push;
  expect(await psql(`select count(*) from storage.objects where name = '${receiptPath}'`)).toBe("1");
  say("R  the upload committed first (no guard existed when it inserted), then 36 committed; the object row is committed and will be in the recovery point");
  // Remove the test hook (it would otherwise be a foreign trigger: the post-36 gate must and does STOP on it, below).
  const withHook = lastJson(await psql(post36Sql));
  expect(withHook.verdict).toBe("STOP");
  expect(withHook.checks.find((c: { id: string }) => c.id.startsWith("P07")).ok).toBe(false);
  await psql("drop trigger zz_hold on storage.objects; drop function private.zz_hold();", "supabase_admin");

  // W2b: the mandatory post-36 gate, before maintenance is enabled.
  const post36 = lastJson(await psql(post36Sql));
  expect(post36.verdict, JSON.stringify(post36.checks.filter((c: { ok: boolean }) => !c.ok))).toBe("PASS");
  expect(post36.checks.find((c: { id: string }) => c.id.startsWith("P08")).got).toEqual([{ enabled: false, bypass: false }]);
  say(`W2b post-36 gate PASS (${post36.checks.length} checks: trigger, definition, function bodies, owner_id, privileges, V3)`);

  // W3: lock at once.
  const installedAt = accepted.length;
  expect((await maintenanceOn()).changed).toBe(true);
  say(`W2/W3 guard installed after ${installedAt} bootstrap writes, maintenance ON`);
  await sleep(1500);
  stop = true; await writer;
  expect(other, "no bootstrap writer may see anything but success or MAINTENANCE_ACTIVE").toEqual([]);
  expect(refused.length, "writers that started after the barrier are refused").toBeGreaterThan(0);
  const stored = new Set((await psql("select name from public.customers where name like 'Bootstrap %'")).split("\n").filter(Boolean));
  expect(accepted.filter((name) => !stored.has(name)), "accepted but missing").toEqual([]);
  expect(refused.filter((name) => stored.has(name)), "refused but written").toEqual([]);
  say(`W3 bootstrap traffic: ${accepted.length} accepted and stored, ${refused.length} refused with MAINTENANCE_ACTIVE, 0 other outcomes`);

  // W4: closed (refusal probes only).
  expect((await staff.rpc("create_customer", { command: { shop_id: SHOP_1, name: "Probe", mobile: null } })).error?.message).toBe("MAINTENANCE_ACTIVE");
  expect((await owner.rpc("submit_batch", { command: {} })).error?.message).toBe("MAINTENANCE_ACTIVE");
  expect((await manager.rpc("create_expense", { command: {} })).error?.message).toBe("MAINTENANCE_ACTIVE");
  expect((await staff.storage.from("expense-receipts").upload(`${SHOP_1}/${expenseId}/${crypto.randomUUID()}.pdf`, new Blob(["%PDF-1.4 x"], { type: "application/pdf" }), { contentType: "application/pdf" })).error).not.toBeNull();
  expect(await psql(V4_TRIGGER)).toBe("1");
  expect(await psql(runbookV3())).toBe("");
  say("W4 ordinary writes refused for staff, manager and owner; direct receipt upload refused; V3 (runbook text) 0 rows; V4 1");

  // Post-36 gate negatives (rolled back; the database is at 36, locked).
  for (const [name, drift] of Object.entries(POST36_DRIFTS)) {
    const result = await gateUnder(drift.sql, post36Sql, drift.admin);
    expect(result.verdict, `the post-36 gate must STOP on ${name}`).toBe("STOP");
    expect(result.failed, `${name} must fail ${drift.stops.join("+")}`).toEqual(expect.arrayContaining(drift.stops));
  }
  say(`W2b post-36 gate STOP on all ${Object.keys(POST36_DRIFTS).length} simulated install defects`);

  // W5 with the old RPC still open: NOT quiescent, and the recovery backup refuses.
  const notQuiet = await observeQuiescence(0);
  expect(notQuiet.first.quiescent, "the old pre-36 transaction is visible to W5").toBe(false);
  expect(notQuiet.first.open_writers).toBeGreaterThan(0);
  expect(notQuiet.first.sessions.some((s: { state: string }) => s.state.startsWith("idle in transaction"))).toBe(true);
  await expect(sh(["backup:db"], { ...backupEnv, SHOPKHATA_BACKUP_REQUIRE_QUIESCENT: "1" })).rejects.toThrow(/not quiescent before the dumps/);
  say(`S  W5 detects the old pre-36 RPC transaction (open writers ${notQuiet.first.open_writers}, write locks ${notQuiet.first.write_locks.length}); the recovery backup REFUSES`);
  // Drain: let it finish. It commits after the lock (it never passed the guard), and before the recovery point.
  oldRpc.send("commit;\nselect 'old-rpc-committed';"); await oldRpc.until("old-rpc-committed"); await oldRpc.end();
  expect(oldRpc.output(), "the old RPC call itself succeeded").toMatch(/^t$/m);
  expect(await psql(`select count(*) from public.customers where name = '${oldRpcName}'`)).toBe("1");
  say("S  drained: the old transaction committed (accepted, before the recovery point)");

  // W5 (T): two zero observations at least 5 s apart, no lock waiter, every session idle with no open transaction.
  const quiet = await observeQuiescence(5000);
  for (const o of [quiet.first, quiet.second]) {
    expect(o.quiescent, JSON.stringify(o)).toBe(true);
    expect(o.busy).toBe(0); expect(o.open_writers).toBe(0); expect(o.lock_waiters).toBe(0); expect(o.write_locks).toEqual([]);
    for (const s of o.sessions) { expect(s.state).toBe("idle"); expect(s.xact_start).toBeNull(); }
  }
  expect(Date.parse(quiet.second.at) - Date.parse(quiet.first.at)).toBeGreaterThanOrEqual(5000);
  const users = [...new Set(quiet.second.sessions.map((s: { user: string }) => s.user))].sort();
  say(`T  W5 quiescent twice ${((Date.parse(quiet.second.at) - Date.parse(quiet.first.at)) / 1000).toFixed(1)} s apart; 0 lock waiters; sessions: ${quiet.second.sessions.length} idle (${users.join(", ")})`);

  // W6: the AUTHORITATIVE recovery point, quiescence enforced by the tool.
  const since = await psql("select clock_timestamp()");
  const recovery = (await sh(["backup:db"], { ...backupEnv, SHOPKHATA_BACKUP_REQUIRE_QUIESCENT: "1" })).match(/Backup complete: (.+)/)?.[1]?.trim();
  expect(recovery).toBeTruthy();
  const manifest = JSON.parse(readFileSync(join(recovery!, "manifest.json"), "utf8"));
  expect(manifest.receipts.map((r: { name: string }) => r.name), "the receipt accepted across the install is in the recovery point").toContain(receiptPath);
  expect(readFileSync(join(recovery!, "data.sql"), "utf8")).toContain(oldRpcName);
  const verified = await sh(["backup:verify", "--from", recovery!], backupEnv, 480_000);
  expect(verified).toContain("RESTORE VERIFIED");
  expect(verified).toContain("restored LOCKED");
  const baseline = await snapshot();
  expect(baseline.maintenance.enabled).toBe(true);
  expect(Object.keys(baseline.receipts)).toContain(receiptPath);
  await sleep(1000);
  const stable = compareSnapshots(baseline, await snapshot(), { expectMaintenance: "on" });
  expect(stable.report, "nothing may move between the recovery point and now").toEqual({ release_control: [], migration_metadata: [], operator_smoke: [], unexpected: [] });
  say(`W6 recovery point (quiescent, ${manifest.receipts.length} receipt(s) incl. the bootstrap one, the drained old-RPC write) RESTORE VERIFIED (locked); baseline stable`);

  // W7-W9: 37 -> 38 -> 39.
  for (let i = 1; i < NEW_VERSIONS.length; i++) {
    await pushUpTo(NEW_VERSIONS[i], NEW_VERSIONS[i]);
    const step = compareSnapshots(baseline, await snapshot(), { expectMigrations: NEW_VERSIONS.slice(1, i + 1), expectMaintenance: "on" });
    expect(step.ok, JSON.stringify(step.report)).toBe(true);
    expect(await psql(runbookV3())).toBe("");
    say(`W7 migration ${NEW_VERSIONS[i]} applied; business data unchanged record by record; maintenance still ON`);
  }
  expect(await psql("select count(*) from supabase_migrations.schema_migrations")).toBe("39");

  // W10-W11: bounded operator bypass and smoke (S1 + payment, S2 + void): two batches.
  expect((await bypassOn()).changed).toBe(true);
  expect((await staff.rpc("create_customer", { command: { shop_id: SHOP_1, name: "Staff during bypass", mobile: null } })).error?.message).toBe("MAINTENANCE_ACTIVE");
  expect((await manager.rpc("create_customer", { command: { shop_id: SHOP_1, name: "Manager during bypass", mobile: null } })).error?.message).toBe("MAINTENANCE_ACTIVE");
  const s1 = await sale(owner, "100.00"); const s2 = await sale(owner, "200.00");
  expect(s1.error).toBeNull(); expect(s2.error).toBeNull();
  expect((await owner.rpc("record_payment", { command: { shop_id: SHOP_1, invoice_id: s1.invoiceId, amount_dirham: 2500, payment_method: "cash", business_date: today, idempotency_key: crypto.randomUUID() } })).error).toBeNull();
  const voidCmd = (invoiceId: string) => ({ command: { shop_id: SHOP_1, invoice_id: invoiceId, reason: "Operator smoke void of a test invoice", idempotency_key: crypto.randomUUID() } });
  expect((await owner.rpc("void_invoice", voidCmd(s1.invoiceId))).error?.message).toBe("PAYMENTS_OUTSTANDING");
  expect((await owner.rpc("void_invoice", voidCmd(s2.invoiceId))).error).toBeNull();
  say("W11 operator smoke: S1 + payment, S2 + void (two batches); S1 void refused PAYMENTS_OUTSTANDING; staff and manager still refused");

  // W12: record-level comparison with the runbook's declaration template.
  const declarations = loadDeclarations(readFileSync("scripts/ops-01b-smoke-declaration.json", "utf8"), {
    SHOP_ID: SHOP_1, BUSINESS_DATE: today, OWNER_ID, S1_NUMBER: s1.number, S1_TOTAL: 10000, S2_NUMBER: s2.number, S2_TOTAL: 20000, PAYMENT_AMOUNT: 2500,
  });
  const migrations = NEW_VERSIONS.slice(1);
  const w12 = compareSnapshots(baseline, await snapshot(), { declarations, expectMigrations: migrations, expectMaintenanceAudit: ["maintenance.operator_bypass_enabled"], expectMaintenance: "bypass" });
  expect(w12.ok, JSON.stringify(w12.report)).toBe(true);
  expect(w12.report.operator_smoke).toHaveLength(13);
  say(`W12 record-level comparison PASS: ${w12.report.operator_smoke.length} declared records matched, unexpected 0`);

  // W13-W14: revoke, then disable; then W15 final comparison.
  expect((await bypassOff()).changed).toBe(true);
  expect((await owner.rpc("create_customer", { command: { shop_id: SHOP_1, name: "Owner after revoke", mobile: null } })).error?.message).toBe("MAINTENANCE_ACTIVE");
  expect((await maintenanceOff()).changed).toBe(true);
  const after = await snapshot();
  const w15 = compareSnapshots(baseline, after, { declarations, expectMigrations: migrations,
    expectMaintenanceAudit: ["maintenance.operator_bypass_enabled", "maintenance.operator_bypass_disabled", "maintenance.disabled"], expectMaintenance: "off" });
  expect(w15.ok, JSON.stringify(w15.report)).toBe(true);
  expect(compareSnapshots(baseline, after, { expectMigrations: migrations, expectMaintenance: "off" }).ok, "the same changes WITHOUT the declaration are unexpected").toBe(false);
  expect(compareSnapshots(baseline, after, { declarations, expectMigrations: migrations, expectMaintenance: "on" }).ok, "a wrong final maintenance state fails").toBe(false);
  say(`W15 final comparison PASS (maintenance on -> bypass -> revoked -> off, 13 smoke records); undeclared smoke and wrong final state FAIL`);

  const acceptedSince = (await psql(`select action from public.audit_events where created_at > '${since}' and action not like 'maintenance.%' order by action`)).split("\n").filter(Boolean);
  expect(acceptedSince).toEqual(["batch.submit", "batch.submit", "invoice.void", "record_payment"]);
  say(`A1 accepted since the recovery point: ${acceptedSince.join(", ")}`);

  expect((await staff.rpc("create_customer", { command: { shop_id: SHOP_1, name: `Back to normal ${uid()}`, mobile: null } })).error).toBeNull();
  expect(await psql("select enabled::text || ':' || (bypass_user_id is null)::text from private.system_maintenance")).toBe("false:true");
  say("W16/W17 reopened: staff writes normally, maintenance off, no bypass");
  expect(existsSync(recovery!)).toBe(true);
  console.log(`[window] TRANSCRIPT\n${log.join("\n")}`);
}
