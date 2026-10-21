import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const OWNER_EMAIL = "owner@shopkhata.local";
const OWNER_PASSWORD = "ShopKhata-Local-Owner-E2E-Only-2026!";
const MANAGER_EMAIL = "manager@shopkhata.local";
const MANAGER_PASSWORD = "ShopKhata-Local-Manager-E2E-Only-2026!";
const STAFF1_EMAIL = "staff1@shopkhata.local";
const STAFF1_PASSWORD = "ShopKhata-Local-E2E-Only-2026!";
const SHOP_1 = "10000000-0000-4000-8000-000000000001";
const MANAGER_ID = "10000000-0000-4000-8000-000000000104";

const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => qatarBusinessDate(new Date());
const entryRow = (patch: Partial<EntryRow>): EntryRow => ({
  rowId: `r-${uid()}`, invoiceId: `IT-SHOP-${Date.now()}-${uid()}`, total: "10.00", received: "", delivered: false, customerId: "", customerName: "", customerMobile: "", ...patch,
});

describe("Shop management (real network, real sessions)", () => {
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

  async function createShop(owner: SupabaseClient, name: string): Promise<string> {
    const { data, error } = await owner.rpc("admin_create_shop", { command: { name } });
    expect(error).toBeNull();
    return data.shop_id as string;
  }

  /** The exact command the New Sale screen builds, sent through the real RPC. */
  async function sell(client: SupabaseClient, shopId: string, rows: EntryRow[], key: string) {
    const input: InvoiceEntryInput = { shopId, businessDate: today(), isBackdated: false, backdatedReason: "", idempotencyKey: key, rows };
    const { command, errors } = prepareInvoiceBatch(input, []);
    expect(errors).toEqual([]);
    return { command, input, result: await client.rpc("submit_batch", { command }) };
  }

  const visibleShopIds = async (client: SupabaseClient) => ((await client.from("shops").select("id")).data ?? []).map((row) => row.id as string);
  const daily = async (client: SupabaseClient, shopId: string) => {
    const { data, error } = await client.rpc("report_daily_summary", { p_shop_id: shopId, p_from: today(), p_to: today() });
    expect(error).toBeNull();
    return (data as { bank_received_dirham: number; cash_received_dirham: number; total_received_dirham: number; invoice_count: number }[])[0];
  };

  it("lets only an owner create and rename shops, and never through a direct write", async () => {
    const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
    const manager = await signIn(MANAGER_EMAIL, MANAGER_PASSWORD);
    const staff = await signIn(STAFF1_EMAIL, STAFF1_PASSWORD);
    for (const client of [manager, staff]) {
      expect((await client.rpc("admin_create_shop", { command: { name: `Denied ${uid()}` } })).error?.message).toBe("INSUFFICIENT_ROLE");
      expect((await client.rpc("admin_update_shop", { command: { shop_id: SHOP_1, name: "Denied" } })).error?.message).toBe("INSUFFICIENT_ROLE");
      expect((await client.from("shops").insert({ name: "Direct" })).error?.code).toBe("42501");
      expect((await client.from("shops").update({ name: "Direct" }).eq("id", SHOP_1)).error?.code).toBe("42501");
    }
    const anon = createClient(credentials.url, credentials.key);
    expect((await anon.rpc("admin_create_shop", { command: { name: "Anon" } })).error?.code).toBe("42501");

    const id = await createShop(owner, `Rename Me ${uid()}`);
    const renamed = await owner.rpc("admin_update_shop", { command: { shop_id: id, name: `Renamed ${uid()}` } });
    expect(renamed.error).toBeNull();
    expect(renamed.data).toMatchObject({ shop_id: id, changed: true });
  });

  it("scopes a draft submission, its idempotency key and its retries to the shop it was created for", async () => {
    const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
    const newShop = await createShop(owner, `Offline Scope ${uid()}`);
    const key = `it-shop-key-${uid()}`;
    const invoiceNumber = `IT-SCOPE-${Date.now()}`;
    const row = entryRow({ invoiceId: invoiceNumber, total: "40.00", received: "40.00", paymentMethod: "bank" });

    // The same idempotency key and invoice number used in two shops are two independent submissions.
    const one = await sell(owner, SHOP_1, [row], key);
    const other = await sell(owner, newShop, [row], key);
    expect(one.result.error).toBeNull();
    expect(other.result.error).toBeNull();
    expect(other.result.data.rows[0].invoice_id).not.toBe(one.result.data.rows[0].invoice_id);

    // Retrying either is an exact replay of its own shop's result: nothing is recorded twice.
    const replayOne = await sell(owner, SHOP_1, [row], key);
    const replayOther = await sell(owner, newShop, [row], key);
    expect(replayOne.result.data.rows[0].invoice_id).toBe(one.result.data.rows[0].invoice_id);
    expect(replayOther.result.data.rows[0].invoice_id).toBe(other.result.data.rows[0].invoice_id);
    const { data: invoices } = await owner.from("invoices").select("shop_id").eq("invoice_id", invoiceNumber);
    expect((invoices ?? []).map((invoice) => invoice.shop_id).sort()).toEqual([SHOP_1, newShop].sort());

    // A stored draft or queued submission for one shop is ignored when read back for another.
    const draft = serializeDraft({ userId: "u1", shopId: SHOP_1, businessDate: today(), today: today(), backdatedReason: "", rows: [row], customers: {}, idempotencyKey: key,
      submission: newSubmission(one.input, new Date().toISOString()), conflict: null, createdAt: new Date().toISOString(), now: new Date().toISOString() });
    expect(normalizeStoredDraft(draft, { userId: "u1", shopId: newShop })).toBeNull();
    expect(normalizeStoredDraft(draft, { userId: "u1", shopId: SHOP_1 })?.submission?.payload.shopId).toBe(SHOP_1);
    // A payload whose shop was swapped after it was queued is not accepted back either.
    expect(normalizeStoredDraft({ ...draft, submission: { ...draft.submission!, payload: { ...draft.submission!.payload, shopId: newShop } } }, { userId: "u1", shopId: SHOP_1 })).toBeNull();
  });

  it("keeps a queued submission on its shop after the shop is renamed", async () => {
    const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
    const shop = await createShop(owner, `Before Rename ${uid()}`);
    const queued = prepareInvoiceBatch({ shopId: shop, businessDate: today(), isBackdated: false, backdatedReason: "", idempotencyKey: `it-queued-${uid()}`, rows: [entryRow({ total: "15.00", received: "5.00" })] }, []).command!;
    expect((await owner.rpc("admin_update_shop", { command: { shop_id: shop, name: `After Rename ${uid()}` } })).error).toBeNull();
    const sent = await owner.rpc("submit_batch", { command: queued });
    expect(sent.error).toBeNull();
    const { data } = await owner.from("invoices").select("shop_id").eq("id", sent.data.rows[0].invoice_id).single();
    expect(data?.shop_id).toBe(shop);
  });

  it("shows managers a new shop only while assigned, and keeps Cash, Bank and sales inside each shop", async () => {
    const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
    const manager = await signIn(MANAGER_EMAIL, MANAGER_PASSWORD);
    const shop = await createShop(owner, `Isolated ${uid()}`);
    const before = await daily(owner, SHOP_1);

    expect(await visibleShopIds(owner)).toContain(shop);
    expect(await visibleShopIds(manager)).not.toContain(shop);
    const blocked = await sell(manager, shop, [entryRow({ total: "10.00" })], `it-blocked-${uid()}`);
    expect(blocked.result.error?.message).toBe("UNAUTHORIZED_SHOP");

    const assign = (assigned: boolean) => owner.rpc("admin_set_shop_assignment", { command: { user_id: MANAGER_ID, shop_id: shop, assigned } });
    expect((await assign(true)).error).toBeNull();
    expect(await visibleShopIds(manager)).toContain(shop);
    const sold = await sell(manager, shop, [entryRow({ total: "30.00", received: "30.00", paymentMethod: "bank" })], `it-shop-bank-${uid()}`);
    expect(sold.result.error).toBeNull();

    expect(await daily(owner, shop)).toMatchObject({ invoice_count: 1, bank_received_dirham: 3000, cash_received_dirham: 0, total_received_dirham: 3000 });
    expect(await daily(owner, SHOP_1)).toEqual(before);

    expect((await assign(false)).error).toBeNull();
    expect(await visibleShopIds(manager)).not.toContain(shop);
    expect((await sell(manager, shop, [entryRow({ total: "10.00" })], `it-revoked-${uid()}`)).result.error?.message).toBe("UNAUTHORIZED_SHOP");
  });
});
