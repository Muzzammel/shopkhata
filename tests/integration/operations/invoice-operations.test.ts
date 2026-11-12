import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { resetLocal } from "./release-helpers";

// Hook budget: the prerequisite check (<= 30 s) + RESET_BUDGET (lease, image checks, reset, kill confirmation and lease
// release all inside it; scripts/local-reset.mjs) + 30 s slack. A hook that still times out leaves the lease held.
const SUITE_TIMEOUT = 210_000;
const RESET_BUDGET = 150_000;
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

const SHOP1 = "10000000-0000-4000-8000-000000000001";
const SHOP2 = "10000000-0000-4000-8000-000000000002";
const key = () => crypto.randomUUID();

describe("complete invoice operations through real authenticated Supabase", () => {
  let staff: SupabaseClient;
  let owner: SupabaseClient;
  let manager: SupabaseClient;
  beforeAll(async () => {
    if (!isSupabaseRunning()) throw new Error("Prerequisite: local Supabase must be running.");
    await resetLocal([], { timeoutMs: RESET_BUDGET });
    const env = parseEnv(runSupabase(["status", "-o", "env"], 30_000));
    async function login(email: string, password: string) {
      const c = createClient(env.API_URL, env.PUBLISHABLE_KEY ?? env.ANON_KEY);
      const { error } = await c.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return c;
    }
    staff = await login("staff1@shopkhata.local", "ShopKhata-Local-E2E-Only-2026!");
    owner = await login("owner@shopkhata.local", "ShopKhata-Local-Owner-E2E-Only-2026!");
    manager = await login("manager@shopkhata.local", "ShopKhata-Local-Manager-E2E-Only-2026!");
  }, SUITE_TIMEOUT);

  async function create(client = staff, shop = SHOP1, number = "OPS-" + key(), total = 10000, customerName?: string) {
    const { data, error } = await client.rpc("submit_batch", { command: {
      shop_id: shop, business_date: qatarBusinessDate(new Date()), idempotency_key: key(),
      rows: [{ row_id: "r1", invoice_number: number, total_dirham: total, received_dirham: 0, payment_method: "cash", delivered: false, customer: customerName ? { type: "quick_add", name: customerName, mobile: null } : null }],
    } });
    expect(error).toBeNull(); expect(data.ok).toBe(true);
    const { data: i, error: readError } = await client.from("effective_invoices").select("*").eq("shop_id",shop).eq("original_invoice_number",number).single();
    expect(readError).toBeNull(); return i;
  }
  const financial = (i: string, delta = -1000) => ({ shop_id: SHOP1, invoice_id: i, payment_id: null, amount_delta_dirham: delta, reason: "Fix total", idempotency_key: key() });
  const replacement = (i: string, number: string, revision = 0) => ({ shop_id: SHOP1, invoice_id: i, invoice_number: number, expected_revision: revision, customer_id: null, delivered: false, reason: "Fix number", idempotency_key: key() });
  const decision = (request_id: string, revision = 0, outcome = "approved") => ({ shop_id: SHOP1, request_id, expected_revision: revision, decision: outcome, reason: null, idempotency_key: key() });
  async function request(rpc: string, command: object) {
    const r = await staff.rpc(rpc, { command }); expect(r.error).toBeNull(); return r.data.request_id as string;
  }

  it("records a follow-up payment then approves a correction exactly once", async () => {
    const i = await create();
    const command = { shop_id: SHOP1, invoice_id: i.canonical_invoice_id, amount_dirham: 2000, payment_method: "cash", business_date: qatarBusinessDate(new Date()), idempotency_key: key() };
    const paid = await staff.rpc("record_payment", { command }); expect(paid.error).toBeNull();
    expect((await staff.rpc("record_payment", { command })).data).toEqual(paid.data);
    const rid = await request("request_invoice_correction",financial(i.canonical_invoice_id));
    const cmd = decision(rid);
    const approved = await manager.rpc("decide_invoice_correction", { command: cmd }); expect(approved.error).toBeNull();
    expect((await manager.rpc("decide_invoice_correction", { command: cmd })).data).toEqual(approved.data);
    const { data } = await staff.from("effective_invoices").select("*").eq("canonical_invoice_id",i.canonical_invoice_id).single();
    expect(data.effective_total_dirham).toBe(9000); expect(data.effective_paid_dirham).toBe(2000); expect(data.effective_due_dirham).toBe(7000);
  });

  it("corrects a payment through the append-only ledger and rejects invalid corrected payments", async () => {
    const i=await create();
    const p=await staff.rpc("record_payment",{command:{shop_id:SHOP1,invoice_id:i.canonical_invoice_id,amount_dirham:2000,payment_method:"cash",business_date:qatarBusinessDate(new Date()),idempotency_key:key()}});
    const rid=await request("request_invoice_correction",{...financial(i.canonical_invoice_id, -500),payment_id:p.data.payment_id});
    expect((await owner.rpc("decide_invoice_correction",{command:decision(rid)})).error).toBeNull();
    const bad=await request("request_invoice_correction",{...financial(i.canonical_invoice_id, -2000),payment_id:p.data.payment_id});
    expect((await owner.rpc("decide_invoice_correction",{command:decision(bad)})).error?.message).toBe("INVALID_FINANCIAL_RESULT");
    const {data}=await staff.from("effective_invoices").select("*").eq("canonical_invoice_id",i.canonical_invoice_id).single();
    expect(data.effective_paid_dirham).toBe(1500); expect(data.effective_due_dirham).toBe(8500);
  });

  it("reserves current and historical numbers, supports same number in another shop, and blocks duplicates", async () => {
    const i = await create(); const number="NEW-"+key();
    const cmd=replacement(i.canonical_invoice_id,number); const rid=await request("request_invoice_replacement",cmd);
    expect((await staff.rpc("request_invoice_replacement",{command:cmd})).data.request_id).toBe(rid);
    const d=decision(rid); const approved=await owner.rpc("decide_invoice_replacement",{command:d}); expect(approved.error).toBeNull();
    expect((await owner.rpc("decide_invoice_replacement",{command:d})).data).toEqual(approved.data);
    for(const n of [i.original_invoice_number,number]) {
      const {data:r,error}=await staff.from("invoice_number_registry").select("canonical_invoice_id").eq("shop_id",SHOP1).eq("normalized_invoice_number",n.toLowerCase()).single();
      expect(error).toBeNull(); expect(r?.canonical_invoice_id).toBe(i.canonical_invoice_id);
      const duplicate=await staff.rpc("submit_batch",{command:{shop_id:SHOP1,business_date:qatarBusinessDate(new Date()),idempotency_key:key(),rows:[{row_id:"r1",invoice_number:n,total_dirham:100,received_dirham:0,payment_method:"cash",delivered:false,customer:null}]}});
      expect(duplicate.error).not.toBeNull();
    }
    const other=await create(owner,SHOP2,number); expect(other.shop_id).toBe(SHOP2);
    const {data}=await staff.from("effective_invoices").select("*").eq("canonical_invoice_id",i.canonical_invoice_id).single();
    expect(data.revision).toBe(1); expect(data.effective_invoice_number).toBe(number); expect(data.original_invoice_number).toBe(i.original_invoice_number);
  });

  it("serializes racing replacement approvals into one linear revision", async () => {
    const i=await create();
    const a=await request("request_invoice_replacement",replacement(i.canonical_invoice_id,"A-"+key()));
    const b=await request("request_invoice_replacement",replacement(i.canonical_invoice_id,"B-"+key()));
    const results=await Promise.all([owner.rpc("decide_invoice_replacement",{command:decision(a)}),manager.rpc("decide_invoice_replacement",{command:decision(b)})]);
    expect(results.filter(r=>r.error===null)).toHaveLength(1); expect(results.find(r=>r.error)?.error?.message).toBe("STALE_REVISION");
    const {data}=await staff.from("replacement_decisions").select("*").eq("invoice_id",i.canonical_invoice_id); expect(data).toHaveLength(1);
  });

  it("serializes racing approvals/rejections of one request and prevents contradictory decisions", async () => {
    const i=await create(); const rid=await request("request_invoice_correction",financial(i.canonical_invoice_id));
    const results=await Promise.all([owner.rpc("decide_invoice_correction",{command:decision(rid)}),manager.rpc("decide_invoice_correction",{command:decision(rid,0,"rejected")})]);
    expect(results.filter(r=>r.error===null)).toHaveLength(1); expect(results.find(r=>r.error)?.error?.message).toBe("ALREADY_DECIDED");
  });

  it("safely races two invoices reserving the same normalized number", async () => {
    const a=await create(); const b=await create(); const number="RACE-"+key();
    const ar=await request("request_invoice_replacement",replacement(a.canonical_invoice_id,number));
    const br=await request("request_invoice_replacement",replacement(b.canonical_invoice_id,number.toLowerCase()));
    const results=await Promise.all([owner.rpc("decide_invoice_replacement",{command:decision(ar)}),manager.rpc("decide_invoice_replacement",{command:decision(br)})]);
    expect(results.filter(r=>r.error===null)).toHaveLength(1); expect(results.find(r=>r.error)?.error?.message).toBe("NUMBER_ALREADY_REGISTERED");
  });

  it("returns one decision and one audit event for concurrent exact retry", async () => {
    const i=await create(); const rid=await request("request_invoice_replacement",replacement(i.canonical_invoice_id,"RETRY-"+key()));
    const cmd=decision(rid); const rs=await Promise.all([owner.rpc("decide_invoice_replacement",{command:cmd}),owner.rpc("decide_invoice_replacement",{command:cmd})]);
    expect(rs.every(r=>r.error===null)).toBe(true); expect(rs[0].data).toEqual(rs[1].data);
    const {data}=await owner.from("audit_events").select("*").eq("entity_id",i.canonical_invoice_id).eq("action","replacement.decide"); expect(data).toHaveLength(1);
  });

  it("enforces staff approval denial, shop isolation, direct write denial and actor fingerprints", async () => {
    const i=await create(); const cmd=replacement(i.canonical_invoice_id,"AUTH-"+key()); const rid=await request("request_invoice_replacement",cmd);
    expect((await staff.rpc("decide_invoice_replacement",{command:decision(rid)})).error?.message).toBe("INSUFFICIENT_ROLE");
    expect((await manager.rpc("request_invoice_replacement",{command:cmd})).error?.message).toBe("IDEMPOTENCY_CONFLICT");
    const other=await create(owner,SHOP2);
    expect((await staff.from("effective_invoices").select("*").eq("canonical_invoice_id",other.canonical_invoice_id)).data).toEqual([]);
    expect((await staff.rpc("request_invoice_replacement",{command:{...cmd,shop_id:SHOP2,invoice_id:other.canonical_invoice_id,idempotency_key:key()}})).error?.message).toBe("UNAUTHORIZED_SHOP");
    expect((await staff.rpc("request_invoice_correction",{command:{...financial(other.canonical_invoice_id),shop_id:SHOP2}})).error?.message).toBe("UNAUTHORIZED_SHOP");
    expect((await staff.from("replacement_requests").insert({shop_id:SHOP1})).error).not.toBeNull();
    expect((await staff.from("replacement_decisions").insert({shop_id:SHOP1})).error).not.toBeNull();
  });

  it("uses the effective customer for new governed credits while retaining original credit and replay", async () => {
    const i = await create(staff, SHOP1, "CREDIT-" + key(), 10000, "Original credit customer " + key());
    const other = await create(staff, SHOP1, "CUSTOMER-" + key(), 10000, "Effective credit customer " + key());
    const command = { shop_id: SHOP1, invoice_id: i.canonical_invoice_id, amount_dirham: 13000, payment_method: "cash", business_date: qatarBusinessDate(new Date()), reason: "Approved excess", idempotency_key: key() };
    const original = await manager.rpc("approve_overpayment", { command });
    expect(original.error).toBeNull(); expect(original.data.customer_id).toBe(i.effective_customer_id);
    const req = { ...replacement(i.canonical_invoice_id, "CREDIT-NEW-" + key()), customer_id: other.effective_customer_id, delivered: true };
    const requested = await manager.rpc("request_invoice_replacement", { command: req });
    expect(requested.error).toBeNull();
    expect((await manager.rpc("decide_invoice_replacement", { command: decision(requested.data.request_id) })).error).toBeNull();
    expect((await manager.rpc("approve_overpayment", { command })).data).toEqual(original.data);
    const newer = await manager.rpc("approve_overpayment", { command: { ...command, amount_dirham: 500, idempotency_key: key() } });
    expect(newer.error).toBeNull(); expect(newer.data.customer_id).toBe(other.effective_customer_id);
    const credits = await manager.from("customer_credits").select("customer_id, amount_dirham").eq("invoice_id", i.canonical_invoice_id).order("amount_dirham");
    expect(credits.data).toEqual([{ customer_id: other.effective_customer_id, amount_dirham: 500 }, { customer_id: i.effective_customer_id, amount_dirham: 3000 }]);
    const effective = await staff.from("effective_invoices").select("*").eq("canonical_invoice_id", i.canonical_invoice_id).single();
    expect(effective.data.effective_due_dirham).toBe(0); expect(effective.data.effective_paid_dirham).toBe(10000);
  });

  // --- Corrected-total corrections: the request states the total the invoice should have. ---
  const corrected = (i: string, expected: number, total: number) => ({ shop_id: SHOP1, invoice_id: i, payment_id: null, expected_total_dirham: expected, corrected_total_dirham: total, reason: "Fix total", idempotency_key: key() });
  const effectiveOf = async (i: string) => (await staff.from("effective_invoices").select("*").eq("canonical_invoice_id", i).single()).data;
  const pay = async (i: string, amount: number) => expect((await staff.rpc("record_payment", { command: { shop_id: SHOP1, invoice_id: i, amount_dirham: amount, payment_method: "cash", business_date: qatarBusinessDate(new Date()), idempotency_key: key() } })).error).toBeNull();

  it("corrects 1000 to exactly 1500, not 2500, idempotently, leaving the original invoice and history unchanged", async () => {
    const i = await create(staff, SHOP1, "TOTAL-UP-" + key(), 100000, "Total correction customer " + key());
    const id = i.canonical_invoice_id as string;
    await pay(id, 40000);
    const original = (await staff.from("invoices").select("*").eq("id", id).single()).data;

    const cmd = corrected(id, 100000, 150000);
    const first = await staff.rpc("request_invoice_correction", { command: cmd }); expect(first.error).toBeNull();
    // An exact retry returns the same request and stores nothing more.
    expect((await staff.rpc("request_invoice_correction", { command: cmd })).data).toEqual(first.data);
    const requests = await staff.from("correction_requests").select("*").eq("invoice_id", id);
    expect(requests.data).toHaveLength(1);
    // The database derived the delta itself: +500.00, not the +1500.00 the old screen would have sent.
    expect(requests.data![0]).toMatchObject({ expected_total_dirham: 100000, corrected_total_dirham: 150000, amount_delta_dirham: 50000, payment_id: null });
    // The same key with a different total is a conflict, never a second request.
    expect((await staff.rpc("request_invoice_correction", { command: { ...cmd, corrected_total_dirham: 160000 } })).error?.message).toBe("IDEMPOTENCY_CONFLICT");
    // Nothing takes effect before approval.
    expect((await effectiveOf(id)).effective_total_dirham).toBe(100000);

    const d = decision(first.data.request_id);
    const approved = await manager.rpc("decide_invoice_correction", { command: d }); expect(approved.error).toBeNull();
    expect((await manager.rpc("decide_invoice_correction", { command: d })).data).toEqual(approved.data);

    const after = await effectiveOf(id);
    expect(after.effective_total_dirham).toBe(150000);
    expect(after.effective_paid_dirham).toBe(40000);
    expect(after.effective_due_dirham).toBe(110000);
    // Exactly one ledger row, and the committed invoice and request rows are untouched.
    const ledger = await staff.from("corrections").select("amount_delta_dirham, request_id").eq("invoice_id", id);
    expect(ledger.data).toEqual([{ amount_delta_dirham: 50000, request_id: first.data.request_id }]);
    expect((await staff.from("invoices").select("*").eq("id", id).single()).data).toEqual(original);
    expect(original.total_amount_dirham).toBe(100000);
    expect((await staff.from("correction_requests").select("*").eq("invoice_id", id)).data).toEqual(requests.data);
    expect((await owner.from("correction_requests").update({ corrected_total_dirham: 1 }).eq("id", first.data.request_id).select()).data ?? []).toEqual([]);
    expect((await owner.from("correction_requests").delete().eq("id", first.data.request_id).select()).data ?? []).toEqual([]);
    expect((await staff.from("correction_requests").select("corrected_total_dirham").eq("id", first.data.request_id).single()).data).toEqual({ corrected_total_dirham: 150000 });

    // Every projection that reports this invoice agrees with the corrected total.
    const balance = await staff.from("customer_financial_balances").select("outstanding_due_dirham").eq("customer_id", after.effective_customer_id).single();
    expect(balance.data?.outstanding_due_dirham).toBe(110000);
    const entries = await staff.from("customer_ledger").select("debit_dirham, credit_dirham").eq("customer_id", after.effective_customer_id);
    expect(entries.error).toBeNull();
    expect(entries.data!.reduce((sum, row) => sum + row.debit_dirham - row.credit_dirham, 0)).toBe(110000);
    expect((await staff.from("invoice_effective_balances").select("effective_total_dirham, effective_due_dirham").eq("canonical_invoice_id", id).single()).data).toEqual({ effective_total_dirham: 150000, effective_due_dirham: 110000 });
  });

  it("corrects 1500 down to exactly 1000", async () => {
    const i = await create(staff, SHOP1, "TOTAL-DOWN-" + key(), 150000);
    const id = i.canonical_invoice_id as string;
    await pay(id, 100000);
    const rid = await request("request_invoice_correction", corrected(id, 150000, 100000));
    expect((await staff.from("correction_requests").select("amount_delta_dirham").eq("id", rid).single()).data).toEqual({ amount_delta_dirham: -50000 });
    expect((await owner.rpc("decide_invoice_correction", { command: decision(rid) })).error).toBeNull();
    const after = await effectiveOf(id);
    expect(after.effective_total_dirham).toBe(100000); expect(after.effective_paid_dirham).toBe(100000); expect(after.effective_due_dirham).toBe(0);
  });

  it("refuses a corrected total that would leave an invalid paid or due state, at request and again at approval", async () => {
    const i = await create(staff, SHOP1, "TOTAL-BAD-" + key(), 100000);
    const id = i.canonical_invoice_id as string;
    await pay(id, 40000);
    const refuse = async (command: object, message: string) => expect((await staff.rpc("request_invoice_correction", { command })).error?.message).toBe(message);
    await refuse(corrected(id, 100000, 39999), "INVALID_FINANCIAL_RESULT");   // total below what is already paid
    await refuse(corrected(id, 100000, 100000), "CORRECTION_NO_CHANGE");
    await refuse(corrected(id, 90000, 150000), "STALE_TOTAL");                // the client's idea of the current total is wrong
    await refuse({ ...corrected(id, 100000, 150000), corrected_total_dirham: -1 }, "INVALID_REQUEST");
    await refuse({ ...corrected(id, 100000, 150000), corrected_total_dirham: 1500.5 }, "INVALID_REQUEST");
    await refuse({ ...corrected(id, 100000, 150000), amount_delta_dirham: 50000 }, "INVALID_REQUEST");   // never both
    const { expected_total_dirham: _expected, ...withoutExpected } = corrected(id, 100000, 150000); void _expected;
    await refuse(withoutExpected, "INVALID_REQUEST");
    const payment = (await staff.from("payments").select("id").eq("invoice_id", id).single()).data!;
    await refuse({ ...corrected(id, 100000, 150000), payment_id: payment.id }, "INVALID_REQUEST");
    expect((await staff.from("correction_requests").select("id").eq("invoice_id", id)).data).toEqual([]);

    // Valid when requested (paid 400, corrected total 500), invalid by the time it is approved (paid 600).
    const rid = await request("request_invoice_correction", corrected(id, 100000, 50000));
    await pay(id, 20000);
    expect((await owner.rpc("decide_invoice_correction", { command: decision(rid) })).error?.message).toBe("INVALID_FINANCIAL_RESULT");
    const after = await effectiveOf(id);
    expect(after.effective_total_dirham).toBe(100000); expect(after.effective_paid_dirham).toBe(60000); expect(after.effective_due_dirham).toBe(40000);
    expect((await staff.from("corrections").select("id").eq("invoice_id", id)).data).toEqual([]);
  });

  it("never stacks two corrected-total requests: the second is stale once the first is approved", async () => {
    const i = await create(staff, SHOP1, "TOTAL-STALE-" + key(), 100000);
    const id = i.canonical_invoice_id as string;
    const a = await request("request_invoice_correction", corrected(id, 100000, 150000));
    const b = await request("request_invoice_correction", corrected(id, 100000, 120000));
    expect((await owner.rpc("decide_invoice_correction", { command: decision(a) })).error).toBeNull();
    // Approving b as a delta would have produced 1700. It is refused instead and the total stays 1500.
    expect((await owner.rpc("decide_invoice_correction", { command: decision(b) })).error?.message).toBe("STALE_TOTAL");
    expect((await effectiveOf(id)).effective_total_dirham).toBe(150000);
    // A stale request can still be closed by rejecting it.
    expect((await owner.rpc("decide_invoice_correction", { command: decision(b, 0, "rejected") })).error).toBeNull();
    expect((await effectiveOf(id)).effective_total_dirham).toBe(150000);
    expect((await staff.from("corrections").select("amount_delta_dirham").eq("invoice_id", id)).data).toEqual([{ amount_delta_dirham: 50000 }]);
  });
});
