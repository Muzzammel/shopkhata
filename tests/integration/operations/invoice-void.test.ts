import { execFileSync, spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareInvoiceBatch, qatarBusinessDate, type EntryRow } from "@/lib/invoice-entry";
import { resetLocal } from "./release-helpers";

// OPS-01B slice 1: invoice void through the real API with real sessions and permissions, and the
// void-versus-void and void-versus-payment races proven with two concurrent database sessions.

// Hook budget: the prerequisite check (<= 30 s) + RESET_BUDGET (lease, image checks, reset, kill confirmation and lease
// release all inside it; scripts/local-reset.mjs) + 30 s slack. A hook that still times out leaves the lease held.
const SUITE_TIMEOUT = 210_000;
const RESET_BUDGET = 150_000;
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
const OWNER_ID = "10000000-0000-4000-8000-000000000101";

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
const decideSql = (requestId: string, key: string) =>
  `select 'dec:' || (public.decide_invoice_correction('${JSON.stringify({ shop_id: SHOP_1, request_id: requestId, expected_revision: 0, decision: "approved", reason: null, idempotency_key: key })}') ->> 'ok');\n`;
const creditSql = (customerId: string, key: string, amount: number) =>
  `select 'credit:' || (public.apply_customer_credit('${JSON.stringify({ shop_id: SHOP_1, customer_id: customerId, amount_dirham: amount, business_date: today(), idempotency_key: key })}') ->> 'ok');\n`;
const closeSql = () => `select 'close:' || (public.close_business_date('${JSON.stringify({ shop_id: SHOP_1, business_date: today() })}') is not null);\n`;
const reopenSql = () => `select public.reopen_business_date('${JSON.stringify({ shop_id: SHOP_1, business_date: today(), reason: "integration test reopens today" })}');\n`;
const psqlScalar = async (sql: string) => { const result = await session(`${sql}\n`).done; expect(result.code, result.err).toBe(0); return result.out.trim(); };
const balances = (invoiceId: string) => psqlScalar(`select concat_ws('|', effective_total_dirham, effective_paid_dirham, effective_due_dirham, is_void) from public.effective_invoices where canonical_invoice_id = '${invoiceId}'`);

