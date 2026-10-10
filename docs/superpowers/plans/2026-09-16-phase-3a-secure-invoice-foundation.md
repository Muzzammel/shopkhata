# ShopKhata Phase 3A: Secure Invoice Foundation — Implementation Plan

> **For agentic workers:** Execute sequentially in one ShopKhata session. This plan covers **database-layer scope only** — no Next.js UI, server actions, routes, or `lib/domain/*` changes. Every task ends in one focused commit. Do not start Task *n+1* until Task *n*'s verification commands pass.

**Goal:** Build the secure database foundation for atomic invoice-batch submission — schema, the `submit_batch` `SECURITY DEFINER` RPC, its authorization boundary, its idempotency/fingerprint semantics, and full pgTAP + integration-test coverage — so that a later UI phase has nothing left to secure, only to call.

**Governing documents:**
- `docs/plans/ShopKhata-Phase-3-Invoice-Operations-Design.md` (approved design; this plan implements only the subset defined below as "Phase 3A scope")
- `docs/plans/ShopKhata-V1-Implementation-Plan.md` Task 4 (auth boundary) and Task 5 (`submit_batch` interface origin)
- `docs/product/ShopKhata-Product-Design-Specification.md` §14 (backdated entry rules)

**Architecture:** One new `SECURITY DEFINER` function, `public.submit_batch(command jsonb) returns jsonb`, becomes the sole write path for a rapid-entry batch. It derives the actor exclusively from `auth.uid()`, re-checks shop access and role via the existing `private.has_shop_access` / `public.profiles` (never trusting client-asserted role or shop), validates the entire raw JSON shape and every business rule before any write, and performs all writes — quick-add customers, the batch row, each invoice, its invoice-number-registry reservation, and its initial payment — inside its own single statement invocation, so any exception anywhere rolls back everything already done in that call. A new `public.invoice_number_registry` table (append-only, uniquely keyed on `(shop_id, normalized_invoice_number)`) is the authoritative source for same-shop invoice-number uniqueness, replacing a naive `invoices.invoice_id` lookup so it stays correct once replacement-versions exist in a later phase. Idempotency is implemented by storing a canonical SHA-256 fingerprint and the exact success payload on the `batches` row, keyed by `(shop_id, idempotency_key)`, with a transaction-scoped advisory lock serializing concurrent requests for the same key.

**Tech stack:** PostgreSQL 17, Supabase CLI 2.115.0, pgTAP, TypeScript, `@supabase/supabase-js`, Vitest.

## Revision notes

**First pass** corrected nineteen defects found in the originally drafted version of this plan before any of it was implemented: unresolved migration-filename placeholders; an idempotency migration that could not coexist with any pre-existing `batches` row; no real concurrency control around the idempotency check; raw-cast/raw-Postgres-error exposure on malformed caller input instead of the documented structured error; an incomplete reject list; case/whitespace-sensitive invoice-number handling that contradicted the registry's job; a broken closed-date pgTAP fixture that could never reach the code path it claimed to test; a cross-shop success pgTAP test that used an actor with no access to the target shop; a missing genuine rollback test; missing real-concurrency integration coverage; a hand-rolled subprocess runner instead of the proven one; fragile `supabase status -o env` parsing; a self-contradictory TDD step order; an invalid CLI flag; inconsistent `pnpm`/`pnpm.cmd` usage; an integration test that never actually read back what it wrote; and incoherent execution-state instructions.

**Second pass (this revision)** corrects thirteen further defects found before any implementation began: a missing `afterAll` import and an unguarded credentials variable in the Task 5 integration test; a registry-backfill rollback test that queried the very table its own migration had rolled back out of existence; no protection anywhere against a blank-after-trim invoice number reaching the registry; a canonical fingerprint that discarded invoice-number display casing even though casing is part of what actually gets stored in `invoices.invoice_id`; several raw JSON fields (`idempotency_key`, `backdated_reason`, `note`, `payment_method`) accepted with no type check and payment-method representations that could churn the fingerprint for no reason; customer-object keys not restricted per `type` (an `existing` reference could carry a stray `name`, a `quick_add` object a stray `customer_id`); a "genuine mid-write rollback" pgTAP test that in fact never reaches the write phase; a concurrency test that raced on a single row instead of proving a real two-row rollback; under-verified concurrency assertions that didn't check every affected table or the losing call's exact error; an unenforced (if usually reliable) response-row ordering; and advisory-lock wording that overstated both collision safety and lock lifetime.

Every task below reflects both passes' fixes; none of the originally approved design's included/excluded scope changed as a result (see the "Preserved from the approved design" list at the end of Task 4 and the out-of-scope section).

## Global constraints

- Branch `phase-3-operational-ui`. **This plan file itself remains untracked while under revision** — do not stage or commit it as part of this revision (see the last line of this section). Once the user approves this revision, commit the plan file by itself in one commit. Implementation (Task 1 onward) then begins from **that plan commit**, on a clean working tree, verified immediately before Task 1 with `git status --short` and `git rev-parse --short HEAD` — never against a hardcoded prior commit hash such as `55c8008`, because the plan-approval commit (and any other commits landed since this revision was written) are both ahead of it by the time implementation starts.
- No `app/`, `features/`, `lib/domain/`, or `lib/auth/` changes. This is a database-and-tests-only phase; the RPC must be independently secure when called directly, bypassing any future browser or server action.
- Use only `pnpm.cmd exec supabase` in local mode (this repo's local shell is Windows PowerShell; `pnpm.cmd` — not bare `pnpm` — is required so that direct process invocation, not just interactive-shell `PATHEXT` resolution, reliably finds the executable, matching the convention already used by `tests/integration/migration/upgrade-path.test.ts`'s `PNPM` constant). Never link, push, log in, or target a remote project. GitHub Actions CI runs on Linux and keeps bare `pnpm` in `.github/workflows/ci.yml` — only the PowerShell commands documented in this plan switch to `pnpm.cmd`.
- Do not weaken RLS, append-only protections, or existing grants to make a test pass.
- Every new `SECURITY DEFINER` function uses `set search_path = ''` and fully schema-qualified references, per `supabase/migrations/20260828164246_rls.sql` convention. Private-schema helper functions that are not themselves `SECURITY DEFINER` also set `search_path = ''`, matching this plan's own helper functions below.
- Reuse `private.is_active_actor()` and `private.has_shop_access(uuid)` for authentication/shop-access checks; do not re-implement them.
- Regenerate `lib/supabase/database.types.ts` only after database GREEN (Task 6), as strict UTF-8 with no BOM and exactly one trailing newline.
- Do not implement `record_payment`, replacement-request/decision tables, or any Phase 3B/3C/3D function. Do not add UI, navigation, invoice-detail screens, or duplicate-warning UI.
- Do not stage or commit this plan file.

---

## Task 1 — Persist the delivered flag and note; tighten the total-amount constraint

**Why:** `submit_batch` must enforce "a delivered row with due requires a customer" (design §5/§7), but `invoices` has no column recording delivery state today, and no `note` column exists at all (design §14.2 items 1 and 3). The existing `invoices_total_amount_nonnegative` check allows `total_amount_dirham = 0`; the design requires strictly greater than zero (§14.2 item 2), and `submit_batch` needs this enforced at the database boundary, not only inside the function body.

**Files:**
- Create: `supabase/migrations/20260916120000_invoice_delivered_flag_and_note.sql` — create this file directly with this exact name. Do **not** run `pnpm.cmd exec supabase migration new ...` for any migration in this plan: that command stamps the current wall-clock timestamp, which would not match the four exact, monotonically ordered filenames fixed by this plan (this one, then `20260916120100_batch_idempotency_fingerprint.sql`, `20260916120200_invoice_number_registry.sql`, `20260916120300_submit_batch_rpc.sql` — each sorts after the last existing migration, `20260902073650_phase2_security_remediation.sql`).
- Modify: `supabase/tests/schema.test.sql`

### Step 1: Write failing schema tests

Bump `select plan(99);` to `select plan(102);` and add three assertions immediately after the existing total-amount block (after the `payments_amount_nonnegative` assertions, near line 78 of the current file):

```sql
select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'invoices'
      and column_name = 'delivered' and data_type = 'boolean'
      and is_nullable = 'NO' and column_default = 'false'
  ),
  'invoices.delivered is a required boolean defaulting to false'
);

select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'invoices'
      and column_name = 'note' and data_type = 'text' and is_nullable = 'YES'
  ),
  'invoices.note is an optional text column'
);

select throws_ok(
  $$
  insert into public.invoices (
    shop_id, batch_id, invoice_id, total_amount_dirham, business_date
  ) values (
    '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
    'ZERO-TOTAL', 0, current_date
  );
  $$,
  '23514',
  null,
  'a zero invoice total is rejected'
);
```

Also **modify** the existing assertion (current lines 55–62) that checks for `invoices_total_amount_nonnegative` to instead check for the new constraint name and definition:

```sql
select ok(
  exists (
    select 1 from pg_constraint
    where conname = 'invoices_total_amount_positive'
      and conrelid = to_regclass('public.invoices')
      and pg_get_constraintdef(oid) = 'CHECK ((total_amount_dirham > 0))'
  ),
  'invoice totals have a named strictly-positive constraint'
);
```

### Step 2: Confirm failure

```powershell
pnpm.cmd exec supabase db reset --local
pnpm.cmd exec supabase test db --local
```

Expected: FAIL — `delivered`/`note` columns do not exist, the old constraint name still matches `>= 0`, and the zero-total insert currently succeeds instead of throwing `23514`.

### Step 3: Implement the migration

```sql
do $$
declare
  invalid_totals integer;
begin
  select count(*) into invalid_totals
  from public.invoices
  where total_amount_dirham <= 0;

  if invalid_totals > 0 then
    raise exception 'Migration invoice_delivered_flag_and_note preflight failed: found % existing invoice(s) with total_amount_dirham <= 0. Repair required before tightening the constraint.', invalid_totals
      using errcode = 'check_violation';
  end if;
end $$;

alter table public.invoices
  add column delivered boolean not null default false,
  add column note text;

alter table public.invoices
  drop constraint invoices_total_amount_nonnegative,
  add constraint invoices_total_amount_positive check (total_amount_dirham > 0);
```

### Step 4: Confirm success

```powershell
pnpm.cmd exec supabase db reset --local
pnpm.cmd exec supabase test db --local
```

Expected: all 102 assertions pass.

### Step 5: Commit

```powershell
git add supabase/migrations/20260916120000_invoice_delivered_flag_and_note.sql supabase/tests/schema.test.sql
git commit -m "feat: persist invoice delivered flag and note, require positive totals"
```

---

## Task 2 — Batch idempotency-key uniqueness and canonical-fingerprint storage, compatible with pre-existing rows

