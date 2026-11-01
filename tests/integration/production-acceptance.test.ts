import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import readXlsxFile from "read-excel-file/universal";
import writeXlsxFile from "write-excel-file/universal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ExportSheet } from "@/lib/excel/exports";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import {
  customerDueSheet, dailySummarySheet, expenseReportSheet, fetchCustomerDueReport, fetchDailySummary, fetchExpenseReport,
  fetchPaymentReport, fetchSalesReport, paymentReportSheet, salesReportSheet,
} from "@/lib/reports";

// BIG SLICE 5 production acceptance: owner administration, the authorization
// attack matrix, the two-shop requirement, and a full financial scenario that
// must survive a real backup and restore unchanged. Every call goes through
// the public API with a real signed-in session, never through a privileged connection.

const SHOP1 = "10000000-0000-4000-8000-000000000001";
const SHOP2 = "10000000-0000-4000-8000-000000000002";
const STAFF1 = "10000000-0000-4000-8000-000000000102";
const MANAGER = "10000000-0000-4000-8000-000000000104";
const ACCOUNTS = {
  owner: ["owner@shopkhata.local", "ShopKhata-Local-Owner-E2E-Only-2026!"],
  staff: ["staff1@shopkhata.local", "ShopKhata-Local-E2E-Only-2026!"],
  staff2: ["staff2@shopkhata.local", "ShopKhata-Local-Shop2-E2E-Only-2026!"],
  manager: ["manager@shopkhata.local", "ShopKhata-Local-Manager-E2E-Only-2026!"],
} as const;
const CLI = join(process.cwd(), "node_modules", "supabase", "dist", "supabase.js");
const SUITE_TIMEOUT = 180_000;

const cli = (args: string[], timeout = 120_000) => execFileSync(process.execPath, [CLI, "--agent", "no", ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
/** Row count and hash of every table plus the receipt objects, read as the database owner. */
function databaseState() {
  const out = cli(["--output-format", "json", "db", "query", "--local", "-f", join("scripts", "backup-fingerprint.sql")]);
  const { tables, receipt_objects } = JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1))[0].fingerprint;
  return { tables, receipt_objects };
}
const key = () => crypto.randomUUID();
const number = (label: string) => `ACC-${label}-${key().slice(0, 8)}`;
const sheetData = async (sheet: ExportSheet) => (await readXlsxFile(await writeXlsxFile([sheet]).toBlob()))[0].data;

