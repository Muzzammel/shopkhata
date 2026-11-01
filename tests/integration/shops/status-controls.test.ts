import { execFileSync, spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareInvoiceBatch, qatarBusinessDate, type EntryRow } from "@/lib/invoice-entry";

// OPS-01A: shop and account Active / Inactive controls through the real API with real sessions,
// and the deactivate-versus-write race proven with two concurrent database sessions.

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

const OWNER_EMAIL = "owner@shopkhata.local";
const OWNER_PASSWORD = "ShopKhata-Local-Owner-E2E-Only-2026!";
const STAFF1_EMAIL = "staff1@shopkhata.local";
const STAFF1_PASSWORD = "ShopKhata-Local-E2E-Only-2026!";
const SHOP_1 = "10000000-0000-4000-8000-000000000001";
const OWNER_ID = "10000000-0000-4000-8000-000000000101";
const STAFF1_ID = "10000000-0000-4000-8000-000000000102";

const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => qatarBusinessDate(new Date());

/**
 * One psql session in the local database container. The whole script is sent at once; `until`
 * resolves when a line of output contains the marker, so a second session can be started at an
 * exact point of the first one's transaction instead of after a guessed delay.
 */
function session(script: string) {
  const child = spawn("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", DB_CONTAINER, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"]);
  let out = ""; let err = "";
  const waiters: { marker: string; resolve: () => void }[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
    for (const waiter of waiters.filter((w) => out.includes(w.marker))) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
  });
  child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => child.on("close", (code) => resolve({ code, out, err })));
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

const as = (userId: string) => `set local role authenticated;\nselect set_config('request.jwt.claims', '{"role":"authenticated","sub":"${userId}"}', true) is not null;\n`;
const status = (active: boolean, reason: string) => `select 'status:' || (public.admin_set_shop_status('${JSON.stringify({ shop_id: SHOP_1, is_active: active, reason })}') ->> 'changed');\n`;
const expense = (key: string) => `select 'expense:' || (public.create_expense('${JSON.stringify({ shop_id: SHOP_1, amount_dirham: 100, business_date: today(), category: "supplies", description: "Race", idempotency_key: key })}') ->> 'ok');\n`;
const psqlScalar = async (sql: string) => { const result = await session(`${sql}\n`).done; expect(result.code, result.err).toBe(0); return result.out.trim(); };