**Why:** `batches.idempotency_key` today is a plain nullable `text` with no unique index and no fingerprint column (design §9/§14.2 item 7). `submit_batch` needs a place to persist the canonical fingerprint of the request that produced a batch (to detect a same-key-different-request conflict) and the exact success payload it returned (to replay it verbatim on an exact retry) — both scoped by `(shop_id, idempotency_key)`. `batches` is append-only (`batches_append_only` rejects every `UPDATE`/`DELETE`, including one issued by a migration), so this migration must not need to rewrite any existing row, and it must not assume the table is empty.

**Files:**
- Create: `supabase/migrations/20260916120100_batch_idempotency_fingerprint.sql`
- Modify: `supabase/tests/schema.test.sql`

**Design decision:** `idempotency_key`, `fingerprint`, and `idempotency_result` are all **nullable**, with a `CHECK` constraint requiring they be either all null (a legacy row, or any row `submit_batch` never touches) or all non-null (a row `submit_batch` created). Because `batches` cannot be `UPDATE`d, the `CHECK` constraint is added `NOT VALID` — Postgres enforces it on every `INSERT`/`UPDATE` from the moment it is added, but does not scan or reject any row that predates it, so a real pre-existing row that happens to carry a bare `idempotency_key` with no fingerprint (which existed as a column before Phase 3A) is grandfathered in rather than blocking the migration. This is different from `UNIQUE`, which Postgres cannot add `NOT VALID` — a genuine duplicate `(shop_id, idempotency_key)` pair among pre-existing non-null keys is the one thing this migration cannot work around, so a preflight checks specifically for that (not for the mere existence of prior rows, which the previous draft of this migration incorrectly rejected outright).

### Step 1: Write failing schema tests

Bump `plan(102)` to `plan(111)` and add:

```sql
select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'batches'
      and column_name = 'idempotency_key' and data_type = 'text' and is_nullable = 'YES'
  ),
  'batches.idempotency_key remains nullable to preserve pre-fingerprint legacy rows'
);

select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'batches'
      and column_name = 'fingerprint' and data_type = 'text' and is_nullable = 'YES'
  ),
  'batches.fingerprint is a nullable text column'
);

select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'batches'
      and column_name = 'idempotency_result' and data_type = 'jsonb' and is_nullable = 'YES'
  ),
  'batches.idempotency_result is a nullable jsonb column'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conname = 'batches_idempotency_fields_all_or_none'
      and conrelid = to_regclass('public.batches')
      and pg_get_constraintdef(oid) = 'CHECK ((idempotency_key IS NULL AND fingerprint IS NULL AND idempotency_result IS NULL) OR (idempotency_key IS NOT NULL AND fingerprint IS NOT NULL AND idempotency_result IS NOT NULL))'
  ),
  'batches enforces idempotency_key/fingerprint/idempotency_result as all-null or all-non-null'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conname = 'batches_shop_id_idempotency_key_uq'
      and conrelid = to_regclass('public.batches')
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (shop_id, idempotency_key)'
  ),
  'batches has a named unique constraint on (shop_id, idempotency_key)'
);

select lives_ok(
  $$
  insert into public.batches (id, shop_id, business_date, created_by)
  values ('c0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', current_date, '10000000-0000-4000-8000-000000000101');
  $$,
  'a legacy-shaped batch with all three idempotency fields null is accepted'
);

select lives_ok(
  $$
  insert into public.batches (id, shop_id, business_date, created_by, idempotency_key, fingerprint, idempotency_result)
  values ('c0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', current_date, '10000000-0000-4000-8000-000000000101', 'schema-test-full-1', 'fp', '{}'::jsonb);
  $$,
  'a batch with all three idempotency fields populated is accepted'
);

select throws_ok(
  $$
  insert into public.batches (id, shop_id, business_date, created_by, idempotency_key)
  values ('c0000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', current_date, '10000000-0000-4000-8000-000000000101', 'schema-test-partial');
  $$,
  '23514',
  null,
  'an idempotency_key with no fingerprint or result is rejected'
);

select throws_ok(
  $$
  insert into public.batches (id, shop_id, business_date, created_by, idempotency_key, fingerprint, idempotency_result)
  values ('c0000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', current_date, '10000000-0000-4000-8000-000000000101', 'schema-test-full-1', 'fp-2', '{}'::jsonb);
  $$,
  '23505',
  null,
  'reusing (shop_id, idempotency_key) across two batch rows is rejected'
);
```

No fixture changes are needed elsewhere in `schema.test.sql` or in `supabase/tests/rls.test.sql` for this task: `idempotency_key`/`fingerprint`/`idempotency_result` all remain nullable, so every existing fixture that omits them (e.g. the `do $setup$` batch fixture in `rls.test.sql`) continues to satisfy the new all-null branch untouched. The one exception is the `lives_ok` fixture in `schema.test.sql` (currently ~line 416, "the same invoice ID is accepted in different shops") that sets `idempotency_key` to a bare string with no fingerprint — under the new constraint this now violates `batches_idempotency_fields_all_or_none`, so drop `idempotency_key` from that fixture's column list and values entirely (its own test is about invoice IDs, not idempotency, so the column is simply not needed there):

```sql
insert into public.batches (id, shop_id, business_date, created_by)
values
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', current_date, '10000000-0000-4000-8000-000000000101'),
  ('10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', current_date, '10000000-0000-4000-8000-000000000101');
```

### Step 2: Confirm failure

```powershell
pnpm.cmd exec supabase db reset --local
pnpm.cmd exec supabase test db --local
```

Expected: FAIL — the new columns/constraints do not exist yet.

### Step 3: Implement the migration

```sql
do $$
declare
  duplicate_count integer;
begin
  select count(*) into duplicate_count
  from (
    select shop_id, idempotency_key
    from public.batches
    where idempotency_key is not null
    group by shop_id, idempotency_key
    having count(*) > 1
  ) dupes;

  if duplicate_count > 0 then
    raise exception 'Migration batch_idempotency_fingerprint preflight failed: found % existing (shop_id, idempotency_key) pair(s) shared by more than one batch row. Resolve these duplicates before adding the unique constraint.', duplicate_count;
  end if;
end $$;

alter table public.batches
  add column fingerprint text,
  add column idempotency_result jsonb;

-- NOT VALID: enforces the invariant on every future write without scanning
-- or rejecting a row that predates this migration. batches is append-only
-- (batches_append_only rejects UPDATE/DELETE for every role, including one
-- issued by a migration), so an existing row that has an idempotency_key
-- but no fingerprint cannot be brought into compliance by rewriting it —
-- it can only be grandfathered in.
alter table public.batches
  add constraint batches_idempotency_fields_all_or_none check (
    (idempotency_key is null and fingerprint is null and idempotency_result is null)
    or (idempotency_key is not null and fingerprint is not null and idempotency_result is not null)
  ) not valid;

alter table public.batches
  add constraint batches_shop_id_idempotency_key_uq unique (shop_id, idempotency_key);
```

### Step 4: Confirm success

```powershell
pnpm.cmd exec supabase db reset --local
pnpm.cmd exec supabase test db --local
```

Expected: all 111 schema assertions and the existing 39 RLS assertions pass.

### Step 5: Commit

```powershell
git add supabase/migrations/20260916120100_batch_idempotency_fingerprint.sql supabase/tests/schema.test.sql
git commit -m "feat: require batch idempotency-key uniqueness and add fingerprint/result storage"
```

---

## Task 3 — Invoice-number registry, normalized uniqueness, and a collision-checked backfill

**Why:** Same-shop invoice-number uniqueness must be checked against an append-only registry, not `invoices.invoice_id` alone, so it stays correct once a later phase's replacement-versions can change an invoice's effective number without changing that original column (design §14.2 item 11, §17). No such registry exists today; it must be introduced with a safe backfill of any invoice numbers that already exist. Uniqueness must be case- and whitespace-insensitive (`lower(btrim(invoice_number))`) so `"INV-1"` and `"inv-1 "` are recognized as the same number — trim-only normalization would let two visually-identical numbers coexist, defeating the registry's purpose — while the exact, outer-trimmed-only value the submitter typed is still preserved for display.

**Files:**
- Create: `supabase/migrations/20260916120200_invoice_number_registry.sql`
- Modify: `supabase/tests/schema.test.sql`, `supabase/tests/rls.test.sql`
- Create: `tests/integration/migration/invoice-number-registry-backfill.test.ts`

### Step 1: Write failing tests

**schema.test.sql** — bump `plan(111)` to `plan(120)` and add:

```sql
select has_table('public', 'invoice_number_registry', 'invoice_number_registry table exists');

select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'invoice_number_registry'
      and column_name = 'normalized_invoice_number' and data_type = 'text'
      and is_generated = 'ALWAYS'
  ),
  'invoice_number_registry.normalized_invoice_number is a generated column'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conname = 'invoice_number_registry_shop_id_normalized_number_uq'
      and conrelid = to_regclass('public.invoice_number_registry')
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (shop_id, normalized_invoice_number)'
  ),
  'invoice_number_registry enforces unique (shop_id, normalized_invoice_number)'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conname = 'invoice_number_registry_shop_id_canonical_invoice_id_fkey'
      and conrelid = to_regclass('public.invoice_number_registry')
      and confrelid = to_regclass('public.invoices')
      and contype = 'f'
      and pg_get_constraintdef(oid) = 'FOREIGN KEY (shop_id, canonical_invoice_id) REFERENCES invoices(shop_id, id) ON DELETE RESTRICT'
  ),
  'invoice_number_registry has composite foreign key to invoices(shop_id, id)'
);

select throws_ok(
  $$
  insert into public.invoice_number_registry (shop_id, invoice_number, canonical_invoice_id)
  values (
    '10000000-0000-4000-8000-000000000001',
    'CROSS-SHOP-REGISTRY',
    '20000000-0000-4000-8000-000000000002'
  );
  $$,
  '23503',
  null,
  'a registry entry cannot reference a canonical invoice from another shop'
);

select lives_ok(
  $$
  insert into public.invoice_number_registry (shop_id, invoice_number, canonical_invoice_id)
  values (
    '10000000-0000-4000-8000-000000000001',
    'CASE-VARIANT-1',
    '20000000-0000-4000-8000-000000000001'
  );
  $$,
  'the first casing of a normalized invoice number is accepted'
);

select throws_ok(
  $$
  insert into public.invoice_number_registry (shop_id, invoice_number, canonical_invoice_id)
  values (
    '10000000-0000-4000-8000-000000000001',
    ' case-variant-1 ',
    '20000000-0000-4000-8000-000000000001'
  );
  $$,
  '23505',
  null,
  'a case- and whitespace-variant of an already-registered number is rejected as a duplicate'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conname = 'invoice_number_registry_invoice_number_not_blank'
      and conrelid = to_regclass('public.invoice_number_registry')
      and pg_get_constraintdef(oid) = 'CHECK ((btrim(invoice_number) <> ''::text))'
  ),
  'invoice_number_registry rejects a null-equivalent (blank-after-trim) invoice_number'
);

select throws_ok(
  $$
  insert into public.invoice_number_registry (shop_id, invoice_number, canonical_invoice_id)
  values (
    '10000000-0000-4000-8000-000000000001',
    '   ',
    '20000000-0000-4000-8000-000000000001'
  );
  $$,
  '23514',
  null,
  'a blank-after-trim invoice_number is rejected'
);
```

