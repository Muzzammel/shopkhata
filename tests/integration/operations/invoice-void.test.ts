import { execFileSync, spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareInvoiceBatch, qatarBusinessDate, type EntryRow } from "@/lib/invoice-entry";

// OPS-01B slice 1: invoice void through the real API with real sessions and permissions, and the
// void-versus-void and void-versus-payment races proven with two concurrent database sessions.

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

const OWNER = { email: "owner@shopkhata.local", password: "ShopKhata-Local-Owner-E2E-Only-2026!" };
const MANAGER = { email: "manager@shopkhata.local", password: "ShopKhata-Local-Manager-E2E-Only-2026!" };
const STAFF1 = { email: "staff1@shopkhata.local", password: "ShopKhata-Local-E2E-Only-2026!" };
const STAFF2 = { email: "staff2@shopkhata.local", password: "ShopKhata-Local-Shop2-E2E-Only-2026!" };
const SHOP_1 = "10000000-0000-4000-8000-000000000001";
const MANAGER_ID = "10000000-0000-4000-8000-000000000104";
const STAFF1_ID = "10000000-0000-4000-8000-000000000102";

const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => qatarBusinessDate(new Date());

/** One psql session; `until` resolves when its output contains the marker (see status-controls.test.ts). */
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
const voidSql = (invoiceId: string, key: string, reason = "Customer cancelled the order") =>
  `select 'void:' || (public.void_invoice('${JSON.stringify({ shop_id: SHOP_1, invoice_id: invoiceId, reason, idempotency_key: key })}') ->> 'void_id');\n`;
const paySql = (invoiceId: string, key: string, amount: number) =>
  `select 'pay:' || (public.record_payment('${JSON.stringify({ shop_id: SHOP_1, invoice_id: invoiceId, amount_dirham: amount, payment_method: "cash", business_date: today(), idempotency_key: key })}') ->> 'ok');\n`;
const psqlScalar = async (sql: string) => { const result = await session(`${sql}\n`).done; expect(result.code, result.err).toBe(0); return result.out.trim(); };
const balances = (invoiceId: string) => psqlScalar(`select concat_ws('|', effective_total_dirham, effective_paid_dirham, effective_due_dirham, is_void) from public.effective_invoices where canonical_invoice_id = '${invoiceId}'`);