describe("production acceptance against real Supabase", () => {
  let credentials = { url: "", key: "" };
  let owner: SupabaseClient; let staff: SupabaseClient; let staff2: SupabaseClient; let manager: SupabaseClient; let anonymous: SupabaseClient;
  let today = "";
  let backupDir = "";

  async function login(who: keyof typeof ACCOUNTS) {
    const client = createClient(credentials.url, credentials.key, { auth: { persistSession: false } });
    // The API gateway drops idle connections while the database is being restored, so a
    // connection-level failure (never a rejected credential) is retried.
    for (let attempt = 1; ; attempt++) {
      const { error } = await client.auth.signInWithPassword({ email: ACCOUNTS[who][0], password: ACCOUNTS[who][1] });
      if (!error) return client;
      if (error.name !== "AuthRetryableFetchError" || attempt === 5) throw error;
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
  beforeAll(async () => {
    try { cli(["migration", "list", "--local"], 30_000); } catch { throw new Error("Prerequisite: local Supabase and Docker must be running."); }
    cli(["db", "reset", "--local"]);
    const env = Object.fromEntries(cli(["status", "-o", "env"], 30_000).split(/\r?\n/).flatMap((line) => { const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line); return m ? [[m[1], m[2].replace(/^"|"$/g, "")]] : []; }));
    credentials = { url: env.API_URL, key: env.PUBLISHABLE_KEY ?? env.ANON_KEY };
    [owner, staff, staff2, manager] = await Promise.all([login("owner"), login("staff"), login("staff2"), login("manager")]);
    anonymous = createClient(credentials.url, credentials.key, { auth: { persistSession: false } });
    today = qatarBusinessDate(new Date());
    backupDir = mkdtempSync(join(tmpdir(), "shopkhata-acceptance-backup-"));
  }, SUITE_TIMEOUT);
  afterAll(() => {
    if (backupDir) rmSync(backupDir, { recursive: true, force: true });
    if (credentials.url) cli(["db", "reset", "--local"]);
  }, SUITE_TIMEOUT);

  async function must<T>(call: PromiseLike<{ data: T; error: { message: string; details?: string } | null }>): Promise<NonNullable<T>> {
    const { data, error } = await call;
    if (error || data === null || data === undefined) throw new Error(`${error?.message ?? "NO_DATA"} ${error?.details ?? ""}`);
    return data;
  }
  const rpc = (client: SupabaseClient, name: string, command: Record<string, unknown>) => client.rpc(name, { command });
  const code = async (call: PromiseLike<{ error: { message: string } | null }>) => (await call).error?.message ?? "ALLOWED";
  const row = (invoiceNumber: string, total: number, received = 0, customerId: string | null = null) => ({
    row_id: key(), invoice_number: invoiceNumber, total_dirham: total, received_dirham: received, payment_method: "cash", delivered: customerId !== null,
    customer: customerId ? { type: "existing", customer_id: customerId } : null,
  });
  const batch = (rows: ReturnType<typeof row>[], shopId = SHOP1) => ({ shop_id: shopId, business_date: today, idempotency_key: key(), rows });
  const customer = async (client: SupabaseClient, shopId: string, name = `Acceptance ${key()}`) =>
    (await must(rpc(client, "create_customer", { shop_id: shopId, name, mobile: null }))).customer_id as string;
  const expense = (shopId: string, amount: number, description = `Acceptance expense ${key()}`) =>
    ({ shop_id: shopId, amount_dirham: amount, business_date: today, category: "supplies", description, idempotency_key: key() });
  async function receipt(client: SupabaseClient, shopId: string, expenseId: string, bytes: number[]) {
    const path = `${shopId}/${expenseId}/${key()}.png`;
    await must(client.storage.from("expense-receipts").upload(path, new Uint8Array(bytes), { contentType: "image/png" }));
    await must(rpc(client, "register_expense_attachment", { shop_id: shopId, expense_id: expenseId, file_path: path, file_name: "receipt.png", content_type: "image/png", byte_size: bytes.length, idempotency_key: key() }));
    return path;
  }
  const visibleInvoices = async (client: SupabaseClient, shopId: string) => (await client.from("invoices").select("id").eq("shop_id", shopId)).data?.length ?? 0;

  it("lets only an owner administer accounts, and applies every change to the account's next request", async () => {
    await must(rpc(staff, "submit_batch", batch([row(number("admin"), 10_00)])));
    const account = (userId: string, role: string, isActive: boolean) => ({ user_id: userId, role, is_active: isActive });
    const assignment = (userId: string, shopId: string, assigned: boolean) => ({ user_id: userId, shop_id: shopId, assigned });

    // Non-owners, through the RPCs and straight at the tables.
    for (const client of [staff, manager]) {
      expect(await code(rpc(client, "admin_update_account", account(STAFF1, "owner", true)))).toBe("INSUFFICIENT_ROLE");
      expect(await code(rpc(client, "admin_set_shop_assignment", assignment(MANAGER, SHOP2, true)))).toBe("INSUFFICIENT_ROLE");
      expect(await code(rpc(client, "admin_register_account", { email: "x@shopkhata.local", display_name: "X", role: "owner" }))).toBe("INSUFFICIENT_ROLE");
    }
    expect((await rpc(anonymous, "admin_update_account", account(STAFF1, "owner", true))).error).not.toBeNull();
    expect((await staff.from("profiles").update({ role: "owner" }).eq("id", STAFF1).select("id")).data ?? []).toEqual([]);
    expect((await staff.from("user_shop_assignments").insert({ user_id: STAFF1, shop_id: SHOP2 }).select("id")).data ?? []).toEqual([]);
    expect((await manager.from("profiles").select("id")).data).toHaveLength(1);
    expect(await must(owner.from("profiles").select("role,is_active").eq("id", STAFF1).single())).toEqual({ role: "staff", is_active: true });
    expect(await visibleInvoices(staff, SHOP2)).toBe(0);

    // The owner sees every account and its assignments.
    expect((await must(owner.from("profiles").select("id"))).length).toBe(4);
    expect(await code(rpc(owner, "admin_update_account", { ...account(STAFF1, "staff", true), granted_by: "owner" }))).toBe("INVALID_REQUEST");
    expect(await code(rpc(owner, "admin_update_account", account("10000000-0000-4000-8000-000000000101", "staff", true)))).toBe("SELF_CHANGE_FORBIDDEN");

    // Removing the assignment blocks reads and writes on the same, still valid, session.
    expect(await visibleInvoices(staff, SHOP1)).toBeGreaterThan(0);
    await must(rpc(owner, "admin_set_shop_assignment", assignment(STAFF1, SHOP1, false)));
    expect(await visibleInvoices(staff, SHOP1)).toBe(0);
    expect(await code(rpc(staff, "submit_batch", batch([row(number("removed"), 10_00)])))).toBe("UNAUTHORIZED_SHOP");
    expect(await code(rpc(staff, "create_expense", expense(SHOP1, 1_00)))).toBe("UNAUTHORIZED_SHOP");
    // Moving the account to the other shop gives it that shop and only that shop.
    await must(rpc(owner, "admin_set_shop_assignment", assignment(STAFF1, SHOP2, true)));
    expect((await must(staff.from("shops").select("id"))).map((shop) => shop.id)).toEqual([SHOP2]);
    expect(await code(rpc(staff, "create_expense", expense(SHOP2, 1_00)))).toBe("ALLOWED");
    await must(rpc(owner, "admin_set_shop_assignment", assignment(STAFF1, SHOP2, false)));
    await must(rpc(owner, "admin_set_shop_assignment", assignment(STAFF1, SHOP1, true)));
    expect(await visibleInvoices(staff, SHOP1)).toBeGreaterThan(0);
    expect(await code(rpc(staff, "create_expense", expense(SHOP2, 1_00)))).toBe("UNAUTHORIZED_SHOP");

    // Deactivation ends access although the session token and the assignment still exist.
    // Status needs a reason and its own RPC; the role RPC refuses to carry it.
    expect(await code(rpc(owner, "admin_update_account", account(STAFF1, "staff", false)))).toBe("STATUS_REASON_REQUIRED");
    await must(rpc(owner, "admin_set_account_status", { user_id: STAFF1, is_active: false, reason: "acceptance: access check" }));
    expect(await visibleInvoices(staff, SHOP1)).toBe(0);
    expect(await code(rpc(staff, "submit_batch", batch([row(number("inactive"), 10_00)])))).toBe("AUTHENTICATION_REQUIRED");
    expect(await code(rpc(staff, "record_customer_payment", { shop_id: SHOP1, customer_id: key(), amount_dirham: 1, business_date: today, idempotency_key: key() }))).toBe("AUTHENTICATION_REQUIRED");
    await must(rpc(owner, "admin_set_account_status", { user_id: STAFF1, is_active: true, reason: "acceptance: access restored" }));
    expect(await visibleInvoices(staff, SHOP1)).toBeGreaterThan(0);

    // A role change is effective immediately in both directions.
    expect(await code(rpc(staff, "close_business_date", { shop_id: SHOP1, business_date: today }))).toBe("INSUFFICIENT_ROLE");
    await must(rpc(owner, "admin_update_account", account(STAFF1, "manager", true)));
    await must(rpc(staff, "close_business_date", { shop_id: SHOP1, business_date: today }));
    await must(rpc(staff, "reopen_business_date", { shop_id: SHOP1, business_date: today, reason: "role change check" }));
    await must(rpc(owner, "admin_update_account", account(STAFF1, "staff", true)));
    expect(await code(rpc(staff, "close_business_date", { shop_id: SHOP1, business_date: today }))).toBe("INSUFFICIENT_ROLE");

    const audit = await must(owner.from("audit_events").select("action,actor_id,entity_id").eq("entity_type", "profile").order("recorded_at"));
    expect(audit.map((event) => event.action)).toEqual([
      "assignment.remove", "assignment.add", "assignment.remove", "assignment.add", "account.deactivate", "account.reactivate", "account.update", "account.update",
    ]);
    expect(audit.every((event) => event.actor_id === "10000000-0000-4000-8000-000000000101" && event.entity_id === STAFF1)).toBe(true);
    // Account history is not visible to a manager or staff.
    expect((await manager.from("audit_events").select("id").in("action", ["account.update", "account.register"])).data).toEqual([]);
  });

  it("keeps the two shops independent: numbers, visibility, balances, reports, receipts and closing", async () => {
    const shared = number("SAME");
    const name = `Shared Name ${key()}`;
    const customer1 = await customer(staff, SHOP1, name);
    const customer2 = await customer(staff2, SHOP2, name);
    const before1 = await fetchSalesReport(owner, SHOP1, today, today);
    const before2 = await fetchSalesReport(owner, SHOP2, today, today);

    // The same invoice number is saved independently in each shop, by each shop's own staff.
    const first = await must(rpc(staff, "submit_batch", batch([row(shared, 700_00, 100_00, customer1)])));
    const second = await must(rpc(staff2, "submit_batch", batch([row(shared, 30_00, 0, customer2)], SHOP2)));
    expect(first.rows[0].invoice_id).not.toBe(second.rows[0].invoice_id);
    expect(await code(rpc(staff, "submit_batch", batch([row(shared, 1_00)])))).not.toBe("ALLOWED");

    // Each staff account sees its own shop only; the owner sees and operates both.
    expect((await must(staff.from("effective_invoices").select("shop_id,effective_total_dirham").eq("effective_invoice_number", shared)))).toEqual([{ shop_id: SHOP1, effective_total_dirham: 700_00 }]);
    expect((await must(staff2.from("effective_invoices").select("shop_id,effective_total_dirham").eq("effective_invoice_number", shared)))).toEqual([{ shop_id: SHOP2, effective_total_dirham: 30_00 }]);
    expect((await must(owner.from("effective_invoices").select("shop_id").eq("effective_invoice_number", shared))).map((item) => item.shop_id).sort()).toEqual([SHOP1, SHOP2]);
    expect((await must(staff.from("shops").select("id"))).map((shop) => shop.id)).toEqual([SHOP1]);
    expect((await must(staff2.from("shops").select("id"))).map((shop) => shop.id)).toEqual([SHOP2]);
    await must(rpc(owner, "record_payment", { shop_id: SHOP1, invoice_id: first.rows[0].invoice_id, amount_dirham: 50_00, payment_method: "cash", business_date: today, idempotency_key: key() }));
    await must(rpc(owner, "record_payment", { shop_id: SHOP2, invoice_id: second.rows[0].invoice_id, amount_dirham: 5_00, payment_method: "cash", business_date: today, idempotency_key: key() }));

    // Balances and reports are per shop: each moved by exactly its own invoice.
    const balance = async (client: SupabaseClient, shopId: string, customerId: string) =>
      (await must(client.from("customer_financial_balances").select("outstanding_due_dirham").eq("shop_id", shopId).eq("customer_id", customerId).single())).outstanding_due_dirham;
    expect(await balance(owner, SHOP1, customer1)).toBe(550_00);
    expect(await balance(owner, SHOP2, customer2)).toBe(25_00);
    expect((await staff.from("customer_financial_balances").select("customer_id").eq("customer_id", customer2)).data).toEqual([]);
    const after1 = await fetchSalesReport(owner, SHOP1, today, today);
    const after2 = await fetchSalesReport(owner, SHOP2, today, today);
    expect(after1.totals.totalDirham - before1.totals.totalDirham).toBe(700_00);
    expect(after2.totals.totalDirham - before2.totals.totalDirham).toBe(30_00);
    expect(after1.totals.dueDirham - before1.totals.dueDirham).toBe(550_00);
    expect(after2.totals.dueDirham - before2.totals.dueDirham).toBe(25_00);
    expect((await fetchSalesReport(staff, SHOP2, today, today)).totals.invoiceCount).toBe(0);
    expect((await fetchCustomerDueReport(staff2, SHOP1)).rows).toEqual([]);

    // Receipts are private to their shop.
    const expense1 = (await must(rpc(staff, "create_expense", expense(SHOP1, 9_00)))).expense_id as string;
    const expense2 = (await must(rpc(staff2, "create_expense", expense(SHOP2, 8_00)))).expense_id as string;
    const path1 = await receipt(staff, SHOP1, expense1, [137, 80, 78, 71, 1]);
    const path2 = await receipt(staff2, SHOP2, expense2, [137, 80, 78, 71, 2, 2]);
    expect((await staff.storage.from("expense-receipts").download(path1)).data?.size).toBe(5);
    expect((await staff.storage.from("expense-receipts").download(path2)).error).not.toBeNull();
    expect((await staff2.storage.from("expense-receipts").download(path1)).error).not.toBeNull();
    expect((await owner.storage.from("expense-receipts").download(path2)).data?.size).toBe(6);

    // Closing Shop 1 today leaves Shop 2 open and writable.
    await must(rpc(manager, "close_business_date", { shop_id: SHOP1, business_date: today }));
    try {
      expect(await code(rpc(staff, "create_expense", expense(SHOP1, 1_00)))).toBe("CLOSED_DATE");
      expect(await code(rpc(staff2, "create_expense", expense(SHOP2, 1_00)))).toBe("ALLOWED");
      expect((await must(owner.from("daily_closes").select("shop_id").eq("business_date", today))).map((event) => event.shop_id)).toEqual([SHOP1, SHOP1, SHOP1]);
    } finally {
      await must(rpc(manager, "reopen_business_date", { shop_id: SHOP1, business_date: today, reason: "two-shop check complete" }));
    }
  });

  it("rejects every direct unauthorized request and leaves the database byte-for-byte unchanged", async () => {
    // Shop 2 records the attackers (Shop 1 staff, Shop 1 manager, an anonymous caller) aim at.
    const victimCustomer = await customer(staff2, SHOP2);
    const numberA = number("victim");
    const submitted = await must(rpc(staff2, "submit_batch", batch([row(numberA, 200_00, 50_00, victimCustomer), row(number("credit"), 10_00, 0, victimCustomer)], SHOP2)));
    const [invoice, creditInvoice] = submitted.rows.map((item: { invoice_id: string }) => item.invoice_id);
    const payment = (await must(rpc(staff2, "record_payment", { shop_id: SHOP2, invoice_id: invoice, amount_dirham: 10_00, payment_method: "cash", business_date: today, idempotency_key: key() }))).payment_id as string;
    await must(rpc(owner, "approve_overpayment", { shop_id: SHOP2, invoice_id: creditInvoice, amount_dirham: 15_00, payment_method: "cash", business_date: today, idempotency_key: key(), reason: "paid extra" }));
    const victimExpense = (await must(rpc(staff2, "create_expense", expense(SHOP2, 40_00)))).expense_id as string;
    const victimReceipt = await receipt(staff2, SHOP2, victimExpense, [137, 80, 78, 71, 9, 9, 9]);
    const correction = (await must(rpc(staff2, "request_invoice_correction", { shop_id: SHOP2, invoice_id: invoice, payment_id: null, amount_delta_dirham: -1_00, reason: "pending", idempotency_key: key() }))).request_id as string;
    const replacement = (await must(rpc(staff2, "request_invoice_replacement", { shop_id: SHOP2, invoice_id: invoice, expected_revision: 0, invoice_number: number("renamed"), customer_id: victimCustomer, delivered: true, reason: "pending", idempotency_key: key() }))).request_id as string;
    const expenseCorrection = (await must(rpc(staff2, "request_expense_correction", { shop_id: SHOP2, expense_id: victimExpense, amount_dirham: 41_00, category: "supplies", description: "pending", reason: "pending", idempotency_key: key() }))).request_id as string;
    // The attacker's own, legitimate Shop 1 records, used for mixed-shop requests.
    const ownCustomer = await customer(staff, SHOP1);
    const ownInvoice = (await must(rpc(staff, "submit_batch", batch([row(number("own"), 60_00, 0, ownCustomer)])))).rows[0].invoice_id as string;
    const ownExpense = (await must(rpc(staff, "create_expense", expense(SHOP1, 3_00)))).expense_id as string;

    const before = databaseState();
    const failures: string[] = [];
    let attempts = 0;
    const denied = async (label: string, call: PromiseLike<{ data: unknown; error: unknown }>) => {
      attempts += 1;
      const { data, error } = await call;
      if (!error && !(Array.isArray(data) && data.length === 0)) failures.push(`${label} -> ${JSON.stringify(data)}`);
    };

    // 1. Reads of another shop's records, filtered by shop and by direct ID.
    for (const [who, client] of [["staff", staff], ["manager", manager], ["anonymous", anonymous]] as const) {
      for (const table of ["invoices", "effective_invoices", "invoice_effective_balances", "customers", "customer_ledger", "customer_financial_balances", "payments", "report_payments", "expenses",
        "effective_expenses", "attachments", "corrections", "correction_requests", "replacement_requests", "expense_correction_requests", "customer_credits", "credit_applications",
        "customer_payment_batches", "batches", "daily_closes", "audit_events", "invoice_number_registry"]) {
        await denied(`${who} reads ${table} of Shop 2`, client.from(table).select("*").eq("shop_id", SHOP2).limit(5));
      }
      await denied(`${who} reads the invoice by id`, client.from("invoices").select("*").eq("id", invoice));
      await denied(`${who} reads the invoice by number`, client.from("effective_invoices").select("*").eq("effective_invoice_number", numberA));
      await denied(`${who} reads the customer by id`, client.from("customers").select("*").eq("id", victimCustomer));
      await denied(`${who} reads the customer ledger`, client.from("customer_ledger").select("*").eq("customer_id", victimCustomer));
      await denied(`${who} reads the expense by id`, client.from("effective_expenses").select("*").eq("id", victimExpense));
      await denied(`${who} reads the receipt record`, client.from("attachments").select("*").eq("file_path", victimReceipt));
      await denied(`${who} reads the Shop 2 record`, client.from("shops").select("*").eq("id", SHOP2));
      await denied(`${who} reads other profiles`, client.from("profiles").select("*").neq("id", who === "staff" ? STAFF1 : MANAGER));
      await denied(`${who} reads other assignments`, client.from("user_shop_assignments").select("*").eq("shop_id", SHOP2));

      // 2. Reports: every figure for the other shop is empty or zero.
      await denied(`${who} daily summary`, client.rpc("report_daily_summary", { p_shop_id: SHOP2, p_from: today, p_to: today }));
      await denied(`${who} pending requests`, client.rpc("report_day_pending_requests", { p_shop_id: SHOP2, p_date: today }).then(({ data, error }) => ({ error, data: (data ?? []).filter((item: Record<string, number>) => Object.values(item).some(Boolean)) })));
      for (const [report, args] of [["report_sales_totals", { p_shop_id: SHOP2, p_from: today, p_to: today }], ["report_customer_due_totals", { p_shop_id: SHOP2 }],
        ["report_expense_totals", { p_shop_id: SHOP2, p_from: today, p_to: today }], ["report_payment_totals", { p_shop_id: SHOP2, p_from: today, p_to: today }]] as const) {
        await denied(`${who} ${report}`, client.rpc(report, args).then(({ data, error }) => ({ error, data: (data ?? []).filter((item: Record<string, unknown>) => Object.values(item).some((value) => typeof value === "number" && value !== 0)) })));
      }

      // 3. The private receipt.
      const bucket = client.storage.from("expense-receipts");
      await denied(`${who} downloads the receipt`, bucket.download(victimReceipt));
      await denied(`${who} signs a receipt URL`, bucket.createSignedUrl(victimReceipt, 60));
      await denied(`${who} lists the receipt folder`, bucket.list(`${SHOP2}/${victimExpense}`));
      await denied(`${who} uploads into Shop 2`, bucket.upload(`${SHOP2}/${victimExpense}/${key()}.png`, new Uint8Array([1]), { contentType: "image/png" }));
      await denied(`${who} overwrites the receipt`, bucket.upload(victimReceipt, new Uint8Array([6, 6, 6]), { contentType: "image/png", upsert: true }));
      await denied(`${who} deletes the receipt`, bucket.remove([victimReceipt]));
      await denied(`${who} moves the receipt`, bucket.move(victimReceipt, `${SHOP1}/${ownExpense}/${key()}.png`));

      // 4. Write RPCs naming the other shop. The batch is exactly what an offline replay sends.
      const commands: [string, Record<string, unknown>][] = [
        ["submit_batch", batch([row(number("replay"), 5_00)], SHOP2)],
        ["create_customer", { shop_id: SHOP2, name: `Intruder ${key()}`, mobile: null }],
        ["record_payment", { shop_id: SHOP2, invoice_id: invoice, amount_dirham: 1_00, payment_method: "cash", business_date: today, idempotency_key: key() }],
        ["record_customer_payment", { shop_id: SHOP2, customer_id: victimCustomer, amount_dirham: 1_00, business_date: today, idempotency_key: key() }],
        ["apply_customer_credit", { shop_id: SHOP2, customer_id: victimCustomer, amount_dirham: 1_00, business_date: today, idempotency_key: key() }],
        ["approve_overpayment", { shop_id: SHOP2, invoice_id: invoice, amount_dirham: 999_00, payment_method: "cash", business_date: today, idempotency_key: key(), reason: "intruder" }],
        ["request_invoice_correction", { shop_id: SHOP2, invoice_id: invoice, payment_id: null, amount_delta_dirham: -5_00, reason: "intruder", idempotency_key: key() }],
        ["request_invoice_correction", { shop_id: SHOP2, invoice_id: invoice, payment_id: payment, amount_delta_dirham: -5_00, reason: "intruder", idempotency_key: key() }],
        ["decide_invoice_correction", { shop_id: SHOP2, request_id: correction, expected_revision: 0, decision: "approved", reason: null, idempotency_key: key() }],
        ["request_invoice_replacement", { shop_id: SHOP2, invoice_id: invoice, expected_revision: 0, invoice_number: number("stolen"), customer_id: null, delivered: false, reason: "intruder", idempotency_key: key() }],
        ["decide_invoice_replacement", { shop_id: SHOP2, request_id: replacement, expected_revision: 0, decision: "approved", reason: null, idempotency_key: key() }],
        ["create_expense", expense(SHOP2, 1_00)],
        ["request_expense_correction", { shop_id: SHOP2, expense_id: victimExpense, amount_dirham: 1, category: "other", description: "intruder", reason: "intruder", idempotency_key: key() }],
        ["decide_expense_correction", { shop_id: SHOP2, request_id: expenseCorrection, decision: "approved", idempotency_key: key() }],
        ["register_expense_attachment", { shop_id: SHOP2, expense_id: victimExpense, file_path: victimReceipt, file_name: "x.png", content_type: "image/png", byte_size: 7, idempotency_key: key() }],
        ["close_business_date", { shop_id: SHOP2, business_date: today }],
        ["reopen_business_date", { shop_id: SHOP2, business_date: today, reason: "intruder" }],
        // 5. The caller's own shop ID wrapped around the other shop's record IDs.
        ["record_payment", { shop_id: SHOP1, invoice_id: invoice, amount_dirham: 1_00, payment_method: "cash", business_date: today, idempotency_key: key() }],
        ["record_customer_payment", { shop_id: SHOP1, customer_id: victimCustomer, amount_dirham: 1_00, business_date: today, idempotency_key: key() }],
        ["apply_customer_credit", { shop_id: SHOP1, customer_id: victimCustomer, amount_dirham: 1_00, business_date: today, idempotency_key: key() }],
        ["request_invoice_correction", { shop_id: SHOP1, invoice_id: invoice, payment_id: null, amount_delta_dirham: -5_00, reason: "intruder", idempotency_key: key() }],
        ["request_invoice_correction", { shop_id: SHOP1, invoice_id: ownInvoice, payment_id: payment, amount_delta_dirham: -5_00, reason: "intruder", idempotency_key: key() }],
        ["decide_invoice_correction", { shop_id: SHOP1, request_id: correction, expected_revision: 0, decision: "approved", reason: null, idempotency_key: key() }],
        ["request_invoice_replacement", { shop_id: SHOP1, invoice_id: invoice, expected_revision: 0, invoice_number: number("stolen"), customer_id: null, delivered: false, reason: "intruder", idempotency_key: key() }],
        ["request_invoice_replacement", { shop_id: SHOP1, invoice_id: ownInvoice, expected_revision: 0, invoice_number: number("crossed"), customer_id: victimCustomer, delivered: true, reason: "intruder", idempotency_key: key() }],
        ["decide_invoice_replacement", { shop_id: SHOP1, request_id: replacement, expected_revision: 0, decision: "approved", reason: null, idempotency_key: key() }],
        ["request_expense_correction", { shop_id: SHOP1, expense_id: victimExpense, amount_dirham: 1, category: "other", description: "intruder", reason: "intruder", idempotency_key: key() }],
        ["decide_expense_correction", { shop_id: SHOP1, request_id: expenseCorrection, decision: "approved", idempotency_key: key() }],
        ["register_expense_attachment", { shop_id: SHOP1, expense_id: ownExpense, file_path: victimReceipt, file_name: "x.png", content_type: "image/png", byte_size: 7, idempotency_key: key() }],
        ["submit_batch", batch([row(number("crossed"), 5_00, 0, victimCustomer)])],
        // 6. Client-supplied authority.
        ["submit_batch", { ...batch([row(number("smuggle"), 5_00)]), role: "owner", created_by: "10000000-0000-4000-8000-000000000101" }],
        ["submit_batch", { ...batch([row(number("backdate"), 5_00)]), business_date: "2026-01-05", is_backdated: true, backdated_reason: "intruder" }],
        ["create_expense", { ...expense(SHOP1, 1_00), business_date: "2026-01-05", backdated_reason: "intruder" }],
        ["reopen_business_date", { shop_id: SHOP1, business_date: "2026-01-05", reason: "intruder" }],
        // 7. Account administration.
        ["admin_update_account", { user_id: who === "manager" ? MANAGER : STAFF1, role: "owner", is_active: true }],
        ["admin_set_shop_assignment", { user_id: who === "manager" ? MANAGER : STAFF1, shop_id: SHOP2, assigned: true }],
        ["admin_register_account", { email: "staff2@shopkhata.local", display_name: "Intruder", role: "owner" }],
        ["admin_set_account_status", { user_id: "10000000-0000-4000-8000-000000000101", is_active: false, reason: "intruder" }],
        ["admin_set_shop_status", { shop_id: SHOP1, is_active: false, reason: "intruder" }],
      ];
      for (const [name, command] of commands) await denied(`${who} ${name} ${JSON.stringify(command).slice(0, 90)}`, rpc(client, name, command));

      // 8. Tables written directly, bypassing every RPC.
      const writes: [string, PromiseLike<{ data: unknown; error: unknown }>][] = [
        ["insert invoice", client.from("invoices").insert({ shop_id: SHOP2, invoice_id: number("direct"), total_amount_dirham: 1, business_date: today }).select("id")],
        ["insert own-shop invoice", client.from("invoices").insert({ shop_id: SHOP1, invoice_id: number("direct"), total_amount_dirham: 1, business_date: today }).select("id")],
        ["insert payment", client.from("payments").insert({ shop_id: SHOP2, invoice_id: invoice, amount_dirham: 1, business_date: today }).select("id")],
        ["insert expense", client.from("expenses").insert({ shop_id: SHOP1, description: "direct", amount_dirham: 1, business_date: today }).select("id")],
        ["insert credit", client.from("customer_credits").insert({ shop_id: SHOP1, customer_id: ownCustomer, amount_dirham: 100_00, business_date: today, approved_by: "10000000-0000-4000-8000-000000000101" }).select("id")],
        ["insert correction", client.from("corrections").insert({ shop_id: SHOP1, invoice_id: ownInvoice, amount_delta_dirham: -60_00, reason: "direct", business_date: today, approved_by: "10000000-0000-4000-8000-000000000101" }).select("id")],
        ["insert close event", client.from("daily_closes").insert({ shop_id: SHOP2, business_date: today, event_type: "closed" }).select("id")],
        ["insert audit event", client.from("audit_events").insert({ shop_id: SHOP1, action: "forged", entity_type: "invoice" }).select("id")],
        ["insert attachment", client.from("attachments").insert({ shop_id: SHOP1, file_path: victimReceipt, file_name: "x.png", expense_id: ownExpense }).select("id")],
        ["update invoice", client.from("invoices").update({ total_amount_dirham: 1 }).eq("id", ownInvoice).select("id")],
        ["delete invoice", client.from("invoices").delete().eq("id", ownInvoice).select("id")],
        ["delete audit trail", client.from("audit_events").delete().eq("shop_id", SHOP1).select("id")],
        ["update customer", client.from("customers").update({ shop_id: SHOP1 }).eq("id", victimCustomer).select("id")],
        ["update profile", client.from("profiles").update({ role: "owner", is_active: true }).neq("email", "").select("id")],
        ["insert assignment", client.from("user_shop_assignments").insert({ user_id: who === "manager" ? MANAGER : STAFF1, shop_id: SHOP2 }).select("id")],
        ["rename shop", client.from("shops").update({ name: "Taken" }).eq("id", SHOP2).select("id")],
      ];
      for (const [label, call] of writes) await denied(`${who} direct ${label}`, call);
    }

    // 9. Staff attempting manager-only actions inside their own shop.
    const pendingOwn = (await must(rpc(staff2, "request_invoice_correction", { shop_id: SHOP2, invoice_id: invoice, payment_id: null, amount_delta_dirham: -2_00, reason: "own pending", idempotency_key: key() }))).request_id as string;
    const afterSetup = databaseState();
    for (const [name, command] of [
      ["decide_invoice_correction", { shop_id: SHOP2, request_id: pendingOwn, expected_revision: 0, decision: "approved", reason: null, idempotency_key: key() }],
      ["decide_invoice_replacement", { shop_id: SHOP2, request_id: replacement, expected_revision: 0, decision: "approved", reason: null, idempotency_key: key() }],
      ["decide_expense_correction", { shop_id: SHOP2, request_id: expenseCorrection, decision: "approved", idempotency_key: key() }],
      ["approve_overpayment", { shop_id: SHOP2, invoice_id: invoice, amount_dirham: 999_00, payment_method: "cash", business_date: today, idempotency_key: key(), reason: "self-approved" }],
      ["close_business_date", { shop_id: SHOP2, business_date: today }],
    ] as const) await denied(`Shop 2 staff ${name}`, rpc(staff2, name, command));

    expect(failures).toEqual([]);
    // 99 attempts by each of three attackers, plus five by Shop 2's own staff. A dropped attack fails here.
    expect(attempts).toBe(302);
    // Nothing was written anywhere: the first pass against the state before it, the staff pass against its own.
    expect(databaseState()).toEqual(afterSetup);
    expect({ ...afterSetup.tables, correction_requests: before.tables.correction_requests, audit_events: before.tables.audit_events }).toEqual(before.tables);
    expect((await staff2.storage.from("expense-receipts").download(victimReceipt)).data?.size).toBe(7);
  }, SUITE_TIMEOUT);

  it("commits the largest allowed batch atomically and maps a rejection to exactly the offending rows", async () => {
    const MAX_ROWS = 100; // the documented V1 limit (MAX_IMPORT_ROWS and the server's rows-per-batch limit)
    const taken = number("taken");
    await must(rpc(staff, "submit_batch", batch([row(taken, 5_00)])));
    const rows = Array.from({ length: MAX_ROWS }, (_, index) => row(number(`max-${String(index).padStart(3, "0")}`), 100_00 + index, index % 2 ? 50_00 : 0));
    const numbers = rows.map((item) => item.invoice_number);
    const saved = async () => (await must(owner.from("invoices").select("id,batch_id").eq("shop_id", SHOP1).in("invoice_id", numbers)));

    // Two bad rows among a hundred: the whole batch is refused and the errors name those rows only.
    const broken = rows.map((item) => ({ ...item }));
    broken[72].invoice_number = taken;
    broken[40].received_dirham = broken[40].total_dirham + 1;
    const rejected = await rpc(staff, "submit_batch", batch(broken));
    expect(rejected.error).not.toBeNull();
    const reported = (JSON.parse(rejected.error?.details ?? "[]") as { row_id: string }[]).map((item) => item.row_id);
    expect(reported.length).toBeGreaterThan(0);
    expect([...new Set(reported)].every((id) => [broken[40].row_id, broken[72].row_id].includes(id))).toBe(true);
    expect(await saved()).toEqual([]);

    // One row over the limit is refused; nothing is saved.
    expect((await rpc(staff, "submit_batch", batch([...rows, row(number("over"), 1_00)]))).error).not.toBeNull();
    expect(await saved()).toEqual([]);

    // The full batch commits as one unit, and an exact retry returns the same receipt without writing again.
    const command = batch(rows);
    const started = performance.now();
    const receipt = await must(rpc(staff, "submit_batch", command));
    const elapsed = performance.now() - started;
    // Kept for the verification record; test-results/ is not tracked.
    mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
    writeFileSync(join(process.cwd(), "test-results", "large-batch.json"), `${JSON.stringify({ rows: MAX_ROWS, commitMs: Math.round(elapsed) })}\n`);
    expect(elapsed).toBeLessThan(10_000);
    expect(receipt.rows).toHaveLength(MAX_ROWS);
    const committed = await saved();
    expect(committed).toHaveLength(MAX_ROWS);
    expect(new Set(committed.map((item) => item.batch_id)).size).toBe(1);
    expect((await must(owner.from("payments").select("id").eq("shop_id", SHOP1).eq("batch_id", committed[0].batch_id)))).toHaveLength(MAX_ROWS / 2);
    expect(await must(rpc(staff, "submit_batch", command))).toEqual(receipt);
    expect(await saved()).toHaveLength(MAX_ROWS);
  });

  it("reproduces identical balances, reports and exports after a real backup and restore", async () => {
    // 1-2. Customer and invoices, one of them partly paid at entry.
    const customerId = await customer(staff, SHOP1);
    const renamed = number("B-renamed");
    const submitted = await must(rpc(staff, "submit_batch", batch([row(number("A"), 1000_00, 400_00, customerId), row(number("B"), 500_00, 500_00), row(number("C"), 300_00, 0, customerId)])));
    const [invoiceA, invoiceB, invoiceC] = submitted.rows.map((item: { invoice_id: string }) => item.invoice_id);
    // 4. Follow-up payment.
    await must(rpc(staff, "record_payment", { shop_id: SHOP1, invoice_id: invoiceA, amount_dirham: 100_00, payment_method: "cash", business_date: today, idempotency_key: key() }));
    // 5. Approved correction of the total.
    const correction = await must(rpc(staff, "request_invoice_correction", { shop_id: SHOP1, invoice_id: invoiceA, payment_id: null, amount_delta_dirham: -50_00, reason: "price agreed lower", idempotency_key: key() }));
    await must(rpc(manager, "decide_invoice_correction", { shop_id: SHOP1, request_id: correction.request_id, expected_revision: 0, decision: "approved", reason: null, idempotency_key: key() }));
    // 6. Non-financial replacement.
    const replacement = await must(rpc(staff, "request_invoice_replacement", { shop_id: SHOP1, invoice_id: invoiceB, expected_revision: 0, invoice_number: renamed, customer_id: null, delivered: false, reason: "number typo", idempotency_key: key() }));
    await must(rpc(manager, "decide_invoice_replacement", { shop_id: SHOP1, request_id: replacement.request_id, expected_revision: 0, decision: "approved", reason: null, idempotency_key: key() }));
    // 7-8. Approved overpayment creates a credit, which is then applied to the oldest due.
    await must(rpc(manager, "approve_overpayment", { shop_id: SHOP1, invoice_id: invoiceC, amount_dirham: 350_00, payment_method: "cash", business_date: today, idempotency_key: key(), reason: "customer paid extra" }));
    await must(rpc(staff, "apply_customer_credit", { shop_id: SHOP1, customer_id: customerId, amount_dirham: 50_00, business_date: today, idempotency_key: key() }));
    // 9-10. Expense with a receipt, then an approved correction.
    const created = await must(rpc(staff, "create_expense", expense(SHOP1, 120_00, "Acceptance paper")));
    const receiptBytes = [137, 80, 78, 71, 13, 10, 26, 10, 42];
    const receiptPath = await receipt(staff, SHOP1, created.expense_id, receiptBytes);
    const expenseCorrection = await must(rpc(staff, "request_expense_correction", { shop_id: SHOP1, expense_id: created.expense_id, amount_dirham: 150_00, category: "supplies", description: "Acceptance paper", reason: "receipt total", idempotency_key: key() }));
    await must(rpc(manager, "decide_expense_correction", { shop_id: SHOP1, request_id: expenseCorrection.request_id, decision: "approved", idempotency_key: key() }));

    const invoiceState = async (client: SupabaseClient) => Object.fromEntries((await must(client.from("effective_invoices")
      .select("canonical_invoice_id,effective_invoice_number,effective_total_dirham,effective_paid_dirham,effective_credit_applied_dirham,effective_due_dirham").in("canonical_invoice_id", [invoiceA, invoiceB, invoiceC])))
      .map(({ canonical_invoice_id, ...rest }) => [canonical_invoice_id, rest]));
    expect(await invoiceState(staff)).toMatchObject({
      [invoiceA]: { effective_total_dirham: 950_00, effective_paid_dirham: 500_00, effective_credit_applied_dirham: 50_00, effective_due_dirham: 400_00 },
      [invoiceB]: { effective_invoice_number: renamed, effective_total_dirham: 500_00, effective_due_dirham: 0 },
      [invoiceC]: { effective_total_dirham: 300_00, effective_paid_dirham: 300_00, effective_due_dirham: 0 },
    });

    // 11. Close the day.
    await must(rpc(manager, "close_business_date", { shop_id: SHOP1, business_date: today, note: "acceptance close" }));

    // 12-13. Reports and their exports, for both shops, as the application reads them.
    const snapshot = async (client: SupabaseClient) => {
      const result: Record<string, unknown> = { invoices: await invoiceState(client) };
      result.balance = await must(client.from("customer_financial_balances").select("outstanding_due_dirham,available_credit_dirham,invoice_count").eq("shop_id", SHOP1).eq("customer_id", customerId).single());
      result.ledger = await must(client.from("customer_ledger").select("entry_type,debit_dirham,credit_dirham,reference").eq("shop_id", SHOP1).eq("customer_id", customerId).order("recorded_at").order("sequence_id"));
      for (const shopId of [SHOP1, SHOP2]) {
        const daily = await fetchDailySummary(client, shopId, today, today);
        const sales = await fetchSalesReport(client, shopId, today, today);
        const dues = await fetchCustomerDueReport(client, shopId);
        const expenses = await fetchExpenseReport(client, shopId, today, today);
        const payments = await fetchPaymentReport(client, shopId, today, today);
        result[shopId] = {
          daily, sales: sales.totals, dues: dues.totals, expenses: expenses.totals, payments: payments.totals,
          exports: await Promise.all([dailySummarySheet(daily), salesReportSheet(sales.rows, sales.totals), customerDueSheet(dues.rows, dues.totals),
            expenseReportSheet(expenses.rows, expenses.totals), paymentReportSheet(payments.rows, payments.totals)].map(sheetData)),
        };
      }
      return result;
    };
    const before = await snapshot(owner);
    expect(before.balance).toEqual({ outstanding_due_dirham: 400_00, available_credit_dirham: 0, invoice_count: 2 });
    const ledger = before.ledger as { debit_dirham: number; credit_dirham: number }[];
    expect(ledger.reduce((sum, entry) => sum + entry.debit_dirham - entry.credit_dirham, 0)).toBe(400_00);

    // 14-15. Back up, destroy the database, restore it. The script fails unless its own reconciliation passes.
    const env: NodeJS.ProcessEnv = { ...process.env, SHOPKHATA_BACKUP_DIR: backupDir };
    delete env.SHOPKHATA_BACKUP_DB_URL;
    const output = execFileSync(process.execPath, [join("scripts", "backup.mjs"), "verify"], { encoding: "utf8", timeout: 240_000, env, stdio: ["ignore", "pipe", "pipe"] });
    expect(output).toContain("RESTORE VERIFIED");
    const [backup] = readdirSync(backupDir);
    const manifest = JSON.parse(readFileSync(join(backupDir, backup, "manifest.json"), "utf8"));
    const verification = JSON.parse(readFileSync(join(backupDir, backup, "restore-verification.json"), "utf8"));
    // The script's own output and the reconciled figures, kept for the verification record.
    mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
    writeFileSync(join(process.cwd(), "test-results", "restore-drill.json"), `${JSON.stringify({
      output: output.split(/\r?\n/).filter((line) => line.includes("[backup]")).map((line) => line.replace(backupDir, "<backup dir>")),
      tables: manifest.fingerprint.tables, shops: Object.fromEntries(Object.entries(manifest.fingerprint.shops as Record<string, Record<string, unknown>>).map(([id, shop]) => [id, {
        sales_totals: shop.sales_totals, customer_due_totals: shop.customer_due_totals, effective_invoices: shop.effective_invoices, customer_balances: shop.customer_balances,
        customer_ledger: shop.customer_ledger, effective_expenses: shop.effective_expenses, closed_dates: shop.closed_dates,
      }])), receipts: manifest.receipts.length, differences: verification.differences,
    }, null, 2)}\n`);
    expect(manifest).toMatchObject({ format: 1, environment: "local", receiptAttachments: manifest.receipts.length });
    expect(manifest.migrations.at(-1)).toBe(readdirSync(join(process.cwd(), "supabase", "migrations")).sort().at(-1)?.split("_")[0]);
    expect(manifest.receipts.map((item: { name: string }) => item.name)).toContain(receiptPath);
    expect(verification).toMatchObject({ ok: true, differences: [] });
    expect(verification.restoredFingerprint).toEqual(manifest.fingerprint);

    // 16. Restored accounts sign in with their own passwords and read the same figures.
    [owner, staff, staff2, manager] = await Promise.all([login("owner"), login("staff"), login("staff2"), login("manager")]);
    expect(await snapshot(owner)).toEqual(before);
    expect(await invoiceState(staff)).toEqual(before.invoices);
    const restoredReceipt = await must(staff.storage.from("expense-receipts").download(receiptPath));
    expect([...new Uint8Array(await restoredReceipt.arrayBuffer())]).toEqual(receiptBytes);
    expect((await staff2.storage.from("expense-receipts").download(receiptPath)).error).not.toBeNull();
    expect(await visibleInvoices(staff2, SHOP1)).toBe(0);

    // The restored system keeps its rules and stays operable: still closed, reopenable, then writable with working sequences.
    expect(await code(rpc(staff, "record_payment", { shop_id: SHOP1, invoice_id: invoiceA, amount_dirham: 1_00, payment_method: "cash", business_date: today, idempotency_key: key() }))).toBe("CLOSED_DATE");
    await must(rpc(manager, "reopen_business_date", { shop_id: SHOP1, business_date: today, reason: "post-restore check" }));
    await must(rpc(staff, "record_payment", { shop_id: SHOP1, invoice_id: invoiceA, amount_dirham: 100_00, payment_method: "cash", business_date: today, idempotency_key: key() }));
    const publicIds = await must(owner.from("customers").select("public_id"));
    await customer(staff, SHOP1);
    expect(new Set((await must(owner.from("customers").select("public_id"))).map((item) => item.public_id)).size).toBe(publicIds.length + 1);
    expect((await must(owner.from("customer_financial_balances").select("outstanding_due_dirham").eq("shop_id", SHOP1).eq("customer_id", customerId).single())).outstanding_due_dirham).toBe(300_00);
  }, 300_000);
});
