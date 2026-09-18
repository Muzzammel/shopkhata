import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
const MANAGER_EMAIL = "manager@shopkhata.local";
const MANAGER_PASSWORD = "ShopKhata-Local-Manager-E2E-Only-2026!";
const SHOP_1 = "10000000-0000-4000-8000-000000000001";

function uniqueInvoiceNumber(label: string): string {
  return `IT-AOP-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("approve_overpayment RPC (real network, real sessions)", () => {
  let supabaseAvailable = false;
  // See submit-batch.test.ts for why this placeholder is safe: beforeAll
  // either reassigns it before any test runs, or throws and every
  // test/afterAll short-circuits on `supabaseAvailable` first.
  let credentials: { url: string; key: string } = { url: "", key: "" };

  beforeAll(() => {
    if (!isSupabaseRunning()) {
      throw new Error(
        "Prerequisite: local Supabase must be running. Start it with: pnpm.cmd exec supabase start --local",
      );
    }
    supabaseAvailable = true;
    runSupabase(["db", "reset", "--local"], RESET_TIMEOUT);
    const env = parseEnv(runSupabase(["status", "-o", "env"], 30_000));
    const url = env.API_URL;
    const key = env.PUBLISHABLE_KEY ?? env.ANON_KEY;
    if (!url || !key) {
      throw new Error("Could not read local Supabase URL/key from `supabase status -o env`.");
    }
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

  // Creates a real invoice via submit_batch (never inserted directly), with
  // a real quick-add customer attached unless withCustomer is false. Returns
  // the invoice id and, when a customer was attached, its id.
  async function createInvoice(
    client: SupabaseClient,
    label: string,
    totalDirham: number,
    withCustomer = true,
  ): Promise<{ invoiceId: string; customerId: string | null }> {
    const invoiceNumber = uniqueInvoiceNumber(label);
    const customerName = `IT-AOP-Customer-${label}-${Date.now()}`;
    const { data, error } = await client.rpc("submit_batch", {
      command: {
        shop_id: SHOP_1,
        business_date: new Date().toISOString().slice(0, 10),
        idempotency_key: `it-invoice-${invoiceNumber}`,
        rows: [
          {
            row_id: "r1",
            invoice_number: invoiceNumber,
            total_dirham: totalDirham,
            received_dirham: 0,
            payment_method: "cash",
            delivered: false,
            customer: withCustomer ? { type: "quick_add", name: customerName, mobile: null } : null,
          },
        ],
      },
    });
    if (error) throw error;
    const invoiceId = data.rows[0].invoice_id as string;

    const { data: invoiceRow, error: invoiceError } = await client
      .from("invoices")
      .select("customer_id")
      .eq("id", invoiceId)
      .single();
    if (invoiceError) throw invoiceError;
    return { invoiceId, customerId: (invoiceRow?.customer_id as string | null) ?? null };
  }

  it("lets a manager approve an overpayment against a real invoice and reads back both rows through RLS", async () => {
    const managerClient = await signIn(MANAGER_EMAIL, MANAGER_PASSWORD);
    const { invoiceId, customerId } = await createInvoice(managerClient, "happy", 1000);

    const { data, error } = await managerClient.rpc("approve_overpayment", {
      command: {
        shop_id: SHOP_1,
        invoice_id: invoiceId,
        amount_dirham: 1300,
        payment_method: "cash",
        business_date: new Date().toISOString().slice(0, 10),
        idempotency_key: `it-${invoiceId}-p1`,
        reason: "customer paid extra, keep on account",
      },
    });
    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    expect(data.applied_amount).toBe(1000);
    expect(data.credit_amount).toBe(300);
    expect(data.effective_due).toBe(0);
    expect(data.customer_id).toBe(customerId);

    const { data: paymentRow, error: paymentError } = await managerClient
      .from("payments")
      .select("amount_dirham, invoice_id")
      .eq("id", data.payment_id)
      .single();
    expect(paymentError).toBeNull();
    expect(paymentRow?.amount_dirham).toBe(1000);
    expect(paymentRow?.invoice_id).toBe(invoiceId);

    const { data: creditRow, error: creditError } = await managerClient
      .from("customer_credits")
      .select("amount_dirham, customer_id, invoice_id, reason, approved_by, approved_at")
      .eq("id", data.credit_id)
      .single();
    expect(creditError).toBeNull();
    expect(creditRow?.amount_dirham).toBe(300);
    expect(creditRow?.customer_id).toBe(customerId);
    expect(creditRow?.invoice_id).toBe(invoiceId);
    expect(creditRow?.reason).toBe("customer paid extra, keep on account");
    expect(creditRow?.approved_by).not.toBeNull();
    expect(creditRow?.approved_at).not.toBeNull();
  });

  it("rejects a staff attempt to approve an overpayment", async () => {
    const staffClient = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const managerClient = await signIn(MANAGER_EMAIL, MANAGER_PASSWORD);
    const { invoiceId } = await createInvoice(managerClient, "staff-reject", 1000);

    const { error } = await staffClient.rpc("approve_overpayment", {
      command: {
        shop_id: SHOP_1,
        invoice_id: invoiceId,
        amount_dirham: 1200,
        payment_method: "cash",
        business_date: new Date().toISOString().slice(0, 10),
        idempotency_key: `it-${invoiceId}-staff`,
        reason: "should be rejected",
      },
    });
    expect(error).not.toBeNull();
    expect(error?.message).toBe("INSUFFICIENT_ROLE");
  });

  it("rejects an overpayment against an invoice with no customer attached", async () => {
    const managerClient = await signIn(MANAGER_EMAIL, MANAGER_PASSWORD);
    const { invoiceId } = await createInvoice(managerClient, "no-customer", 1000, false);

    const { error } = await managerClient.rpc("approve_overpayment", {
      command: {
        shop_id: SHOP_1,
        invoice_id: invoiceId,
        amount_dirham: 1200,
        payment_method: "cash",
        business_date: new Date().toISOString().slice(0, 10),
        idempotency_key: `it-${invoiceId}-no-customer`,
        reason: "no customer to credit",
      },
    });
    expect(error).not.toBeNull();
    expect(error?.message).toBe("OVERPAYMENT_VALIDATION_FAILED");
  });

  it("replays an exact resubmission without creating a duplicate payment or credit", async () => {
    const managerClient = await signIn(MANAGER_EMAIL, MANAGER_PASSWORD);
    const { invoiceId } = await createInvoice(managerClient, "replay", 1000);
    const command = {
      shop_id: SHOP_1,
      invoice_id: invoiceId,
      amount_dirham: 1200,
      payment_method: "cash",
      business_date: new Date().toISOString().slice(0, 10),
      idempotency_key: `it-${invoiceId}-replay`,
      reason: "replay test",
    };

    const first = await managerClient.rpc("approve_overpayment", { command });
    expect(first.error).toBeNull();

    const second = await managerClient.rpc("approve_overpayment", { command });
    expect(second.error).toBeNull();
    expect(second.data.payment_id).toBe(first.data.payment_id);
    expect(second.data.credit_id).toBe(first.data.credit_id);

    const { count: paymentCount } = await managerClient
      .from("payments")
      .select("*", { count: "exact", head: true })
      .eq("invoice_id", invoiceId);
    expect(paymentCount).toBe(1);

    const { count: creditCount } = await managerClient
      .from("customer_credits")
      .select("*", { count: "exact", head: true })
      .eq("invoice_id", invoiceId);
    expect(creditCount).toBe(1);
  });

  // Unlike record_payment (which rejects any amount over due outright),
  // approve_overpayment always succeeds for an amount that exceeds the
  // CURRENT due -- once an invoice is fully paid, due is 0, so a second
  // concurrent overpayment call legitimately succeeds too, applying 0 and
  // converting its entire tendered amount to credit. Both calls succeeding
  // is therefore correct; what must never happen is both calls applying the
  // full amount to `payments`, which would double-book the invoice past its
  // total. That's exactly the race the `for update` lock on the invoice row
  // (added after this test first caught it unlocked) prevents.
  it("concurrency: two simultaneous overpayment approvals against the same invoice never double-book the payments total", async () => {
    const managerClientA = await signIn(MANAGER_EMAIL, MANAGER_PASSWORD);
    const managerClientB = await signIn(MANAGER_EMAIL, MANAGER_PASSWORD);
    const { invoiceId } = await createInvoice(managerClientA, "race", 1000);
    const businessDate = new Date().toISOString().slice(0, 10);

    const [resultA, resultB] = await Promise.all([
      managerClientA.rpc("approve_overpayment", {
        command: {
          shop_id: SHOP_1,
          invoice_id: invoiceId,
          amount_dirham: 1200,
          payment_method: "cash",
          business_date: businessDate,
          idempotency_key: `it-${invoiceId}-race-a`,
          reason: "race a",
        },
      }),
      managerClientB.rpc("approve_overpayment", {
        command: {
          shop_id: SHOP_1,
          invoice_id: invoiceId,
          amount_dirham: 1200,
          payment_method: "cash",
          business_date: businessDate,
          idempotency_key: `it-${invoiceId}-race-b`,
          reason: "race b",
        },
      }),
    ]);

    expect(resultA.error).toBeNull();
    expect(resultB.error).toBeNull();

    const appliedAmounts = [resultA.data.applied_amount, resultB.data.applied_amount].sort((a, b) => a - b);
    const creditAmounts = [resultA.data.credit_amount, resultB.data.credit_amount].sort((a, b) => a - b);
    // Whichever call wins the invoice row lock applies the full due (1000)
    // and credits the 200 excess; the loser sees due already at 0 and
    // converts its entire 1200 tender to credit.
    expect(appliedAmounts).toEqual([0, 1000]);
    expect(creditAmounts).toEqual([200, 1200]);

    const { data: paymentRows, count: paymentCount } = await managerClientA
      .from("payments")
      .select("amount_dirham", { count: "exact" })
      .eq("invoice_id", invoiceId);
    expect(paymentCount).toBe(2);
    const totalApplied = (paymentRows ?? []).reduce((sum, row) => sum + (row.amount_dirham as number), 0);
    expect(totalApplied).toBe(1000);

    const { data: creditRows, count: creditCount } = await managerClientA
      .from("customer_credits")
      .select("amount_dirham", { count: "exact" })
      .eq("invoice_id", invoiceId);
    expect(creditCount).toBe(2);
    const totalCredited = (creditRows ?? []).reduce((sum, row) => sum + (row.amount_dirham as number), 0);
    expect(totalCredited).toBe(1400);
  });
});
