import { execFileSync, spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// OPS-01B slice 1 + remediation on a POPULATED database:
//   35 (20261031165915, production today)
//   -> 36 maintenance guard (20261103140000) -> 37 invoice void (20261103150000)
//   -> 38 historical-sales remediation (20261103190000) -> 39 release compatibility (20261103203806).
// Existing financial history, reports and balances must be unchanged by the upgrade, and a void made on 37 must satisfy
// 38's composite correction FK and report as a movement on its own date.

const RESET_TIMEOUT = 180_000;
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const DB_CONTAINER = "supabase_db_shopkhata";
const V35 = "20261031165915";
const V36_GUARD = "20261103140000";
const V37_VOID = "20261103150000";
const V38_REMEDIATION = "20261103190000";
const V39_COMPAT = "20261103203806";
// Partial delivery (40-43) follows OPS-01B, so "migration up" from 35 or 37 also applies these.
const PARTIAL_DELIVERY = ["20261112090000", "20261112100000", "20261112110000", "20261112120000"];
// The e4f4cfe application's report_sales_totals contract (that app stays in production while 36-39 are applied).
const LEGACY = ["invoice_count", "effective_total_dirham", "effective_paid_dirham", "credit_applied_dirham", "effective_due_dirham", "delivered_count", "undelivered_count"];
const legacy = (from: string, to: string) => `select concat_ws('|', ${LEGACY.map((k) => `s.${k}`).join(", ")}) from public.report_sales_totals('${SHOP}', ${from}, ${to}) s;`;
const SHOP = "10000000-0000-4000-8000-000000000001";
const OWNER = "10000000-0000-4000-8000-000000000101";

function supabase(args: string[]): string {
  const win = process.platform === "win32";
  return execFileSync(win ? (process.env.ComSpec ?? "cmd.exe") : PNPM, win ? ["/d", "/s", "/c", "call", PNPM, "exec", "supabase", "--agent", "no", ...args] : ["exec", "supabase", "--agent", "no", ...args], {
    encoding: "utf-8", timeout: RESET_TIMEOUT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${join(process.cwd(), "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}` },
  });
}
/** Runs SQL as the database owner in Qatar time; returns unaligned output. */
function sql(script: string): string {
  const result = spawnSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", DB_CONTAINER, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1"],
    { input: `set timezone = 'Asia/Qatar';\n${script}`, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout.trim();
}
const asOwner = `select set_config('request.jwt.claims', '{"role":"authenticated","sub":"${OWNER}"}', false) is not null;\nset role authenticated;\n`;

// History spanning several days: corrected invoice, partly paid invoice, payment correction, anonymous invoice, a closed day.
const POPULATE = `
insert into public.customers(id, shop_id, public_id, name) values ('c9000000-0000-4000-8000-000000000001', '${SHOP}', 'CUS-UPG-1', 'Upgrade customer');
insert into public.invoices(id, shop_id, customer_id, invoice_id, total_amount_dirham, business_date, delivered, created_by) values
  ('a9100000-0000-4000-8000-000000000001', '${SHOP}', 'c9000000-0000-4000-8000-000000000001', 'UPG-1', 10000, current_date - 3, true, '${OWNER}'),
  ('a9100000-0000-4000-8000-000000000002', '${SHOP}', 'c9000000-0000-4000-8000-000000000001', 'UPG-2', 7000, current_date - 3, false, '${OWNER}'),
  ('a9100000-0000-4000-8000-000000000003', '${SHOP}', null, 'UPG-3', 4000, current_date - 2, false, '${OWNER}');
insert into public.invoice_number_registry(shop_id, invoice_number, canonical_invoice_id) select shop_id, invoice_id, id from public.invoices where invoice_id like 'UPG-%';
insert into public.payments(id, shop_id, invoice_id, amount_dirham, business_date) values ('b9100000-0000-4000-8000-000000000002', '${SHOP}', 'a9100000-0000-4000-8000-000000000002', 3000, current_date - 2);
insert into public.corrections(shop_id, invoice_id, payment_id, amount_delta_dirham, reason, business_date, created_by, approved_by) values
  ('${SHOP}', 'a9100000-0000-4000-8000-000000000001', null, -1500, 'discount', current_date - 2, '${OWNER}', '${OWNER}'),
  ('${SHOP}', null, 'b9100000-0000-4000-8000-000000000002', -500, 'counted again', current_date - 1, '${OWNER}', '${OWNER}');
insert into public.daily_closes(shop_id, business_date, event_type, actor_id) values ('${SHOP}', current_date - 3, 'closed', '${OWNER}');`;

// Projections that exist on every version and must not move during the upgrade.
const STATE = `select jsonb_build_object(
  'daily', (select jsonb_agg(to_jsonb(d) order by d.business_date) from public.report_daily_summary('${SHOP}', current_date - 3, current_date) d),
  'balances', (select jsonb_agg(to_jsonb(b) order by b.customer_id) from public.customer_financial_balances b where b.shop_id = '${SHOP}'),
  'ledger', (select jsonb_agg(jsonb_build_object('t', l.entry_type, 'd', l.business_date, 'dr', l.debit_dirham, 'cr', l.credit_dirham) order by l.business_date, l.recorded_at, l.sequence_id) from public.customer_ledger l where l.shop_id = '${SHOP}'),
  'invoices', (select jsonb_agg(jsonb_build_object('n', e.original_invoice_number, 't', e.effective_total_dirham, 'p', e.effective_paid_dirham, 'd', e.effective_due_dirham) order by e.original_invoice_number) from public.effective_invoices e where e.shop_id = '${SHOP}'),
  'counts', (select jsonb_build_object('inv', (select count(*) from public.invoices), 'pay', (select count(*) from public.payments), 'cor', (select count(*) from public.corrections), 'audit', (select count(*) from public.audit_events)))
)::text;`;

describe("OPS-01B migrations 36-39 on a populated database (35 -> 39)", () => {
  beforeAll(() => { supabase(["migration", "list", "--local"]); }, 60_000);
  afterAll(() => { supabase(["db", "reset", "--local"]); }, RESET_TIMEOUT);

  it("35 -> 43 applies exactly migrations 36-43, keeps every existing figure, then a void preserves history and nets to zero", () => {
    supabase(["db", "reset", "--local", "--version", V35]);
    sql(POPULATE);
    const before = sql(STATE);
    const legacyRange = sql(legacy("current_date - 3", "current_date"));
    const legacyToday = sql(legacy("current_date", "current_date"));
    supabase(["migration", "up", "--local"]);
    // The four OPS-01B versions then the four partial-delivery versions, in order, and nothing else after 35.
    expect(sql(`select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations where version > '${V35}'`)).toBe([V36_GUARD, V37_VOID, V38_REMEDIATION, V39_COMPAT, ...PARTIAL_DELIVERY].join(","));
    expect(sql("select count(*) from supabase_migrations.schema_migrations")).toBe("43");
    // 36 installed the guard OFF: upgrading a populated database does not put it into maintenance or write audit rows.
    expect(sql("select enabled::text || ':' || (select count(*) from public.audit_events where entity_type = 'system_maintenance') from private.system_maintenance")).toBe("false:0");
    expect(sql(STATE)).toBe(before);
    // The old app's contract is intact: same fields, same values wherever no correction crosses the window edge.
    expect(sql(legacy("current_date - 3", "current_date"))).toBe(legacyRange);
    expect(sql(legacy("current_date", "current_date"))).toBe(legacyToday);
    // The -15 discount dated D-2 no longer restates D-3 for the old app either (business-date sales, no historical rewrite).
    expect(sql(`select effective_total_dirham || '|' || net_sales_dirham from public.report_sales_totals('${SHOP}', current_date - 3, current_date - 3);`)).toBe("17000|17000");
    // Sales totals now reconcile with Daily Close for the populated range.
    expect(sql(`select array[s.gross_sales_dirham, s.sales_corrections_dirham] = (select array[sum(gross_invoice_dirham)::bigint, sum(invoice_corrections_dirham)::bigint] from public.report_daily_summary('${SHOP}', current_date - 3, current_date)) from public.report_sales_totals('${SHOP}', current_date - 3, current_date) s;`)).toBe("t");

    const d3 = sql(`select to_jsonb(d)::text from public.report_daily_summary('${SHOP}', current_date - 3, current_date - 3) d;`);
    const s3 = sql(`select array[gross_sales_dirham, sales_corrections_dirham, net_sales_dirham]::text from public.report_sales_totals('${SHOP}', current_date - 3, current_date - 3);`);
    expect(s3).toBe("{17000,0,17000}");
    sql(`${asOwner}select public.void_invoice('{"shop_id":"${SHOP}","invoice_id":"a9100000-0000-4000-8000-000000000001","reason":"Upgrade test void","idempotency_key":"upg-void-1"}');`);
    // The closed original day is untouched; the void is today's -85 (100 - 15).
    expect(sql(`select to_jsonb(d)::text from public.report_daily_summary('${SHOP}', current_date - 3, current_date - 3) d;`)).toBe(d3);
    expect(sql(`select array[gross_sales_dirham, sales_corrections_dirham, net_sales_dirham]::text from public.report_sales_totals('${SHOP}', current_date - 3, current_date - 3);`)).toBe(s3);
    expect(sql(`select sales_corrections_dirham from public.report_sales_totals('${SHOP}', current_date, current_date);`)).toBe("-8500");
    expect(sql(`select sum(amount_dirham) from public.sales_movements where invoice_id = 'a9100000-0000-4000-8000-000000000001';`)).toBe("0");
    expect(sql(`select concat_ws('|', effective_total_dirham, is_void) from public.effective_invoices where canonical_invoice_id = 'a9100000-0000-4000-8000-000000000001';`)).toBe("0|t");
  });

  it("a void made on 37 survives 38 and 39: composite FK validates and the void reports on its own date", () => {
    supabase(["db", "reset", "--local", "--version", V37_VOID]);
    sql(POPULATE);
    sql(`${asOwner}select public.void_invoice('{"shop_id":"${SHOP}","invoice_id":"a9100000-0000-4000-8000-000000000003","reason":"Voided before the remediation","idempotency_key":"upg-void-37"}');`);
    const before = sql(STATE);
    supabase(["migration", "up", "--local"]);
    expect(sql(`select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations where version > '${V37_VOID}'`)).toBe([V38_REMEDIATION, V39_COMPAT, ...PARTIAL_DELIVERY].join(","));
    expect(sql(STATE)).toBe(before);
    expect(sql(`select convalidated from pg_constraint where conname = 'invoice_voids_correction_fkey';`)).toBe("t");
    expect(sql(`select string_agg(movement_type || ':' || amount_dirham || ':' || (business_date = current_date), ',' order by business_date) from public.sales_movements where invoice_id = 'a9100000-0000-4000-8000-000000000003';`))
      .toBe("sale:4000:false,invoice_void:-4000:true");
    expect(sql(`select array[gross_sales_dirham, sales_corrections_dirham, net_sales_dirham]::text from public.report_sales_totals('${SHOP}', current_date - 2, current_date - 2);`)).toBe("{4000,-1500,2500}");
    expect(sql(`select to_regprocedure('public.report_dashboard_snapshot(uuid,date,date,uuid[])') is null;`)).toBe("t");
  });
});
