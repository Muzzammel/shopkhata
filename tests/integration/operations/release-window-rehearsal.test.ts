import { execFile } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { prepareInvoiceBatch, qatarBusinessDate, type EntryRow } from "@/lib/invoice-entry";
import { compareSnapshots } from "../../../scripts/window-compare.mjs";

// OPS-01B slice 1: the corrected release window, rehearsed end to end on the local stack with the runbook's real commands
// (docs/operations/ops-01b-slice1-release-runbook.md). It models production at migration 35 and walks:
//   inventory gate -> bootstrap (install the guard under live traffic, then lock) -> prove closed -> drain -> AUTHORITATIVE
//   recovery point -> 37 -> 38 -> 39 -> bounded operator bypass smoke -> revoke -> reopen -> categorized comparison.
// The Vercel Firewall is the one control that cannot run locally (it was rehearsed on a disposable Vercel project).

const execFileP = promisify(execFile);
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const DB_CONTAINER = "supabase_db_shopkhata";
const DB_URL = "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const V35 = "20261031165915";
const NEW_VERSIONS = ["20261103140000", "20261103150000", "20261103190000", "20261103203806"];
const SHOP_1 = "10000000-0000-4000-8000-000000000001";
const OWNER_ID = "10000000-0000-4000-8000-000000000101";
const OWNER = { email: "owner@shopkhata.local", password: "ShopKhata-Local-Owner-E2E-Only-2026!" };
const MANAGER = { email: "manager@shopkhata.local", password: "ShopKhata-Local-Manager-E2E-Only-2026!" };
const STAFF1 = { email: "staff1@shopkhata.local", password: "ShopKhata-Local-E2E-Only-2026!" };
const RELEASE_REF = "ops-01b-slice1-rehearsal";

const log: string[] = [];
const say = (line: string) => { log.push(line); console.log(`[window] ${line}`); if (process.env.WINDOW_TRANSCRIPT) appendFileSync(process.env.WINDOW_TRANSCRIPT, `${line}
`); };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const uid = () => Math.random().toString(36).slice(2, 10);

async function sh(args: string[], env: Record<string, string> = {}, timeout = 300_000): Promise<string> {
  const win = process.platform === "win32";
  try {
    const { stdout, stderr } = await execFileP(win ? (process.env.ComSpec ?? "cmd.exe") : PNPM, win ? ["/d", "/s", "/c", "call", PNPM, ...args] : args, {
      timeout, maxBuffer: 64 * 1024 * 1024, encoding: "utf-8",
      env: { ...process.env, ...env, PATH: `${join(process.cwd(), "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}` },
    });
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`pnpm ${args.join(" ")} failed:\n${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`);
  }
}
const supabase = (args: string[], env?: Record<string, string>, timeout?: number) => sh(["exec", "supabase", "--agent", "no", ...args], env, timeout);

async function psql(sql: string): Promise<string> {
  const child = execFileP("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", DB_CONTAINER, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], { maxBuffer: 64 * 1024 * 1024 });
  child.child.stdin?.end(sql);
  return (await child).stdout.trim();
}
const lastJson = (text: string) => JSON.parse(text.split(/\r?\n/).filter((line) => line.startsWith("{")).pop() ?? "null");
const snapshotSql = readFileSync("scripts/window-snapshot.sql", "utf8");
const preflightSql = readFileSync("scripts/ops-01b-preflight.sql", "utf8");
const snapshot = async () => { const s = lastJson(await psql(snapshotSql)); delete s.at; return s; };