Extend the two existing table-name arrays in `schema.test.sql` to include `'invoice_number_registry'`:
- the privilege check ("application roles have no UPDATE or DELETE privilege on financial events", ~line 812)
- the append-only-trigger check ("financial event tables have append-only triggers", ~line 834)

**rls.test.sql** — bump `plan(39)` to `plan(40)` and add one assertion following the existing per-table pattern (after the `audit_events` RLS-enabled check, ~line 358):

```sql
select ok(
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'invoice_number_registry' and c.relrowsecurity),
  'RLS is enabled on public.invoice_number_registry'
);
```

Then extend, without changing the plan count:
- the `do $setup$` fixture: add two registry rows tied to the existing `RLS-SHOP-1`/`RLS-SHOP-2` invoice fixtures (ids `40000000-…-0001` / `…-0002`), e.g. `invoice_number` = `'RLS-SHOP-1'` / `'RLS-SHOP-2'`.
- `pg_temp.try_financial_insert`: add a `when 'invoice_number_registry' then …` branch inserting a row referencing a shop-1 invoice with a fresh id/number.
- `pg_temp.try_financial_delete`: add a matching `when 'invoice_number_registry' then …` branch keyed to the id above.
- every `unnest(array[...])` table-name array used for "every table has a policy," "anon cannot read," per-role `visible_count`, `try_financial_insert/update/delete`, "fails closed," and "append-only protections remain effective" — add `'invoice_number_registry'` to each. (This is what provides direct-write-denial coverage for the new table — see Task 4's pgTAP notes; no duplicate coverage is added in `submit_batch.test.sql`.)

**tests/integration/migration/invoice-number-registry-backfill.test.ts** — new file. Copy the `run`/`runSupabase`/`isSupabaseRunning`/`executeSql`/`queryRows` helpers from `tests/integration/migration/upgrade-path.test.ts` **verbatim** into this new file (this project keeps each integration test file self-contained; do not import across test files):

```ts
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
```

`CommandFailure` is the same type alias already defined in `upgrade-path.test.ts`'s copied helpers.

### Step 2: Confirm failure

```powershell
pnpm.cmd exec supabase db reset --local
pnpm.cmd exec supabase test db --local
pnpm.cmd test:migration-upgrade
```

Expected: FAIL — `invoice_number_registry` does not exist (schema/RLS pgTAP), and all three new integration tests fail (nothing to register/reject because the table and its preflights do not exist).

### Step 3: Implement the migration

```sql
do $$
declare
  blank_count integer;
  blank_report text;
begin
  select count(*), string_agg(format('shop %s: invoice row %s', shop_id, id), '; ')
  into blank_count, blank_report
  from public.invoices
  where btrim(invoice_id) = '';

  if blank_count > 0 then
    raise exception 'Migration invoice_number_registry preflight failed: found % existing invoice(s) with a null-equivalent (blank-after-trim) invoice_id: %. Repair required before backfilling the registry.', blank_count, blank_report;
  end if;
end $$;

do $$
declare
  collision_count integer;
  collision_report text;
begin
  select count(*), string_agg(
    format('shop %s: %s', shop_id, invoice_ids), '; '
  )
  into collision_count, collision_report
  from (
    select shop_id, string_agg(distinct invoice_id, ', ' order by invoice_id) as invoice_ids
    from public.invoices
    group by shop_id, lower(btrim(invoice_id))
    having count(distinct invoice_id) > 1
  ) collisions;

  if collision_count > 0 then
    raise exception 'Migration invoice_number_registry preflight failed: found % same-shop invoice-number collision(s) after case/whitespace normalization: %. Resolve these before backfilling the registry.', collision_count, collision_report;
  end if;
end $$;

create table public.invoice_number_registry (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  invoice_number text not null,
  normalized_invoice_number text generated always as (lower(btrim(invoice_number))) stored,
  canonical_invoice_id uuid not null,
  created_at timestamptz not null default now(),
  constraint invoice_number_registry_invoice_number_not_blank check (btrim(invoice_number) <> ''),
  constraint invoice_number_registry_shop_id_normalized_number_uq unique (shop_id, normalized_invoice_number),
  constraint invoice_number_registry_shop_id_canonical_invoice_id_fkey
    foreign key (shop_id, canonical_invoice_id)
    references public.invoices (shop_id, id)
    on delete restrict
);

create trigger invoice_number_registry_append_only
  before update or delete on public.invoice_number_registry
  for each row execute function public.reject_append_only_mutation();

revoke update, delete on table public.invoice_number_registry from anon, authenticated;

alter table public.invoice_number_registry enable row level security;

grant select on table public.invoice_number_registry to authenticated;

create policy invoice_number_registry_select_authenticated
on public.invoice_number_registry
for select
to authenticated
using (private.has_shop_access(shop_id));

insert into public.invoice_number_registry (shop_id, invoice_number, canonical_invoice_id)
select shop_id, invoice_id, id
from public.invoices;
```

### Step 4: Confirm success

```powershell
pnpm.cmd exec supabase db reset --local
pnpm.cmd exec supabase test db --local
pnpm.cmd test:migration-upgrade
```

Expected: 120 schema assertions, 40 RLS assertions, and the migration-upgrade suite (now 5 tests: 2 existing daily-close tests + 3 registry-backfill tests) all pass.

### Step 5: Commit

```powershell
git add supabase/migrations/20260916120200_invoice_number_registry.sql supabase/tests/schema.test.sql supabase/tests/rls.test.sql tests/integration/migration/invoice-number-registry-backfill.test.ts
git commit -m "feat: add append-only invoice-number registry with normalized uniqueness and backfill"
```

---

## Task 4 — `submit_batch` SECURITY DEFINER RPC and its pgTAP coverage

**Why:** This is the only authorized write path for a rapid-entry batch (design §6). It must derive the actor from `auth.uid()` only, re-check shop access and role in-function, validate the complete request — including its raw JSON shape, before any scalar cast — before any write, and implement exact idempotency/replay/conflict semantics with real concurrency control, regardless of whether a browser or server action is bypassed entirely.

**Files:**
- Create: `supabase/migrations/20260916120300_submit_batch_rpc.sql`
- Create: `supabase/tests/submit_batch.test.sql`
- Modify: `supabase/tests/rls.test.sql` (one existing assertion)

**Interface:**

```
submit_batch(command jsonb) returns jsonb
```

Request shape (documented here as the binding contract; enforced field-by-field in Step 3):

```jsonc
{
  "shop_id": "uuid",
  "business_date": "YYYY-MM-DD",
  "is_backdated": false,
  "backdated_reason": null,
  "idempotency_key": "client-generated-string",
  "rows": [
    {
      "row_id": "stable-client-row-id",
      "invoice_number": "INV-1001",
      "total_dirham": 10000,
      "received_dirham": 4000,
      "payment_method": "cash",
      "delivered": true,
      "note": null,
      "customer": { "type": "existing", "customer_id": "uuid" }
      // or: { "type": "quick_add", "name": "Ali", "mobile": null }
      // or: null
    }
  ]
}
```

No key beyond the ones shown above is accepted at the command, row, or `customer` level — an unrecognized key is rejected rather than silently ignored (§ Reject list below).

Success response (also the exact value persisted to `batches.idempotency_result` and replayed verbatim on retry):

```jsonc
{
  "ok": true,
  "batch_id": "uuid",
  "recorded_at": "2026-09-16T10:00:00.000Z",
  "rows": [
    { "row_id": "stable-client-row-id", "invoice_id": "uuid", "invoice_number": "INV-1001", "customer_id": "uuid-or-null", "payment_id": "uuid-or-null" }
  ]
}
```

Failure is always a raised exception (never a `{ ok: false }` return), so the whole call aborts atomically:

| Condition | `errcode` | `MESSAGE` | `DETAIL` |
|---|---|---|---|
| not authenticated / inactive | `28000` | `AUTHENTICATION_REQUIRED` | — |
| no access to `shop_id` | `42501` | `UNAUTHORIZED_SHOP` | — |
| non-owner submits a backdated batch | `42501` | `INSUFFICIENT_ROLE` | — |
| business date is closed | `P0001` | `CLOSED_DATE` | — |
| the command's raw JSON shape is malformed, or any row/field validation fails | `P0001` | `BATCH_VALIDATION_FAILED` | JSON array of `{row_id, field, code, message}` |
| replay with a different fingerprint | `P0001` | `IDEMPOTENCY_CONFLICT` | — |
| registry loses a same-shop-number race | `P0001` | `BATCH_VALIDATION_FAILED` | JSON array with `code: "INVOICE_NUMBER_ALREADY_REGISTERED"` |

Error codes reuse `lib/domain/errors.ts`'s `DOMAIN_ERROR_CODES` string values (`DUPLICATE_INVOICE`, `CUSTOMER_REQUIRED`, `AMOUNT_INVALID`) wherever the concept is identical, so a later server action can map them without translation; server-only concepts get new codes (`INVOICE_NUMBER_REQUIRED`, `INVOICE_NUMBER_ALREADY_REGISTERED`, `CUSTOMER_NOT_FOUND`, `CUSTOMER_IDENTIFIER_REQUIRED`, `CUSTOMER_REFERENCE_INVALID`, `PAYMENT_METHOD_INVALID`, `FUTURE_DATE_NOT_ALLOWED`, `BACKDATE_REASON_REQUIRED`, `BACKDATE_FLAG_INVALID`, `ROW_ID_REQUIRED`, `ROW_ID_DUPLICATE`, `BATCH_EMPTY`, `REQUEST_INVALID`). `REQUEST_INVALID` covers every raw-shape violation (a non-object command or row, an unsupported key at any level, a missing/non-array `rows`, or a field whose JSON type doesn't match what the field requires) that isn't better described by a more specific code.

