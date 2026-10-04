import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fetchExpenseExport, fetchInvoiceExport } from "@/lib/excel/exports";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { fetchCustomerDueReport, fetchDailySummary, fetchExpenseReport, fetchPaymentReport, fetchSalesReport, SCREEN_ROW_LIMIT } from "@/lib/reports";
import { readAllPages } from "@/lib/read-all-pages";

// Performance sanity at a realistic size for two small shops (see scripts/perf-fixture.sql).
// Every read is made the way the application makes it: through the API, as a signed-in
// Shop 1 staff account under row-level security. This is a sanity check for obvious
// problems (missing indexes, N+1 reads, oversized responses), not a benchmark.

const SHOP1 = "10000000-0000-4000-8000-000000000001";
const CLI = join(process.cwd(), "node_modules", "supabase", "dist", "supabase.js");
const DB_CONTAINER = "supabase_db_shopkhata";
/** No single screen read may take longer than this on a developer machine. */
const BUDGET_MS = 1500;
/** Full-year reports and whole-range exports read every row, so they get more. */
const HEAVY_BUDGET_MS = 6000;

const cli = (args: string[], timeout = 180_000) => execFileSync(process.execPath, [CLI, "--agent", "no", ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
function psql(args: string[], stdin?: number) {
  const result = spawnSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", DB_CONTAINER, "psql", "-h", "127.0.0.1", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t", ...args],
    { encoding: "utf8", stdio: [stdin ?? "ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout.trim();
}

describe("performance sanity at production-like size", () => {
  let staff: SupabaseClient;
  let traffic = { requests: 0, bytes: 0 };
  const results: { read: string; ms: number; requests: number; kb: number; rows: number | string }[] = [];
  const today = qatarBusinessDate(new Date());
  const daysAgo = (days: number) => new Date(Date.parse(`${today}T12:00:00.000Z`) - days * 86_400_000).toISOString().slice(0, 10);
  let counts: Record<string, number> = {};

  beforeAll(async () => {
    try { cli(["migration", "list", "--local"], 30_000); } catch { throw new Error("Prerequisite: local Supabase and Docker must be running."); }
    cli(["db", "reset", "--local"]);
    const fixture = openSync(join(process.cwd(), "scripts", "perf-fixture.sql"), "r");
    try { psql([], fixture); } finally { closeSync(fixture); }
    counts = JSON.parse(psql(["-c", `select jsonb_object_agg(t, n) from (values
      ('invoices', (select count(*) from public.invoices)), ('payments', (select count(*) from public.payments)), ('customers', (select count(*) from public.customers)),
      ('expenses', (select count(*) from public.expenses)), ('corrections', (select count(*) from public.corrections)), ('replacements', (select count(*) from public.replacement_decisions)),
      ('credit_applications', (select count(*) from public.credit_applications)), ('close_events', (select count(*) from public.daily_closes)), ('accounts', (select count(*) from public.profiles)),
      ('shops_with_invoices', (select count(distinct shop_id) from public.invoices))) x(t, n)`]));
    const env = Object.fromEntries(cli(["status", "-o", "env"], 30_000).split(/\r?\n/).flatMap((line) => { const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line); return m ? [[m[1], m[2].replace(/^"|"$/g, "")]] : []; }));
    staff = createClient(env.API_URL, env.PUBLISHABLE_KEY ?? env.ANON_KEY, {
      auth: { persistSession: false },
      global: { fetch: async (input, init) => {
        const response = await fetch(input, init);
        traffic.requests += 1;
        traffic.bytes += Number(response.headers.get("content-length") ?? 0) || (await response.clone().arrayBuffer()).byteLength;
        return response;
      } },
    });
    const { error } = await staff.auth.signInWithPassword({ email: "staff1@shopkhata.local", password: "ShopKhata-Local-E2E-Only-2026!" });
    if (error) throw error;
  }, 300_000);
  afterAll(() => {
    // Kept for the verification record; test-results/ is not tracked.
    mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
    writeFileSync(join(process.cwd(), "test-results", "perf-results.json"), `${JSON.stringify({ measuredAt: new Date().toISOString(), fixture: counts, budgetMs: { screen: BUDGET_MS, heavy: HEAVY_BUDGET_MS }, results }, null, 2)}\n`);
    console.table(results);
    cli(["db", "reset", "--local"]);
  }, 300_000);

  /** Best of three, so a cold cache does not decide the result. */
  async function measure(read: string, budget: number, run: () => Promise<number | string>) {
    let best = Infinity; let requests = 0; let bytes = 0; let rows: number | string = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      traffic = { requests: 0, bytes: 0 };
      const started = performance.now();
      rows = await run();
      const elapsed = performance.now() - started;
      if (elapsed < best) { best = elapsed; requests = traffic.requests; bytes = traffic.bytes; }
    }
    results.push({ read, ms: Math.round(best), requests, kb: Math.round(bytes / 1024), rows });
    expect(best, `${read} took ${Math.round(best)} ms`).toBeLessThan(budget);
    return { requests, bytes };
  }
  async function rows<T>(query: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
    const { data, error } = await query;
    if (error || !data) throw new Error(`read failed: ${JSON.stringify(error)}`);
    return data;
  }

  it("holds a year of trading for two shops", () => {
    expect(counts.invoices).toBeGreaterThan(20_000);
    expect(counts.payments).toBeGreaterThan(15_000);
    expect(counts.customers).toBe(3000);
    expect(counts.expenses).toBeGreaterThan(4000);
    expect(counts.corrections).toBeGreaterThan(100);
    expect(counts.replacements).toBeGreaterThan(50);
    expect(counts.close_events).toBeGreaterThan(700);
    expect(counts.accounts).toBe(12);
    expect(counts.shops_with_invoices).toBe(2);
  });

  it("serves the invoice workspace, duplicate lookup and Invoice Detail within budget", async () => {
    let invoiceId = "";
    await measure("workspace: 30 recent invoices", BUDGET_MS, async () => {
      const data = await rows(staff.from("effective_invoices").select("*").eq("shop_id", SHOP1).order("recorded_at", { ascending: false }).order("canonical_invoice_id").limit(30));
      invoiceId = data[15].canonical_invoice_id;
      return data.length;
    });
    // The workspace loads every invoice number of the shop for instant and offline duplicate warnings.
    const registry = await measure("workspace: all invoice numbers (duplicate check)", HEAVY_BUDGET_MS, async () => {
      const { data } = await readAllPages((offset, end) => staff.from("invoice_number_registry").select("invoice_number").eq("shop_id", SHOP1).order("invoice_number").range(offset, end));
      return data!.length;
    });
    expect(registry.bytes).toBeLessThan(1_000_000);
    await measure("duplicate lookup: one invoice number", BUDGET_MS, async () =>
      (await rows(staff.from("invoice_number_registry").select("canonical_invoice_id").eq("shop_id", SHOP1).eq("normalized_invoice_number", `perf-1-${daysAgo(200).slice(2).replaceAll("-", "")}-007`))).length);
    await measure("Invoice Detail: invoice, balances, payments, corrections", BUDGET_MS, async () => {
      const [invoice, effective, payments, corrections, requests] = await Promise.all([
        rows(staff.from("invoices").select("id, shop_id, invoice_id, total_amount_dirham, business_date, recorded_at, created_by, delivered, customer_id").eq("shop_id", SHOP1).eq("id", invoiceId)),
        rows(staff.from("effective_invoices").select("*").eq("shop_id", SHOP1).eq("canonical_invoice_id", invoiceId)),
        rows(staff.from("payments").select("id, amount_dirham, business_date, recorded_at, payment_method, created_by").eq("shop_id", SHOP1).eq("invoice_id", invoiceId).order("recorded_at")),
        rows(staff.from("corrections").select("id, amount_delta_dirham, reason, business_date, recorded_at, approved_by, payment_id").eq("shop_id", SHOP1).eq("invoice_id", invoiceId).not("approved_by", "is", null)),
        rows(staff.from("correction_requests").select("id").eq("shop_id", SHOP1).eq("invoice_id", invoiceId)),
      ]);
      return invoice.length + effective.length + payments.length + corrections.length + requests.length;
    });
  });

  it("serves the customer list, search, the busiest customer's ledger and the due report within budget", async () => {
    const busiest = psql(["-c", `select customer_id from public.invoices where shop_id = '${SHOP1}' and customer_id is not null group by 1 order by count(*) desc limit 1`]);
    await measure("customers: first page with balances", BUDGET_MS, async () => {
      const page = await rows(staff.from("customers").select("id,public_id,name,mobile,created_at", { count: "exact" }).eq("shop_id", SHOP1).order("name", { ascending: true, nullsFirst: false }).order("public_id").range(0, 30));
      const balances = await rows(staff.from("customer_financial_balances").select("customer_id,outstanding_due_dirham,invoice_count,last_activity_date,available_credit_dirham").eq("shop_id", SHOP1).in("customer_id", page.map((customer) => customer.id)));
      return `${page.length}+${balances.length}`;
    });
    await measure("customers: search by name", BUDGET_MS, async () =>
      (await rows(staff.from("customers").select("id,public_id,name,mobile").eq("shop_id", SHOP1).or("name.ilike.*1-07*,mobile.ilike.*1-07*,public_id.ilike.*1-07*").order("name").range(0, 30))).length);
    await measure("Customer Detail: balance, invoices, ledger, credit (busiest customer)", HEAVY_BUDGET_MS, async () => {
      const [balance, invoices, ledger, credits] = await Promise.all([
        rows(staff.from("customer_financial_balances").select("outstanding_due_dirham,available_credit_dirham,invoice_count,last_activity_date").eq("shop_id", SHOP1).eq("customer_id", busiest)),
        readAllPages((offset, end) => staff.from("effective_invoices").select("canonical_invoice_id,effective_invoice_number,business_date,recorded_at,effective_total_dirham,effective_paid_dirham,effective_credit_applied_dirham,effective_due_dirham,effective_delivered").eq("shop_id", SHOP1).eq("effective_customer_id", busiest).order("business_date", { ascending: false }).order("canonical_invoice_id").range(offset, end)),
        readAllPages((offset, end) => staff.from("customer_ledger").select("business_date,recorded_at,sequence_id,invoice_id,entry_type,reference,invoice_number,actor_id,debit_dirham,credit_dirham").eq("shop_id", SHOP1).eq("customer_id", busiest).order("business_date").order("recorded_at").order("sequence_id").range(offset, end)),
        rows(staff.from("customer_credits").select("id,invoice_id,amount_dirham,business_date,recorded_at,reason,approved_by").eq("shop_id", SHOP1).eq("customer_id", busiest).not("approved_by", "is", null)),
      ]);
      // The ledger and the balance must agree at this size too.
      expect(ledger.data!.reduce((sum, entry) => sum + entry.debit_dirham - entry.credit_dirham, 0)).toBe(balance[0].outstanding_due_dirham);
      return `${invoices.data!.length} invoices, ${ledger.data!.length} ledger rows, ${credits.length} credits`;
    });
    await measure("report: customer due (screen)", HEAVY_BUDGET_MS, async () => (await fetchCustomerDueReport(staff, SHOP1, SCREEN_ROW_LIMIT + 1)).rows.length);
  });

  it("serves expenses, the daily summary and every date-range report within budget", async () => {
    await measure("expenses: first page", BUDGET_MS, async () =>
      (await rows(staff.from("effective_expenses").select("id,shop_id,description,amount_dirham,category,business_date,recorded_at,created_by,correction_request_id,backdated_reason").eq("shop_id", SHOP1).order("business_date", { ascending: false }).order("recorded_at", { ascending: false }).range(0, 29))).length);
    await measure("daily summary: one closed day", BUDGET_MS, async () => (await fetchDailySummary(staff, SHOP1, daysAgo(30), daysAgo(30))).length);
    await measure("daily summary: 31 days", BUDGET_MS, async () => (await fetchDailySummary(staff, SHOP1, daysAgo(30), today)).length);
    await measure("report: sales, today (screen)", BUDGET_MS, async () => (await fetchSalesReport(staff, SHOP1, today, today, SCREEN_ROW_LIMIT + 1)).rows.length);
    await measure("report: sales, 31 days (screen)", BUDGET_MS, async () => (await fetchSalesReport(staff, SHOP1, daysAgo(30), today, SCREEN_ROW_LIMIT + 1)).totals.invoiceCount);
    await measure("report: sales, 366 days (screen)", HEAVY_BUDGET_MS, async () => (await fetchSalesReport(staff, SHOP1, daysAgo(365), today, SCREEN_ROW_LIMIT + 1)).totals.invoiceCount);
    await measure("report: payments, 31 days (screen)", BUDGET_MS, async () => (await fetchPaymentReport(staff, SHOP1, daysAgo(30), today, SCREEN_ROW_LIMIT + 1)).rows.length);
    await measure("report: expenses, 31 days (screen)", BUDGET_MS, async () => (await fetchExpenseReport(staff, SHOP1, daysAgo(30), today, SCREEN_ROW_LIMIT + 1)).totals.count);
    await measure("export: invoices, 31 days (every row)", HEAVY_BUDGET_MS, async () => (await fetchInvoiceExport(staff, SHOP1, daysAgo(30), today)).length);
    await measure("export: expenses, 31 days (every row)", HEAVY_BUDGET_MS, async () => (await fetchExpenseExport(staff, SHOP1, daysAgo(30), today)).length);
    await measure("daily close screen: state and history", BUDGET_MS, async () =>
      (await rows(staff.from("daily_closes").select("event_sequence,event_type,actor_id,recorded_at,reason,note").eq("shop_id", SHOP1).eq("business_date", daysAgo(45)).order("event_sequence", { ascending: false }).limit(100))).length);
  });

  it("uses an index for every lookup the screens depend on", () => {
    // Plans as the application role sees them, with row-level security applied.
    const plan = (sql: string) => psql(["-c", `begin; select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000102","role":"authenticated"}', true); set local role authenticated; explain (format json) ${sql}; rollback;`]);
    const lookups: Record<string, string> = {
      "invoice by id": `select * from public.invoices where shop_id = '${SHOP1}' and id = '${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}'`,
      "invoice number lookup": `select canonical_invoice_id from public.invoice_number_registry where shop_id = '${SHOP1}' and normalized_invoice_number = 'perf-1-x'`,
      "invoices of a business date": `select id from public.invoices where shop_id = '${SHOP1}' and business_date = current_date - 30`,
      "payments of an invoice": `select id from public.payments where shop_id = '${SHOP1}' and invoice_id = '${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}'`,
      "payments of a business date": `select id from public.payments where shop_id = '${SHOP1}' and business_date = current_date - 30`,
      "invoices of a customer": `select id from public.invoices where shop_id = '${SHOP1}' and customer_id = '${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}'`,
      "expenses of a business date": `select id from public.expenses where shop_id = '${SHOP1}' and business_date = current_date - 30`,
      "close state of a date": `select event_type from public.daily_closes where shop_id = '${SHOP1}' and business_date = current_date - 30 order by event_sequence desc limit 1`,
      "customer by id": `select id from public.customers where shop_id = '${SHOP1}' and id = '${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}'`,
    };
    const plans = Object.fromEntries(Object.entries(lookups).map(([name, sql]) => [name, plan(sql)]));
    expect(Object.entries(plans).filter(([, text]) => text.includes('"Node Type": "Seq Scan"')).map(([name]) => name)).toEqual([]);
    // Shop access is resolved once per statement (an InitPlan), never as a per-row filter.
    expect(Object.entries(plans).filter(([, text]) => !text.includes("InitPlan") || text.includes("has_shop_access")).map(([name]) => name)).toEqual([]);
  });
});
