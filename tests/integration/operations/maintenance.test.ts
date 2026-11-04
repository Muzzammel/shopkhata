import { execFileSync, spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareInvoiceBatch, qatarBusinessDate, type EntryRow } from "@/lib/invoice-entry";

// OPS-01B slice 1: the database maintenance boundary through the real Data API and Storage API, with sessions that
// were signed in BEFORE maintenance started (an already-open tab, a queued retry, or someone calling Supabase by hand
// with a valid token). Two-session tests prove an enable is a barrier for in-flight and later writes.

const SUITE_TIMEOUT = 120_000;
const RESET_TIMEOUT = 90_000;
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const DB_CONTAINER = "supabase_db_shopkhata";

type CommandFailure = Error & { stdout?: string; stderr?: string };

// --- Copied verbatim from tests/integration/migration/upgrade-path.test.ts ---
function run(args: string[], timeout: number): string {
  const useWindowsCommandShell = process.platform === "win32";
  const executable = useWindowsCommandShell
    ? (process.env.ComSpec ?? "cmd.exe")
    : PNPM;
  const executableArgs = useWindowsCommandShell
    ? ["/d", "/s", "/c", "call", PNPM, ...args]
    : args;

  try {
    return execFileSync(executable, executableArgs, {
      encoding: "utf-8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${join(process.cwd(), "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
      },
    });
  } catch (err: unknown) {
    const failure = err as CommandFailure;
    const combined = [failure.message ?? "", failure.stdout ?? "", failure.stderr ?? ""].join("\n");
    const wrapped = new Error(`Command failed: ${PNPM} ${args.join(" ")}\n${combined}`) as CommandFailure;
    wrapped.stdout = failure.stdout ?? "";
    wrapped.stderr = failure.stderr ?? "";
    throw wrapped;
  }
}

function runSupabase(args: string[], timeout: number): string {
  return run(["exec", "supabase", "--agent", "no", ...args], timeout);
}

function isSupabaseRunning(): boolean {
  try {
    runSupabase(["migration", "list", "--local"], 30_000);
    return true;
  } catch {
    return false;
  }
}
// --- End verbatim copy ---

function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    values[key] = rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"') ? rawValue.slice(1, -1) : rawValue;
  }
  return values;
}

/** One psql session; `until` resolves when its output contains the marker (see invoice-void.test.ts). */
function session(script: string) {
  const child = spawn("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", DB_CONTAINER, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"]);
  let out = ""; let err = "";
  const waiters: { marker: string; resolve: () => void }[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
    for (const waiter of waiters.filter((w) => out.includes(w.marker))) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
  });
  child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  const done = new Promise<{ code: number | null; out: string; err: string; at: number }>((resolve) => child.on("close", (code) => resolve({ code, out, err, at: Date.now() })));
  child.stdin.end(script);
  return {
    done,
    until: (marker: string) => new Promise<void>((resolve, reject) => {
      if (out.includes(marker)) return resolve();
      waiters.push({ marker, resolve });
      void done.then(() => reject(new Error(`session ended before "${marker}": ${out}\n${err}`)));
    }),
  };
}

const OWNER = { email: "owner@shopkhata.local", password: "ShopKhata-Local-Owner-E2E-Only-2026!" };
const MANAGER = { email: "manager@shopkhata.local", password: "ShopKhata-Local-Manager-E2E-Only-2026!" };
const STAFF1 = { email: "staff1@shopkhata.local", password: "ShopKhata-Local-E2E-Only-2026!" };
const SHOP_1 = "10000000-0000-4000-8000-000000000001";
const SHOP_2 = "10000000-0000-4000-8000-000000000002";
const OWNER_ID = "10000000-0000-4000-8000-000000000101";
const MANAGER_ID = "10000000-0000-4000-8000-000000000104";
const STAFF1_ID = "10000000-0000-4000-8000-000000000102";