**Design decisions made while implementing (flagged for confirmation, not left ambiguous):**
1. Invoice-number normalization for *matching* purposes — within-batch duplicate detection, the registry prevalidation query, and the registry's own unique constraint — is `lower(btrim(...))`. The outer-trimmed-but-original-case value is what is written to `invoices.invoice_id` and `invoice_number_registry.invoice_number` (preserving exactly what the submitter typed, minus incidental leading/trailing whitespace, for display); a separate, generated `normalized_invoice_number` column drives uniqueness (Task 3). This is deliberately **not** the same normalization the canonical fingerprint uses — see decision 2.
2. The canonical fingerprint (design §9) preserves each row's invoice number with only `btrim(...)` applied — **not** `lower(...)` — because casing is part of what is actually written to and displayed from `invoices.invoice_id`; two submissions differing only by invoice-number casing produce two different stored values, so they are not the same request for idempotency purposes even though the registry (decision 1) treats them as the same *business* invoice number. Concretely: an exact retry (identical casing) under the same key is idempotent and replays the original result verbatim; the same key resubmitted with only the casing changed now has a *different* fingerprint, so it correctly raises `IDEMPOTENCY_CONFLICT` rather than silently replaying a result that would misrepresent what the caller just sent; and a *different* key carrying a case-variant of an already-registered number still fails with the registry's own structured `INVOICE_NUMBER_ALREADY_REGISTERED` error, since that check is independent of the fingerprint and always uses the case-insensitive normalized key from decision 1. The fingerprint also canonicalizes each row's `payment_method` to the single value it can ever legitimately have — the literal `'cash'` when `received_dirham` is not greater than zero (payment method is irrelevant when nothing is received, so no representation of it — `'cash'`, `null`, or anything else the caller happened to send — should be able to change the fingerprint), and the actual (already-validated-as-`'cash'`) value otherwise. It also omits the raw `is_backdated` boolean because the function makes it fully determined by `business_date < current_date` combined with `backdated_reason` presence (Step 3 rejects any other combination) — it cannot vary independently without also changing a field that *is* in the fingerprint.
3. "Closed-date rejection" and "future date prohibited" are included even though Phase 3A's own enforcement checklist didn't name them explicitly, because the approved design (§11, §14.2 item 6) and the product spec (§14.5) both require them of "this phase's transaction function," and the `daily_closes` table this depends on already exists. No new authorization rule is invented — only what §11/§14 already specify.
4. Concurrency for the idempotency check is provided by a transaction-scoped advisory lock, `pg_advisory_xact_lock(hashtextextended(shop_id::text || ':' || idempotency_key, 0))`. Concatenating the UUID text form of `shop_id` (always exactly 36 characters, never containing `:`) with `idempotency_key` using `:` as a separator is unambiguous. A hash collision between two different `(shop_id, idempotency_key)` pairs is theoretically possible — any fixed-width hash has a nonzero collision probability — but is harmless: it can only make two unrelated requests briefly wait on the same lock (safe over-serialization), never cause one request's idempotency check to observe or return another pair's row, because the lookup that follows the lock still filters on the exact `(shop_id, idempotency_key)` values, not on the hash. `pg_advisory_xact_lock` is scoped to the *enclosing transaction* and releases automatically when that transaction ends (commit or rollback) — for a single RPC call executed in its own transaction (the normal PostgREST/Supabase calling convention), that coincides with the function returning; if `submit_batch` were ever invoked as one statement inside a longer-lived caller transaction, the lock would be held for the rest of that outer transaction, not merely until this function's own `return`. The lock is acquired once the fingerprint is known, serializing every concurrent call for the same `(shop_id, idempotency_key)` so that the *existing-row check that follows the lock* — not the `INSERT`'s own unique constraint — is what a second concurrent identical or conflicting call observes. A genuinely different `(shop_id, idempotency_key)` racing on the same invoice number instead is still caught by the registry's real unique constraint (decision 5), since two different keys normally hash to two different locks and are never incorrectly treated as the same idempotency record even in the rare case of a collision.
5. Prevalidating already-registered invoice numbers (a batched `SELECT` against `invoice_number_registry`, run once per call after every row passes shape/business-rule validation but before any write) is advisory and exists only to reject a doomed batch quickly, before creating a quick-add customer or a batch row for it. The registry's real unique constraint, caught in the per-row write loop, remains the authoritative last line of defense against a genuinely concurrent registration of the same number under a *different* idempotency key — the prevalidation query and the write-loop's `unique_violation` handler both compare on the same normalized key, so they never disagree except under real cross-session concurrency, which by definition only the write-loop catch can observe.

### Step 1: Write failing pgTAP tests

Create `supabase/tests/submit_batch.test.sql`:

