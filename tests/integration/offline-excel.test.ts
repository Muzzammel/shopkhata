import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import readXlsxFile from "read-excel-file/universal";
import writeXlsxFile from "write-excel-file/universal";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { expenseExportSheet, fetchExpenseExport, fetchInvoiceExport, fetchLedgerExport, invoiceExportSheet, ledgerExportSheet } from "@/lib/excel/exports";
import { qatarBusinessDate } from "@/lib/invoice-entry";

const SHOP1 = "10000000-0000-4000-8000-000000000001";
const SHOP2 = "10000000-0000-4000-8000-000000000002";
const MANAGER_ID = "10000000-0000-4000-8000-000000000104";
const OWNER_ID = "10000000-0000-4000-8000-000000000101";
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
// Stands in for another administrator changing server state while this device is offline.
function sql(statement: string) {
  return execFileSync(process.execPath, [join(process.cwd(), "node_modules", "supabase", "dist", "supabase.js"), "--agent", "no", "db", "query", "--local", statement], { encoding: "utf8", timeout: 30_000 });
}
function parseEnv(output: string) {
  return Object.fromEntries(output.split(/\r?\n/).flatMap((line) => { const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line); return m ? [[m[1], m[2].replace(/^"|"$/g, "")]] : []; }));
}
const key = () => crypto.randomUUID();
const number = (label: string) => `OFF-${label}-${key().slice(0, 8)}`;