const GUARDED = ["admin_create_shop", "admin_register_account", "admin_set_account_status", "admin_set_shop_assignment", "admin_set_shop_status",
  "admin_update_account", "admin_update_shop", "apply_customer_credit", "approve_overpayment", "close_business_date", "create_customer", "create_expense",
  "decide_expense_correction", "decide_invoice_correction", "decide_invoice_replacement", "record_customer_payment", "record_payment",
  "register_expense_attachment", "reopen_business_date", "request_expense_correction", "request_invoice_correction", "request_invoice_replacement",
  "submit_batch", "void_invoice"];

const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => qatarBusinessDate(new Date());
const as = (userId: string) => `set local role authenticated;\nselect set_config('request.jwt.claims', '{"role":"authenticated","sub":"${userId}"}', true) is not null;\n`;
const psqlScalar = async (sql: string) => { const result = await session(`${sql}\n`).done; expect(result.code, result.err).toBe(0); return result.out.trim(); };
const mt = (enabled: boolean, reason = "Integration release window") => ({ command: { enabled, reason, release_ref: "it-candidate" } });

describe("OPS-01B maintenance boundary (real Data API, Storage API and concurrent sessions)", () => {
  let supabaseAvailable = false;
  let credentials: { url: string; key: string } = { url: "", key: "" };

  beforeAll(() => {
    if (!isSupabaseRunning()) throw new Error("Prerequisite: local Supabase must be running. Start it with: pnpm.cmd exec supabase start --local");
    supabaseAvailable = true;
    runSupabase(["db", "reset", "--local"], RESET_TIMEOUT);
    const env = parseEnv(runSupabase(["status", "-o", "env"], 30_000));
    const url = env.API_URL;
    const key = env.PUBLISHABLE_KEY ?? env.ANON_KEY;
    if (!url || !key) throw new Error("Could not read local Supabase URL/key from `supabase status -o env`.");
    credentials = { url, key };
  }, SUITE_TIMEOUT);

  afterAll(() => {
    if (!supabaseAvailable) return;
    runSupabase(["db", "reset", "--local"], RESET_TIMEOUT);
  }, SUITE_TIMEOUT);

  async function signIn({ email, password }: { email: string; password: string }): Promise<SupabaseClient> {
    const client = createClient(credentials.url, credentials.key);
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return client;
  }

  function batch(rows = 1) {
    const entry: EntryRow[] = Array.from({ length: rows }, () => ({ rowId: `r-${uid()}`, invoiceId: `IT-MT-${Date.now()}-${uid()}`, total: "100.00", received: "", delivered: false, customerId: "", customerName: "", customerMobile: "" }));
    const { command, errors } = prepareInvoiceBatch({ shopId: SHOP_1, businessDate: today(), isBackdated: false, backdatedReason: "", idempotencyKey: `it-mt-${uid()}`, rows: entry }, []);
    expect(errors).toEqual([]);
    return { command };
  }
  const upload = (client: SupabaseClient, expenseId: string) =>
    client.storage.from("expense-receipts").upload(`${SHOP_1}/${expenseId}/${crypto.randomUUID()}.pdf`, new Blob(["%PDF-1.4 maintenance"], { type: "application/pdf" }), { contentType: "application/pdf", upsert: false });

  it("refuses every business write from sessions opened before maintenance, for owner, manager and staff; bypass is owner-only, short-lived and keeps role checks", async () => {
    // Sessions opened while the system is normal (the "already-open tab").
    const owner = await signIn(OWNER); const manager = await signIn(MANAGER); const staff = await signIn(STAFF1);
    const sale = await staff.rpc("submit_batch", batch());
    expect(sale.error).toBeNull();
    const invoiceId = sale.data.rows[0].invoice_id as string;
    const expense = await staff.rpc("create_expense", { command: { shop_id: SHOP_1, amount_dirham: 1500, business_date: today(), category: "supplies", description: "Before maintenance", idempotency_key: crypto.randomUUID() } });
    expect(expense.error).toBeNull();
    const expenseId = expense.data.expense_id as string;

    // Only an owner controls maintenance.
    expect((await staff.rpc("set_maintenance", mt(true))).error?.message).toBe("INSUFFICIENT_ROLE");
    expect((await manager.rpc("set_maintenance", mt(true))).error?.message).toBe("INSUFFICIENT_ROLE");
    const on = await owner.rpc("set_maintenance", mt(true));
    expect(on.error).toBeNull();
    expect(on.data).toMatchObject({ ok: true, changed: true, enabled: true, release_ref: "it-candidate" });

    // Realistic, otherwise-valid commands. Each is replayed after maintenance to prove it was valid.
    const valid = {
      submit_batch: batch().command,
      record_payment: { shop_id: SHOP_1, invoice_id: invoiceId, amount_dirham: 2500, payment_method: "cash", business_date: today(), idempotency_key: crypto.randomUUID() },
      create_customer: { shop_id: SHOP_1, name: `Maintenance ${uid()}`, mobile: null },
      create_expense: { shop_id: SHOP_1, amount_dirham: 700, business_date: today(), category: "supplies", description: "During maintenance", idempotency_key: crypto.randomUUID() },
      request_invoice_correction: { shop_id: SHOP_1, invoice_id: invoiceId, payment_id: null, amount_delta_dirham: 2000, reason: "Price was higher", idempotency_key: crypto.randomUUID() },
      close_business_date: { shop_id: SHOP_1, business_date: today() },
    } as const;
    const clients = { owner, manager, staff };
    for (const [who, client] of Object.entries(clients)) {
      for (const [fn, command] of Object.entries(valid)) {
        expect((await client.rpc(fn, { command })).error?.message, `${who}:${fn}`).toBe("MAINTENANCE_ACTIVE");
      }
      expect((await client.rpc("void_invoice", { command: { shop_id: SHOP_1, invoice_id: invoiceId, reason: "Customer cancelled the order", idempotency_key: crypto.randomUUID() } })).error?.message, `${who}:void`).toBe("MAINTENANCE_ACTIVE");
      for (const fn of GUARDED) expect((await client.rpc(fn, { command: {} })).error?.message, `${who}:${fn}`).toBe("MAINTENANCE_ACTIVE");
      const receipt = await upload(client, expenseId);
      expect(receipt.error, `${who}:upload`).not.toBeNull();
    }
    expect(await psqlScalar(`select count(*) from storage.objects where name like '${SHOP_1}/${expenseId}/%'`)).toBe("0");

    // The same refusal for a hand-written request with the stored access token (no supabase-js, no app).
    const token = (await staff.auth.getSession()).data.session!.access_token;
    const raw = await fetch(`${credentials.url}/rest/v1/rpc/submit_batch`, { method: "POST", headers: { apikey: credentials.key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ command: batch().command }) });
    expect(raw.status).toBe(400);
    expect(((await raw.json()) as { message: string }).message).toBe("MAINTENANCE_ACTIVE");
    const insert = await fetch(`${credentials.url}/rest/v1/customers`, { method: "POST", headers: { apikey: credentials.key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ shop_id: SHOP_1, name: "Direct insert" }) });
    expect([401, 403]).toContain(insert.status);
    // pg_graphql is not installed: there is no GraphQL mutation surface.
    const gql = await fetch(`${credentials.url}/graphql/v1`, { method: "POST", headers: { apikey: credentials.key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: "{ __typename }" }) });
    expect(gql.ok && JSON.stringify(await gql.json()).includes("__typename\":\"Query")).toBe(false);
    // Reads stay RLS-scoped (no new exposure): staff can read their shop's invoice.
    expect((await staff.from("effective_invoices").select("canonical_invoice_id").eq("canonical_invoice_id", invoiceId)).data).toHaveLength(1);

    // Operator bypass: only an active owner can hold it; it never lifts the refusal for anyone else.
    expect((await owner.rpc("set_maintenance_bypass", { command: { user_id: MANAGER_ID, minutes: 10, reason: "Smoke" } })).error?.message).toBe("BYPASS_USER_NOT_ACTIVE_OWNER");
    expect((await staff.rpc("set_maintenance_bypass", { command: { user_id: STAFF1_ID, minutes: 10, reason: "Smoke" } })).error?.message).toBe("INSUFFICIENT_ROLE");
    const bypass = await owner.rpc("set_maintenance_bypass", { command: { user_id: OWNER_ID, minutes: 10, reason: "Operator smoke of candidate" } });
    expect(bypass.error).toBeNull();
    expect(bypass.data).toMatchObject({ changed: true, bypass_user_id: OWNER_ID });
    const ownerSale = await owner.rpc("submit_batch", batch());
    expect(ownerSale.error).toBeNull();
    expect((await upload(owner, expenseId)).error).toBeNull();
    expect((await manager.rpc("submit_batch", batch())).error?.message).toBe("MAINTENANCE_ACTIVE");
    expect((await staff.rpc("create_customer", { command: valid.create_customer })).error?.message).toBe("MAINTENANCE_ACTIVE");
    expect((await upload(staff, expenseId)).error).not.toBeNull();
    // No role elevation and no shop-status skip: the bypass owner is still refused where an owner normally is.
    expect((await owner.rpc("admin_set_shop_status", { command: { shop_id: SHOP_2, is_active: false, reason: "Bypass scope test" } })).error).toBeNull();
    expect((await owner.rpc("create_customer", { command: { shop_id: SHOP_2, name: `Inactive ${uid()}`, mobile: null } })).error?.message).toBe("SHOP_INACTIVE");
    expect((await owner.rpc("admin_set_shop_status", { command: { shop_id: SHOP_2, is_active: true, reason: "Bypass scope test done" } })).error).toBeNull();

    // Expiry: an expired grant is ignored without anyone revoking it.
    await psqlScalar("update private.system_maintenance set bypass_expires_at = now() - interval '1 second'");
    expect((await owner.rpc("submit_batch", batch())).error?.message).toBe("MAINTENANCE_ACTIVE");
    expect((await upload(owner, expenseId)).error).not.toBeNull();
    // Revocation is immediate.
    expect((await owner.rpc("set_maintenance_bypass", { command: { user_id: OWNER_ID, minutes: 5, reason: "Second smoke pass" } })).error).toBeNull();
    expect((await owner.rpc("set_maintenance_bypass", { command: { user_id: null, reason: "Smoke finished" } })).data).toMatchObject({ changed: true, bypass_user_id: null });
    expect((await owner.rpc("submit_batch", batch())).error?.message).toBe("MAINTENANCE_ACTIVE");

    // Reopen: the refused commands were valid all along.
    const off = await owner.rpc("set_maintenance", mt(false, "Candidate healthy"));
    expect(off.data).toMatchObject({ changed: true, enabled: false });
    expect((await owner.rpc("set_maintenance", mt(false, "Candidate healthy"))).data).toMatchObject({ changed: false });
    for (const fn of ["submit_batch", "record_payment", "create_customer", "create_expense", "request_invoice_correction"] as const) {
      expect((await staff.rpc(fn, { command: valid[fn] })).error, `after reopen ${fn}`).toBeNull();
    }
    expect((await upload(staff, expenseId)).error).toBeNull();
    const { data: audit } = await owner.from("audit_events").select("action").eq("entity_type", "system_maintenance").order("created_at");
    expect(audit?.map((row) => row.action)).toEqual(["maintenance.enabled", "maintenance.operator_bypass_enabled", "maintenance.operator_bypass_enabled", "maintenance.operator_bypass_disabled", "maintenance.disabled"]);
    expect((await staff.from("audit_events").select("id").eq("entity_type", "system_maintenance")).data).toEqual([]);
  });

  it("race: an enable waits for an in-flight write, which commits; nothing written after the enable", async () => {
    const name = `Inflight ${uid()}`;
    const write = session(`begin;\n${as(STAFF1_ID)}select 'wrote:' || (public.create_customer('${JSON.stringify({ shop_id: SHOP_1, name, mobile: null })}') ->> 'ok');\nselect pg_sleep(1.5);\ncommit;\n`);
    await write.until("wrote:");
    const started = Date.now();
    const enable = session(`begin;\n${as(OWNER_ID)}select 'on:' || (public.set_maintenance('${JSON.stringify(mt(true).command)}') ->> 'changed');\ncommit;\n`);
    const [w, e] = await Promise.all([write.done, enable.done]);
    expect(w.code, w.err).toBe(0);
    expect(e.code, e.err).toBe(0);
    expect(e.out).toContain("on:true");
    expect(e.at - started).toBeGreaterThan(800);
    expect(e.at).toBeGreaterThanOrEqual(w.at - 50);
    expect(await psqlScalar(`select count(*) from public.customers where name = '${name}'`)).toBe("1");
    await psqlScalar(`update private.system_maintenance set enabled = false, enabled_at = null, enabled_by = null, reason = null, release_ref = null`);
  });

  it("race: a write that starts while an enable is uncommitted waits, then refuses", async () => {
    const name = `Late ${uid()}`;
    const enable = session(`begin;\n${as(OWNER_ID)}select 'on:' || (public.set_maintenance('${JSON.stringify(mt(true).command)}') ->> 'changed');\nselect pg_sleep(1.5);\ncommit;\n`);
    await enable.until("on:");
    const write = session(`begin;\n${as(STAFF1_ID)}select public.create_customer('${JSON.stringify({ shop_id: SHOP_1, name, mobile: null })}');\ncommit;\n`);
    const [e, w] = await Promise.all([enable.done, write.done]);
    expect(e.code, e.err).toBe(0);
    expect(w.code).not.toBe(0);
    expect(w.err).toContain("MAINTENANCE_ACTIVE");
    expect(w.at).toBeGreaterThanOrEqual(e.at - 50);
    expect(await psqlScalar(`select count(*) from public.customers where name = '${name}'`)).toBe("0");
  });

  it("race: two owners enabling and disabling concurrently leave one state and one audit row per transition", async () => {
    await psqlScalar("update private.system_maintenance set enabled = false, enabled_at = null, enabled_by = null, reason = null, release_ref = null");
    const before = Number(await psqlScalar("select count(*) from public.audit_events where entity_type = 'system_maintenance'"));
    const enableSql = `begin;\n${as(OWNER_ID)}select 'r:' || (public.set_maintenance('${JSON.stringify(mt(true).command)}') ->> 'changed');\nselect pg_sleep(0.5);\ncommit;\n`;
    const [a, b] = await Promise.all([session(enableSql).done, session(enableSql).done]);
    expect([a.out, b.out].map((out) => /r:(true|false)/.exec(out)?.[1]).sort()).toEqual(["false", "true"]);
    const disableSql = `begin;\n${as(OWNER_ID)}select 'r:' || (public.set_maintenance('${JSON.stringify(mt(false).command)}') ->> 'changed');\ncommit;\n`;
    const [c, d] = await Promise.all([session(disableSql).done, session(disableSql).done]);
    expect([c.out, d.out].map((out) => /r:(true|false)/.exec(out)?.[1]).sort()).toEqual(["false", "true"]);
    expect(await psqlScalar("select enabled from private.system_maintenance")).toBe("f");
    expect(Number(await psqlScalar("select count(*) from public.audit_events where entity_type = 'system_maintenance'")) - before).toBe(2);
  });
});