```sql
begin;

create extension if not exists pgtap with schema extensions;

select plan(57);

-- Fixtures: a shop-1 existing customer, reused across several assertions.
insert into public.customers (id, shop_id, name)
values ('c9000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Submit-Batch Fixture Customer');

-- 1. Authorization boundary --------------------------------------------------

-- anon cannot even invoke the function (no EXECUTE grant — Postgres denies before the function body runs).
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok(
  $$select public.submit_batch('{"shop_id":"10000000-0000-4000-8000-000000000001","business_date":"2026-09-16","idempotency_key":"k1a","rows":[]}'::jsonb)$$,
  '42501', null,
  'anon has no EXECUTE grant on submit_batch'
);
reset role;

-- An authenticated call with no resolvable actor (missing/invalid sub claim) is rejected in-function.
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok(
  $$select public.submit_batch('{"shop_id":"10000000-0000-4000-8000-000000000001","business_date":"2026-09-16","idempotency_key":"k1b","rows":[]}'::jsonb)$$,
  '28000', null,
  'an authenticated call with no resolvable actor is rejected'
);
reset role;

-- Wrong-shop call rejected (Shop 1 staff targeting Shop 2).
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select throws_ok(
  $$select public.submit_batch('{"shop_id":"10000000-0000-4000-8000-000000000002","business_date":"2026-09-16","idempotency_key":"k2","rows":[]}'::jsonb)$$,
  '42501', null,
  'a call targeting an unassigned shop is rejected'
);
reset role;

-- 2. Malformed raw JSON shape is rejected structurally, never as a raw cast/type error ----

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select throws_ok(
  $$select public.submit_batch('"just a string"'::jsonb)$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-object command is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k-rows-absent'
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a command with no rows key is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k-rows-non-array',
    'rows', 'oops'
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-array rows field is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k-unsupported-key',
    'bogus_field', 'nope',
    'rows', jsonb_build_array()
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'an unsupported top-level field is rejected'
);
reset role;

-- 3. A well-formed single-row batch succeeds and is linked to its batch. ----

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select lives_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k3',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-0001',
      'total_dirham', 10000, 'received_dirham', 4000, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'a well-formed batch with one advance-with-partial-payment row succeeds'
);
select is(
  (select count(*)::int from public.invoices i join public.batches b on b.id = i.batch_id
   where i.invoice_id = 'SB-0001' and b.shop_id = '10000000-0000-4000-8000-000000000001'),
  1,
  'the successful batch created exactly one linked invoice'
);
select is(
  (select count(*)::int from public.invoice_number_registry
   where shop_id = '10000000-0000-4000-8000-000000000001' and normalized_invoice_number = 'sb-0001'),
  1,
  'the successful invoice reserved exactly one registry entry'
);
select is(
  (select amount_dirham from public.payments p
   join public.invoices i on i.id = p.invoice_id
   where i.invoice_id = 'SB-0001'),
  4000::bigint,
  'the initial payment amount matches received_dirham'
);

-- 4. Exact replay returns the original result with no new writes. ----

select is(
  (select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k3',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-0001',
      'total_dirham', 10000, 'received_dirham', 4000, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  )) ->> 'batch_id'),
  (select b.id::text from public.batches b where b.idempotency_key = 'k3'),
  'replaying the identical batch under the same key returns the original batch id'
);
select is(
  (select count(*)::int from public.invoices where invoice_id = 'SB-0001'),
  1,
  'replaying the identical batch does not create a second invoice'
);

-- 5. Same key, different fingerprint: explicit conflict, no write. ----

select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k3',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-0001-CHANGED',
      'total_dirham', 10000, 'received_dirham', 4000, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'P0001', 'IDEMPOTENCY_CONFLICT',
  'reusing a key with a changed fingerprint is rejected'
);

-- Casing alone is a content change too: the fingerprint preserves display
-- casing (design decision 2), so reusing the same key with only the
-- invoice-number casing changed must also conflict, not silently replay.
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k3',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'sb-0001',
      'total_dirham', 10000, 'received_dirham', 4000, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'P0001', 'IDEMPOTENCY_CONFLICT',
  'reusing a key with only the invoice-number casing changed is a conflict, not a silent replay'
);

-- 6. Total-not-greater-than-zero row rejected; nothing written. ----

select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k6',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-BAD-TOTAL',
      'total_dirham', 0, 'received_dirham', 0, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a total-not-greater-than-zero row is rejected'
);
select is(
  (select count(*)::int from public.invoices where invoice_id = 'SB-BAD-TOTAL'),
  0,
  'the rejected batch created no invoice'
);
select is(
  (select count(*)::int from public.batches where idempotency_key = 'k6'),
  0,
  'the rejected batch created no batch row'
);

-- 7. Non-cash payment method with received > 0 is rejected by the RPC directly. ----

select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k7',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-BAD-METHOD',
      'total_dirham', 5000, 'received_dirham', 5000, 'payment_method', 'card',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-cash payment method with a positive received amount is rejected by the RPC'
);

-- 8. Delivered row with due and no customer is rejected. ----

select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k8',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-BAD-CUSTOMER',
      'total_dirham', 5000, 'received_dirham', 1000, 'payment_method', 'cash',
      'delivered', true, 'customer', null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a delivered row with due and no customer is rejected'
);

-- 9. Quick-add with both name and mobile blank is rejected. ----

select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k9',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-BLANK-QUICKADD',
      'total_dirham', 5000, 'received_dirham', 0, 'payment_method', 'cash',
      'delivered', false, 'customer', jsonb_build_object('type', 'quick_add', 'name', '   ', 'mobile', null)
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a quick-add customer with both name and mobile blank is rejected'
);

-- 10. Cross-shop customer injection rejected. ----

select throws_ok(
  format(
    $$select public.submit_batch(jsonb_build_object(
      'shop_id', '10000000-0000-4000-8000-000000000001',
      'business_date', current_date::text,
      'idempotency_key', 'k10',
      'rows', jsonb_build_array(jsonb_build_object(
        'row_id', 'r1', 'invoice_number', 'SB-CROSS-CUSTOMER',
        'total_dirham', 5000, 'received_dirham', 0, 'payment_method', 'cash',
        'delivered', false, 'customer', jsonb_build_object('type', 'existing', 'customer_id', %L)
      ))
    ))$$,
    (select id::text from public.customers where shop_id = '10000000-0000-4000-8000-000000000002' limit 1)
  ),
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a row referencing a customer from another shop is rejected'
);

-- 11. Same-shop duplicate invoice number (against the registry, not just invoices) is rejected. ----

select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k11',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-0001',
      'total_dirham', 100, 'received_dirham', 0, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'resubmitting an already-registered invoice number under a new key is rejected'
);

-- Case-variant of an already-registered number is rejected the same way.
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k11-case',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'sb-0001',
      'total_dirham', 100, 'received_dirham', 0, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a case-variant of an already-registered invoice number is rejected'
);
reset role;

-- 12. Same invoice number accepted across two different shops, for an actor with access to both. ----

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select lives_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000002',
    'business_date', current_date::text,
    'idempotency_key', 'k12',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-0001',
      'total_dirham', 100, 'received_dirham', 0, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'the same invoice number is accepted in a different shop for an actor with access to both'
);
reset role;

-- 13. Closed-date rejection: owner, valid backdate fields, a closed historical date. ----

insert into public.daily_closes (shop_id, business_date, event_type, actor_id)
values ('10000000-0000-4000-8000-000000000001', current_date - 2, 'closed', '10000000-0000-4000-8000-000000000101');
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', (current_date - 2)::text,
    'is_backdated', true,
    'backdated_reason', 'late entry on a closed date',
    'idempotency_key', 'k13',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-CLOSED-DATE',
      'total_dirham', 100, 'received_dirham', 0, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'P0001', 'CLOSED_DATE',
  'the owner is still rejected against a closed historical date even with valid backdate fields'
);
reset role;

-- 14. Backdated batch: non-owner rejected, owner accepted. ----

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', (current_date - 1)::text,
    'is_backdated', true,
    'backdated_reason', 'late entry',
    'idempotency_key', 'k14a',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-BACKDATE-STAFF',
      'total_dirham', 100, 'received_dirham', 0, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  '42501', null,
  'a backdated batch submitted by non-owner staff is rejected'
);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select lives_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', (current_date - 1)::text,
    'is_backdated', true,
    'backdated_reason', 'late entry',
    'idempotency_key', 'k14b',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id', 'r1', 'invoice_number', 'SB-BACKDATE-OWNER',
      'total_dirham', 100, 'received_dirham', 0, 'payment_method', 'cash',
      'delivered', false, 'customer', null
    ))
  ))$$,
  'a backdated batch submitted by the owner succeeds'
);
reset role;

-- 15. Canonical fingerprint: changes with content, stable across replay, stable across casing. ----

select isnt(
  private.canonical_batch_command('10000000-0000-4000-8000-000000000001', current_date, false, null,
    jsonb_build_array(jsonb_build_object('row_id','r1','invoice_number','A','total_dirham',100,'received_dirham',0))),
  private.canonical_batch_command('10000000-0000-4000-8000-000000000001', current_date, false, null,
    jsonb_build_array(jsonb_build_object('row_id','r1','invoice_number','B','total_dirham',100,'received_dirham',0))),
  'the canonical command changes when a row''s invoice number changes'
);
select is(
  private.canonical_batch_command('10000000-0000-4000-8000-000000000001', current_date, false, null,
    jsonb_build_array(jsonb_build_object('row_id','r1','invoice_number','A','total_dirham',100,'received_dirham',0))),
  private.canonical_batch_command('10000000-0000-4000-8000-000000000001', current_date, false, null,
    jsonb_build_array(jsonb_build_object('row_id','r1','invoice_number','A','total_dirham',100,'received_dirham',0))),
  'the canonical command is stable across an exact semantic replay'
);
select isnt(
  private.canonical_batch_command('10000000-0000-4000-8000-000000000001', current_date, false, null,
    jsonb_build_array(jsonb_build_object('row_id','r1','invoice_number','ABC-1','total_dirham',100,'received_dirham',0))),
  private.canonical_batch_command('10000000-0000-4000-8000-000000000001', current_date, false, null,
    jsonb_build_array(jsonb_build_object('row_id','r1','invoice_number','abc-1','total_dirham',100,'received_dirham',0))),
  'the canonical command preserves invoice-number display casing, so a retry differing only by casing fingerprints differently'
);
select is(
  private.canonical_batch_command('10000000-0000-4000-8000-000000000001', current_date, false, null,
    jsonb_build_array(jsonb_build_object('row_id','r1','invoice_number','A','total_dirham',100,'received_dirham',0,'payment_method','cash'))),
  private.canonical_batch_command('10000000-0000-4000-8000-000000000001', current_date, false, null,
    jsonb_build_array(jsonb_build_object('row_id','r1','invoice_number','A','total_dirham',100,'received_dirham',0,'payment_method',null))),
  'when received_dirham is zero, differing payment_method representations do not change the canonical command'
);

-- 16. More malformed-shape and type/overflow cases, each rejected structurally. ----

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k16-row-shape',
    'rows', jsonb_build_array('just a string')
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-object row is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k16-dup-row-id',
    'rows', jsonb_build_array(
      jsonb_build_object('row_id','dup','invoice_number','SB-DUP-ROW-ID-1','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null),
      jsonb_build_object('row_id','dup','invoice_number','SB-DUP-ROW-ID-2','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null)
    )
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a duplicate row_id within one batch is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k16-case-dup',
    'rows', jsonb_build_array(
      jsonb_build_object('row_id','r1','invoice_number','CASE-DUP','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null),
      jsonb_build_object('row_id','r2','invoice_number','case-dup','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null)
    )
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a within-batch case-variant duplicate invoice number is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k16-bad-uuid',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-UUID','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,
      'customer', jsonb_build_object('type','existing','customer_id','not-a-uuid')
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a malformed customer_id UUID is rejected structurally, not as a raw cast error'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', 'not-a-date',
    'idempotency_key', 'k16-bad-date',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-DATE','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a malformed business_date is rejected structurally, not as a raw cast error'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k16-bad-bool',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-BOOL','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered','banana','customer',null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-boolean delivered value is rejected structurally, not as a raw cast error'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k16-overflow',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-OVERFLOW','total_dirham',99999999999999999999999999,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a total_dirham beyond 64-bit range is rejected structurally, not as a raw overflow error'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k16-fraction',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-FRACTION','total_dirham',100.5,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a fractional total_dirham is rejected structurally, not as a raw cast error'
);
reset role;

-- 17. A single invalid row rolls back a multi-row batch entirely (customers, invoices, payments, audit). ----

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k17',
    'rows', jsonb_build_array(
      jsonb_build_object('row_id','r1','invoice_number','SB-ROLLBACK-1','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',jsonb_build_object('type','quick_add','name','Rollback Customer','mobile',null)),
      jsonb_build_object('row_id','r2','invoice_number','SB-ROLLBACK-2','total_dirham',0,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null)
    )
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a batch with one invalid row is rejected in full'
);
select is(
  (select count(*)::int from public.invoices where invoice_id in ('SB-ROLLBACK-1','SB-ROLLBACK-2')),
  0,
  'no invoice from the rolled-back batch was persisted'
);
select is(
  (select count(*)::int from public.customers where name = 'Rollback Customer'),
  0,
  'the quick-add customer from the rolled-back batch was not persisted'
);
select is(
  (select count(*)::int from public.audit_events where entity_type = 'batch' and (metadata ->> 'idempotency_key') = 'k17'),
  0,
  'no audit event was recorded for the rolled-back batch'
);

-- 18. Existing-registry prevalidation rejects a multi-row batch entirely, before any write, ----
--     even though an earlier row's quick-add customer and initial payment were fully prepared.
--     (SB-0001 was registered by test group 3 above and is already committed, so this batch is
--     rejected by the advisory prevalidation query — not by the write-loop's unique_violation
--     catch, which this fixture never reaches, since nothing is written until prevalidation
--     passes. This test does not claim to exercise the write-loop's own unique-constraint catch;
--     that path can only be exercised by a genuine cross-session race, which the Task 5
--     integration suite covers separately with two real connections.)

select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k18',
    'rows', jsonb_build_array(
      jsonb_build_object('row_id','r1','invoice_number','SB-MIDWRITE-1','total_dirham',5000,'received_dirham',2000,'payment_method','cash','delivered',false,'customer',jsonb_build_object('type','quick_add','name','Midwrite Customer','mobile',null)),
      jsonb_build_object('row_id','r2','invoice_number','SB-0001','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null)
    )
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'existing-registry prevalidation rejects a multi-row batch in full before any write, even with an earlier row fully prepared'
);
select is(
  (select count(*)::int from public.customers where name = 'Midwrite Customer'),
  0,
  'the earlier row''s quick-add customer was not persisted'
);
select is(
  (select count(*)::int from public.invoices where invoice_id = 'SB-MIDWRITE-1'),
  0,
  'the earlier row''s invoice was not persisted'
);
select is(
  (select count(*)::int from public.payments p join public.invoices i on i.id = p.invoice_id where i.invoice_id = 'SB-MIDWRITE-1'),
  0,
  'the earlier row''s initial payment was not persisted'
);
select is(
  (select count(*)::int from public.invoice_number_registry where shop_id = '10000000-0000-4000-8000-000000000001' and normalized_invoice_number = 'sb-0001'),
  1,
  'the pre-existing registry reservation is unaffected, and no second one was created'
);
select is(
  (select count(*)::int from public.audit_events where entity_type = 'batch' and (metadata ->> 'idempotency_key') = 'k18'),
  0,
  'no audit event was recorded for the rejected batch'
);
reset role;

-- 19. Focused type-validation tests for fields tightened in this revision. ----

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 12345,
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-KEY-TYPE','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-string idempotency_key is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k19-backdated-reason-type',
    'is_backdated', false,
    'backdated_reason', 12345,
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-REASON-TYPE','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-string, non-null backdated_reason is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k19-note-type',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-NOTE-TYPE','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'note',12345,'customer',null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-string, non-null note is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k19-method-type',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-METHOD-TYPE','total_dirham',100,'received_dirham',0,'payment_method',12345,'delivered',false,'customer',null
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a non-string, non-null payment_method is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k19-existing-extra-key',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-EXISTING-KEYS','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,
      'customer', jsonb_build_object('type','existing','customer_id','c9000000-0000-4000-8000-000000000001','name','Should Not Be Here')
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'an existing-customer reference with an extra name field is rejected'
);
select throws_ok(
  $$select public.submit_batch(jsonb_build_object(
    'shop_id', '10000000-0000-4000-8000-000000000001',
    'business_date', current_date::text,
    'idempotency_key', 'k19-quickadd-extra-key',
    'rows', jsonb_build_array(jsonb_build_object(
      'row_id','r1','invoice_number','SB-BAD-QUICKADD-KEYS','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,
      'customer', jsonb_build_object('type','quick_add','name','Extra Key Customer','customer_id','c9000000-0000-4000-8000-000000000001')
    ))
  ))$$,
  'P0001', 'BATCH_VALIDATION_FAILED',
  'a quick-add customer with an extra customer_id field is rejected'
);
reset role;

-- 20. Response row order preserves submission order. ----

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select is(
  (
    select array_agg(row_value ->> 'row_id' order by ord)
    from jsonb_array_elements(
      (public.submit_batch(jsonb_build_object(
        'shop_id', '10000000-0000-4000-8000-000000000001',
        'business_date', current_date::text,
        'idempotency_key', 'k20-order',
        'rows', jsonb_build_array(
          jsonb_build_object('row_id','order-r1','invoice_number','SB-ORDER-1','total_dirham',100,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null),
          jsonb_build_object('row_id','order-r2','invoice_number','SB-ORDER-2','total_dirham',200,'received_dirham',0,'payment_method','cash','delivered',false,'customer',null)
        )
      )) -> 'rows')
    ) with ordinality as t(row_value, ord)
  ),
  array['order-r1', 'order-r2'],
  'the response rows array preserves the order rows were submitted in'
);
reset role;

select * from finish();
rollback;
```