describe("OPS-01A status controls (real network, real sessions, concurrent sessions)", () => {
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

  async function signIn(email: string, password: string): Promise<SupabaseClient> {
    const client = createClient(credentials.url, credentials.key);
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return client;
  }

  const row = (patch: Partial<EntryRow> = {}): EntryRow => ({ rowId: `r-${uid()}`, invoiceId: `IT-ST-${Date.now()}-${uid()}`, total: "10.00", received: "", delivered: false, customerId: "", customerName: "", customerMobile: "", ...patch });
  const sell = (client: SupabaseClient, key = `it-st-${uid()}`) => {
    const { command, errors } = prepareInvoiceBatch({ shopId: SHOP_1, businessDate: today(), isBackdated: false, backdatedReason: "", idempotencyKey: key, rows: [row()] }, []);
    expect(errors).toEqual([]);
    return client.rpc("submit_batch", { command });
  };
  const setShop = (client: SupabaseClient, active: boolean, reason = "integration") => client.rpc("admin_set_shop_status", { command: { shop_id: SHOP_1, is_active: active, reason } });
  const setAccount = (client: SupabaseClient, active: boolean, reason = "integration") => client.rpc("admin_set_account_status", { command: { user_id: STAFF1_ID, is_active: active, reason } });

  it("refuses the status RPCs to anon and staff, and never through a direct write", async () => {
    const staff = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    expect((await setShop(staff, false)).error?.message).toBe("INSUFFICIENT_ROLE");
    expect((await staff.rpc("admin_set_account_status", { command: { user_id: OWNER_ID, is_active: false, reason: "x" } })).error?.message).toBe("INSUFFICIENT_ROLE");
    expect((await staff.from("shops").update({ is_active: false }).eq("id", SHOP_1)).error?.code).toBe("42501");
    const anon = createClient(credentials.url, credentials.key);
    expect((await setShop(anon, false)).error?.code).toBe("42501");
    expect((await setAccount(anon, false)).error?.code).toBe("42501");
  });

  it("an inactive shop refuses new sales from an open staff session, keeps its history readable, and accepts sales again after reactivation", async () => {
    const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
    const staff = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    expect((await sell(staff)).error).toBeNull();
    const before = (await staff.from("invoices").select("id", { count: "exact", head: true }).eq("shop_id", SHOP_1)).count;

    expect((await setShop(owner, false, " ")).error?.message).toBe("REASON_REQUIRED");
    const off = await setShop(owner, false, "Closed for stocktake");
    expect(off.error).toBeNull();
    expect(off.data).toMatchObject({ shop_id: SHOP_1, is_active: false, changed: true });

    const refused = await sell(staff);
    expect(refused.error?.message).toBe("SHOP_INACTIVE");
    expect(refused.error?.code).toBe("P0001");
    expect((await staff.rpc("create_customer", { command: { shop_id: SHOP_1, name: `Refused ${uid()}`, mobile: null } })).error?.message).toBe("SHOP_INACTIVE");
    expect((await staff.from("invoices").select("id", { count: "exact", head: true }).eq("shop_id", SHOP_1)).count).toBe(before);

    const { data: audit } = await owner.from("audit_events").select("action,actor_id,reason,metadata").eq("entity_type", "shop").eq("entity_id", SHOP_1).eq("action", "shop.deactivate");
    expect(audit).toEqual([{ action: "shop.deactivate", actor_id: OWNER_ID, reason: "Closed for stocktake", metadata: { name: "Shop 1", before: { is_active: true }, after: { is_active: false } } }]);

    expect((await setShop(owner, true, "Stocktake done")).error).toBeNull();
    expect((await sell(staff)).error).toBeNull();
  });

  it("a deactivated account's existing session can do nothing, its records keep their author, and reactivation restores it", async () => {
    const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
    const staff = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const sold = await sell(staff);
    expect(sold.error).toBeNull();
    const invoiceId = sold.data.rows[0].invoice_id as string;

    expect((await owner.rpc("admin_set_account_status", { command: { user_id: OWNER_ID, is_active: false, reason: "x" } })).error?.message).toBe("SELF_CHANGE_FORBIDDEN");
    expect((await owner.rpc("admin_update_account", { command: { user_id: STAFF1_ID, role: "staff", is_active: false } })).error?.message).toBe("STATUS_REASON_REQUIRED");
    expect((await setAccount(owner, false, "Left the business")).data).toMatchObject({ user_id: STAFF1_ID, is_active: false, changed: true });

    // The same client, holding the token issued before the deactivation.
    expect((await sell(staff)).error?.message).toBe("AUTHENTICATION_REQUIRED");
    expect((await staff.from("invoices").select("id")).data).toEqual([]);
    const { data: authored } = await owner.from("invoices").select("created_by").eq("id", invoiceId).single();
    expect(authored?.created_by).toBe(STAFF1_ID);
    const { data: audit } = await owner.from("audit_events").select("action,actor_id,reason,metadata").eq("entity_type", "profile").eq("entity_id", STAFF1_ID).eq("action", "account.deactivate");
    expect(audit).toEqual([{ action: "account.deactivate", actor_id: OWNER_ID, reason: "Left the business", metadata: { role: "staff", before: { is_active: true }, after: { is_active: false } } }]);

    expect((await setAccount(owner, true, "Rehired")).error).toBeNull();
    expect((await sell(staff)).error).toBeNull();
  });

  it("race: a write that locked the shop first commits before the deactivation, which waits for it", async () => {
    const key = `race-first-${uid()}`;
    const writer = session(`begin;\n${as(STAFF1_ID)}${expense(key)}select pg_sleep(1.5);\nselect 'writer-commit:' || extract(epoch from clock_timestamp());\ncommit;\n`);
    await writer.until("expense:true");
    const owner = session(`begin;\n${as(OWNER_ID)}${status(false, "race one")}select 'status-at:' || extract(epoch from clock_timestamp());\ncommit;\n`);
    const [w, o] = await Promise.all([writer.done, owner.done]);
    expect(w.code, w.err).toBe(0);
    expect(o.code, o.err).toBe(0);
    expect(o.out).toContain("status:true");
    const writerCommit = Number(/writer-commit:(.+)/.exec(w.out)![1]);
    const statusAt = Number(/status-at:(.+)/.exec(o.out)![1]);
    // The deactivation could only finish after the writer committed: it waited on the writer's row lock.
    expect(statusAt).toBeGreaterThanOrEqual(writerCommit);
    expect(await psqlScalar(`select count(*) from public.expenses where idempotency_key = '${key}'`)).toBe("1");
    expect(await psqlScalar(`select is_active from public.shops where id = '${SHOP_1}'`)).toBe("f");
    await session(`begin;\n${as(OWNER_ID)}${status(true, "race one done")}commit;\n`).done;
  });

  it("race: a write that arrives while a deactivation is in flight waits, then sees the shop inactive and writes nothing", async () => {
    const key = `race-second-${uid()}`;
    const owner = session(`begin;\n${as(OWNER_ID)}${status(false, "race two")}select pg_sleep(1.5);\ncommit;\n`);
    await owner.until("status:true");
    // The deactivation is not committed yet, so without the row lock this write would see the shop active.
    const writer = session(`begin;\n${as(STAFF1_ID)}${expense(key)}commit;\n`);
    const [o, w] = await Promise.all([owner.done, writer.done]);
    expect(o.code, o.err).toBe(0);
    expect(w.code).not.toBe(0);
    expect(w.err).toContain("SHOP_INACTIVE");
    expect(await psqlScalar(`select count(*) from public.expenses where idempotency_key = '${key}'`)).toBe("0");
    await session(`begin;\n${as(OWNER_ID)}${status(true, "race two done")}commit;\n`).done;
    expect(await psqlScalar(`select is_active from public.shops where id = '${SHOP_1}'`)).toBe("t");
  });
});
