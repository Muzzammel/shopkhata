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
const SHOP_2 = "10000000-0000-4000-8000-000000000002";

function uniqueInvoiceNumber(label: string): string {
  return `IT-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("submit_batch RPC (real network, real sessions)", () => {
  let supabaseAvailable = false;
  // Initialized to a safe, obviously-invalid default so TypeScript never
  // treats this as possibly unassigned when read inside an `it` block —
  // `beforeAll` runs in a separate callback the compiler cannot correlate
  // with later reads, so a definite-assignment story is needed either way.
  // If `beforeAll` throws before reassigning it (e.g. Supabase not running),
  // `supabaseAvailable` stays false and every test/afterAll short-circuits
  // before this placeholder value could ever be used to sign in.
  let credentials: { url: string; key: string } = { url: "", key: "" };

  beforeAll(() => {
    if (!isSupabaseRunning()) {
      throw new Error(
        "Prerequisite: local Supabase must be running. Start it with: pnpm.cmd exec supabase start --local",
      );
    }
    supabaseAvailable = true;
    runSupabase(["db", "reset", "--local"], RESET_TIMEOUT);
    // Parsed once per suite, not once per sign-in: `supabase status -o env`
    // quotes every value, and re-invoking the CLI per client is unnecessary.
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

  it("lets Shop 1 staff submit a mixed batch and read it back through RLS", async () => {
    const client = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const invoiceNumber = uniqueInvoiceNumber("mixed");
    const businessDate = new Date().toISOString().slice(0, 10);

    const { data, error } = await client.rpc("submit_batch", {
      command: {
        shop_id: SHOP_1,
        business_date: businessDate,
        idempotency_key: `it-${invoiceNumber}`,
        rows: [
          {
            row_id: "r1",
            invoice_number: invoiceNumber,
            total_dirham: 10000,
            received_dirham: 10000,
            payment_method: "cash",
            delivered: true,
            customer: null,
          },
        ],
      },
    });
    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    const invoiceId = data.rows[0].invoice_id as string;
    const paymentId = data.rows[0].payment_id as string;

    const { data: batchRow, error: batchError } = await client
      .from("batches")
      .select("id, shop_id, business_date")
      .eq("id", data.batch_id)
      .single();
    expect(batchError).toBeNull();
    expect(batchRow?.shop_id).toBe(SHOP_1);

    const { data: invoiceRow, error: invoiceError } = await client
      .from("invoices")
      .select("invoice_id, total_amount_dirham, delivered, business_date")
      .eq("id", invoiceId)
      .single();
    expect(invoiceError).toBeNull();
    expect(invoiceRow?.invoice_id).toBe(invoiceNumber);
    expect(invoiceRow?.total_amount_dirham).toBe(10000);
    expect(invoiceRow?.delivered).toBe(true);

    const { data: registryRow, error: registryError } = await client
      .from("invoice_number_registry")
      .select("canonical_invoice_id")
      .eq("shop_id", SHOP_1)
      .eq("invoice_number", invoiceNumber)
      .single();
    expect(registryError).toBeNull();
    expect(registryRow?.canonical_invoice_id).toBe(invoiceId);

    const { data: paymentRow, error: paymentError } = await client
      .from("payments")
      .select("amount_dirham, payment_method")
      .eq("id", paymentId)
      .single();
    expect(paymentError).toBeNull();
    expect(paymentRow?.amount_dirham).toBe(10000);
    expect(paymentRow?.payment_method).toBe("cash");
  });

  it("rejects a non-cash payment method even with the browser and server action bypassed", async () => {
    const client = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);

    const { error } = await client.rpc("submit_batch", {
      command: {
        shop_id: SHOP_1,
        business_date: new Date().toISOString().slice(0, 10),
        idempotency_key: `it-${uniqueInvoiceNumber("bad-method")}`,
        rows: [
          {
            row_id: "r1",
            invoice_number: uniqueInvoiceNumber("bad-method"),
            total_dirham: 5000,
            received_dirham: 5000,
            payment_method: "card",
            delivered: false,
            customer: null,
          },
        ],
      },
    });
    expect(error).not.toBeNull();
    expect(error?.message).toBe("BATCH_VALIDATION_FAILED");
  });

  it("rejects a backdated batch from staff and accepts it from the owner", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const staffClient = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const { error: staffError } = await staffClient.rpc("submit_batch", {
      command: {
        shop_id: SHOP_1,
        business_date: yesterday,
        is_backdated: true,
        backdated_reason: "late entry",
        idempotency_key: `it-${uniqueInvoiceNumber("staff-backdate")}`,
        rows: [
          {
            row_id: "r1",
            invoice_number: uniqueInvoiceNumber("staff-backdate"),
            total_dirham: 100,
            received_dirham: 0,
            delivered: false,
            customer: null,
          },
        ],
      },
    });
    expect(staffError?.code).toBe("42501");

    const ownerClient = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
    const { data, error: ownerError } = await ownerClient.rpc("submit_batch", {
      command: {
        shop_id: SHOP_1,
        business_date: yesterday,
        is_backdated: true,
        backdated_reason: "late entry",
        idempotency_key: `it-${uniqueInvoiceNumber("owner-backdate")}`,
        rows: [
          {
            row_id: "r1",
            invoice_number: uniqueInvoiceNumber("owner-backdate"),
            total_dirham: 100,
            received_dirham: 0,
            delivered: false,
            customer: null,
          },
        ],
      },
    });
    expect(ownerError).toBeNull();
    expect(data.ok).toBe(true);
  });

  it("replays an exact resubmission without creating a duplicate invoice", async () => {
    const client = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const invoiceNumber = uniqueInvoiceNumber("replay");
    const command = {
      shop_id: SHOP_1,
      business_date: new Date().toISOString().slice(0, 10),
      idempotency_key: `it-${invoiceNumber}`,
      rows: [
        {
          row_id: "r1",
          invoice_number: invoiceNumber,
          total_dirham: 100,
          received_dirham: 0,
          delivered: false,
          customer: null,
        },
      ],
    };

    const first = await client.rpc("submit_batch", { command });
    const second = await client.rpc("submit_batch", { command });

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(second.data.batch_id).toBe(first.data.batch_id);

    const { count } = await client
      .from("invoices")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .eq("invoice_id", invoiceNumber);
    expect(count).toBe(1);
  });

  it("accepts the same invoice number in two different shops for the owner", async () => {
    const client = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
    const invoiceNumber = uniqueInvoiceNumber("two-shops");

    const buildCommand = (shopId: string, idempotencyKey: string) => ({
      shop_id: shopId,
      business_date: new Date().toISOString().slice(0, 10),
      idempotency_key: idempotencyKey,
      rows: [
        {
          row_id: "r1",
          invoice_number: invoiceNumber,
          total_dirham: 100,
          received_dirham: 0,
          delivered: false,
          customer: null,
        },
      ],
    });

    const shop1Result = await client.rpc("submit_batch", { command: buildCommand(SHOP_1, `it-shop1-${invoiceNumber}`) });
    const shop2Result = await client.rpc("submit_batch", { command: buildCommand(SHOP_2, `it-shop2-${invoiceNumber}`) });

    expect(shop1Result.error).toBeNull();
    expect(shop2Result.error).toBeNull();
  });

  it("concurrency: same key + same fingerprint both succeed with the same result and exactly one write set", async () => {
    const clientA = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const clientB = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const invoiceNumber = uniqueInvoiceNumber("same-key-same-fp");
    const idempotencyKey = `it-${invoiceNumber}`;
    const command = {
      shop_id: SHOP_1,
      business_date: new Date().toISOString().slice(0, 10),
      idempotency_key: idempotencyKey,
      rows: [
        {
          row_id: "r1",
          invoice_number: invoiceNumber,
          total_dirham: 100,
          received_dirham: 0,
          delivered: false,
          customer: null,
        },
      ],
    };

    const [resultA, resultB] = await Promise.all([
      clientA.rpc("submit_batch", { command }),
      clientB.rpc("submit_batch", { command }),
    ]);

    expect(resultA.error).toBeNull();
    expect(resultB.error).toBeNull();
    expect(resultA.data.batch_id).toBe(resultB.data.batch_id);

    const { count: batchCount } = await clientA
      .from("batches")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .eq("idempotency_key", idempotencyKey);
    expect(batchCount).toBe(1);

    const { count: invoiceCount } = await clientA
      .from("invoices")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .eq("invoice_id", invoiceNumber);
    expect(invoiceCount).toBe(1);

    const { count: registryCount } = await clientA
      .from("invoice_number_registry")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .ilike("invoice_number", invoiceNumber);
    expect(registryCount).toBe(1);

    const { count: auditCount } = await clientA
      .from("audit_events")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .eq("entity_type", "batch")
      .eq("entity_id", resultA.data.batch_id);
    expect(auditCount).toBe(1);
  });

  it("concurrency: same key + different fingerprint yields exactly one commit and one explicit IDEMPOTENCY_CONFLICT", async () => {
    const clientA = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const clientB = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const idempotencyKey = `it-conflict-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const businessDate = new Date().toISOString().slice(0, 10);

    const buildCommand = (invoiceNumber: string) => ({
      shop_id: SHOP_1,
      business_date: businessDate,
      idempotency_key: idempotencyKey,
      rows: [
        {
          row_id: "r1",
          invoice_number: invoiceNumber,
          total_dirham: 100,
          received_dirham: 0,
          delivered: false,
          customer: null,
        },
      ],
    });

    const [resultA, resultB] = await Promise.all([
      clientA.rpc("submit_batch", { command: buildCommand(uniqueInvoiceNumber("conflict-a")) }),
      clientB.rpc("submit_batch", { command: buildCommand(uniqueInvoiceNumber("conflict-b")) }),
    ]);

    const successes = [resultA, resultB].filter((r) => r.error === null);
    const conflicts = [resultA, resultB].filter((r) => r.error?.message === "IDEMPOTENCY_CONFLICT");
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    const { count: batchCount } = await clientA
      .from("batches")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .eq("idempotency_key", idempotencyKey);
    expect(batchCount).toBe(1);

    // Only the winning attempt's invoice/registry/audit write set exists —
    // the losing attempt (same key, different fingerprint) wrote nothing,
    // since it was rejected by the existing-row check before any write.
    const winner = successes[0];
    const winningInvoiceNumber = (winner.data.rows as Array<{ invoice_number: string }>)[0].invoice_number;

    const { count: invoiceCount } = await clientA
      .from("invoices")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .eq("invoice_id", winningInvoiceNumber);
    expect(invoiceCount).toBe(1);

    const { count: registryCount } = await clientA
      .from("invoice_number_registry")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .ilike("invoice_number", winningInvoiceNumber);
    expect(registryCount).toBe(1);

    const { count: auditCount } = await clientA
      .from("audit_events")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .eq("entity_type", "batch")
      .eq("entity_id", winner.data.batch_id);
    expect(auditCount).toBe(1);
  });

  it("concurrency: different keys racing on a shared second invoice number yields a real two-row write-loop rollback for the loser", async () => {
    // This test exercises the write-loop's own `unique_violation` catch
    // (design decision 5), not the advisory prevalidation query: each
    // command's row 2 shares a normalized invoice number with the other
    // command's row 2, but that number is brand new to the registry when
    // both commands prevalidate, so prevalidation passes for both and the
    // real unique constraint on invoice_number_registry is what decides
    // the race — genuinely mid-write, inside the per-row insert loop.
    const clientA = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const clientB = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    const businessDate = new Date().toISOString().slice(0, 10);
    const sharedNumber = uniqueInvoiceNumber("race-shared-row2");
    const contenderANumber = uniqueInvoiceNumber("race-contender-a-row1");
    const contenderBNumber = uniqueInvoiceNumber("race-contender-b-row1");
    const contenderAKey = `it-race-a-${sharedNumber}`;
    const contenderBKey = `it-race-b-${sharedNumber}`;
    const contenderACustomerName = `Race Contender A ${sharedNumber}`;
    const contenderBCustomerName = `Race Contender B ${sharedNumber}`;

    const buildCommand = (
      idempotencyKey: string,
      row1InvoiceNumber: string,
      row1CustomerName: string,
      row2InvoiceNumber: string,
    ) => ({
      shop_id: SHOP_1,
      business_date: businessDate,
      idempotency_key: idempotencyKey,
      rows: [
        {
          row_id: "r1",
          invoice_number: row1InvoiceNumber,
          total_dirham: 5000,
          received_dirham: 2000,
          payment_method: "cash",
          delivered: false,
          customer: { type: "quick_add", name: row1CustomerName, mobile: null },
        },
        {
          row_id: "r2",
          invoice_number: row2InvoiceNumber,
          total_dirham: 100,
          received_dirham: 0,
          delivered: false,
          customer: null,
        },
      ],
    });

    const [resultA, resultB] = await Promise.all([
      clientA.rpc("submit_batch", {
        command: buildCommand(contenderAKey, contenderANumber, contenderACustomerName, sharedNumber),
      }),
      clientB.rpc("submit_batch", {
        command: buildCommand(contenderBKey, contenderBNumber, contenderBCustomerName, sharedNumber),
      }),
    ]);

    const results = [
      { key: contenderAKey, result: resultA, contenderNumber: contenderANumber, customerName: contenderACustomerName },
      { key: contenderBKey, result: resultB, contenderNumber: contenderBNumber, customerName: contenderBCustomerName },
    ];
    const winners = results.filter((r) => r.result.error === null);
    const losers = results.filter((r) => r.result.error !== null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const winner = winners[0];
    const loser = losers[0];
    expect(loser.result.error?.message).toBe("BATCH_VALIDATION_FAILED");

    // Loser: prove no batch, contender-specific customer, invoice, payment,
    // registry reservation, or audit event was left behind.
    const { count: loserBatchCount } = await clientA
      .from("batches")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .eq("idempotency_key", loser.key);
    expect(loserBatchCount).toBe(0);

    const { count: loserCustomerCount } = await clientA
      .from("customers")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .eq("name", loser.customerName);
    expect(loserCustomerCount).toBe(0);

    const { count: loserInvoiceCount } = await clientA
      .from("invoices")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .eq("invoice_id", loser.contenderNumber);
    expect(loserInvoiceCount).toBe(0);

    const { count: loserPaymentCount } = await clientA
      .from("payments")
      .select("*, invoices!inner(invoice_id, shop_id)", { count: "exact", head: true })
      .eq("invoices.shop_id", SHOP_1)
      .eq("invoices.invoice_id", loser.contenderNumber);
    expect(loserPaymentCount).toBe(0);

    const { count: loserRegistryCount } = await clientA
      .from("invoice_number_registry")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .ilike("invoice_number", loser.contenderNumber);
    expect(loserRegistryCount).toBe(0);

    const { count: loserAuditCount } = await clientA
      .from("audit_events")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .eq("entity_type", "batch")
      .contains("metadata", { idempotency_key: loser.key });
    expect(loserAuditCount).toBe(0);

    // Winner: prove the complete write set exists exactly once — batch,
    // both invoices, quick-add customer, payments, registry rows, audit event.
    const { count: winnerBatchCount } = await clientA
      .from("batches")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .eq("idempotency_key", winner.key);
    expect(winnerBatchCount).toBe(1);

    const { count: winnerContenderInvoiceCount } = await clientA
      .from("invoices")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .eq("invoice_id", winner.contenderNumber);
    expect(winnerContenderInvoiceCount).toBe(1);

    const { count: sharedInvoiceCount } = await clientA
      .from("invoices")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .eq("invoice_id", sharedNumber);
    expect(sharedInvoiceCount).toBe(1);

    const { count: winnerCustomerCount } = await clientA
      .from("customers")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .eq("name", winner.customerName);
    expect(winnerCustomerCount).toBe(1);

    const { count: winnerPaymentCount } = await clientA
      .from("payments")
      .select("*, invoices!inner(invoice_id, shop_id)", { count: "exact", head: true })
      .eq("invoices.shop_id", SHOP_1)
      .eq("invoices.invoice_id", winner.contenderNumber);
    expect(winnerPaymentCount).toBe(1);

    const { count: winnerContenderRegistryCount } = await clientA
      .from("invoice_number_registry")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .ilike("invoice_number", winner.contenderNumber);
    expect(winnerContenderRegistryCount).toBe(1);

    const { count: sharedRegistryCount } = await clientA
      .from("invoice_number_registry")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .ilike("invoice_number", sharedNumber);
    expect(sharedRegistryCount).toBe(1);

    const { count: winnerAuditCount } = await clientA
      .from("audit_events")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", SHOP_1)
      .eq("entity_type", "batch")
      .contains("metadata", { idempotency_key: winner.key });
    expect(winnerAuditCount).toBe(1);
  });
});