describe("OPS-01B invoice void (real network, real sessions, concurrent sessions)", () => {
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

  /** A fresh unpaid 100.00 invoice in shop 1, sold by staff through the real batch RPC. */
  async function sell(): Promise<string> {
    const staff = await signIn(STAFF1);
    const row: EntryRow = { rowId: `r-${uid()}`, invoiceId: `IT-VOID-${Date.now()}-${uid()}`, total: "100.00", received: "", delivered: false, customerId: "", customerName: "", customerMobile: "" };
    const { command, errors } = prepareInvoiceBatch({ shopId: SHOP_1, businessDate: today(), isBackdated: false, backdatedReason: "", idempotencyKey: `it-void-${uid()}`, rows: [row] }, []);
    expect(errors).toEqual([]);
    const { data, error } = await staff.rpc("submit_batch", { command });
    expect(error).toBeNull();
    return data.rows[0].invoice_id as string;
  }
  const voidCommand = (invoiceId: string, key = crypto.randomUUID(), reason = "Customer cancelled the order") => ({ command: { shop_id: SHOP_1, invoice_id: invoiceId, reason, idempotency_key: key } });

  it("enforces role and shop through real sessions, and keeps the void record shop-private", async () => {
    const invoiceId = await sell();
    const staff = await signIn(STAFF1);
    const staff2 = await signIn(STAFF2);
    const manager = await signIn(MANAGER);
    const refused = await staff.rpc("void_invoice", voidCommand(invoiceId));
    expect(refused.error?.message).toBe("INSUFFICIENT_ROLE");
    expect((await staff2.rpc("void_invoice", voidCommand(invoiceId))).error?.message).toBe("UNAUTHORIZED_SHOP");
    expect((await staff.from("invoice_voids").insert({ shop_id: SHOP_1, invoice_id: invoiceId, reason: "Direct write attempt", actor_user_id: STAFF1_ID, business_date: today(), idempotency_key: "x", fingerprint: "x" })).error?.code).toBe("42501");

    const key = crypto.randomUUID();
    const voided = await manager.rpc("void_invoice", voidCommand(invoiceId, key, "  Entered twice by mistake  "));
    expect(voided.error).toBeNull();
    expect(voided.data).toMatchObject({ ok: true, invoice_id: invoiceId, business_date: today() });
    expect((await manager.rpc("void_invoice", voidCommand(invoiceId, key, "  Entered twice by mistake  "))).data).toEqual(voided.data);
    expect((await manager.rpc("void_invoice", voidCommand(invoiceId))).error?.message).toBe("ALREADY_VOID");

    const { data: rows } = await staff.from("invoice_voids").select("reason,actor_user_id").eq("invoice_id", invoiceId);
    expect(rows).toEqual([{ reason: "Entered twice by mistake", actor_user_id: MANAGER_ID }]);
    expect((await staff2.from("invoice_voids").select("id").eq("invoice_id", invoiceId)).data).toEqual([]);
    const { data: invoice } = await staff.from("effective_invoices").select("original_total_dirham,effective_total_dirham,is_void").eq("canonical_invoice_id", invoiceId).single();
    expect(invoice).toEqual({ original_total_dirham: 10000, effective_total_dirham: 0, is_void: true });
    const owner = await signIn(OWNER);
    const { data: audit } = await owner.from("audit_events").select("actor_id,reason").eq("action", "invoice.void").eq("entity_id", invoiceId);
    expect(audit).toEqual([{ actor_id: MANAGER_ID, reason: "Entered twice by mistake" }]);
  });

  it("race: two concurrent voids with different keys — exactly one succeeds, the other waits and gets ALREADY_VOID", async () => {
    const invoiceId = await sell();
    const first = session(`begin;\n${as(MANAGER_ID)}${voidSql(invoiceId, `race-a-${uid()}`)}select pg_sleep(1.5);\ncommit;\n`);
    await first.until("void:");
    const second = session(`begin;\n${as(MANAGER_ID)}${voidSql(invoiceId, `race-b-${uid()}`, "Second operator also voiding")}commit;\n`);
    const [a, b] = await Promise.all([first.done, second.done]);
    expect(a.code, a.err).toBe(0);
    expect(b.code).not.toBe(0);
    expect(b.err).toContain("ALREADY_VOID");
    expect(await psqlScalar(`select count(*) from public.invoice_voids where invoice_id = '${invoiceId}'`)).toBe("1");
    expect(await psqlScalar(`select count(*) from public.corrections where invoice_id = '${invoiceId}'`)).toBe("1");
    expect(await balances(invoiceId)).toBe("0|0|0|t");
  });

  it("race: two concurrent voids with the same key — the second waits and replays the first result", async () => {
    const invoiceId = await sell();
    const key = `race-same-${uid()}`;
    const first = session(`begin;\n${as(MANAGER_ID)}${voidSql(invoiceId, key)}select pg_sleep(1.5);\ncommit;\n`);
    await first.until("void:");
    const second = session(`begin;\n${as(MANAGER_ID)}${voidSql(invoiceId, key)}commit;\n`);
    const [a, b] = await Promise.all([first.done, second.done]);
    expect(a.code, a.err).toBe(0);
    expect(b.code, b.err).toBe(0);
    expect(/void:(\S+)/.exec(b.out)![1]).toBe(/void:(\S+)/.exec(a.out)![1]);
    expect(await psqlScalar(`select count(*) from public.invoice_voids where invoice_id = '${invoiceId}'`)).toBe("1");
  });

  it("race: a payment that locked the invoice first commits; the waiting void then refuses with PAYMENTS_OUTSTANDING", async () => {
    const invoiceId = await sell();
    const payer = session(`begin;\n${as(STAFF1_ID)}${paySql(invoiceId, `race-pay-${uid()}`, 2500)}select pg_sleep(1.5);\ncommit;\n`);
    await payer.until("pay:true");
    const voider = session(`begin;\n${as(MANAGER_ID)}${voidSql(invoiceId, `race-void-${uid()}`)}commit;\n`);
    const [p, v] = await Promise.all([payer.done, voider.done]);
    expect(p.code, p.err).toBe(0);
    expect(v.code).not.toBe(0);
    expect(v.err).toContain("PAYMENTS_OUTSTANDING");
    expect(await psqlScalar(`select count(*) from public.invoice_voids where invoice_id = '${invoiceId}'`)).toBe("0");
    expect(await balances(invoiceId)).toBe("10000|2500|7500|f");
  });

  it("race: a payment that arrives while a void is in flight waits, then is refused and writes nothing", async () => {
    const invoiceId = await sell();
    const voider = session(`begin;\n${as(MANAGER_ID)}${voidSql(invoiceId, `race-void2-${uid()}`)}select pg_sleep(1.5);\ncommit;\n`);
    await voider.until("void:");
    const payer = session(`begin;\n${as(STAFF1_ID)}${paySql(invoiceId, `race-pay2-${uid()}`, 2500)}commit;\n`);
    const [v, p] = await Promise.all([voider.done, payer.done]);
    expect(v.code, v.err).toBe(0);
    expect(p.code).not.toBe(0);
    expect(p.err).toMatch(/PAYMENT_VALIDATION_FAILED|INVOICE_VOID/);
    expect(await psqlScalar(`select count(*) from public.payments where invoice_id = '${invoiceId}'`)).toBe("0");
    expect(await balances(invoiceId)).toBe("0|0|0|t");
  });
});
