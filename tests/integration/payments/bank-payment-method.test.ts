import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { preparePaymentAttempt } from "@/lib/invoice-payment";
import { prepareInvoiceBatch, qatarBusinessDate, type EntryRow, type InvoiceEntryInput } from "@/lib/invoice-entry";
import { newSubmission, normalizeStoredDraft, serializeDraft } from "@/lib/offline/draft-state";

const SUITE_TIMEOUT = 120_000;
const RESET_TIMEOUT = 90_000;
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

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
    values[key] =
      rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue;
  }
  return values;
}

const STAFF1_EMAIL = "staff1@shopkhata.local";
const STAFF1_PASSWORD = "ShopKhata-Local-E2E-Only-2026!";
const OWNER_EMAIL = "owner@shopkhata.local";
const OWNER_PASSWORD = "ShopKhata-Local-Owner-E2E-Only-2026!";
const SHOP_1 = "10000000-0000-4000-8000-000000000001";
const SHOP_2 = "10000000-0000-4000-8000-000000000002";
const STAFF1_ID = "10000000-0000-4000-8000-000000000102";

const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => qatarBusinessDate(new Date());
const daysAgo = (n: number) => qatarBusinessDate(new Date(Date.now() - n * 86_400_000));
const entryRow = (patch: Partial<EntryRow>): EntryRow => ({
  rowId: `r-${uid()}`, invoiceId: `IT-BANK-${Date.now()}-${uid()}`, total: "10.00", received: "", delivered: false, customerId: "", customerName: "", customerMobile: "", ...patch,
});