Register it with the Supabase CLI test runner the same way `schema.test.sql`/`rls.test.sql` already are (no config change needed — `supabase test db --local` runs every `supabase/tests/*.test.sql` file automatically).

Also **modify** the existing `rls.test.sql` assertion (currently ~line 547) that asserts `submit_batch` does **not** exist yet — it is written specifically to guard Task 4 of the V1 plan against premature Phase 3 implementation, and must now assert the opposite for `submit_batch` while continuing to guard against out-of-scope functions:

```sql
select ok(
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'submit_batch'
  )
  and not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prokind = 'f'
      and p.proname in ('record_payment', 'approve_overpayment', 'create_expense')
  ),
  'Phase 3A implements submit_batch only, not later financial commands'
);
```

### Step 2: Confirm failure

```powershell
pnpm.cmd exec supabase db reset --local
pnpm.cmd exec supabase test db --local supabase/tests/submit_batch.test.sql
```

(`supabase test db` takes test paths as trailing positional arguments in Supabase CLI 2.115.0 — there is no `--file` flag.)

Expected: FAIL — `public.submit_batch` and `private.canonical_batch_command` do not exist. The modified `rls.test.sql` assertion also fails (function absent).

### Step 3: Implement the migration

```sql
create or replace function private.normalize_optional_text(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(coalesce(value, '')), '');
$$;

create or replace function private.is_valid_uuid_text(value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select value is not null
    and value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;

create or replace function private.is_valid_date_text(value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if value is null or value !~ '^\d{4}-\d{2}-\d{2}$' then
    return false;
  end if;
  perform value::date;
  return true;
exception
  when others then
    return false;
end;
$$;

create or replace function private.is_safe_bigint_jsonb(value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if value is null or jsonb_typeof(value) <> 'number' then
    return false;
  end if;
  if (value::text) !~ '^-?\d+$' then
    return false;
  end if;
  return (value::text)::numeric between (-9223372036854775808)::numeric and 9223372036854775807::numeric;
exception
  when others then
    return false;
end;
$$;

create or replace function private.jsonb_object_keys_subset(value jsonb, allowed text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(value) = 'object'
    and not exists (
      select 1 from jsonb_object_keys(value) k where not (k = any(allowed))
    );
$$;

create or replace function private.canonical_batch_command(
  p_shop_id uuid,
  p_business_date date,
  p_is_backdated boolean,
  p_backdated_reason text,
  p_rows jsonb
) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'shop_id', p_shop_id,
    'business_date', p_business_date,
    'backdated_reason', private.normalize_optional_text(p_backdated_reason),
    'rows', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'row_id', row_value ->> 'row_id',
          'invoice_number', btrim(coalesce(row_value ->> 'invoice_number', '')),
          'total_dirham', (row_value ->> 'total_dirham')::bigint,
          'received_dirham', coalesce((row_value ->> 'received_dirham')::bigint, 0),
          'payment_method', case
            when coalesce((row_value ->> 'received_dirham')::bigint, 0) > 0 then row_value ->> 'payment_method'
            else 'cash'
          end,
          'delivered', coalesce((row_value ->> 'delivered')::boolean, false),
          'note', private.normalize_optional_text(row_value ->> 'note'),
          'customer_type', row_value -> 'customer' ->> 'type',
          'customer_id', row_value -> 'customer' ->> 'customer_id',
          'customer_name', private.normalize_optional_text(row_value -> 'customer' ->> 'name'),
          'customer_mobile', private.normalize_optional_text(row_value -> 'customer' ->> 'mobile')
        )
        order by ordinality
      ), '[]'::jsonb)
      from jsonb_array_elements(p_rows) with ordinality as t(row_value, ordinality)
    )
  );
$$;

create or replace function public.submit_batch(command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_shop_id_text text;
  v_shop_id uuid;
  v_business_date_text text;
  v_business_date date;
  v_is_backdated boolean;
  v_backdated_reason text;
  v_idempotency_key text;
  v_rows jsonb;
  v_row jsonb;
  v_idx integer;
  v_row_id text;
  v_display_number text;
  v_normalized_number text;
  v_total bigint;
  v_received bigint;
  v_payment_method text;
  v_delivered boolean;
  v_note text;
  v_customer jsonb;
  v_customer_type text;
  v_customer_id_text text;
  v_customer_id uuid;
  v_customer_name text;
  v_customer_mobile text;
  v_seen_row_ids text[] := '{}';
  v_seen_numbers text[] := '{}';
  v_row_errors jsonb := '[]'::jsonb;
  v_prepared jsonb := '[]'::jsonb;
  v_prepared_row jsonb;
  v_batch_id uuid := gen_random_uuid();
  v_recorded_at timestamptz := now();
  v_fingerprint text;
  v_lock_key bigint;
  v_existing record;
  v_close_state text;
  v_row_results jsonb;
  v_result jsonb;
  v_prepared_customer_id uuid;
  v_prepared_payment_id uuid;
  v_conflicting_numbers text[];
  v_registry_conflicts jsonb;
begin
  if v_actor_id is null or not private.is_active_actor() then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000';
  end if;

  select p.role into v_actor_role from public.profiles p where p.id = v_actor_id;

  if jsonb_typeof(command) is distinct from 'object' then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'request', 'code', 'REQUEST_INVALID', 'message', 'The command must be a JSON object.'))::text;
  end if;

  if not private.jsonb_object_keys_subset(command, array['shop_id','business_date','is_backdated','backdated_reason','idempotency_key','rows']) then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'request', 'code', 'REQUEST_INVALID', 'message', 'The command contains an unsupported field.'))::text;
  end if;

  v_shop_id_text := command ->> 'shop_id';

  if jsonb_typeof(command -> 'idempotency_key') is distinct from 'string' then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'idempotency_key', 'code', 'REQUEST_INVALID', 'message', 'idempotency_key must be a JSON string.'))::text;
  end if;
  v_idempotency_key := command ->> 'idempotency_key';

  if not private.is_valid_uuid_text(v_shop_id_text) or btrim(v_idempotency_key) = '' then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'request', 'code', 'REQUEST_INVALID', 'message', 'shop_id must be a UUID and idempotency_key is required.'))::text;
  end if;
  v_shop_id := v_shop_id_text::uuid;

  if not private.has_shop_access(v_shop_id) then
    raise exception 'UNAUTHORIZED_SHOP' using errcode = '42501';
  end if;

  v_business_date_text := command ->> 'business_date';
  if not private.is_valid_date_text(v_business_date_text) then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'business_date', 'code', 'REQUEST_INVALID', 'message', 'business_date must be a valid YYYY-MM-DD date.'))::text;
  end if;
  v_business_date := v_business_date_text::date;

  if command ? 'is_backdated' and jsonb_typeof(command -> 'is_backdated') <> 'boolean' then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'is_backdated', 'code', 'REQUEST_INVALID', 'message', 'is_backdated must be a boolean.'))::text;
  end if;
  v_is_backdated := coalesce((command ->> 'is_backdated')::boolean, false);

  if command ? 'backdated_reason' and jsonb_typeof(command -> 'backdated_reason') not in ('string', 'null') then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'backdated_reason', 'code', 'REQUEST_INVALID', 'message', 'backdated_reason must be a string or null.'))::text;
  end if;
  v_backdated_reason := private.normalize_optional_text(command ->> 'backdated_reason');

  if v_business_date > current_date then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'business_date', 'code', 'FUTURE_DATE_NOT_ALLOWED', 'message', 'Business date cannot be in the future.'))::text;
  end if;

  if v_business_date < current_date then
    if v_actor_role is distinct from 'owner' then
      raise exception 'INSUFFICIENT_ROLE' using errcode = '42501';
    end if;
    if not v_is_backdated or v_backdated_reason is null then
      raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
        detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'backdated_reason', 'code', 'BACKDATE_REASON_REQUIRED', 'message', 'A reason is required to submit a backdated batch.'))::text;
    end if;
  elsif v_is_backdated then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'is_backdated', 'code', 'BACKDATE_FLAG_INVALID', 'message', 'is_backdated may only be true for a date before today.'))::text;
  end if;

  select d.event_type into v_close_state
  from public.daily_closes d
  where d.shop_id = v_shop_id and d.business_date = v_business_date
  order by d.event_sequence desc
  limit 1;

  if v_close_state = 'closed' then
    raise exception 'CLOSED_DATE' using errcode = 'P0001';
  end if;

  if not (command ? 'rows') or jsonb_typeof(command -> 'rows') <> 'array' then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'rows', 'code', 'REQUEST_INVALID', 'message', 'rows must be a JSON array.'))::text;
  end if;
  v_rows := command -> 'rows';

  if jsonb_array_length(v_rows) = 0 then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'rows', 'code', 'BATCH_EMPTY', 'message', 'A batch must contain at least one row.'))::text;
  end if;

  for v_idx in 0 .. jsonb_array_length(v_rows) - 1 loop
    v_row := v_rows -> v_idx;

    if jsonb_typeof(v_row) <> 'object' then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', null, 'field', 'row', 'code', 'REQUEST_INVALID', 'message', 'Every row must be a JSON object.');
      continue;
    end if;

    if not private.jsonb_object_keys_subset(v_row, array['row_id','invoice_number','total_dirham','received_dirham','payment_method','delivered','note','customer']) then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row ->> 'row_id', 'field', 'row', 'code', 'REQUEST_INVALID', 'message', 'Row contains an unsupported field.');
      continue;
    end if;

    v_row_id := case when jsonb_typeof(v_row -> 'row_id') = 'string' then v_row ->> 'row_id' else null end;

    if v_row_id is null or btrim(v_row_id) = '' then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row ->> 'row_id', 'field', 'row_id', 'code', 'ROW_ID_REQUIRED', 'message', 'Every row requires a stable client row id.');
    elsif v_row_id = any(v_seen_row_ids) then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'row_id', 'code', 'ROW_ID_DUPLICATE', 'message', 'row_id is duplicated within this batch.');
    else
      v_seen_row_ids := v_seen_row_ids || v_row_id;
    end if;

    v_display_number := case when jsonb_typeof(v_row -> 'invoice_number') = 'string' then btrim(v_row ->> 'invoice_number') else null end;
    v_normalized_number := case when v_display_number is not null then lower(v_display_number) else null end;

    if v_display_number is null or v_display_number = '' then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'invoice_number', 'code', 'INVOICE_NUMBER_REQUIRED', 'message', 'Invoice number is required.');
    elsif v_normalized_number = any(v_seen_numbers) then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'invoice_number', 'code', 'DUPLICATE_INVOICE', 'message', 'Invoice number is duplicated within this batch.');
    else
      v_seen_numbers := v_seen_numbers || v_normalized_number;
    end if;

    if private.is_safe_bigint_jsonb(v_row -> 'total_dirham') then
      v_total := (v_row ->> 'total_dirham')::bigint;
    else
      v_total := null;
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'total_dirham', 'code', 'AMOUNT_INVALID', 'message', 'Total must be a whole number of dirham representable as a 64-bit integer.');
    end if;
    if v_total is not null and v_total <= 0 then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'total_dirham', 'code', 'AMOUNT_INVALID', 'message', 'Total must be a positive whole number of dirham.');
    end if;

    if not (v_row ? 'received_dirham') or jsonb_typeof(v_row -> 'received_dirham') = 'null' then
      v_received := 0;
    elsif private.is_safe_bigint_jsonb(v_row -> 'received_dirham') then
      v_received := (v_row ->> 'received_dirham')::bigint;
    else
      v_received := null;
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'received_dirham', 'code', 'AMOUNT_INVALID', 'message', 'Received must be a whole number of dirham representable as a 64-bit integer.');
    end if;
    if v_received is not null and (v_received < 0 or (v_total is not null and v_received > v_total)) then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'received_dirham', 'code', 'AMOUNT_INVALID', 'message', 'Received must be between zero and the total.');
    end if;

    if v_row ? 'payment_method' and jsonb_typeof(v_row -> 'payment_method') not in ('string', 'null') then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'payment_method', 'code', 'REQUEST_INVALID', 'message', 'payment_method must be a string or null.');
      v_payment_method := null;
    else
      v_payment_method := v_row ->> 'payment_method';
    end if;
    if v_received is not null and v_received > 0 and v_payment_method is distinct from 'cash' then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'payment_method', 'code', 'PAYMENT_METHOD_INVALID', 'message', 'Only the cash payment method is supported.');
    end if;

    if v_row ? 'delivered' and jsonb_typeof(v_row -> 'delivered') <> 'boolean' then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'delivered', 'code', 'REQUEST_INVALID', 'message', 'delivered must be a boolean.');
      v_delivered := false;
    else
      v_delivered := coalesce((v_row ->> 'delivered')::boolean, false);
    end if;

    if v_row ? 'note' and jsonb_typeof(v_row -> 'note') not in ('string', 'null') then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'note', 'code', 'REQUEST_INVALID', 'message', 'note must be a string or null.');
      v_note := null;
    else
      v_note := private.normalize_optional_text(v_row ->> 'note');
    end if;

    v_customer := v_row -> 'customer';
    v_customer_type := null;
    v_customer_id := null;
    v_customer_name := null;
    v_customer_mobile := null;

    if v_customer is null or jsonb_typeof(v_customer) = 'null' then
      null; -- no customer supplied; valid.
    elsif jsonb_typeof(v_customer) <> 'object' then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_REFERENCE_INVALID', 'message', 'customer must be a JSON object or null.');
    elsif not private.jsonb_object_keys_subset(v_customer, array['type','customer_id','name','mobile']) then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_REFERENCE_INVALID', 'message', 'customer contains an unsupported field.');
    else
      v_customer_type := case when jsonb_typeof(v_customer -> 'type') = 'string' then v_customer ->> 'type' else null end;

      if v_customer_type = 'existing' then
        v_customer_id_text := case when jsonb_typeof(v_customer -> 'customer_id') = 'string' then v_customer ->> 'customer_id' else null end;
        if not private.is_valid_uuid_text(v_customer_id_text) then
          v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_REFERENCE_INVALID', 'message', 'customer_id must be a UUID.');
        else
          v_customer_id := v_customer_id_text::uuid;
          if not exists (select 1 from public.customers c where c.id = v_customer_id and c.shop_id = v_shop_id) then
            v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_NOT_FOUND', 'message', 'Customer was not found in this shop.');
            v_customer_id := null;
          end if;
        end if;
      elsif v_customer_type = 'quick_add' then
        if (v_customer ? 'name' and jsonb_typeof(v_customer -> 'name') not in ('string', 'null'))
          or (v_customer ? 'mobile' and jsonb_typeof(v_customer -> 'mobile') not in ('string', 'null')) then
          v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_REFERENCE_INVALID', 'message', 'name and mobile must be strings when present.');
        else
          v_customer_name := private.normalize_optional_text(v_customer ->> 'name');
          v_customer_mobile := private.normalize_optional_text(v_customer ->> 'mobile');
          if v_customer_name is null and v_customer_mobile is null then
            v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_IDENTIFIER_REQUIRED', 'message', 'A quick-add customer needs a name or mobile number.');
          end if;
        end if;
      else
        v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_REFERENCE_INVALID', 'message', 'customer.type must be existing or quick_add.');
      end if;
    end if;

    if v_delivered and v_total is not null and v_received is not null and (v_total - v_received) > 0 and v_customer_type is null then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_REQUIRED', 'message', 'A customer is required for a delivered invoice with due.');
    end if;

    if v_received is null then
      v_received := 0; -- keep downstream arithmetic well-defined; this row already carries an AMOUNT_INVALID error
    end if;

    v_prepared_customer_id := case when v_customer_type = 'quick_add' then gen_random_uuid() else v_customer_id end;
    v_prepared_payment_id := case when v_received > 0 then gen_random_uuid() else null end;

    v_prepared := v_prepared || jsonb_build_object(
      'row_id', v_row_id,
      'invoice_id', gen_random_uuid(),
      'invoice_number', v_display_number,
      'total', v_total,
      'received', v_received,
      'delivered', v_delivered,
      'note', v_note,
      'customer_type', v_customer_type,
      'customer_id', v_prepared_customer_id,
      'customer_name', v_customer_name,
      'customer_mobile', v_customer_mobile,
      'payment_id', v_prepared_payment_id
    );
  end loop;

  if jsonb_array_length(v_row_errors) > 0 then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001', detail = v_row_errors::text;
  end if;

  -- Every scalar in v_rows is now known to be well-shaped, so this cast-heavy
  -- helper is safe to call.
  v_fingerprint := encode(
    extensions.digest(
      private.canonical_batch_command(v_shop_id, v_business_date, v_is_backdated, v_backdated_reason, v_rows)::text::bytea,
      'sha256'
    ),
    'hex'
  );

  -- Serialize concurrent calls for this exact (shop_id, idempotency_key) so
  -- the existing-row check below — not the batches INSERT's unique
  -- constraint — is what a concurrent identical or conflicting retry
  -- observes. See "Design decisions", item 4.
  v_lock_key := hashtextextended(v_shop_id::text || ':' || v_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  select b.fingerprint, b.idempotency_result into v_existing
  from public.batches b
  where b.shop_id = v_shop_id and b.idempotency_key = v_idempotency_key;

  if found then
    if v_existing.fingerprint = v_fingerprint then
      return v_existing.idempotency_result;
    end if;
    raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'P0001';
  end if;

  -- Advisory-only: reject a doomed batch before creating anything for it.
  -- The registry's own unique constraint in the write loop below remains
  -- the authoritative defense against a genuinely concurrent registration.
  select array_agg(distinct r.normalized_invoice_number)
  into v_conflicting_numbers
  from public.invoice_number_registry r
  where r.shop_id = v_shop_id
    and r.normalized_invoice_number = any(v_seen_numbers);

  if v_conflicting_numbers is not null then
    select jsonb_agg(jsonb_build_object(
      'row_id', p ->> 'row_id', 'field', 'invoice_number',
      'code', 'INVOICE_NUMBER_ALREADY_REGISTERED',
      'message', 'This invoice number already exists in this shop.'
    ))
    into v_registry_conflicts
    from jsonb_array_elements(v_prepared) p
    where lower(p ->> 'invoice_number') = any(v_conflicting_numbers);

    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001', detail = v_registry_conflicts::text;
  end if;

  -- WITH ORDINALITY + ORDER BY ordinality: jsonb_agg over a bare
  -- jsonb_array_elements() is not documented to preserve array order, so
  -- the response's `rows` array is made to preserve submitted row order
  -- explicitly rather than relying on incidental iteration order.
  select jsonb_agg(jsonb_build_object(
    'row_id', p ->> 'row_id',
    'invoice_id', p ->> 'invoice_id',
    'invoice_number', p ->> 'invoice_number',
    'customer_id', p ->> 'customer_id',
    'payment_id', p ->> 'payment_id'
  ) order by ord) into v_row_results
  from jsonb_array_elements(v_prepared) with ordinality as t(p, ord);

  v_result := jsonb_build_object(
    'ok', true,
    'batch_id', v_batch_id,
    'recorded_at', to_char(v_recorded_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'rows', v_row_results
  );

  insert into public.batches (
    id, shop_id, business_date, is_backdated, backdated_reason,
    idempotency_key, fingerprint, idempotency_result, created_by, recorded_at
  ) values (
    v_batch_id, v_shop_id, v_business_date, v_is_backdated, v_backdated_reason,
    v_idempotency_key, v_fingerprint, v_result, v_actor_id, v_recorded_at
  );

  for v_idx in 0 .. jsonb_array_length(v_prepared) - 1 loop
    v_prepared_row := v_prepared -> v_idx;

    if v_prepared_row ->> 'customer_type' = 'quick_add' then
      insert into public.customers (id, shop_id, name, mobile, created_by)
      values (
        (v_prepared_row ->> 'customer_id')::uuid, v_shop_id,
        v_prepared_row ->> 'customer_name', v_prepared_row ->> 'customer_mobile', v_actor_id
      );
    end if;

    insert into public.invoices (
      id, shop_id, batch_id, customer_id, invoice_id, delivered, note,
      total_amount_dirham, business_date, created_by, recorded_at
    ) values (
      (v_prepared_row ->> 'invoice_id')::uuid, v_shop_id, v_batch_id,
      nullif(v_prepared_row ->> 'customer_id', '')::uuid,
      v_prepared_row ->> 'invoice_number', (v_prepared_row ->> 'delivered')::boolean,
      v_prepared_row ->> 'note', (v_prepared_row ->> 'total')::bigint,
      v_business_date, v_actor_id, v_recorded_at
    );

    begin
      insert into public.invoice_number_registry (shop_id, invoice_number, canonical_invoice_id)
      values (v_shop_id, v_prepared_row ->> 'invoice_number', (v_prepared_row ->> 'invoice_id')::uuid);
    exception
      when unique_violation then
        raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
          detail = jsonb_build_array(jsonb_build_object(
            'row_id', v_prepared_row ->> 'row_id', 'field', 'invoice_number',
            'code', 'INVOICE_NUMBER_ALREADY_REGISTERED', 'message', 'This invoice number already exists in this shop.'
          ))::text;
    end;

    if (v_prepared_row ->> 'payment_id') is not null then
      insert into public.payments (
        id, shop_id, batch_id, invoice_id, amount_dirham, business_date, payment_method, created_by, recorded_at
      ) values (
        (v_prepared_row ->> 'payment_id')::uuid, v_shop_id, v_batch_id,
        (v_prepared_row ->> 'invoice_id')::uuid, (v_prepared_row ->> 'received')::bigint,
        v_business_date, 'cash', v_actor_id, v_recorded_at
      );
    end if;
  end loop;

  insert into public.audit_events (shop_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_shop_id, v_actor_id, 'batch.submit', 'batch', v_batch_id::text,
    jsonb_build_object('idempotency_key', v_idempotency_key, 'row_count', jsonb_array_length(v_rows))
  );

  return v_result;
end;
$$;

revoke all on function public.submit_batch(jsonb) from public, anon;
grant execute on function public.submit_batch(jsonb) to authenticated;
```

