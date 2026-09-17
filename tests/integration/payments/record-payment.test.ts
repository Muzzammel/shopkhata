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
const OWNER_EMAIL = "owner@shopkhata.local";
const OWNER_PASSWORD = "ShopKhata-Local-Owner-E2E-Only-2026!";
const SHOP_1 = "10000000-0000-4000-8000-000000000001";

function uniqueInvoiceNumber(label: string): string {
  return `IT-PAY-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("record_payment RPC (real network, real sessions)", () => {
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

  // Creates a real invoice via submit_batch (never inserted directly), so
  // every test below exercises record_payment against exactly the kind of
  // row the app itself produces. Returns the invoice id and its total.
  async function createInvoice(
    client: SupabaseClient,
    label: string,
    totalDirham: number,
  ): Promise<string> {
    const invoiceNumber = uniqueInvoiceNumber(label);
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
            customer: null,
          },
        ],
      },
    });
    if (error) throw error;
    return data.rows[0].invoice_id as string;
  }

  it("lets Shop 1 staff record a payment against a real invoice and reads it back through RLS", async () => {
    const client = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const invoiceId = await createInvoice(client, "happy", 1000);

    const { data, error } = await client.rpc("record_payment", {
      command: {
        shop_id: SHOP_1,
        invoice_id: invoiceId,
        amount_dirham: 400,
        payment_method: "cash",
        business_date: new Date().toISOString().slice(0, 10),
        idempotency_key: `it-${invoiceId}-p1`,
      },
    });
    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    expect(data.effective_paid).toBe(400);
    expect(data.effective_due).toBe(600);

    const { data: paymentRow, error: paymentError } = await client
      .from("payments")
      .select("amount_dirham, payment_method, invoice_id")
      .eq("id", data.payment_id)
      .single();
    expect(paymentError).toBeNull();
    expect(paymentRow?.amount_dirham).toBe(400);
    expect(paymentRow?.payment_method).toBe("cash");
    expect(paymentRow?.invoice_id).toBe(invoiceId);
  });

  it("rejects a payment that would overpay the invoice", async () => {
    const client = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const invoiceId = await createInvoice(client, "overpay", 500);

    const { error } = await client.rpc("record_payment", {
      command: {
        shop_id: SHOP_1,
        invoice_id: invoiceId,
        amount_dirham: 600,
        payment_method: "cash",
        business_date: new Date().toISOString().slice(0, 10),
        idempotency_key: `it-${invoiceId}-overpay`,
      },
    });
    expect(error).not.toBeNull();
    expect(error?.message).toBe("PAYMENT_VALIDATION_FAILED");
  });

  it("rejects a backdated payment from staff and accepts it from the owner", async () => {
    const staffClient = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const invoiceId = await createInvoice(staffClient, "backdate", 1000);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const { error: staffError } = await staffClient.rpc("record_payment", {
      command: {
        shop_id: SHOP_1,
        invoice_id: invoiceId,
        amount_dirham: 100,
        payment_method: "cash",
        business_date: yesterday,
        idempotency_key: `it-${invoiceId}-backdate-staff`,
      },
    });
    expect(staffError).not.toBeNull();
    expect(staffError?.message).toBe("INSUFFICIENT_ROLE");

    const ownerClient = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
    const { data, error: ownerError } = await ownerClient.rpc("record_payment", {
      command: {
        shop_id: SHOP_1,
        invoice_id: invoiceId,
        amount_dirham: 100,
        payment_method: "cash",
        business_date: yesterday,
        idempotency_key: `it-${invoiceId}-backdate-owner`,
      },
    });
    expect(ownerError).toBeNull();
    expect(data.ok).toBe(true);
  });

  it("replays an exact resubmission without creating a duplicate payment", async () => {
    const client = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const invoiceId = await createInvoice(client, "replay", 1000);
    const command = {
      shop_id: SHOP_1,
      invoice_id: invoiceId,
      amount_dirham: 300,
      payment_method: "cash",
      business_date: new Date().toISOString().slice(0, 10),
      idempotency_key: `it-${invoiceId}-replay`,
    };

    const first = await client.rpc("record_payment", { command });
    expect(first.error).toBeNull();

    const second = await client.rpc("record_payment", { command });
    expect(second.error).toBeNull();
    expect(second.data.payment_id).toBe(first.data.payment_id);

    const { count } = await client
      .from("payments")
      .select("*", { count: "exact", head: true })
      .eq("invoice_id", invoiceId);
    expect(count).toBe(1);
  });

  it("concurrency: two simultaneous payments that together would overpay — exactly one commits", async () => {
    const clientA = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const clientB = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const invoiceId = await createInvoice(clientA, "race", 1000);
    const businessDate = new Date().toISOString().slice(0, 10);

    const [resultA, resultB] = await Promise.all([
      clientA.rpc("record_payment", {
        command: {
          shop_id: SHOP_1,
          invoice_id: invoiceId,
          amount_dirham: 700,
          payment_method: "cash",
          business_date: businessDate,
          idempotency_key: `it-${invoiceId}-race-a`,
        },
      }),
      clientB.rpc("record_payment", {
        command: {
          shop_id: SHOP_1,
          invoice_id: invoiceId,
          amount_dirham: 700,
          payment_method: "cash",
          business_date: businessDate,
          idempotency_key: `it-${invoiceId}-race-b`,
        },
      }),
    ]);

    const successes = [resultA, resultB].filter((r) => r.error === null);
    const rejections = [resultA, resultB].filter((r) => r.error?.message === "PAYMENT_VALIDATION_FAILED");
    expect(successes).toHaveLength(1);
    expect(rejections).toHaveLength(1);

    const { data: payments, count } = await clientA
      .from("payments")
      .select("amount_dirham", { count: "exact" })
      .eq("invoice_id", invoiceId);
    expect(count).toBe(1);
    const totalPaid = (payments ?? []).reduce((sum, row) => sum + (row.amount_dirham as number), 0);
    expect(totalPaid).toBe(700);
    expect(successes[0].data.effective_paid).toBe(700);
    expect(successes[0].data.effective_due).toBe(300);
  });
});