describe("Bank payment method (real network, real sessions)", () => {
  let supabaseAvailable = false;
  let credentials: { url: string; key: string } = { url: "", key: "" };

  beforeAll(() => {
    if (!isSupabaseRunning()) {
      throw new Error("Prerequisite: local Supabase must be running. Start it with: pnpm.cmd exec supabase start --local");
    }
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

  /** The exact command the New Sale screen builds, sent through the real RPC. */
  async function sell(client: SupabaseClient, rows: EntryRow[], extra: Partial<InvoiceEntryInput> = {}, key = `it-bank-${uid()}`) {
    const input: InvoiceEntryInput = { shopId: SHOP_1, businessDate: today(), isBackdated: false, backdatedReason: "", idempotencyKey: key, rows, ...extra };
    const { command, errors } = prepareInvoiceBatch(input, []);
    expect(errors).toEqual([]);
    const result = await client.rpc("submit_batch", { command });
    return { command, result, input };
  }

  async function methodsOf(client: SupabaseClient, invoiceId: string) {
    const { data, error } = await client.from("payments").select("amount_dirham, payment_method").eq("invoice_id", invoiceId).order("recorded_at");
    expect(error).toBeNull();
    return (data ?? []).map((row) => `${row.payment_method}:${row.amount_dirham}`);
  }

  async function balance(client: SupabaseClient, invoiceId: string) {
    const { data, error } = await client.from("effective_invoices").select("effective_total_dirham, effective_paid_dirham, effective_due_dirham").eq("canonical_invoice_id", invoiceId).single();
    expect(error).toBeNull();
    return data;
  }

  async function newCustomer(client: SupabaseClient, shopId: string, label: string) {
    const { data, error } = await client.rpc("create_customer", { command: { shop_id: shopId, name: `Bank ${label} ${uid()}`, mobile: null } });
    expect(error).toBeNull();
    return data.customer_id as string;
  }

  it("creates a Cash sale and a Bank sale with identical invoice totals, paid and due", async () => {
    const staff = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const cash = entryRow({ total: "100.00", received: "40.00", paymentMethod: "cash" });
    const bank = entryRow({ total: "100.00", received: "40.00", paymentMethod: "bank" });
    const { result } = await sell(staff, [cash, bank]);
    expect(result.error).toBeNull();
    const [cashId, bankId] = result.data.rows.map((row: { invoice_id: string }) => row.invoice_id);
    expect(await methodsOf(staff, cashId)).toEqual(["cash:4000"]);
    expect(await methodsOf(staff, bankId)).toEqual(["bank:4000"]);
    expect(await balance(staff, bankId)).toEqual(await balance(staff, cashId));
    expect(await balance(staff, bankId)).toEqual({ effective_total_dirham: 10000, effective_paid_dirham: 4000, effective_due_dirham: 6000 });
  });

  it("treats a row without a method as cash and records nothing for an unpaid row", async () => {
    const staff = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const { result } = await sell(staff, [entryRow({ total: "50.00", received: "50.00", delivered: true }), entryRow({ total: "30.00", received: "", paymentMethod: "bank" })]);
    expect(result.error).toBeNull();
    const [paidId, unpaidId] = result.data.rows.map((row: { invoice_id: string }) => row.invoice_id);
    expect(await methodsOf(staff, paidId)).toEqual(["cash:5000"]);
    expect(await methodsOf(staff, unpaidId)).toEqual([]);
  });

  it("records a Cash and a Bank follow-up payment with the same balance effect", async () => {
    const staff = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const { result } = await sell(staff, [entryRow({ total: "100.00" }), entryRow({ total: "100.00" })]);
    const [cashInvoice, bankInvoice] = result.data.rows.map((row: { invoice_id: string }) => row.invoice_id);
    const base = { shopId: SHOP_1, invoiceNumber: "x", amount: "25.50" };
    const cashCommand = preparePaymentAttempt({ ...base, invoiceId: cashInvoice, paymentMethod: "cash", idempotencyKey: `it-pay-${uid()}` }, 10000, new Date()).command!;
    const bankCommand = preparePaymentAttempt({ ...base, invoiceId: bankInvoice, paymentMethod: "bank", idempotencyKey: `it-pay-${uid()}` }, 10000, new Date()).command!;
    const cashPaid = await staff.rpc("record_payment", { command: cashCommand });
    const bankPaid = await staff.rpc("record_payment", { command: bankCommand });
    expect(cashPaid.error).toBeNull();
    expect(bankPaid.error).toBeNull();
    expect({ paid: bankPaid.data.effective_paid, due: bankPaid.data.effective_due }).toEqual({ paid: cashPaid.data.effective_paid, due: cashPaid.data.effective_due });
    expect(await methodsOf(staff, cashInvoice)).toEqual(["cash:2550"]);
    expect(await methodsOf(staff, bankInvoice)).toEqual(["bank:2550"]);

    // Replay of the same Bank command is the same payment; the same key as Cash is refused.
    const replay = await staff.rpc("record_payment", { command: bankCommand });
    expect(replay.data.payment_id).toBe(bankPaid.data.payment_id);
    const flipped = await staff.rpc("record_payment", { command: { ...bankCommand, payment_method: "cash" } });
    expect(flipped.error?.message).toBe("IDEMPOTENCY_CONFLICT");
    expect(await methodsOf(staff, bankInvoice)).toEqual(["bank:2550"]);
  });

  it("rejects unsupported methods on every write path", async () => {
    const staff = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const { result } = await sell(staff, [entryRow({ total: "100.00" })]);
    const invoiceId = result.data.rows[0].invoice_id as string;
    for (const method of ["card", "Bank", "", "cheque"]) {
      const payment = await staff.rpc("record_payment", { command: { shop_id: SHOP_1, invoice_id: invoiceId, amount_dirham: 100, payment_method: method, business_date: today(), idempotency_key: `it-bad-${uid()}` } });
      expect(payment.error?.message).toBe("PAYMENT_VALIDATION_FAILED");
    }
    const batch = await staff.rpc("submit_batch", { command: { shop_id: SHOP_1, business_date: today(), idempotency_key: `it-bad-${uid()}`, rows: [{ row_id: "r1", invoice_number: `IT-BAD-${uid()}`, total_dirham: 500, received_dirham: 500, payment_method: "card", delivered: false, customer: null }] } });
    expect(batch.error?.message).toBe("BATCH_VALIDATION_FAILED");
    const customerId = await newCustomer(staff, SHOP_1, "reject");
    const customerPayment = await staff.rpc("record_customer_payment", { command: { shop_id: SHOP_1, customer_id: customerId, amount_dirham: 100, payment_method: "wallet", business_date: today(), idempotency_key: `it-bad-${uid()}` } });
    expect(customerPayment.error?.message).toBe("INVALID_PAYMENT_METHOD");
    expect(await methodsOf(staff, invoiceId)).toEqual([]);
  });

  it("allocates a Bank customer payment exactly like a Cash one, oldest due first", async () => {
    const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
    const staff = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const customers = { cash: await newCustomer(staff, SHOP_1, "fifo-cash"), bank: await newCustomer(staff, SHOP_1, "fifo-bank") };
    const invoices: Record<"cash" | "bank", string[]> = { cash: [], bank: [] };
    // Backdated by the owner so the oldest-first order is fixed by business date.
    for (const who of ["cash", "bank"] as const) {
      for (const [age, total] of [[3, "300.00"], [2, "200.00"], [1, "100.00"]] as const) {
        const row = entryRow({ total, delivered: true, customerId: customers[who] });
        const { result } = await sell(owner, [row], { businessDate: daysAgo(age), isBackdated: true, backdatedReason: "bank fifo fixture" });
        expect(result.error).toBeNull();
        invoices[who].push(result.data.rows[0].invoice_id);
      }
    }
    const pay = (who: "cash" | "bank", method: "cash" | "bank", amount: number, key: string) =>
      staff.rpc("record_customer_payment", { command: { shop_id: SHOP_1, customer_id: customers[who], amount_dirham: amount, payment_method: method, business_date: today(), idempotency_key: key } });

    const cash = await pay("cash", "cash", 45000, `it-fifo-cash-${uid()}`);
    const bankKey = `it-fifo-bank-${uid()}`;
    const bank = await pay("bank", "bank", 45000, bankKey);
    expect(cash.error).toBeNull();
    expect(bank.error).toBeNull();
    const amounts = (receipt: { allocations: { amount_dirham: number }[] }) => receipt.allocations.map((item) => item.amount_dirham);
    expect(amounts(bank.data)).toEqual([30000, 15000]);
    expect(amounts(bank.data)).toEqual(amounts(cash.data));
    // The same invoices in the same order were touched.
    expect(bank.data.allocations.map((item: { invoice_id: string }) => invoices.bank.indexOf(item.invoice_id))).toEqual([0, 1]);

    for (const [index, expected] of [["0", "bank:30000"], ["1", "bank:15000"]] as const) expect(await methodsOf(staff, invoices.bank[Number(index)])).toEqual([expected]);
    for (const [index, expected] of [["0", "cash:30000"], ["1", "cash:15000"]] as const) expect(await methodsOf(staff, invoices.cash[Number(index)])).toEqual([expected]);
    expect(await methodsOf(staff, invoices.bank[2])).toEqual([]);

    const balances = async (who: "cash" | "bank") => (await Promise.all(invoices[who].map((id) => balance(staff, id))));
    expect(await balances("bank")).toEqual(await balances("cash"));
    const customerBalance = async (id: string) => (await staff.from("customer_financial_balances").select("outstanding_due_dirham, available_credit_dirham").eq("customer_id", id).single()).data;
    expect(await customerBalance(customers.bank)).toEqual(await customerBalance(customers.cash));
    expect(await customerBalance(customers.bank)).toEqual({ outstanding_due_dirham: 15000, available_credit_dirham: 0 });

    // Idempotent replay is the same batch; Cash cannot reuse the Bank key; nothing is paid twice.
    const replay = await pay("bank", "bank", 45000, bankKey);
    expect(replay.data.batch_id).toBe(bank.data.batch_id);
    expect((await pay("bank", "cash", 45000, bankKey)).error?.message).toBe("IDEMPOTENCY_CONFLICT");
    expect(await customerBalance(customers.bank)).toEqual({ outstanding_due_dirham: 15000, available_credit_dirham: 0 });

    // Overpayment is refused for Bank exactly as for Cash.
    expect((await pay("bank", "bank", 15001, `it-fifo-over-${uid()}`)).error?.message).toBe("AMOUNT_EXCEEDS_DUE");
    // Applying credit is not a receipt and takes no method.
    const credit = await staff.rpc("apply_customer_credit", { command: { shop_id: SHOP_1, customer_id: customers.bank, amount_dirham: 1, payment_method: "bank", business_date: today(), idempotency_key: `it-credit-${uid()}` } });
    expect(credit.error?.message).toBe("INVALID_REQUEST");
  });

  it("keeps a customer payment inside its own shop", async () => {
    const staff = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
    const other = await newCustomer(owner, SHOP_2, "other-shop");
    const denied = await staff.rpc("record_customer_payment", { command: { shop_id: SHOP_2, customer_id: other, amount_dirham: 100, payment_method: "bank", business_date: today(), idempotency_key: `it-iso-${uid()}` } });
    expect(denied.error?.code).toBe("42501");
  });

  it("keeps the overpayment's credit on the same tender as its payment and reports it as Bank", async () => {
    const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
    const customerId = await newCustomer(owner, SHOP_1, "overpay");
    const { result } = await sell(owner, [entryRow({ total: "100.00", received: "", delivered: true, customerId })]);
    const invoiceId = result.data.rows[0].invoice_id as string;
    const before = await owner.rpc("report_daily_summary", { p_shop_id: SHOP_1, p_from: today(), p_to: today() });
    const approved = await owner.rpc("approve_overpayment", { command: { shop_id: SHOP_1, invoice_id: invoiceId, amount_dirham: 15000, payment_method: "bank", business_date: today(), idempotency_key: `it-ov-${uid()}`, reason: "paid by bank transfer" } });
    expect(approved.error).toBeNull();
    expect(await methodsOf(owner, invoiceId)).toEqual(["bank:10000"]);
    const credit = await owner.from("customer_credits").select("amount_dirham, payment_method").eq("invoice_id", invoiceId).single();
    expect(credit.data).toEqual({ amount_dirham: 5000, payment_method: "bank" });
    const after = await owner.rpc("report_daily_summary", { p_shop_id: SHOP_1, p_from: today(), p_to: today() });
    const read = (rows: { data: { cash_received_dirham: number; bank_received_dirham: number; total_received_dirham: number }[] | null }) => rows.data?.[0] ?? { cash_received_dirham: 0, bank_received_dirham: 0, total_received_dirham: 0 };
    expect(read(after).bank_received_dirham - read(before).bank_received_dirham).toBe(15000);
    expect(read(after).cash_received_dirham - read(before).cash_received_dirham).toBe(0);
    expect(read(after).total_received_dirham - read(before).total_received_dirham).toBe(15000);
  });

  it("splits Daily Close and the payment report into Cash and Bank, with Total = Cash + Bank", async () => {
    const staff = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
    const day = async () => {
      const summary = (await owner.rpc("report_daily_summary", { p_shop_id: SHOP_1, p_from: today(), p_to: today() })).data?.[0];
      const totals = (await owner.rpc("report_payment_totals", { p_shop_id: SHOP_1, p_from: today(), p_to: today() })).data as { source: string | null; method: string | null; amount_dirham: number }[];
      const method = (name: string) => totals.find((row) => row.source === null && row.method === name)?.amount_dirham ?? 0;
      return { cash: summary?.cash_received_dirham ?? 0, bank: summary?.bank_received_dirham ?? 0, total: summary?.total_received_dirham ?? 0, reportCash: method("cash"), reportBank: method("bank") };
    };
    const before = await day();
    await sell(staff, [entryRow({ total: "100.00", received: "60.00", paymentMethod: "cash" }), entryRow({ total: "100.00", received: "25.00", paymentMethod: "bank" })]);
    const after = await day();
    expect(after.cash - before.cash).toBe(6000);
    expect(after.bank - before.bank).toBe(2500);
    expect(after.total - before.total).toBe(8500);
    expect(after.total).toBe(after.cash + after.bank);
    expect(after.reportCash).toBe(after.cash);
    expect(after.reportBank).toBe(after.bank);
  });

  it("replays a queued offline Bank sale as Bank, once, and never as a Cash version", async () => {
    const staff = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const rows = [entryRow({ total: "80.00", received: "30.00", paymentMethod: "bank" }), entryRow({ total: "40.00", received: "40.00", paymentMethod: "cash", delivered: true })];
    const payload: InvoiceEntryInput = { shopId: SHOP_1, businessDate: today(), isBackdated: false, backdatedReason: "", idempotencyKey: `it-offline-${uid()}`, rows };
    // Saved to the device while offline, then read back after a restart on the same user and shop.
    const stored = serializeDraft({ userId: STAFF1_ID, shopId: SHOP_1, businessDate: payload.businessDate, today: payload.businessDate, backdatedReason: "", rows, customers: {}, idempotencyKey: payload.idempotencyKey,
      submission: newSubmission(payload, new Date().toISOString()), conflict: null, createdAt: new Date().toISOString(), now: new Date().toISOString() });
    const restored = normalizeStoredDraft(JSON.parse(JSON.stringify(stored)), { userId: STAFF1_ID, shopId: SHOP_1 });
    expect(restored?.submission).not.toBeNull();
    const queued = restored!.submission!.payload;

    const send = () => staff.rpc("submit_batch", { command: prepareInvoiceBatch(queued, [], true).command });
    const first = await send();
    expect(first.error).toBeNull();
    // "Reconnect" retries the identical payload: the same receipt, no second invoice or payment.
    const retry = await send();
    expect(retry.error).toBeNull();
    expect(retry.data.batch_id).toBe(first.data.batch_id);
    const [bankId, cashId] = first.data.rows.map((row: { invoice_id: string }) => row.invoice_id);
    expect(await methodsOf(staff, bankId)).toEqual(["bank:3000"]);
    expect(await methodsOf(staff, cashId)).toEqual(["cash:4000"]);

    // A Cash version of the same operation cannot be created under the same key.
    const asCash = { ...queued, rows: queued.rows.map((row) => ({ ...row, paymentMethod: "cash" as const })) };
    const conflicting = await staff.rpc("submit_batch", { command: prepareInvoiceBatch(asCash, [], true).command });
    expect(conflicting.error?.message).toBe("IDEMPOTENCY_CONFLICT");
    expect(await methodsOf(staff, bankId)).toEqual(["bank:3000"]);
  });
});