### Step 4: Confirm success

```powershell
pnpm.cmd exec supabase db reset --local
pnpm.cmd exec supabase test db --local
```

Expected: 120 schema assertions, 40 RLS assertions, and 57 `submit_batch` assertions all pass.

### Step 5: Commit

```powershell
git add supabase/migrations/20260916120300_submit_batch_rpc.sql supabase/tests/submit_batch.test.sql supabase/tests/rls.test.sql
git commit -m "feat: implement submit_batch security-definer RPC with full authorization boundary"
```

**Preserved from the approved design (unchanged by this revision):** `invoices.delivered`; the invoice-only `note` column (never on `batches`/`payments`); `total_amount_dirham > 0`; future-date rejection; append-only, event-sequence-ordered `daily_closes` evaluation; owner-only backdating; and the update to the obsolete "`submit_batch` must not exist" `rls.test.sql` assertion. This revision only changed *how* several of these are validated (raw-shape checks before casts, normalized invoice-number comparisons, advisory-lock-guarded idempotency) — not what they require.

---

## Task 5 — Integration-test harness: owner local credential and `submit-batch.test.ts`

**Why:** pgTAP proves the RPC's authorization/validation logic at the SQL level via spoofed `request.jwt.claims`. It cannot prove the RPC is safe when called over real PostgREST with a real session, cannot exercise genuine concurrency (two simultaneous connections racing for the same idempotency key or invoice number), and cannot prove a written row is actually readable back through RLS as the submitting actor. `staff1@shopkhata.local` is the only seeded account with a real local password today (`supabase/seed.sql`); the owner-only backdate path needs a real owner session too.