/** supabase CLI push of only the migrations up to `last` (runbook section 4). */
async function pushUpTo(last: string, expectListed: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ops01b-stage-"));
  mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
  cpSync("supabase/config.toml", join(dir, "supabase", "config.toml"));
  for (const file of readdirSync("supabase/migrations")) if (file.split("_")[0] <= last) cpSync(join("supabase/migrations", file), join(dir, "supabase", "migrations", file));
  const dry = await supabase(["--workdir", dir, "db", "push", "--db-url", DB_URL, "--dry-run"]);
  const listed = dry.split(/\r?\n/).filter((line) => /^\s*•?\s*\d{14}_/.test(line) || /^\s*\d{14}_/.test(line));
  expect(listed.join("\n"), "the dry run must list exactly the migration being applied").toContain(expectListed);
  expect(listed).toHaveLength(1);
  await supabase(["--workdir", dir, "db", "push", "--db-url", DB_URL]);
}
/** Runbook section 5: ONE statement per control, the owner claims set inside it. */
async function control(fn: "set_maintenance" | "set_maintenance_bypass", command: object): Promise<{ changed: boolean }> {
  const file = join(mkdtempSync(join(tmpdir(), "ops01b-ctl-")), "control.sql");
  writeFileSync(file, `select public.${fn}('${JSON.stringify(command)}'::jsonb) as result from (select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '${OWNER_ID}')::text, true)) s`);
  const out = await supabase(["db", "query", "--db-url", DB_URL, "-f", file, "--output-format", "json"]);
  const rows = JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1)) as { result: { changed: boolean } }[];
  return rows[0].result;
}
const maintenanceOn = () => control("set_maintenance", { enabled: true, reason: "OPS-01B slice 1 release window", release_ref: RELEASE_REF });
const maintenanceOff = () => control("set_maintenance", { enabled: false, reason: "Candidate healthy; reopening", release_ref: RELEASE_REF });
const bypassOn = () => control("set_maintenance_bypass", { user_id: OWNER_ID, minutes: 60, reason: "Operator smoke of the candidate" });
const bypassOff = () => control("set_maintenance_bypass", { user_id: null, reason: "Operator smoke finished" });

// V3 of the runbook: every API-executable write function calls the guard first (0 rows expected).
const V3_UNGUARDED = `select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.provolatile = 'v'
  and has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.proname not in ('set_maintenance', 'set_maintenance_bypass')
  and regexp_replace(regexp_replace(p.prosrc, '/\\*.*?\\*/', '', 'g'), '--[^\\n]*', '', 'g') !~* '\\mbegin\\M\\s*perform\\s+private\\.assert_not_in_maintenance\\(\\)\\s*;';`;
// V4: the Storage guard trigger exists and is enabled.
const V4_TRIGGER = `select count(*) from pg_trigger where tgrelid = 'storage.objects'::regclass and tgname = 'expense_receipts_maintenance_guard' and tgenabled = 'O' and not tgisinternal;`;
// Quiescence (runbook W5): no other backend is doing or holding work.
const BUSY_BACKENDS = `select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'
  and (state in ('active', 'idle in transaction', 'idle in transaction (aborted)', 'fastpath function call') or wait_event_type = 'Lock')
  and query not like '%pg_stat_activity%';`;

const MUTATIONS: Record<string, string> = {
  "an extra write grant to authenticated": "grant insert on public.customers to authenticated;",
  "a table published to Realtime": "alter publication supabase_realtime add table public.customers;",
  "a drifted RPC body": "create or replace function public.create_customer(command jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$ begin return '{}'::jsonb; end $$;",
  "an extra anon-executable function": "create function public.zz_extra() returns void language sql as $$ select 1 $$; grant execute on function public.zz_extra() to anon;",
  "a volatile function offered from another schema": "create schema zz; create function zz.w() returns void language sql as $$ select 1 $$; grant usage on schema zz to authenticated; grant execute on function zz.w() to authenticated;",
  "a custom trigger on storage.objects": "create function public.zz_t() returns trigger language plpgsql as $$ begin return new; end $$; create trigger zz_t before insert on storage.objects for each row execute function public.zz_t();",
  "an extra Storage bucket": "insert into storage.buckets(id, name) values ('zz', 'zz');",
  "a changed Storage policy": "alter policy expense_receipts_shop_insert on storage.objects with check (true);",
  "RLS switched off on a table": "alter table public.customers disable row level security;",
  "an unexpected applied migration": "insert into supabase_migrations.schema_migrations(version, name) values ('20261103140000', 'x');",
  "the maintenance table already present": "create table private.system_maintenance(id int);",
  "a mutation trigger on a business table": "create function public.zz_h() returns trigger language plpgsql as $$ begin return new; end $$; create trigger zz_h after insert on public.payments for each row execute function public.zz_h();",
};

describe("OPS-01B corrected release window (35 -> 39), rehearsed on the local stack", () => {
  it("walks the runbook in order: inventory, bootstrap under live traffic, lock, drain, recovery point, 37-39, bypass smoke, reopen", async () => {
    try { await rehearse(); } finally { await supabase(["db", "reset", "--local"], undefined, 240_000); }
  }, 1_500_000);
});

