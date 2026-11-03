import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import readXlsxFile from "read-excel-file/universal";
import writeXlsxFile from "write-excel-file/universal";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ExportSheet } from "@/lib/excel/exports";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import {
  customerDueSheet, dailySummarySheet, expenseReportSheet, fetchCustomerDueReport, fetchDailySummary, fetchExpenseReport,
  fetchPaymentReport, fetchSalesReport, paymentReportSheet, salesReportSheet,
} from "@/lib/reports";

const SHOP1 = "10000000-0000-4000-8000-000000000001";
const SHOP2 = "10000000-0000-4000-8000-000000000002";
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const SUITE_TIMEOUT = 120_000;

function run(args: string[], timeout = 90_000) {
  const win = process.platform === "win32";
  return execFileSync(win ? (process.env.ComSpec ?? "cmd.exe") : PNPM, win ? ["/d", "/s", "/c", "call", PNPM, ...args] : args, {
    encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${join(process.cwd(), "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}` },
  });
}
const supabaseCli = (args: string[], timeout = 90_000) => run(["exec", "supabase", "--agent", "no", ...args], timeout);
function sql(statement: string) {
  return execFileSync(process.execPath, [join(process.cwd(), "node_modules", "supabase", "dist", "supabase.js"), "--agent", "no", "db", "query", "--local", statement], { encoding: "utf8", timeout: 30_000 });
}
function parseEnv(output: string) {
  return Object.fromEntries(output.split(/\r?\n/).flatMap((line) => { const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line); return m ? [[m[1], m[2].replace(/^"|"$/g, "")]] : []; }));
}
const key = () => crypto.randomUUID();
const number = (label: string) => `DC-${label}-${key().slice(0, 8)}`;
async function sheetData(sheet: ExportSheet) {
  return (await readXlsxFile(await writeXlsxFile([sheet]).toBlob()))[0].data;
}

describe("daily close, backdating and reports against real Supabase", () => {
  let available = false;
  let credentials = { url: "", key: "" };
  let staff: SupabaseClient; let staff2: SupabaseClient; let manager: SupabaseClient; let owner: SupabaseClient;
  // Pinned per test; a test that would start in the last 90 seconds of the Qatar day waits for the new day.
  let today = qatarBusinessDate(new Date());
  beforeEach(async () => {
    const msToMidnight = 86_400_000 - (Date.now() + 3 * 3_600_000) % 86_400_000;
    if (msToMidnight < 90_000) await new Promise((resolve) => setTimeout(resolve, msToMidnight + 1_000));
    today = qatarBusinessDate(new Date());
  }, 120_000);
  const daysBefore = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00.000Z`) - days * 86_400_000).toISOString().slice(0, 10);

  async function login(email: string, password: string) {
    const client = createClient(credentials.url, credentials.key);
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return client;
  }
  beforeAll(async () => {
    try { supabaseCli(["migration", "list", "--local"], 30_000); } catch { throw new Error("Prerequisite: local Supabase and Docker must be running."); }
    available = true;
    supabaseCli(["db", "reset", "--local"]);
    const env = parseEnv(supabaseCli(["status", "-o", "env"], 30_000));
    credentials = { url: env.API_URL, key: env.PUBLISHABLE_KEY ?? env.ANON_KEY };
    [staff, staff2, manager, owner] = await Promise.all([
      login("staff1@shopkhata.local", "ShopKhata-Local-E2E-Only-2026!"),
      login("staff2@shopkhata.local", "ShopKhata-Local-Shop2-E2E-Only-2026!"),
      login("manager@shopkhata.local", "ShopKhata-Local-Manager-E2E-Only-2026!"),
      login("owner@shopkhata.local", "ShopKhata-Local-Owner-E2E-Only-2026!"),
    ]);
  }, SUITE_TIMEOUT);
  afterAll(() => { if (available) supabaseCli(["db", "reset", "--local"]); }, SUITE_TIMEOUT);

  const close = (client: SupabaseClient, date: string, shopId = SHOP1, extra: Record<string, unknown> = {}) =>
    client.rpc("close_business_date", { command: { shop_id: shopId, business_date: date, ...extra } });
  const reopen = (client: SupabaseClient, date: string, reason: unknown, shopId = SHOP1) =>
    client.rpc("reopen_business_date", { command: { shop_id: shopId, business_date: date, ...(reason === undefined ? {} : { reason }) } });
  const row = (invoiceNumber: string, total: number, received = 0, customerId: string | null = null, delivered = customerId !== null) => ({
    row_id: key(), invoice_number: invoiceNumber, total_dirham: total, received_dirham: received, payment_method: "cash", delivered,
    customer: customerId ? { type: "existing", customer_id: customerId } : null,
  });
  const batch = (rows: ReturnType<typeof row>[], date = today, shopId = SHOP1, backdatedReason?: string) => ({
    shop_id: shopId, business_date: date, idempotency_key: key(), rows, ...(backdatedReason ? { is_backdated: true, backdated_reason: backdatedReason } : {}),
  });
  async function must<T>(call: PromiseLike<{ data: T; error: { message: string; details?: string } | null }>): Promise<NonNullable<T>> {
    const { data, error } = await call;
    if (error || data === null || data === undefined) throw new Error(`${error?.message ?? "NO_DATA"} ${error?.details ?? ""}`);
    return data;
  }
  async function customer(client: SupabaseClient, shopId = SHOP1) {
    return (await must(client.rpc("create_customer", { command: { shop_id: shopId, name: `Close ${key()}`, mobile: null } }))).customer_id as string;
  }
  const invoiceCount = async (invoiceNumber: string, shopId = SHOP1) => (await owner.from("invoices").select("id").eq("shop_id", shopId).eq("invoice_id", invoiceNumber)).data?.length;
  const state = async (date: string, shopId = SHOP1) => (await owner.from("daily_closes").select("event_type").eq("shop_id", shopId).eq("business_date", date).order("event_sequence", { ascending: false }).limit(1)).data?.[0]?.event_type ?? "open";

  it("lets a manager close and reopen with a reason and rejects every unauthorized caller", async () => {
    const anonymous = createClient(credentials.url, credentials.key);
    expect((await close(anonymous, today)).error).not.toBeNull();
    expect((await close(staff, today)).error?.message).toBe("INSUFFICIENT_ROLE");
    expect((await close(staff2, today)).error?.message).toBe("UNAUTHORIZED_SHOP");
    expect((await close(manager, today, SHOP2)).error?.message).toBe("UNAUTHORIZED_SHOP");
    expect((await reopen(staff, today, "let me in")).error?.message).toBe("INSUFFICIENT_ROLE");
    expect(await state(today)).toBe("open");

    const closed = await must(close(manager, today, SHOP1, { note: "till counted" }));
    try {
      expect(closed).toMatchObject({ ok: true, state: "closed", business_date: today });
      expect(await state(today)).toBe("closed");
      expect((await close(manager, today)).error?.message).toBe("ALREADY_CLOSED");
      expect((await reopen(manager, today, undefined)).error?.message).toBe("REASON_REQUIRED");
      expect((await reopen(manager, today, "   ")).error?.message).toBe("REASON_REQUIRED");
      expect((await reopen(staff, today, "let me in")).error?.message).toBe("INSUFFICIENT_ROLE");
      expect(await state(today)).toBe("closed");
    } finally {
      expect(await must(reopen(manager, today, "delivery arrived after close"))).toMatchObject({ ok: true, state: "open" });
    }
    expect((await reopen(manager, today, "again")).error?.message).toBe("NOT_CLOSED");

    const history = await staff.from("daily_closes").select("event_type,reason,note,actor_id").eq("shop_id", SHOP1).eq("business_date", today).order("event_sequence");
    expect(history.data).toEqual([
      { event_type: "closed", reason: null, note: "till counted", actor_id: "10000000-0000-4000-8000-000000000104" },
      { event_type: "reopened", reason: "delivery arrived after close", note: null, actor_id: "10000000-0000-4000-8000-000000000104" },
    ]);
    const audit = await manager.from("audit_events").select("action,reason,entity_id").eq("shop_id", SHOP1).eq("entity_type", "business_date").order("recorded_at");
    expect(audit.data).toEqual([
      { action: "date.close", reason: "till counted", entity_id: today },
      { action: "date.reopen", reason: "delivery arrived after close", entity_id: today },
    ]);
    // History is append-only for every application role.
    const edited = await owner.from("daily_closes").update({ reason: "rewritten" }).eq("shop_id", SHOP1).select("id");
    expect(edited.data ?? []).toEqual([]);
    expect((await owner.from("daily_closes").delete().eq("shop_id", SHOP1).select("id")).data ?? []).toEqual([]);
    expect((await owner.from("daily_closes").select("id").eq("shop_id", SHOP1)).data).toHaveLength(2);
  });

  it("blocks every write to a closed date, keeps a prepared batch rejected, replays committed work exactly, and accepts it all after reopen", async () => {
    const customerId = await customer(staff);
    const dueNumber = number("due");
    const committed = batch([row(dueNumber, 100_00, 20_00, customerId), row(number("credit"), 10_00, 0, customerId)]);
    const receipt = await must(staff.rpc("submit_batch", { command: committed }));
    const [dueInvoice, creditInvoice] = receipt.rows.map((item: { invoice_id: string }) => item.invoice_id);
    const payment = { shop_id: SHOP1, invoice_id: dueInvoice, amount_dirham: 5_00, payment_method: "cash", business_date: today, idempotency_key: key() };
    const paymentReceipt = await must(staff.rpc("record_payment", { command: payment }));
    const customerPayment = { shop_id: SHOP1, customer_id: customerId, amount_dirham: 3_00, business_date: today, idempotency_key: key() };
    const customerPaymentReceipt = await must(staff.rpc("record_customer_payment", { command: customerPayment }));
    const overpayment = { shop_id: SHOP1, invoice_id: creditInvoice, amount_dirham: 0, payment_method: "cash", business_date: today, idempotency_key: key(), reason: "paid extra" };
    const creditDue = (await must(staff.from("effective_invoices").select("effective_due_dirham").eq("canonical_invoice_id", creditInvoice).single())).effective_due_dirham as number;
    overpayment.amount_dirham = creditDue + 4_00;
    const overpaymentReceipt = await must(manager.rpc("approve_overpayment", { command: overpayment }));
    const credit = { shop_id: SHOP1, customer_id: customerId, amount_dirham: 1_00, business_date: today, idempotency_key: key() };
    const creditReceipt = await must(staff.rpc("apply_customer_credit", { command: credit }));
    const expense = { shop_id: SHOP1, amount_dirham: 7_00, business_date: today, category: "supplies", description: `Close expense ${key()}`, idempotency_key: key() };
    const expenseReceipt = await must(staff.rpc("create_expense", { command: expense }));
    const expenseCorrection = await must(staff.rpc("request_expense_correction", { command: { shop_id: SHOP1, expense_id: expenseReceipt.expense_id, amount_dirham: 8_00, category: "supplies", description: expense.description, reason: "receipt total", idempotency_key: key() } }));
    const invoiceCorrection = await must(staff.rpc("request_invoice_correction", { command: { shop_id: SHOP1, invoice_id: dueInvoice, payment_id: null, amount_delta_dirham: -1_00, reason: "discount agreed", idempotency_key: key() } }));

    // A device prepared this batch while the date was open and never sent it.
    const offlineNumber = number("offline");
    const offline = batch([row(offlineNumber, 12_00)]);
    const blockedExpense = { ...expense, description: `Blocked ${key()}`, idempotency_key: key() };
    const approveExpense = { shop_id: SHOP1, request_id: expenseCorrection.request_id, decision: "approved", idempotency_key: key() };
    const approveInvoice = { shop_id: SHOP1, request_id: invoiceCorrection.request_id, expected_revision: 0, decision: "approved", reason: null, idempotency_key: key() };

    const before = await fetchDailySummary(owner, SHOP1, today, today);
    await must(close(manager, today));
    try {
      expect((await staff.rpc("submit_batch", { command: offline })).error?.message).toBe("CLOSED_DATE");
      expect(await invoiceCount(offlineNumber)).toBe(0);
      expect((await owner.from("batches").select("id").eq("shop_id", SHOP1).eq("idempotency_key", offline.idempotency_key)).data).toEqual([]);
      expect((await staff.rpc("record_payment", { command: { ...payment, idempotency_key: key() } })).error?.message).toBe("CLOSED_DATE");
      expect((await staff.rpc("record_customer_payment", { command: { ...customerPayment, idempotency_key: key() } })).error?.message).toBe("CLOSED_DATE");
      expect((await staff.rpc("apply_customer_credit", { command: { ...credit, idempotency_key: key() } })).error?.message).toBe("CLOSED_DATE");
      expect((await manager.rpc("approve_overpayment", { command: { ...overpayment, invoice_id: dueInvoice, amount_dirham: 999_00, idempotency_key: key() } })).error?.message).toBe("CLOSED_DATE");
      expect((await staff.rpc("create_expense", { command: blockedExpense })).error?.message).toBe("CLOSED_DATE");
      expect((await manager.rpc("decide_expense_correction", { command: approveExpense })).error?.message).toBe("CLOSED_DATE");
      expect((await manager.rpc("decide_invoice_correction", { command: approveInvoice })).error?.message).toBe("CLOSED_DATE");
      // The owner is bound by the close as well.
      expect((await owner.rpc("create_expense", { command: { ...blockedExpense, idempotency_key: key() } })).error?.message).toBe("CLOSED_DATE");

      // Each of these committed before the close; the exact same command returns the stored result.
      expect(await must(staff.rpc("submit_batch", { command: committed }))).toEqual(receipt);
      expect(await must(staff.rpc("record_payment", { command: payment }))).toEqual(paymentReceipt);
      expect(await must(staff.rpc("record_customer_payment", { command: customerPayment }))).toEqual(customerPaymentReceipt);
      expect(await must(manager.rpc("approve_overpayment", { command: overpayment }))).toEqual(overpaymentReceipt);
      expect(await must(staff.rpc("apply_customer_credit", { command: credit }))).toEqual(creditReceipt);
      expect(await must(staff.rpc("create_expense", { command: expense }))).toEqual(expenseReceipt);
      // The same key with different content is still a conflict, not a replay.
      expect((await staff.rpc("record_payment", { command: { ...payment, amount_dirham: 6_00 } })).error?.message).toBe("IDEMPOTENCY_CONFLICT");

      expect(await fetchDailySummary(owner, SHOP1, today, today)).toEqual(before);
      // Entry payment, follow-up, customer payment and the applied overpayment: one row each, no duplicates.
      expect((await owner.from("payments").select("id").eq("shop_id", SHOP1).in("invoice_id", [dueInvoice, creditInvoice])).data).toHaveLength(4);
    } finally {
      await must(reopen(manager, today, "resume the day"));
    }

    expect((await staff.rpc("submit_batch", { command: offline })).error).toBeNull();
    expect(await invoiceCount(offlineNumber)).toBe(1);
    expect((await staff.rpc("create_expense", { command: blockedExpense })).error).toBeNull();
    expect((await manager.rpc("decide_expense_correction", { command: approveExpense })).error).toBeNull();
    expect((await manager.rpc("decide_invoice_correction", { command: approveInvoice })).error).toBeNull();
    expect((await staff.rpc("record_payment", { command: { ...payment, idempotency_key: key() } })).error).toBeNull();
  });

  it("allows only an owner to backdate, with a reason, and never into a closed date", async () => {
    const earlier = daysBefore(today, 20);
    const staffBatch = batch([row(number("staff-back"), 10_00)], earlier, SHOP1, "forgot");
    expect((await staff.rpc("submit_batch", { command: staffBatch })).error?.message).toBe("INSUFFICIENT_ROLE");
    expect((await manager.rpc("submit_batch", { command: { ...staffBatch, idempotency_key: key() } })).error?.message).toBe("INSUFFICIENT_ROLE");
    const expense = { shop_id: SHOP1, amount_dirham: 5_00, business_date: earlier, category: "other", description: `Late ${key()}`, backdated_reason: "found the receipt", idempotency_key: key() };
    expect((await staff.rpc("create_expense", { command: expense })).error?.message).toBe("INSUFFICIENT_ROLE");
    expect((await owner.rpc("create_expense", { command: { ...expense, backdated_reason: undefined, idempotency_key: key() } })).error?.message).toBe("INSUFFICIENT_ROLE");
    const unexplained = await owner.rpc("submit_batch", { command: { ...staffBatch, backdated_reason: "  ", idempotency_key: key() } });
    expect(unexplained.error?.details).toContain("BACKDATE_REASON_REQUIRED");

    const ownerNumber = number("owner-back");
    const ownerBatch = batch([row(ownerNumber, 40_00, 10_00)], earlier, SHOP1, "missed sale");
    await must(owner.rpc("submit_batch", { command: ownerBatch }));
    const stored = await must(owner.from("batches").select("business_date,is_backdated,backdated_reason,recorded_at,created_by").eq("shop_id", SHOP1).eq("idempotency_key", ownerBatch.idempotency_key).single());
    expect(stored).toMatchObject({ business_date: earlier, is_backdated: true, backdated_reason: "missed sale", created_by: "10000000-0000-4000-8000-000000000101" });
    // The business date is the earlier day; the recorded timestamp is now.
    expect(qatarBusinessDate(new Date(stored.recorded_at as string))).toBe(today);
    expect((await fetchDailySummary(owner, SHOP1, earlier, earlier))[0]).toMatchObject({ businessDate: earlier, invoiceCount: 1, grossInvoiceDirham: 40_00, initialReceivedDirham: 10_00 });
    await must(owner.rpc("create_expense", { command: expense }));

    await must(close(manager, earlier));
    expect((await owner.rpc("submit_batch", { command: batch([row(number("closed-back"), 10_00)], earlier, SHOP1, "late again") })).error?.message).toBe("CLOSED_DATE");
    expect((await owner.rpc("create_expense", { command: { ...expense, idempotency_key: key(), description: "blocked" } })).error?.message).toBe("CLOSED_DATE");
    const invoiceId = (await must(owner.from("invoices").select("id").eq("shop_id", SHOP1).eq("invoice_id", ownerNumber).single())).id;
    const latePayment = { shop_id: SHOP1, invoice_id: invoiceId, amount_dirham: 5_00, payment_method: "cash", business_date: earlier, backdated_reason: "paid that day", idempotency_key: key() };
    expect((await owner.rpc("record_payment", { command: latePayment })).error?.message).toBe("CLOSED_DATE");
    expect((await reopen(manager, earlier, "manager wants it open")).error?.message).toBe("INSUFFICIENT_ROLE");
    expect(await state(earlier)).toBe("closed");
    await must(reopen(owner, earlier, "record a payment that was missed"));
    expect((await owner.rpc("record_payment", { command: latePayment })).error).toBeNull();
    const audit = await must(owner.from("audit_events").select("reason,metadata").eq("shop_id", SHOP1).eq("action", "record_payment").eq("reason", "paid that day").single());
    expect(audit.metadata).toMatchObject({ is_backdated: true, business_date: earlier });
  });

  it("reconciles every report to the source projections and exports the same values", async () => {
    // Shop 2 has no other activity in this suite, so today's figures are exactly this scenario.
    const customerId = await customer(staff2, SHOP2);
    const a = number("A"), b = number("B"), c = number("C");
    const first = await must(staff2.rpc("submit_batch", { command: batch([row(a, 1000, 400, customerId), row(b, 500, 500)], today, SHOP2) }));
    const invoiceA = first.rows[0].invoice_id as string, invoiceB = first.rows[1].invoice_id as string;
    const followUp = await must(staff2.rpc("record_payment", { command: { shop_id: SHOP2, invoice_id: invoiceA, amount_dirham: 100, payment_method: "cash", business_date: today, idempotency_key: key() } }));
    await must(staff2.rpc("record_customer_payment", { command: { shop_id: SHOP2, customer_id: customerId, amount_dirham: 200, business_date: today, idempotency_key: key() } }));
    const second = await must(staff2.rpc("submit_batch", { command: batch([row(c, 300, 0, customerId)], today, SHOP2) }));
    const invoiceC = second.rows[0].invoice_id as string;
    await must(owner.rpc("approve_overpayment", { command: { shop_id: SHOP2, invoice_id: invoiceA, amount_dirham: 350, payment_method: "cash", business_date: today, idempotency_key: key(), reason: "paid extra" } }));
    await must(staff2.rpc("apply_customer_credit", { command: { shop_id: SHOP2, customer_id: customerId, amount_dirham: 50, business_date: today, idempotency_key: key() } }));
    const totalCorrection = await must(staff2.rpc("request_invoice_correction", { command: { shop_id: SHOP2, invoice_id: invoiceC, payment_id: null, amount_delta_dirham: -30, reason: "price agreed lower", idempotency_key: key() } }));
    const paymentCorrection = await must(staff2.rpc("request_invoice_correction", { command: { shop_id: SHOP2, invoice_id: invoiceA, payment_id: followUp.payment_id, amount_delta_dirham: -10, reason: "counted again", idempotency_key: key() } }));
    for (const request of [totalCorrection, paymentCorrection]) {
      await must(owner.rpc("decide_invoice_correction", { command: { shop_id: SHOP2, request_id: request.request_id, expected_revision: 0, decision: "approved", reason: null, idempotency_key: key() } }));
    }
    // A correction that is requested but never approved must not move any total.
    await must(staff2.rpc("request_invoice_correction", { command: { shop_id: SHOP2, invoice_id: invoiceC, payment_id: null, amount_delta_dirham: -99, reason: "not approved", idempotency_key: key() } }));
    const expense = await must(staff2.rpc("create_expense", { command: { shop_id: SHOP2, amount_dirham: 120, business_date: today, category: "supplies", description: "Report paper", idempotency_key: key() } }));
    await must(staff2.rpc("create_expense", { command: { shop_id: SHOP2, amount_dirham: 80, business_date: today, category: "rent", description: "Report rent", idempotency_key: key() } }));
    const expenseCorrection = await must(staff2.rpc("request_expense_correction", { command: { shop_id: SHOP2, expense_id: expense.expense_id, amount_dirham: 150, category: "supplies", description: "Report paper", reason: "receipt total", idempotency_key: key() } }));
    await must(owner.rpc("decide_expense_correction", { command: { shop_id: SHOP2, request_id: expenseCorrection.request_id, decision: "approved", idempotency_key: key() } }));
    const renamed = number("B-RENAMED");
    const replacement = await must(staff2.rpc("request_invoice_replacement", { command: { shop_id: SHOP2, invoice_id: invoiceB, expected_revision: 0, invoice_number: renamed, customer_id: null, delivered: false, reason: "number typo", idempotency_key: key() } }));
    await must(owner.rpc("decide_invoice_replacement", { command: { shop_id: SHOP2, request_id: replacement.request_id, expected_revision: 0, decision: "approved", reason: null, idempotency_key: key() } }));

    const [day] = await fetchDailySummary(staff2, SHOP2, today, today);
    expect(day).toEqual({
      businessDate: today, invoiceCount: 3, grossInvoiceDirham: 1800, initialReceivedDirham: 900, dueCreatedDirham: 900,
      followupPaymentsDirham: 400, customerPaymentsDirham: 200, paymentCorrectionsDirham: -10, invoiceCorrectionsDirham: -30,
      creditCreatedDirham: 50, creditAppliedDirham: 50, expenseCount: 2, expensesDirham: 230, cashReceivedDirham: 1540,
      bankReceivedDirham: 0, totalReceivedDirham: 1540, netCashMovementDirham: 1310, netDueMovementDirham: 230,
    });

    // Sales: business-date movements reconcile with Daily Close (gross + invoice corrections); the current-state columns
    // equal the effective projection; the replaced invoice is one sale row under its new number.
    const sales = await fetchSalesReport(staff2, SHOP2, today, today);
    const effective = await must(staff2.from("effective_invoices").select("effective_total_dirham,effective_paid_dirham,effective_credit_applied_dirham,effective_due_dirham").eq("shop_id", SHOP2).eq("business_date", today));
    const sum = (field: keyof (typeof effective)[number]) => effective.reduce((total, item) => total + (item[field] as number), 0);
    expect(sales.totals).toEqual({ invoiceCount: 3, grossSalesDirham: day.grossInvoiceDirham, salesCorrectionsDirham: day.invoiceCorrectionsDirham,
      netSalesDirham: day.grossInvoiceDirham + day.invoiceCorrectionsDirham, paidDirham: sum("effective_paid_dirham"), creditAppliedDirham: sum("effective_credit_applied_dirham"),
      dueDirham: sum("effective_due_dirham"), deliveredCount: 2, undeliveredCount: 1 });
    // Every correction here is dated today, so today's net sales equal the effective totals of today's invoices.
    expect(sales.totals).toMatchObject({ grossSalesDirham: 1800, salesCorrectionsDirham: -30, netSalesDirham: sum("effective_total_dirham"), paidDirham: 1490, creditAppliedDirham: 50, dueDirham: 230 });
    expect(sales.rows.filter((item) => item.movement === "sale").map((item) => item.invoiceNumber).sort()).toEqual([a, renamed, c].sort());
    expect(sales.rows.filter((item) => item.movement !== "sale").map((item) => [item.movement, item.amountDirham])).toEqual([["invoice_correction", -30]]);
    // The day's net change in due is the due still open on its invoices.
    expect(day.netDueMovementDirham).toBe(sales.totals.dueDirham);

    // Customer dues: equal to the customer balance projection, and to all invoice due once unassigned due is added.
    const dues = await fetchCustomerDueReport(staff2, SHOP2);
    const balances = await must(staff2.from("customer_financial_balances").select("outstanding_due_dirham,available_credit_dirham").eq("shop_id", SHOP2));
    expect(dues.totals.outstandingDueDirham).toBe(balances.reduce((total, item) => total + (item.outstanding_due_dirham as number), 0));
    expect(dues.totals).toEqual({ customersWithDue: 1, outstandingDueDirham: 230, availableCreditDirham: 0, unassignedDueDirham: 0 });
    expect(dues.rows).toEqual([expect.objectContaining({ customerId, outstandingDueDirham: 230, availableCreditDirham: 0, invoiceCount: 2, lastActivity: today })]);

    // Expenses: equal to the effective expense projection (the corrected amount, once).
    const expenses = await fetchExpenseReport(staff2, SHOP2, today, today);
    const effectiveExpenses = await must(staff2.from("effective_expenses").select("amount_dirham").eq("shop_id", SHOP2).eq("business_date", today));
    expect(expenses.totals.totalDirham).toBe(effectiveExpenses.reduce((total, item) => total + (item.amount_dirham as number), 0));
    expect(expenses.totals).toEqual({ totalDirham: 230, count: 2, byCategory: [{ category: "rent", count: 1, amountDirham: 80 }, { category: "supplies", count: 1, amountDirham: 150 }] });
    expect(expenses.rows.map((item) => [item.description, item.amountDirham, item.corrected])).toEqual(expect.arrayContaining([["Report paper", 150, true], ["Report rent", 80, false]]));
    expect(expenses.totals.totalDirham).toBe(day.expensesDirham);

    // Payments: every movement once; cash equals the daily summary, credit equals credit applied.
    const payments = await fetchPaymentReport(staff2, SHOP2, today, today);
    expect(payments.totals.cashDirham).toBe(day.cashReceivedDirham);
    expect(payments.totals.bankDirham).toBe(day.bankReceivedDirham);
    expect(payments.totals.receivedDirham).toBe(day.totalReceivedDirham);
    expect(payments.totals.creditDirham).toBe(day.creditAppliedDirham);
    expect(payments.rows.map((item) => [item.source, item.amountDirham]).sort()).toEqual([
      ["credit_application", 50], ["customer_payment", 200], ["follow_up", 100], ["follow_up", 300], ["invoice_entry", 400], ["invoice_entry", 500],
      ["overpayment_credit", 50], ["payment_correction", -10],
    ].sort());
    expect(payments.rows.filter((item) => item.source === "credit_application")).toEqual([expect.objectContaining({ invoiceNumber: c, method: "credit" })]);
    expect(payments.rows.find((item) => item.source === "invoice_entry" && item.amountDirham === 500)?.invoiceNumber).toBe(renamed);
    const paidOnA = payments.rows.filter((item) => item.invoiceNumber === a && item.method === "cash" && item.source !== "overpayment_credit").reduce((total, item) => total + item.amountDirham, 0);
    expect(paidOnA).toBe((await must(staff2.from("effective_invoices").select("effective_paid_dirham").eq("canonical_invoice_id", invoiceA).single())).effective_paid_dirham);

    // Exports carry the same authoritative values as the fetches above.
    expect((await sheetData(dailySummarySheet([day])))[1]).toEqual([today, 3, 18, 9, 9, 4, 2, -0.1, -0.3, 0.5, 0.5, 2, 2.3, 15.4, 0, 15.4, 13.1, 2.3]);
    const salesSheet = await sheetData(salesReportSheet(sales.rows, sales.totals));
    expect(salesSheet).toHaveLength(9);
    expect(salesSheet.slice(-4).map((item) => [item[0], item[3]])).toEqual([["Gross sales", 18], ["Invoice corrections", -0.3], ["Net sales", 17.7], ["Current state of these invoices", null]]);
    expect(salesSheet.at(-1)?.slice(7, 11)).toEqual([14.9, 0.5, 2.3, "2 delivered, 1 not delivered"]);
    expect((await sheetData(customerDueSheet(dues.rows, dues.totals))).slice(-2).map((item) => item[3])).toEqual([2.3, 0]);
    expect((await sheetData(expenseReportSheet(expenses.rows, expenses.totals))).at(-1)?.slice(0, 4)).toEqual(["Total", null, "2 expenses", 2.3]);
    expect((await sheetData(paymentReportSheet(payments.rows, payments.totals))).slice(-4).map((item) => [item[0], item[4]])).toEqual([["Total cash received", 15.4], ["Total bank received", 0], ["Total received (cash + bank)", 15.4], ["Total customer credit applied", 0.5]]);

    // A shop the actor is not assigned to yields nothing, on every report.
    expect(await fetchDailySummary(staff, SHOP2, today, today)).toEqual([]);
    expect((await fetchSalesReport(staff, SHOP2, today, today)).totals.invoiceCount).toBe(0);
    expect((await fetchCustomerDueReport(staff, SHOP2)).rows).toEqual([]);
    expect((await fetchExpenseReport(staff, SHOP2, today, today)).totals.totalDirham).toBe(0);
    expect((await fetchPaymentReport(staff, SHOP2, today, today)).rows).toEqual([]);
    expect((await staff.from("report_payments").select("entry_id").eq("shop_id", SHOP2)).data).toEqual([]);
    expect((await close(staff, today, SHOP2)).error?.message).toBe("UNAUTHORIZED_SHOP");
    expect((await close(manager, today, SHOP2)).error?.message).toBe("UNAUTHORIZED_SHOP");
    // Closing Shop 2 leaves Shop 1 writable, and Shop 1 actors cannot see Shop 2's close.
    await must(close(owner, today, SHOP2));
    try {
      expect((await staff2.rpc("create_expense", { command: { shop_id: SHOP2, amount_dirham: 1, business_date: today, category: "other", description: "blocked", idempotency_key: key() } })).error?.message).toBe("CLOSED_DATE");
      expect((await staff.rpc("create_expense", { command: { shop_id: SHOP1, amount_dirham: 1, business_date: today, category: "other", description: "other shop stays open", idempotency_key: key() } })).error).toBeNull();
      expect((await staff.from("daily_closes").select("id").eq("shop_id", SHOP2)).data).toEqual([]);
      expect(await fetchDailySummary(staff2, SHOP2, today, today)).toEqual([day]);
    } finally {
      await must(reopen(owner, today, "isolation check done", SHOP2));
    }
  });

  it("uses the Qatar operating date, not the UTC calendar date, for closing and reporting", async () => {
    // The database and the app agree on the current Qatar date.
    expect(sql("select 'qatar=' || (now() at time zone 'Asia/Qatar')::date::text as value")).toContain(`qatar=${today}`);
    const tomorrow = daysBefore(today, -1);
    expect((await close(owner, tomorrow, SHOP2)).error?.message).toBe("INVALID_DATE");

    // 22:30 UTC on 1 January 2001 is 01:30 on 2 January in Qatar.
    const midnightNumber = number("midnight");
    sql(`insert into public.invoices (shop_id, invoice_id, total_amount_dirham, business_date, recorded_at) values ('${SHOP2}', '${midnightNumber}', 70000, '2001-01-02', '2001-01-01 22:30:00+00')`);
    expect(qatarBusinessDate(new Date("2001-01-01T22:30:00Z"))).toBe("2001-01-02");
    expect(await fetchDailySummary(owner, SHOP2, "2001-01-01", "2001-01-01")).toEqual([]);
    expect((await fetchDailySummary(owner, SHOP2, "2001-01-02", "2001-01-02"))[0]).toMatchObject({ businessDate: "2001-01-02", invoiceCount: 1, grossInvoiceDirham: 70000 });
    const sales = await fetchSalesReport(owner, SHOP2, "2001-01-02", "2001-01-02");
    expect(sales.totals.invoiceCount).toBe(1);
    expect((await fetchSalesReport(owner, SHOP2, "2001-01-01", "2001-01-01")).totals.invoiceCount).toBe(0);
    // The export shows the business date and the Qatar-local recorded time side by side.
    const exported = (await sheetData(salesReportSheet(sales.rows, sales.totals)))[1];
    expect([exported[0], exported[1], exported[2], exported[5]]).toEqual(["2001-01-02", "Sale", midnightNumber, "2001-01-02 01:30:00"]);

    // Closing that business date blocks it; the day before, which shares its UTC date, stays open.
    await must(close(owner, "2001-01-02", SHOP2));
    const late = (date: string) => owner.rpc("create_expense", { command: { shop_id: SHOP2, amount_dirham: 100, business_date: date, category: "other", description: `Qatar ${date}`, backdated_reason: "date semantics", idempotency_key: key() } });
    expect((await late("2001-01-02")).error?.message).toBe("CLOSED_DATE");
    expect((await late("2001-01-01")).error).toBeNull();
  });
});