**Files:**
- Modify: `supabase/seed.sql`
- Create: `tests/integration/batches/submit-batch.test.ts`
- Create: `vitest.integration.batches.config.mts`
- Modify: `package.json`

### Step 1: Write the failing integration test and harness config, without touching the owner credential yet

This step deliberately does **not** modify `supabase/seed.sql` — that is Step 3, after this step's RED is confirmed for the right reason (the owner cannot sign in), not for an unrelated reason like a missing config file.

**`vitest.integration.batches.config.mts`** (new, mirrors `vitest.integration.config.mts`):

```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/integration/batches/**/*.test.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
    maxWorkers: 1,
    pool: "forks",
  },
});
```

**`package.json`** — add a script:

```jsonc
"test:integration:batches": "vitest run --config vitest.integration.batches.config.mts"
```

**`tests/integration/batches/submit-batch.test.ts`** (new). Copy the `run`, `runSupabase`, and `isSupabaseRunning` helpers from `tests/integration/migration/upgrade-path.test.ts` **verbatim** (same `cmd.exe`/`pnpm.cmd` wrapper, `--agent no`, argument arrays, finite timeouts, captured stdout/stderr, prerequisite check via `isSupabaseRunning`) instead of hand-rolling a simpler subprocess call — this repo keeps each integration test file self-contained, so copy rather than import:

```ts
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
```

### Step 2: Confirm failure

```powershell
pnpm.cmd exec supabase start
pnpm.cmd test:integration:batches
```

Expected: FAIL, and specifically because the owner cannot sign in yet (`encrypted_password` is still `''` for `owner@shopkhata.local`) — the backdate and two-shops tests reject with an auth error. Every other test may already pass, since Task 4 is GREEN; that is fine and still counts as genuine RED for the harness piece this step introduces (the owner credential).

### Step 3: Apply the seed change

**`supabase/seed.sql`** — give `owner@shopkhata.local` a real local-only password, mirroring the existing `staff1` pattern exactly:

```sql
-- in the auth.users VALUES list, change the owner row's encrypted_password from '' to:
crypt('ShopKhata-Local-Owner-E2E-Only-2026!', gen_salt('bf')),
```

```sql
-- extend the ON CONFLICT DO UPDATE CASE expressions to also refresh the owner's credential on reset:
  encrypted_password = case
    when auth.users.id in (
      '10000000-0000-4000-8000-000000000101',
      '10000000-0000-4000-8000-000000000102'
    ) then excluded.encrypted_password
    else auth.users.encrypted_password
  end,
  email_confirmed_at = case
    when auth.users.id in (
      '10000000-0000-4000-8000-000000000101',
      '10000000-0000-4000-8000-000000000102'
    ) then excluded.email_confirmed_at
    else auth.users.email_confirmed_at
  end,
```

```sql
-- add an auth.identities row for the owner, mirroring the existing staff1 identity insert:
insert into auth.identities (
  id, user_id, identity_data, provider, provider_id, created_at, updated_at, last_sign_in_at
) values (
  '20000000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000101',
  '{"sub":"10000000-0000-4000-8000-000000000101","email":"owner@shopkhata.local"}',
  'email', '10000000-0000-4000-8000-000000000101', now(), now(), now()
)
on conflict (provider_id, provider) do update set
  id = excluded.id, user_id = excluded.user_id, identity_data = excluded.identity_data,
  created_at = excluded.created_at, updated_at = excluded.updated_at, last_sign_in_at = excluded.last_sign_in_at;
```

### Step 4: Confirm success

```powershell
pnpm.cmd exec supabase db reset --local
pnpm.cmd test:integration:batches
```

Expected: all 8 tests in `submit-batch.test.ts` pass.

### Step 5: Commit

```powershell
git add supabase/seed.sql tests/integration/batches/submit-batch.test.ts vitest.integration.batches.config.mts package.json
git commit -m "test: add real-session integration coverage for submit_batch"
```

---

## Task 6 — Regenerate `lib/supabase/database.types.ts`

**Why:** The generated types currently declare `Functions: { [_ in never]: never }` for `public` (no RPC exists yet) and have no `invoice_number_registry` table or new `invoices`/`batches` columns. This must happen only after Task 5 is GREEN, per the established Phase 2 convention, using the pinned CLI, writing strict UTF-8 with no BOM and exactly one trailing newline.

**Files:**
- Modify: `lib/supabase/database.types.ts` (generated; no hand edits)

### Step 1: Regenerate

```powershell
pnpm.cmd exec supabase db reset --local
$generated = (pnpm.cmd exec supabase gen types typescript --local) -join "`n"
$normalized = $generated.TrimEnd("`r", "`n") + "`n"
$targetPath = (Resolve-Path "lib/supabase/database.types.ts").Path
[System.IO.File]::WriteAllText($targetPath, $normalized, [System.Text.UTF8Encoding]::new($false))
```

### Step 2: Verify

```powershell
Get-Content lib/supabase/database.types.ts -Raw | Select-String -Pattern "submit_batch|invoice_number_registry" | Select-Object -First 5
[System.IO.File]::ReadAllBytes("lib/supabase/database.types.ts") | Select-Object -First 3
```

Expected: the file references `submit_batch` (under `public.Functions`) and `invoice_number_registry` (under `public.Tables`); the first bytes are not `EF BB BF` (UTF-8 BOM).

```powershell
pnpm.cmd typecheck
```

Expected: passes (no code yet consumes the new types, so this only proves the file itself is syntactically valid TypeScript).

### Step 3: Commit

```powershell
git add lib/supabase/database.types.ts
git commit -m "chore: regenerate database types for submit_batch and invoice_number_registry"
```

---

## Task 7 — CI wiring

**Why:** CI must run the new pgTAP file (automatic — `supabase test db --local` already runs every file under `supabase/tests/`), the new migration-upgrade-style backfill tests (automatic — already matched by `tests/integration/migration/**/*.test.ts`), and the new `tests/integration/batches/**` suite, which needs its own step and does **not** depend on the existing `.env.local` generation step because it fetches Supabase credentials itself via `supabase status -o env`.

**Files:**
- Modify: `.github/workflows/ci.yml`

### Step 1: Add the CI step

In the `integration` job, insert a new step after `Run database lint` and before `Create local-only SSR environment configuration`:

```yaml
      - name: Run submit_batch integration tests
        run: pnpm test:integration:batches
```

(CI runs on Linux — keep bare `pnpm` here, per the global constraints; only the PowerShell commands in this plan use `pnpm.cmd`.)

### Step 2: Verify locally

Since GitHub Actions cannot be run from this machine, verify the equivalent sequence locally in the same order CI now uses:

```powershell
pnpm.cmd exec supabase start
pnpm.cmd test:migration-upgrade
pnpm.cmd exec supabase db reset --local
pnpm.cmd exec supabase test db --local
pnpm.cmd exec supabase db lint --local --level warning --fail-on error
pnpm.cmd test:integration:batches
pnpm.cmd exec supabase stop
```

Expected: every command exits 0, in this order, matching the updated `ci.yml`.

### Step 3: Commit

```powershell
git add .github/workflows/ci.yml
git commit -m "ci: run submit_batch integration tests"
```

---

## Final verification (full regression, run once after Task 7)

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test --run
pnpm.cmd build
pnpm.cmd exec supabase start
pnpm.cmd test:migration-upgrade
pnpm.cmd exec supabase db reset --local
pnpm.cmd exec supabase test db --local
pnpm.cmd exec supabase db lint --local --level warning --fail-on error
pnpm.cmd test:integration:batches
pnpm.cmd exec playwright test tests/e2e/auth.spec.ts tests/e2e/smoke.spec.ts
pnpm.cmd audit
pnpm.cmd exec supabase stop
git diff --check
git status --short
git branch --show-current
git rev-parse --short HEAD
```

Expected: schema pgTAP 120/120, RLS pgTAP 40/40, `submit_batch` pgTAP 57/57, migration-upgrade suite 5/5, batches integration suite 8/8, unit suite unchanged and green, e2e specs unchanged and green, `pnpm audit` reports no known vulnerabilities. `git diff --check` reports no whitespace errors; `git status --short` shows a clean tree (only the plan file's own untracked/committed state as established under Global constraints); `git branch --show-current` reports `phase-3-operational-ui`; `git rev-parse --short HEAD` reports the commit this final regression was run against.

## Explicitly out of scope for Phase 3A (do not implement here)

Operational UI/navigation, invoice detail screens, duplicate-warning UI, the follow-up-payment RPC/UI, the replacement request/approval workflow and its tables, Excel import/OCR, reporting, customer ledger, daily-close UI, and any `lib/domain`/`lib/auth`/`app/`/`features/` change. The `daily_closes`-closed-date check and the future-date check inside `submit_batch` are the only pieces of "later phase" surface touched here, because the approved design requires the batch function itself to already refuse both (§11, §14.2 item 6; product spec §14.5) — no close/reopen RPC or screen is added.
