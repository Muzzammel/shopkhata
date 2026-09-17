import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const SUITE_TIMEOUT = 120_000;
const QUERY_TIMEOUT = 60_000;
const RESET_TIMEOUT = 90_000;

const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

type CommandFailure = Error & {
  stdout?: string;
  stderr?: string;
};

/**
 * Execute a command via the cross-platform pnpm executable.
 * Captures stdout/stderr and re-throws with combined output on failure.
 */
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
    const combined = [
      failure.message ?? "",
      failure.stdout ?? "",
      failure.stderr ?? "",
    ].join("\n");
    const wrapped = new Error(
      `Command failed: ${PNPM} ${args.join(" ")}\n${combined}`,
    ) as CommandFailure;
    wrapped.stdout = failure.stdout ?? "";
    wrapped.stderr = failure.stderr ?? "";
    throw wrapped;
  }
}

/**
 * Execute a Supabase CLI command with automatic agent detection disabled.
 * The Supabase CLI defaults to `--agent auto`, which wraps JSON query
 * results as `{ boundary, rows, warning }` under the Vitest/agent
 * environment instead of returning a top-level array. Forcing
 * `--agent no` keeps CLI output consistent regardless of the calling
 * environment.
 */
function runSupabase(args: string[], timeout: number): string {
  return run(["exec", "supabase", "--agent", "no", ...args], timeout);
}

function isSupabaseRunning(): boolean {
  try {
    runSupabase(
      ["migration", "list", "--local"],
      30_000,
    );
    return true;
  } catch {
    return false;
  }
}

function executeSql(sql: string): void {
  const tmpFile = join(
    process.cwd(),
    `tmp_upgrade_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`,
  );
  try {
    writeFileSync(tmpFile, sql, "utf-8");
    runSupabase(
      ["db", "query", "--local", "-f", tmpFile],
      QUERY_TIMEOUT,
    );
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {}
  }
}