describe("offline reconnect, retry and conflicts against real Supabase", () => {
  let available = false;
  let credentials = { url: "", key: "" };
  let staff: SupabaseClient; let staff2: SupabaseClient; let manager: SupabaseClient; let owner: SupabaseClient;
  // The operating date is pinned once per test, never once per file: a suite that
  // starts before Qatar midnight must not submit yesterday's date as "today".
  // A test that would start in the last 90 seconds of the Qatar day waits for
  // the new day first, so no test can cross midnight between pinning and submitting.
  let today = qatarBusinessDate(new Date());
  beforeEach(async () => {
    const msIntoQatarDay = (Date.now() + 3 * 3_600_000) % 86_400_000;
    const msToMidnight = 86_400_000 - msIntoQatarDay;
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

  /** A batch as a device would have frozen it while offline. */
  function prepared(invoiceNumber: string, extra: Record<string, unknown> = {}, row: Record<string, unknown> = {}) {
    return {
      shop_id: SHOP1, business_date: today, idempotency_key: key(), ...extra,
      rows: [{ row_id: "r1", invoice_number: invoiceNumber, total_dirham: 5000, received_dirham: 2000, payment_method: "cash", delivered: false, customer: null, ...row }],
    };
  }
  async function counts(client: SupabaseClient, invoiceNumber: string, idempotencyKey: string, shopId = SHOP1) {
    const invoices = await client.from("invoices").select("id").eq("shop_id", shopId).eq("invoice_id", invoiceNumber);
    const ids = (invoices.data ?? []).map((row) => row.id);
    const payments = ids.length ? await client.from("payments").select("id").eq("shop_id", shopId).in("invoice_id", ids) : { data: [] };
    const batches = await client.from("batches").select("id").eq("shop_id", shopId).eq("idempotency_key", idempotencyKey);
    return { invoices: ids.length, payments: payments.data?.length ?? -1, batches: batches.data?.length ?? -1 };
  }

  it("returns the original result when a batch is retried after a lost response", async () => {
    const command = prepared(number("lost"));
    // First send commits; the device never sees this response.
    const first = await staff.rpc("submit_batch", { command });
    expect(first.error).toBeNull();
    const retry = await staff.rpc("submit_batch", { command });
    expect(retry.error).toBeNull();
    expect(retry.data).toEqual(first.data);
    expect(await counts(staff, command.rows[0].invoice_number, command.idempotency_key)).toEqual({ invoices: 1, payments: 1, batches: 1 });
  });

  it("creates no duplicate financial records across repeated and concurrent reconnect retries", async () => {
    const customerName = `Retry storm ${key()}`;
    const command = prepared(number("storm"), {}, { delivered: true, customer: { type: "quick_add", name: customerName, mobile: null } });
    const burst = await Promise.all(Array.from({ length: 5 }, () => staff.rpc("submit_batch", { command })));
    const later = [];
    for (let i = 0; i < 3; i++) later.push(await staff.rpc("submit_batch", { command }));
    const all = [...burst, ...later];
    expect(all.map((result) => result.error)).toEqual(all.map(() => null));
    expect(new Set(all.map((result) => result.data.batch_id)).size).toBe(1);
    expect(new Set(all.map((result) => JSON.stringify(result.data))).size).toBe(1);
    expect(await counts(staff, command.rows[0].invoice_number, command.idempotency_key)).toEqual({ invoices: 1, payments: 1, batches: 1 });
    const customers = await staff.from("customers").select("id").eq("shop_id", SHOP1).eq("name", customerName);
    expect(customers.data).toHaveLength(1);
    const audits = await owner.from("audit_events").select("id").eq("shop_id", SHOP1).eq("action", "batch.submit").eq("entity_id", all[0].data.batch_id);
    expect(audits.data).toHaveLength(1);
  });

  it("rejects an altered payload that reuses a committed idempotency key", async () => {
    const command = prepared(number("alter"));
    expect((await staff.rpc("submit_batch", { command })).error).toBeNull();
    const altered = { ...command, rows: [{ ...command.rows[0], total_dirham: 9999 }] };
    const result = await staff.rpc("submit_batch", { command: altered });
    expect(result.error?.message).toBe("IDEMPOTENCY_CONFLICT");
    const stored = await staff.from("invoices").select("total_amount_dirham").eq("shop_id", SHOP1).eq("invoice_id", command.rows[0].invoice_number);
    expect(stored.data).toEqual([{ total_amount_dirham: 5000 }]);
  });

  it("conflicts cleanly when an offline-prepared invoice number was used by someone else first", async () => {
    const taken = number("INV-500");
    const offline = { ...prepared(number("fresh")), rows: [
      { row_id: "r1", invoice_number: number("fresh"), total_dirham: 1000, received_dirham: 0, payment_method: "cash", delivered: false, customer: null },
      { row_id: "r2", invoice_number: taken.toLowerCase(), total_dirham: 7000, received_dirham: 7000, payment_method: "cash", delivered: false, customer: null },
    ] };
    // While this device is offline, another user creates the same number.
    const other = await owner.rpc("submit_batch", { command: prepared(taken) });
    expect(other.error).toBeNull();

    const result = await staff.rpc("submit_batch", { command: offline });
    expect(result.error?.message).toBe("BATCH_VALIDATION_FAILED");
    expect(JSON.parse(result.error!.details)).toEqual([{ row_id: "r2", field: "invoice_number", code: "INVOICE_NUMBER_ALREADY_REGISTERED", message: "This invoice number already exists in this shop." }]);
    // Atomic: the valid row r1 was not committed either, and no second invoice exists.
    expect(await counts(staff, offline.rows[0].invoice_number, offline.idempotency_key)).toEqual({ invoices: 0, payments: 0, batches: 0 });
    const existing = await staff.from("invoice_number_registry").select("canonical_invoice_id").eq("shop_id", SHOP1).eq("normalized_invoice_number", taken.toLowerCase());
    expect(existing.data).toEqual([{ canonical_invoice_id: other.data.rows[0].invoice_id }]);
    const invoices = await staff.from("invoices").select("id,total_amount_dirham").eq("shop_id", SHOP1).ilike("invoice_id", taken);
    expect(invoices.data).toEqual([{ id: other.data.rows[0].invoice_id, total_amount_dirham: 5000 }]);
    // The retry stays rejected; the conflict does not resolve itself.
    expect((await staff.rpc("submit_batch", { command: offline })).error?.message).toBe("BATCH_VALIDATION_FAILED");
  });

  it("rejects a prepared backdated batch whose business date was closed before reconnect, and accepts the same key once reopened", async () => {
    const closedDate = daysBefore(today, 12);
    const command = prepared(number("closed"), { business_date: closedDate, is_backdated: true, backdated_reason: "missed entry" });
    sql(`insert into public.daily_closes (shop_id, business_date, event_type, actor_id) values ('${SHOP1}', '${closedDate}', 'closed', '${OWNER_ID}')`);

    const blocked = await owner.rpc("submit_batch", { command });
    expect(blocked.error?.message).toBe("CLOSED_DATE");
    expect(await counts(owner, command.rows[0].invoice_number, command.idempotency_key)).toEqual({ invoices: 0, payments: 0, batches: 0 });

    sql(`insert into public.daily_closes (shop_id, business_date, event_type, actor_id, reason) values ('${SHOP1}', '${closedDate}', 'reopened', '${OWNER_ID}', 'late batch')`);
    const accepted = await owner.rpc("submit_batch", { command });
    expect(accepted.error).toBeNull();
    expect(await counts(owner, command.rows[0].invoice_number, command.idempotency_key)).toEqual({ invoices: 1, payments: 1, batches: 1 });
  });

  it("keeps the original business date and identity when a committed batch is retried after its date has passed", async () => {
    // The batch belongs to a day that is already over on the server, as it is for
    // a batch committed just before Qatar midnight and retried just after.
    const earlier = daysBefore(today, 1);
    const command = prepared(number("past"), { business_date: earlier, is_backdated: true, backdated_reason: "late entry" });
    const first = await owner.rpc("submit_batch", { command });
    expect(first.error).toBeNull();
    const retry = await owner.rpc("submit_batch", { command });
    expect(retry.error).toBeNull();
    expect(retry.data).toEqual(first.data);
    const stored = await owner.from("batches").select("id,business_date").eq("shop_id", SHOP1).eq("idempotency_key", command.idempotency_key);
    expect(stored.data).toEqual([{ id: first.data.batch_id, business_date: earlier }]);
    const invoices = await owner.from("invoices").select("business_date").eq("shop_id", SHOP1).eq("invoice_id", command.rows[0].invoice_number);
    expect(invoices.data).toEqual([{ business_date: earlier }]);
    // The same key cannot be moved to the current day.
    const redated = await owner.rpc("submit_batch", { command: { ...command, business_date: today, is_backdated: false, backdated_reason: null } });
    expect(redated.error?.message).toBe("IDEMPOTENCY_CONFLICT");
    expect(await counts(owner, command.rows[0].invoice_number, command.idempotency_key)).toEqual({ invoices: 1, payments: 1, batches: 1 });
  });

  it("refuses a never-sent batch dated before today instead of silently moving it to the current day", async () => {
    // A staff draft prepared yesterday and first sent today: the server neither
    // accepts the old date from a non-owner nor rewrites it.
    const command = prepared(number("stale"), { business_date: daysBefore(today, 1) });
    const refused = await staff.rpc("submit_batch", { command });
    expect(refused.error?.message).toBe("INSUFFICIENT_ROLE");
    expect(await counts(staff, command.rows[0].invoice_number, command.idempotency_key)).toEqual({ invoices: 0, payments: 0, batches: 0 });
    const anywhere = await owner.from("invoices").select("id").eq("invoice_id", command.rows[0].invoice_number);
    expect(anywhere.data).toEqual([]);
  });

  it("does not commit a prepared batch after the user's shop access was revoked", async () => {
    const command = prepared(number("revoked"));
    sql(`delete from public.user_shop_assignments where user_id = '${MANAGER_ID}' and shop_id = '${SHOP1}'`);
    try {
      const denied = await manager.rpc("submit_batch", { command });
      expect(denied.error?.message).toBe("UNAUTHORIZED_SHOP");
      expect(denied.error?.code).toBe("42501");
      expect(await counts(owner, command.rows[0].invoice_number, command.idempotency_key)).toEqual({ invoices: 0, payments: 0, batches: 0 });
    } finally {
      sql(`insert into public.user_shop_assignments (user_id, shop_id) values ('${MANAGER_ID}', '${SHOP1}') on conflict do nothing`);
    }
    // Access restored by an administrator: the same prepared command commits exactly once.
    expect((await manager.rpc("submit_batch", { command })).error).toBeNull();
    expect((await manager.rpc("submit_batch", { command })).error).toBeNull();
    expect(await counts(owner, command.rows[0].invoice_number, command.idempotency_key)).toEqual({ invoices: 1, payments: 1, batches: 1 });
  });

  it("does not commit a deactivated user's prepared batch", async () => {
    const command = prepared(number("inactive"));
    sql(`update public.profiles set is_active = false where id = '${MANAGER_ID}'`);
    try {
      const denied = await manager.rpc("submit_batch", { command });
      expect(denied.error?.message).toBe("AUTHENTICATION_REQUIRED");
      expect(await counts(owner, command.rows[0].invoice_number, command.idempotency_key)).toEqual({ invoices: 0, payments: 0, batches: 0 });
    } finally {
      sql(`update public.profiles set is_active = true where id = '${MANAGER_ID}'`);
    }
  });

  it("refuses a prepared batch without a session and commits it once after reauthentication", async () => {
    const device = await login("staff1@shopkhata.local", "ShopKhata-Local-E2E-Only-2026!");
    const command = prepared(number("session"));
    await device.auth.signOut();
    const expired = await device.rpc("submit_batch", { command });
    expect(expired.error).not.toBeNull();
    expect(expired.data).toBeNull();
    expect(await counts(staff, command.rows[0].invoice_number, command.idempotency_key)).toEqual({ invoices: 0, payments: 0, batches: 0 });

    const { error } = await device.auth.signInWithPassword({ email: "staff1@shopkhata.local", password: "ShopKhata-Local-E2E-Only-2026!" });
    expect(error).toBeNull();
    const first = await device.rpc("submit_batch", { command });
    expect(first.error).toBeNull();
    expect((await device.rpc("submit_batch", { command })).data).toEqual(first.data);
    expect(await counts(staff, command.rows[0].invoice_number, command.idempotency_key)).toEqual({ invoices: 1, payments: 1, batches: 1 });
  });

  it("refuses another user's replay of a key when they have no access to that shop", async () => {
    const command = prepared(number("foreign"));
    expect((await staff.rpc("submit_batch", { command })).error).toBeNull();
    expect((await staff2.rpc("submit_batch", { command })).error?.message).toBe("UNAUTHORIZED_SHOP");
    expect(await counts(staff, command.rows[0].invoice_number, command.idempotency_key)).toEqual({ invoices: 1, payments: 1, batches: 1 });
  });

  it("keeps a valid customer reference and never reassigns an invalid one", async () => {
    const created = await staff.rpc("create_customer", { command: { shop_id: SHOP1, name: `Offline customer ${key()}`, mobile: null } });
    expect(created.error).toBeNull();
    const valid = prepared(number("cust-ok"), {}, { delivered: true, customer: { type: "existing", customer_id: created.data.customer_id } });
    const saved = await staff.rpc("submit_batch", { command: valid });
    expect(saved.error).toBeNull();
    const invoice = await staff.from("invoices").select("customer_id").eq("id", saved.data.rows[0].invoice_id).single();
    expect(invoice.data?.customer_id).toBe(created.data.customer_id);

    const foreign = await staff2.rpc("create_customer", { command: { shop_id: SHOP2, name: `Other shop customer ${key()}`, mobile: null } });
    expect(foreign.error).toBeNull();
    const invalid = prepared(number("cust-bad"), {}, { delivered: true, customer: { type: "existing", customer_id: foreign.data.customer_id } });
    const rejected = await staff.rpc("submit_batch", { command: invalid });
    expect(rejected.error?.message).toBe("BATCH_VALIDATION_FAILED");
    expect(JSON.parse(rejected.error!.details)).toEqual([expect.objectContaining({ row_id: "r1", field: "customer", code: "CUSTOMER_NOT_FOUND" })]);
    expect(await counts(staff, invalid.rows[0].invoice_number, invalid.idempotency_key)).toEqual({ invoices: 0, payments: 0, batches: 0 });
  });

  describe("Excel exports", () => {
    async function workbook(sheet: Parameters<typeof writeXlsxFile>[0]) {
      return (await readXlsxFile(await writeXlsxFile(sheet as never).toBlob()))[0].data;
    }

    it("exports effective invoice numbers and corrected balances, and no other shop's rows", async () => {
      const original = number("exp-old");
      const renamed = number("exp-new");
      const customer = await staff.rpc("create_customer", { command: { shop_id: SHOP1, name: `Export customer ${key()}`, mobile: "55500001" } });
      const saved = await staff.rpc("submit_batch", { command: prepared(original, {}, { total_dirham: 10000, received_dirham: 3000, delivered: true, customer: { type: "existing", customer_id: customer.data.customer_id } }) });
      expect(saved.error).toBeNull();
      const invoiceId = saved.data.rows[0].invoice_id as string;
      const correction = await staff.rpc("request_invoice_correction", { command: { shop_id: SHOP1, invoice_id: invoiceId, payment_id: null, amount_delta_dirham: 500, reason: "Fix total", idempotency_key: key() } });
      expect(correction.error).toBeNull();
      expect((await manager.rpc("decide_invoice_correction", { command: { shop_id: SHOP1, request_id: correction.data.request_id, expected_revision: 0, decision: "approved", reason: null, idempotency_key: key() } })).error).toBeNull();
      const replacement = await staff.rpc("request_invoice_replacement", { command: { shop_id: SHOP1, invoice_id: invoiceId, invoice_number: renamed, expected_revision: 0, customer_id: customer.data.customer_id, delivered: true, reason: "Fix number", idempotency_key: key() } });
      expect(replacement.error).toBeNull();
      expect((await manager.rpc("decide_invoice_replacement", { command: { shop_id: SHOP1, request_id: replacement.data.request_id, expected_revision: 0, decision: "approved", reason: null, idempotency_key: key() } })).error).toBeNull();
      const foreignNumber = number("exp-shop2");
      expect((await staff2.rpc("submit_batch", { command: { ...prepared(foreignNumber), shop_id: SHOP2 } })).error).toBeNull();

      const rows = await fetchInvoiceExport(staff, SHOP1, today, today);
      const exported = rows.find((row) => row.invoiceId === invoiceId);
      expect(exported).toMatchObject({ invoiceNumber: renamed, originalNumber: original, totalDirham: 10500, paidDirham: 3000, dueDirham: 7500, delivered: true, customerMobile: "55500001" });
      expect(rows.some((row) => row.invoiceNumber === original)).toBe(false);
      expect(rows.some((row) => row.invoiceNumber === foreignNumber)).toBe(false);
      const data = await workbook([invoiceExportSheet(rows)]);
      const line = data.find((cells) => cells[11] === invoiceId);
      expect(line?.slice(0, 7)).toEqual([renamed, today, 105, 30, 0, 75, "Yes"]);
      expect(line?.[10]).toBe(original);

      // Shop 1 staff cannot export Shop 2, even by naming it; Shop 2 staff sees only Shop 2.
      expect(await fetchInvoiceExport(staff, SHOP2, today, today)).toEqual([]);
      const shop2 = await fetchInvoiceExport(staff2, SHOP2, today, today);
      expect(shop2.map((row) => row.invoiceNumber)).toContain(foreignNumber);
      expect(shop2.some((row) => row.invoiceNumber === renamed)).toBe(false);
      expect(await fetchInvoiceExport(staff, SHOP1, "2000-01-01", "2000-01-02")).toEqual([]);
    });

    it("exports a customer ledger that reconciles with the authoritative balance", async () => {
      const customer = await staff.rpc("create_customer", { command: { shop_id: SHOP1, name: `Ledger export ${key()}`, mobile: null } });
      const customerId = customer.data.customer_id as string;
      const invoiceNumber = number("ledger");
      expect((await staff.rpc("submit_batch", { command: prepared(invoiceNumber, {}, { total_dirham: 30000, received_dirham: 5000, delivered: true, customer: { type: "existing", customer_id: customerId } }) })).error).toBeNull();
      expect((await staff.rpc("record_customer_payment", { command: { shop_id: SHOP1, customer_id: customerId, amount_dirham: 10000, business_date: today, idempotency_key: key() } })).error).toBeNull();

      const ledger = await fetchLedgerExport(staff, SHOP1, customerId);
      expect(ledger).not.toBeNull();
      const data = await workbook([ledgerExportSheet(ledger!.sources)]);
      const body = data.slice(1);
      // The invoice and its own first payment share one recorded timestamp, so only their set is fixed.
      expect(body.map((cells) => [cells[1], cells[4], cells[5]]).sort()).toEqual([["invoice", 300, 0], ["payment", 0, 100], ["payment", 0, 50]]);
      expect(body.at(-1)?.slice(1, 7)).toEqual(["payment", expect.any(String), invoiceNumber, 0, 100, 150]);
      body.reduce((previous, cells) => { expect(cells[6]).toBeCloseTo(previous + Number(cells[4]) - Number(cells[5]), 2); return Number(cells[6]); }, 0);
      expect(body.every((cells) => cells[3] === invoiceNumber)).toBe(true);
      const balance = await staff.from("customer_financial_balances").select("outstanding_due_dirham").eq("shop_id", SHOP1).eq("customer_id", customerId).single();
      expect(balance.data?.outstanding_due_dirham).toBe(15000);

      expect(await fetchLedgerExport(staff2, SHOP1, customerId)).toBeNull();
      expect(await fetchLedgerExport(staff, SHOP2, customerId)).toBeNull();
    });

    it("exports the effective expense after an approved correction, scoped to the shop", async () => {
      const description = `Export expense ${key()}`;
      const created = await staff.rpc("create_expense", { command: { shop_id: SHOP1, amount_dirham: 250, business_date: today, category: "supplies", description, idempotency_key: key() } });
      expect(created.error).toBeNull();
      const request = await staff.rpc("request_expense_correction", { command: { shop_id: SHOP1, expense_id: created.data.expense_id, amount_dirham: 30000, category: "utilities", description: `${description} corrected`, reason: "Wrong amount", idempotency_key: key() } });
      expect(request.error).toBeNull();
      expect((await manager.rpc("decide_expense_correction", { command: { shop_id: SHOP1, request_id: request.data.request_id, decision: "approved", idempotency_key: key() } })).error).toBeNull();

      const rows = await fetchExpenseExport(staff, SHOP1, today, today);
      const exported = rows.filter((row) => row.expenseId === created.data.expense_id);
      expect(exported).toEqual([expect.objectContaining({ amountDirham: 30000, category: "utilities", description: `${description} corrected`, createdBy: "Local Shop 1 Staff", businessDate: today })]);
      const data = await workbook([expenseExportSheet(exported)]);
      expect(data[1].slice(0, 5)).toEqual([today, "utilities", `${description} corrected`, 300, "Local Shop 1 Staff"]);
      expect(await fetchExpenseExport(staff2, SHOP1, today, today)).toEqual([]);
      expect(await fetchExpenseExport(staff, SHOP2, today, today)).toEqual([]);
    });
  });
});
