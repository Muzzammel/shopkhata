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

type DailyCloseRow = {
  id: string;
  shop_id: string;
  business_date: string;
  event_sequence: string;
  event_type: string;
  recorded_at: string | Date;
  actor_id: string;
  reason: string | null;
};

type LegacyDailyCloseRow = {
  id: string;
  shop_id: string;
  business_date: string;
  closed_at: string | Date;
  closed_by: string;
  is_reopened: boolean;
  reopened_at: string | Date | null;
  reopened_by: string | null;
  reopen_reason: string | null;
};

function isoTimestamp(value: string | Date): string {
  return new Date(value).toISOString();
}

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

function applyRemediationMigration(): void {
  runSupabase(["migration", "up", "--local"], RESET_TIMEOUT);
}

describe("daily-close legacy migration upgrade path", () => {
  let supabaseAvailable = false;

  beforeAll(() => {
    if (!isSupabaseRunning()) {
      throw new Error(
        "Prerequisite: local Supabase must be running. " +
          "Start it with: pnpm exec supabase start --local",
      );
    }
    supabaseAvailable = true;
  });

  afterAll(() => {
    if (!supabaseAvailable) return;
    // Restore clean fully-migrated and seeded database state
    runSupabase(["db", "reset", "--local"], RESET_TIMEOUT);
  }, SUITE_TIMEOUT);

  it(
    "fails with the intended preflight diagnostic when legacy daily-close rows contain malformed reopen data",
    () => {
      // 1. Reset database to version 20260828164246
      runSupabase(
        [
          "db",
          "reset",
          "--local",
          "--version",
          "20260828164246",
        ],
        RESET_TIMEOUT,
      );

      // 2. Insert representative malformed legacy daily-close records
      executeSql(`
        insert into public.daily_closes (
          id, shop_id, business_date, closed_at, closed_by, is_reopened, reopened_at, reopen_reason
        ) values
          -- Missing reopened_at
          (
            'd9000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001',
            '2026-07-01', now(), '10000000-0000-4000-8000-000000000101',
            true, null, 'reason given but timestamp missing'
          ),
          -- Missing reopen_reason
          (
            'd9000000-0000-4000-8000-000000000002',
            '10000000-0000-4000-8000-000000000001',
            '2026-07-02', now(), '10000000-0000-4000-8000-000000000101',
            true, now(), null
          ),
          -- Blank reopen_reason
          (
            'd9000000-0000-4000-8000-000000000003',
            '10000000-0000-4000-8000-000000000001',
            '2026-07-03', now(), '10000000-0000-4000-8000-000000000101',
            true, now(), '    '
          );
      `);

      const malformedBefore = queryRows<LegacyDailyCloseRow>(`
        select
          id, shop_id, business_date, closed_at, closed_by,
          is_reopened, reopened_at, reopened_by, reopen_reason
        from public.daily_closes
        where id in (
          'd9000000-0000-4000-8000-000000000001',
          'd9000000-0000-4000-8000-000000000002',
          'd9000000-0000-4000-8000-000000000003'
        )
        order by id;
      `);
      expect(malformedBefore).toHaveLength(3);

      // 3. Attempt to apply 20260902073650_phase2_security_remediation.sql and assert preflight diagnostic
      let failed = false;
      let failureOutput = "";
      try {
        applyRemediationMigration();
      } catch (err: unknown) {
        const failure = err as CommandFailure;
        failed = true;
        failureOutput = `${failure.message || ""} ${failure.stderr || ""} ${failure.stdout || ""}`;
      }

      expect(failed).toBe(true);
      expect(failureOutput).toMatch(
        /preflight failed: found 3 legacy daily_closes row\(s\).*is_reopened is true but reopened_at is null or reopen_reason is null\/blank/i,
      );

      const rollbackState = queryRows<{
        migration_absent: boolean;
        legacy_columns_present: boolean;
        legacy_unique_present: boolean;
        remediation_columns_absent: boolean;
        remediation_constraints_absent: boolean;
      }>(`
        select
          not exists (
            select 1
            from supabase_migrations.schema_migrations
            where version = '20260902073650'
          ) as migration_absent,
          (
            select count(*) = 4
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'daily_closes'
              and column_name in ('is_reopened', 'reopened_at', 'reopened_by', 'reopen_reason')
          ) as legacy_columns_present,
          exists (
            select 1
            from pg_constraint
            where conrelid = 'public.daily_closes'::regclass
              and conname = 'daily_closes_shop_date_uq'
          ) as legacy_unique_present,
          not exists (
            select 1
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'daily_closes'
              and column_name in ('event_sequence', 'event_type', 'reason')
          ) as remediation_columns_absent,
          not exists (
            select 1
            from pg_constraint
            where conname in (
              'batches_shop_id_id_uq',
              'customers_shop_id_id_uq',
              'invoices_shop_id_id_uq',
              'payments_shop_id_id_uq',
              'invoices_shop_id_batch_id_fkey',
              'invoices_shop_id_customer_id_fkey',
              'payments_shop_id_batch_id_fkey',
              'payments_shop_id_invoice_id_fkey',
              'customer_credits_shop_id_customer_id_fkey',
              'customer_credits_shop_id_invoice_id_fkey',
              'attachments_shop_id_batch_id_fkey',
              'attachments_shop_id_invoice_id_fkey',
              'corrections_shop_id_invoice_id_fkey',
              'corrections_shop_id_payment_id_fkey',
              'daily_closes_event_sequence_uq',
              'daily_closes_event_type_check',
              'daily_closes_event_reason_check'
            )
          ) as remediation_constraints_absent;
      `);
      expect(rollbackState).toEqual([
        {
          migration_absent: true,
          legacy_columns_present: true,
          legacy_unique_present: true,
          remediation_columns_absent: true,
          remediation_constraints_absent: true,
        },
      ]);

      const malformedAfter = queryRows<LegacyDailyCloseRow>(`
        select
          id, shop_id, business_date, closed_at, closed_by,
          is_reopened, reopened_at, reopened_by, reopen_reason
        from public.daily_closes
        where id in (
          'd9000000-0000-4000-8000-000000000001',
          'd9000000-0000-4000-8000-000000000002',
          'd9000000-0000-4000-8000-000000000003'
        )
        order by id;
      `);
      expect(malformedAfter).toEqual(malformedBefore);
    },
    SUITE_TIMEOUT,
  );

  it(
    "preserves valid legacy close and reopen history and orders them deterministically",
    () => {
      // 1. Reset database to version 20260828164246
      runSupabase(
        [
          "db",
          "reset",
          "--local",
          "--version",
          "20260828164246",
        ],
        RESET_TIMEOUT,
      );

      // 2. Insert representative valid legacy records (closed-only and closed+reopened)
      executeSql(`
        insert into public.daily_closes (
          id, shop_id, business_date, closed_at, closed_by, is_reopened, reopened_at, reopened_by, reopen_reason
        ) values
          (
            'd8000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001',
            '2026-08-01', '2026-08-01 18:00:00+00', '10000000-0000-4000-8000-000000000101',
            false, null, null, null
          ),
          (
            'd8000000-0000-4000-8000-000000000002',
            '10000000-0000-4000-8000-000000000001',
            '2026-08-02', '2026-08-02 18:00:00+00', '10000000-0000-4000-8000-000000000101',
            true, '2026-08-02 20:30:00+00', '10000000-0000-4000-8000-000000000101',
            'approved manager override for late register correction'
          );
      `);

      // 3. Apply 20260902073650_phase2_security_remediation.sql
      applyRemediationMigration();

      // 4. Verify valid reopen history is preserved and ordered correctly
      const rows = queryRows<DailyCloseRow>(`
        select
          id, shop_id, business_date, event_sequence, event_type,
          recorded_at, actor_id, reason
        from public.daily_closes
        where business_date in ('2026-08-01', '2026-08-02')
        order by business_date, event_sequence asc;
      `);

      // Row 1 (2026-08-01): single closed event
      const day1Events = rows.filter((r) =>
        r.business_date.startsWith("2026-08-01"),
      );
      expect(day1Events).toHaveLength(1);
      expect(day1Events[0].id).toBe("d8000000-0000-4000-8000-000000000001");
      expect(day1Events[0].shop_id).toBe("10000000-0000-4000-8000-000000000001");
      expect(day1Events[0].business_date).toMatch(/^2026-08-01/);
      expect(day1Events[0].event_type).toBe("closed");
      expect(isoTimestamp(day1Events[0].recorded_at)).toBe("2026-08-01T18:00:00.000Z");
      expect(day1Events[0].actor_id).toBe("10000000-0000-4000-8000-000000000101");
      expect(day1Events[0].reason).toBeNull();

      // Row 2 (2026-08-02): two events (closed, then reopened)
      const day2Events = rows.filter((r) =>
        r.business_date.startsWith("2026-08-02"),
      );
      expect(day2Events).toHaveLength(2);
      expect(day2Events[0].id).toBe("d8000000-0000-4000-8000-000000000002");
      expect(day2Events[0].shop_id).toBe("10000000-0000-4000-8000-000000000001");
      expect(day2Events[0].business_date).toMatch(/^2026-08-02/);
      expect(day2Events[0].event_type).toBe("closed");
      expect(isoTimestamp(day2Events[0].recorded_at)).toBe("2026-08-02T18:00:00.000Z");
      expect(day2Events[0].actor_id).toBe("10000000-0000-4000-8000-000000000101");
      expect(day2Events[0].reason).toBeNull();
      expect(day2Events[1].event_type).toBe("reopened");
      expect(day2Events[1].shop_id).toBe("10000000-0000-4000-8000-000000000001");
      expect(day2Events[1].business_date).toMatch(/^2026-08-02/);
      expect(isoTimestamp(day2Events[1].recorded_at)).toBe("2026-08-02T20:30:00.000Z");
      expect(day2Events[1].actor_id).toBe("10000000-0000-4000-8000-000000000101");
      expect(day2Events[1].reason).toBe("approved manager override for late register correction");

      // Reopened event must have strictly higher event_sequence than closed event
      expect(BigInt(day2Events[1].event_sequence)).toBeGreaterThan(
        BigInt(day2Events[0].event_sequence),
      );
    },
    SUITE_TIMEOUT,
  );
});