async function rehearse(): Promise<void> {
  {
    const backups = mkdtempSync(join(tmpdir(), "ops01b-backups-"));
    const backupEnv = { SHOPKHATA_BACKUP_DIR: backups };

    // ---- PRE-WINDOW ------------------------------------------------------------------------------------------------
    await supabase(["db", "reset", "--local", "--version", V35], undefined, 240_000);
    const env = Object.fromEntries((await supabase(["status", "-o", "env"])).split(/\r?\n/).map((line) => /^([A-Z][A-Z0-9_]*)="?(.*?)"?$/.exec(line)).filter(Boolean).map((m) => [m![1], m![2]]));
    const url = env.API_URL; const key = env.PUBLISHABLE_KEY ?? env.ANON_KEY;
    const signIn = async ({ email, password }: { email: string; password: string }): Promise<SupabaseClient> => {
      const client = createClient(url, key); const { error } = await client.auth.signInWithPassword({ email, password }); if (error) throw error; return client;
    };
    const staff = await signIn(STAFF1); const owner = await signIn(OWNER); const manager = await signIn(MANAGER);
    const today = qatarBusinessDate(new Date());
    const sale = async (client: SupabaseClient, total: string) => {
      const row: EntryRow = { rowId: `r-${uid()}`, invoiceId: `RH-${Date.now()}-${uid()}`, total, received: "", delivered: false, customerId: "", customerName: "", customerMobile: "" };
      const { command, errors } = prepareInvoiceBatch({ shopId: SHOP_1, businessDate: today, isBackdated: false, backdatedReason: "", idempotencyKey: `rh-${uid()}`, rows: [row] }, []);
      expect(errors).toEqual([]);
      const result = await client.rpc("submit_batch", { command });
      return { error: result.error?.message ?? null, invoiceId: result.data?.rows?.[0]?.invoice_id as string };
    };
    // Production at 35 already holds real business data.
    for (const n of [1, 2, 3]) expect((await staff.rpc("create_customer", { command: { shop_id: SHOP_1, name: `Existing ${n} ${uid()}`, mobile: null } })).error).toBeNull();
    const existing = await sale(staff, "250.00");
    expect(existing.error).toBeNull();
    const expense = await staff.rpc("create_expense", { command: { shop_id: SHOP_1, amount_dirham: 1500, business_date: today, category: "supplies", description: "Existing expense", idempotency_key: crypto.randomUUID() } });
    expect(expense.error).toBeNull();
    const expenseId = expense.data.expense_id as string;
    say("P0 production modeled at migration 35 with business data");

    // Inventory gate: PASS on the reviewed state, STOP on every drift (each inside a rolled-back transaction).
    const gate = lastJson(await psql(preflightSql));
    expect(gate.verdict, JSON.stringify(gate.checks.filter((c: { ok: boolean }) => !c.ok))).toBe("PASS");
    say(`P1 inventory gate PASS (${gate.checks.length} checks)`);
    for (const [name, sql] of Object.entries(MUTATIONS)) {
      const drifted = lastJson(await psql(`begin;\n${sql}\n${preflightSql}\nrollback;\n`));
      expect(drifted.verdict, `the gate must STOP on ${name}`).toBe("STOP");
    }
    say(`P1 inventory gate STOP on all ${Object.keys(MUTATIONS).length} simulated drifts`);

    // Backup capability (NOT the recovery point).
    const rehearsalBackup = (await sh(["backup:db"], backupEnv)).match(/Backup complete: (.+)/)?.[1]?.trim();
    expect(rehearsalBackup).toBeTruthy();
    expect(await sh(["backup:verify", "--from", rehearsalBackup!], backupEnv, 480_000)).toContain("RESTORE VERIFIED");
    say("P2 backup capability proven (pre-window copy, not the recovery point)");

    // ---- WINDOW ----------------------------------------------------------------------------------------------------
    say("W1 Vercel firewall ON: modeled (rehearsed separately on a disposable Vercel project)");
    // Bootstrap traffic: ordinary direct-API writers stay live while the guard is installed and then locked.
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

    const staged36 = NEW_VERSIONS[0];
    await pushUpTo(staged36, staged36);                                             // W2: install the guard (maintenance OFF)
    const installedAt = accepted.length;
    const on = await maintenanceOn();                                               // W3: lock at once
    expect(on.changed).toBe(true);
    say(`W2/W3 guard installed after ${installedAt} bootstrap writes, maintenance ON`);
    await sleep(1500);
    stop = true; await writer;
    expect(other, "no bootstrap writer may see anything but success or MAINTENANCE_ACTIVE").toEqual([]);
    expect(refused.length, "writers that started after the barrier are refused").toBeGreaterThan(0);
    // Every accepted write is in the database; no refused write is.
    const stored = new Set((await psql("select name from public.customers where name like 'Bootstrap %'")).split("\n").filter(Boolean));
    expect(accepted.filter((name) => !stored.has(name)), "accepted but missing").toEqual([]);
    expect(refused.filter((name) => stored.has(name)), "refused but written").toEqual([]);
    say(`W5 bootstrap traffic: ${accepted.length} accepted and stored, ${refused.length} refused with MAINTENANCE_ACTIVE, 0 other outcomes`);

    // W4: prove ordinary business ingress is closed (refusal probes only; no ordinary success after this point).
    const probe = await staff.rpc("create_customer", { command: { shop_id: SHOP_1, name: "Probe", mobile: null } });
    expect(probe.error?.message).toBe("MAINTENANCE_ACTIVE");
    expect((await owner.rpc("submit_batch", { command: {} })).error?.message).toBe("MAINTENANCE_ACTIVE");
    expect((await manager.rpc("create_expense", { command: {} })).error?.message).toBe("MAINTENANCE_ACTIVE");
    expect((await staff.storage.from("expense-receipts").upload(`${SHOP_1}/${expenseId}/${crypto.randomUUID()}.pdf`, new Blob(["%PDF-1.4 x"], { type: "application/pdf" }), { contentType: "application/pdf" })).error).not.toBeNull();
    say("W4 ordinary writes refused for staff, manager and owner; direct receipt upload refused");

    // W5: quiescence.
    expect(Number(await psql(BUSY_BACKENDS)), "no active or idle-in-transaction business backend").toBe(0);
    expect(await psql(V4_TRIGGER)).toBe("1");
    expect(await psql(V3_UNGUARDED)).toBe("");
    say("W5 quiescent: 0 busy backends, every write RPC guarded, storage trigger enabled");

    // W6: the AUTHORITATIVE recovery point, taken only now.
    const since = await psql("select clock_timestamp()");
    const recovery = (await sh(["backup:db"], backupEnv)).match(/Backup complete: (.+)/)?.[1]?.trim();
    expect(recovery).toBeTruthy();
    expect(await sh(["backup:verify", "--from", recovery!], backupEnv, 480_000)).toContain("RESTORE VERIFIED");
    const baseline = await snapshot();
    await sleep(1000);
    expect(await snapshot(), "nothing may change between the baseline and the end of the backup").toEqual(baseline);
    // The backup carries the locked state, so a restored database comes up locked (see the restore step in the runbook).
    const dataSql = readFileSync(join(recovery!, "data.sql"), "utf8");
    expect(dataSql).toContain('COPY "private"."system_maintenance"');
    expect(dataSql).toContain("maintenance.enabled");
    say(`W6 recovery point taken after quiescence (${recovery!.split(/[\\/]/).pop()}), RESTORE VERIFIED, baseline stable`);

    // W7: 37 -> 38 -> 39, verifying after each.
    for (let i = 1; i < NEW_VERSIONS.length; i++) {
      await pushUpTo(NEW_VERSIONS[i], NEW_VERSIONS[i]);
      const now = await snapshot();
      expect(now.maintenance).toBe("true:false");
      const stepCheck = compareSnapshots(baseline, now, { expectMigrations: NEW_VERSIONS.slice(1, i + 1) });
      expect(stepCheck.ok, JSON.stringify(stepCheck.report)).toBe(true);
      expect(await psql(V3_UNGUARDED)).toBe("");
      say(`W7 migration ${NEW_VERSIONS[i]} applied; business data unchanged; maintenance still ON`);
    }
    expect(await psql("select count(*) from supabase_migrations.schema_migrations")).toBe("39");

    // W8: bounded operator bypass and smoke. These are the only writes after the recovery point.
    expect((await bypassOn()).changed).toBe(true);
    expect((await staff.rpc("create_customer", { command: { shop_id: SHOP_1, name: "Staff during bypass", mobile: null } })).error?.message).toBe("MAINTENANCE_ACTIVE");
    expect((await manager.rpc("create_customer", { command: { shop_id: SHOP_1, name: "Manager during bypass", mobile: null } })).error?.message).toBe("MAINTENANCE_ACTIVE");
    const paid = await sale(owner, "100.00"); const unpaid = await sale(owner, "200.00");
    expect(paid.error).toBeNull(); expect(unpaid.error).toBeNull();
    expect((await owner.rpc("record_payment", { command: { shop_id: SHOP_1, invoice_id: paid.invoiceId, amount_dirham: 2500, payment_method: "cash", business_date: today, idempotency_key: crypto.randomUUID() } })).error).toBeNull();
    // The invoice that just received a payment CANNOT be voided (PAYMENTS_OUTSTANDING is correct); the separate unpaid one is.
    const voidCmd = (invoiceId: string) => ({ command: { shop_id: SHOP_1, invoice_id: invoiceId, reason: "Operator smoke void of a test invoice", idempotency_key: crypto.randomUUID() } });
    expect((await owner.rpc("void_invoice", voidCmd(paid.invoiceId))).error?.message).toBe("PAYMENTS_OUTSTANDING");
    expect((await owner.rpc("void_invoice", voidCmd(unpaid.invoiceId))).error).toBeNull();
    say("W8 operator smoke: sale+payment on one invoice, void on a separate unpaid invoice; staff and manager still refused");

    // W9: revoke, then disable (order matters), then prove the general path.
    expect((await bypassOff()).changed).toBe(true);
    expect((await owner.rpc("create_customer", { command: { shop_id: SHOP_1, name: "Owner after revoke", mobile: null } })).error?.message).toBe("MAINTENANCE_ACTIVE");
    expect((await maintenanceOff()).changed).toBe(true);

    // W10: categorized comparison against the recovery point.
    const after = await snapshot();
    const changed = Object.keys(after.tables).filter((name) => after.tables[name] !== baseline.tables[name] && baseline.tables[name] !== undefined);
    const smokeTables = [...changed, ...(after.tables.invoice_voids && after.tables.invoice_voids !== "0:" ? ["invoice_voids"] : [])];
    say(`W10 tables changed by the operator smoke: ${smokeTables.sort().join(", ")}`);
    // Exactly what the declared smoke writes (sale, payment, void) can touch; anything else would be a business write nobody declared.
    expect(smokeTables).toEqual(["batches", "corrections", "invoice_number_registry", "invoice_voids", "invoices", "payments"]);
    const verdict = compareSnapshots(baseline, after, { smokeTables, expectMigrations: NEW_VERSIONS.slice(1), expectMaintenanceAudit: ["maintenance.operator_bypass_enabled", "maintenance.operator_bypass_disabled", "maintenance.disabled"] });
    expect(verdict.ok, JSON.stringify(verdict.report)).toBe(true);
    expect(verdict.report.release_control).toHaveLength(1);
    expect(verdict.report.migration_metadata.join("|")).toContain(NEW_VERSIONS.slice(1).join(", "));
    expect(verdict.report.operator_smoke.length).toBeGreaterThan(0);
    expect(compareSnapshots(baseline, after, { expectMigrations: NEW_VERSIONS.slice(1) }).ok, "the same changes WITHOUT a declared smoke are unexpected").toBe(false);
    say(`W10 comparison: release_control ${verdict.report.release_control.length}, migration_metadata ${verdict.report.migration_metadata.length}, operator_smoke ${verdict.report.operator_smoke.length}, unexpected 0; undeclared smoke correctly fails`);

    // Everything accepted after the recovery point is identifiable (abort reconciliation input).
    const acceptedSince = (await psql(`select action from public.audit_events where created_at > '${since}' and action not like 'maintenance.%' order by created_at`)).split("\n").filter(Boolean);
    expect(acceptedSince.length, "the smoke is visible in the audit trail after the recovery point").toBeGreaterThan(0);
    say(`A1 accepted since the recovery point: ${acceptedSince.join(", ")}`);

    // Reopen: a non-bypass session writes normally.
    expect((await staff.rpc("create_customer", { command: { shop_id: SHOP_1, name: `Back to normal ${uid()}`, mobile: null } })).error).toBeNull();
    expect(await psql("select enabled::text || ':' || (bypass_user_id is null)::text from private.system_maintenance")).toBe("false:true");
    say("W11 reopened: staff writes normally, maintenance off, no bypass");
    expect(existsSync(recovery!)).toBe(true);
    console.log(`[window] TRANSCRIPT\n${log.join("\n")}`);
  }
}