function queryRows<T>(sql: string): T[] {
  const tmpFile = join(
    process.cwd(),
    `tmp_upgrade_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`,
  );
  try {
    writeFileSync(tmpFile, sql, "utf-8");
    const output = runSupabase(
      ["db", "query", "--local", "--output", "json", "-f", tmpFile],
      QUERY_TIMEOUT,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch (err: unknown) {
      throw new Error(
        `Failed to parse JSON output from supabase db query --output json: ${(err as Error).message}\nRaw output:\n${output}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new TypeError(
        `Expected a top-level JSON array from supabase db query --output json, got: ${typeof parsed}`,
      );
    }
    return parsed as T[];
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {}
  }
}

describe("invoice-number registry backfill", () => {
  let supabaseAvailable = false;

  beforeAll(() => {
    if (!isSupabaseRunning()) {
      throw new Error(
        "Prerequisite: local Supabase must be running. Start it with: pnpm.cmd exec supabase start --local",
      );
    }
    supabaseAvailable = true;
  });

  afterAll(() => {
    if (!supabaseAvailable) return;
    runSupabase(["db", "reset", "--local"], RESET_TIMEOUT);
  }, SUITE_TIMEOUT);

  it(
    "registers every pre-existing invoice number with no gaps",
    () => {
      // 1. Reset to the version immediately before this migration
      runSupabase(
        ["db", "reset", "--local", "--version", "20260916120100"],
        RESET_TIMEOUT,
      );

      // 2. Insert representative pre-existing invoices directly (two shops, distinct numbers)
      executeSql(`
        insert into public.batches (id, shop_id, business_date, created_by)
        values ('c1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', current_date, '10000000-0000-4000-8000-000000000101');
      `);
      executeSql(`
        insert into public.invoices (id, shop_id, batch_id, invoice_id, total_amount_dirham, business_date)
        values
          ('c2000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'PRE-EXISTING-1', 500, current_date),
          ('c2000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', null, 'PRE-EXISTING-1', 700, current_date);
      `);

      // 3. Apply the registry migration
      runSupabase(["migration", "up", "--local"], RESET_TIMEOUT);

      // 4. Verify backfill: both invoices registered, keyed correctly per shop
      const rows = queryRows<{ shop_id: string; invoice_number: string; canonical_invoice_id: string }>(`
        select shop_id, invoice_number, canonical_invoice_id
        from public.invoice_number_registry
        where canonical_invoice_id in (
          'c2000000-0000-4000-8000-000000000001',
          'c2000000-0000-4000-8000-000000000002'
        )
        order by shop_id;
      `);
      expect(rows).toEqual([
        { shop_id: "10000000-0000-4000-8000-000000000001", invoice_number: "PRE-EXISTING-1", canonical_invoice_id: "c2000000-0000-4000-8000-000000000001" },
        { shop_id: "10000000-0000-4000-8000-000000000002", invoice_number: "PRE-EXISTING-1", canonical_invoice_id: "c2000000-0000-4000-8000-000000000002" },
      ]);
    },
    SUITE_TIMEOUT,
  );

  it(
    "refuses to backfill when two pre-existing invoices in the same shop collide after normalization",
    () => {
      // 1. Reset to the version immediately before this migration
      runSupabase(
        ["db", "reset", "--local", "--version", "20260916120100"],
        RESET_TIMEOUT,
      );

      // 2. Insert two same-shop invoices whose numbers differ only by case/whitespace
      executeSql(`
        insert into public.batches (id, shop_id, business_date, created_by)
        values ('c3000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', current_date, '10000000-0000-4000-8000-000000000101');
      `);
      executeSql(`
        insert into public.invoices (id, shop_id, batch_id, invoice_id, total_amount_dirham, business_date)
        values
          ('c4000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'DUP-1', 500, current_date),
          ('c4000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', ' dup-1 ', 300, current_date);
      `);

      // 3. Attempt to apply the registry migration and assert the preflight diagnostic
      let failed = false;
      let failureOutput = "";
      try {
        runSupabase(["migration", "up", "--local"], RESET_TIMEOUT);
      } catch (err: unknown) {
        const failure = err as CommandFailure;
        failed = true;
        failureOutput = `${failure.message || ""} ${failure.stderr || ""} ${failure.stdout || ""}`;
      }

      expect(failed).toBe(true);
      expect(failureOutput).toMatch(
        /preflight failed: found \d+ same-shop invoice-number collision/i,
      );

      // The whole migration file runs as one transaction, so a preflight
      // failure rolls back CREATE TABLE along with everything else — the
      // table never existed after this failure. Querying it directly would
      // itself raise "relation does not exist" instead of proving anything;
      // to_regclass is the safe way to assert absence, and we assert its
      // "is null" form directly rather than negating an "is not null" check.
      const registryTableAbsent = queryRows<{ absent: boolean }>(`
        select to_regclass('public.invoice_number_registry') is null as absent;
      `);
      expect(registryTableAbsent[0].absent).toBe(true);

      const migrationApplied = queryRows<{ applied: boolean }>(`
        select exists (
          select 1 from supabase_migrations.schema_migrations
          where version = '20260916120200'
        ) as applied;
      `);
      expect(migrationApplied[0].applied).toBe(false);

      // The two original invoice fixtures are untouched by the rolled-back
      // migration attempt (they were committed by the earlier executeSql
      // call, before the migration was even attempted).
      const invoiceRows = queryRows<{ id: string; invoice_id: string }>(`
        select id, invoice_id
        from public.invoices
        where id in (
          'c4000000-0000-4000-8000-000000000001',
          'c4000000-0000-4000-8000-000000000002'
        )
        order by id;
      `);
      expect(invoiceRows).toEqual([
        { id: "c4000000-0000-4000-8000-000000000001", invoice_id: "DUP-1" },
        { id: "c4000000-0000-4000-8000-000000000002", invoice_id: " dup-1 " },
      ]);
    },
    SUITE_TIMEOUT,
  );

  it(
    "refuses to backfill when a pre-existing invoice has a null-equivalent (blank-after-trim) invoice_id",
    () => {
      // 1. Reset to the version immediately before this migration
      runSupabase(
        ["db", "reset", "--local", "--version", "20260916120100"],
        RESET_TIMEOUT,
      );

      // 2. Insert one invoice whose number is blank after trimming
      executeSql(`
        insert into public.batches (id, shop_id, business_date, created_by)
        values ('c5000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', current_date, '10000000-0000-4000-8000-000000000101');
      `);
      executeSql(`
        insert into public.invoices (id, shop_id, batch_id, invoice_id, total_amount_dirham, business_date)
        values ('c6000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', '   ', 500, current_date);
      `);

      // 3. Attempt to apply the registry migration and assert the preflight diagnostic
      let failed = false;
      let failureOutput = "";
      try {
        runSupabase(["migration", "up", "--local"], RESET_TIMEOUT);
      } catch (err: unknown) {
        const failure = err as CommandFailure;
        failed = true;
        failureOutput = `${failure.message || ""} ${failure.stderr || ""} ${failure.stdout || ""}`;
      }

      expect(failed).toBe(true);
      expect(failureOutput).toMatch(
        /preflight failed: found \d+ existing invoice\(s\) with a null-equivalent/i,
      );

      const registryTableAbsent = queryRows<{ absent: boolean }>(`
        select to_regclass('public.invoice_number_registry') is null as absent;
      `);
      expect(registryTableAbsent[0].absent).toBe(true);

      const migrationApplied = queryRows<{ applied: boolean }>(`
        select exists (
          select 1 from supabase_migrations.schema_migrations
          where version = '20260916120200'
        ) as applied;
      `);
      expect(migrationApplied[0].applied).toBe(false);

      const invoiceRows = queryRows<{ id: string; invoice_id: string }>(`
        select id, invoice_id from public.invoices where id = 'c6000000-0000-4000-8000-000000000001';
      `);
      expect(invoiceRows).toEqual([
        { id: "c6000000-0000-4000-8000-000000000001", invoice_id: "   " },
      ]);
    },
    SUITE_TIMEOUT,
  );
});