describe("OPS-01B invoice void (real network, real sessions, concurrent sessions)", () => {
  let supabaseAvailable = false;
  let credentials: { url: string; key: string } = { url: "", key: "" };

  beforeAll(async () => {
    if (!isSupabaseRunning()) throw new Error("Prerequisite: local Supabase must be running. Start it with: pnpm.cmd exec supabase start --local");
    supabaseAvailable = true;
    await resetLocal([], { timeoutMs: RESET_BUDGET });
    const env = parseEnv(runSupabase(["status", "-o", "env"], 30_000));
    const url = env.API_URL;
    const key = env.PUBLISHABLE_KEY ?? env.ANON_KEY;
    if (!url || !key) throw new Error("Could not read local Supabase URL/key from `supabase status -o env`.");
    credentials = { url, key };
  }, SUITE_TIMEOUT);

  afterAll(async () => {
    if (!supabaseAvailable) return;
    await resetLocal([], { timeoutMs: RESET_BUDGET });
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

  // --- Review gap: races against correction approval, credit application and Daily Close -------------------------------

  /** A pending +20.00 total correction on a fresh 100.00 invoice. */
  async function pendingCorrection(invoiceId: string): Promise<string> {
    const staff = await signIn(STAFF1);
    const { data, error } = await staff.rpc("request_invoice_correction", { command: { shop_id: SHOP_1, invoice_id: invoiceId, payment_id: null, amount_delta_dirham: 2000, reason: "Price was higher", idempotency_key: crypto.randomUUID() } });
    expect(error).toBeNull();
    return data.request_id as string;
  }

  it("race: void in flight, then a correction approval waits and is refused with INVOICE_VOID", async () => {
    const invoiceId = await sell();
    const requestId = await pendingCorrection(invoiceId);
    const voider = session(`begin;\n${as(MANAGER_ID)}${voidSql(invoiceId, `race-cv-${uid()}`)}select pg_sleep(1.5);\ncommit;\n`);
    await voider.until("void:");
    const approver = session(`begin;\n${as(OWNER_ID)}${decideSql(requestId, `race-cv-dec-${uid()}`)}commit;\n`);
    const [v, a] = await Promise.all([voider.done, approver.done]);
    expect(v.code, v.err).toBe(0);
    expect(a.code).not.toBe(0);
    expect(a.err).toContain("INVOICE_VOID");
    expect(await balances(invoiceId)).toBe("0|0|0|t");
    expect(await psqlScalar(`select coalesce(sum(amount_delta_dirham), 0) from public.corrections where invoice_id = '${invoiceId}'`)).toBe("-10000");
  });

  it("race: correction approval in flight, then the void waits and reverses the corrected total", async () => {
    const invoiceId = await sell();
    const requestId = await pendingCorrection(invoiceId);
    const approver = session(`begin;\n${as(OWNER_ID)}${decideSql(requestId, `race-vc-dec-${uid()}`)}select pg_sleep(1.5);\ncommit;\n`);
    await approver.until("dec:");
    const voider = session(`begin;\n${as(MANAGER_ID)}${voidSql(invoiceId, `race-vc-${uid()}`)}commit;\n`);
    const [a, v] = await Promise.all([approver.done, voider.done]);
    expect(a.code, a.err).toBe(0);
    expect(v.code, v.err).toBe(0);
    expect(await balances(invoiceId)).toBe("0|0|0|t");
    expect(await psqlScalar(`select c.amount_delta_dirham from public.corrections c join public.invoice_voids v on v.correction_id = c.id where v.invoice_id = '${invoiceId}'`)).toBe("-12000");
    // History: the sale stays +100 on its date; +20 and -120 are their own movements; they net to 0.
    expect(await psqlScalar(`select string_agg(movement_type || ':' || amount_dirham, ',' order by recorded_at) from public.sales_movements where invoice_id = '${invoiceId}'`)).toBe("sale:10000,invoice_correction:2000,invoice_void:-12000");
  });

  /** A customer with 50.00 of approved credit and one unpaid 100.00 invoice. */
  async function customerWithCredit(): Promise<{ customerId: string; invoiceId: string }> {
    const customerId = crypto.randomUUID(); const invoiceId = crypto.randomUUID(); const number = `IT-VCR-${uid()}`;
    await psqlScalar(`set timezone = 'Asia/Qatar';
insert into public.customers(id, shop_id, public_id, name) values ('${customerId}', '${SHOP_1}', 'CUS-${uid()}', 'Credit race customer');
insert into public.invoices(id, shop_id, customer_id, invoice_id, total_amount_dirham, business_date, delivered, created_by) values ('${invoiceId}', '${SHOP_1}', '${customerId}', '${number}', 10000, current_date, true, '${STAFF1_ID}');
insert into public.invoice_number_registry(shop_id, invoice_number, canonical_invoice_id) values ('${SHOP_1}', '${number}', '${invoiceId}');
insert into public.customer_credits(shop_id, customer_id, amount_dirham, business_date, reason, created_by, approved_by) values ('${SHOP_1}', '${customerId}', 5000, current_date, 'race fixture credit', '${OWNER_ID}', '${OWNER_ID}');`);
    return { customerId, invoiceId };
  }

  it("race: void in flight, then a credit application waits and applies nothing to the voided invoice", async () => {
    const { customerId, invoiceId } = await customerWithCredit();
    const voider = session(`begin;\n${as(MANAGER_ID)}${voidSql(invoiceId, `race-vcr-${uid()}`)}select pg_sleep(1.5);\ncommit;\n`);
    await voider.until("void:");
    const creditor = session(`begin;\n${as(STAFF1_ID)}${creditSql(customerId, `race-vcr-c-${uid()}`, 5000)}commit;\n`);
    const [v, c] = await Promise.all([voider.done, creditor.done]);
    expect(v.code, v.err).toBe(0);
    expect(c.code).not.toBe(0);
    expect(c.err).toMatch(/CREDIT_OR_DUE_INSUFFICIENT|INVOICE_VOID/);
    expect(await psqlScalar(`select count(*) from public.credit_applications where invoice_id = '${invoiceId}'`)).toBe("0");
    expect(await psqlScalar(`select available_credit_dirham from public.customer_financial_balances where customer_id = '${customerId}'`)).toBe("5000");
    expect(await balances(invoiceId)).toBe("0|0|0|t");
  });

  it("race: credit application in flight, then the void waits and refuses with CREDIT_APPLIED", async () => {
    const { customerId, invoiceId } = await customerWithCredit();
    const creditor = session(`begin;\n${as(STAFF1_ID)}${creditSql(customerId, `race-crv-c-${uid()}`, 5000)}select pg_sleep(1.5);\ncommit;\n`);
    await creditor.until("credit:");
    const voider = session(`begin;\n${as(MANAGER_ID)}${voidSql(invoiceId, `race-crv-${uid()}`)}commit;\n`);
    const [c, v] = await Promise.all([creditor.done, voider.done]);
    expect(c.code, c.err).toBe(0);
    expect(v.code).not.toBe(0);
    expect(v.err).toContain("CREDIT_APPLIED");
    expect(await psqlScalar(`select count(*) from public.invoice_voids where invoice_id = '${invoiceId}'`)).toBe("0");
    expect(await psqlScalar(`select concat_ws('|', effective_total_dirham, effective_credit_applied_dirham, effective_due_dirham, is_void) from public.effective_invoices where canonical_invoice_id = '${invoiceId}'`)).toBe("10000|5000|5000|f");
  });

  it("race: void in flight, then closing today waits and the closed day includes the void", async () => {
    const invoiceId = await sell();
    const voider = session(`begin;\n${as(MANAGER_ID)}${voidSql(invoiceId, `race-vcl-${uid()}`)}select pg_sleep(1.5);\ncommit;\n`);
    await voider.until("void:");
    const closer = session(`begin;\n${as(OWNER_ID)}${closeSql()}commit;\n`);
    const [v, c] = await Promise.all([voider.done, closer.done]);
    try {
      expect(v.code, v.err).toBe(0);
      expect(c.code, c.err).toBe(0);
      expect(await balances(invoiceId)).toBe("0|0|0|t");
      // The correction is dated the day that is now closed, and was committed before the close took effect.
      expect(await psqlScalar(`select c.business_date = (now() at time zone 'Asia/Qatar')::date and c.recorded_at < (select max(d.recorded_at) from public.daily_closes d where d.shop_id = c.shop_id and d.business_date = c.business_date and d.event_type = 'closed') from public.corrections c join public.invoice_voids v on v.correction_id = c.id where v.invoice_id = '${invoiceId}'`)).toBe("t");
    } finally {
      await psqlScalar(`begin;\n${as(OWNER_ID)}${reopenSql()}commit;`);
    }
  });

  it("race: closing today in flight, then the void waits and refuses with CLOSED_DATE", async () => {
    const invoiceId = await sell();
    const closer = session(`begin;\n${as(OWNER_ID)}${closeSql()}select pg_sleep(1.5);\ncommit;\n`);
    await closer.until("close:");
    const voider = session(`begin;\n${as(MANAGER_ID)}${voidSql(invoiceId, `race-clv-${uid()}`)}commit;\n`);
    const [c, v] = await Promise.all([closer.done, voider.done]);
    try {
      expect(c.code, c.err).toBe(0);
      expect(v.code).not.toBe(0);
      expect(v.err).toContain("CLOSED_DATE");
      expect(await psqlScalar(`select count(*) from public.invoice_voids where invoice_id = '${invoiceId}'`)).toBe("0");
      expect(await balances(invoiceId)).toBe("10000|0|10000|f");
    } finally {
      await psqlScalar(`begin;\n${as(OWNER_ID)}${reopenSql()}commit;`);
    }
  });
});
