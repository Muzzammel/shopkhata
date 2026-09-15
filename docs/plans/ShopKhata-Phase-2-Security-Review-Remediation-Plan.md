# ShopKhata Phase 2 Security-Review Remediation Plan

> **For agentic workers:** Execute this plan sequentially in one ShopKhata session. Do not delegate it. Preserve genuine RED evidence before writing implementation SQL or application code.

**Goal:** Close the three independently confirmed Phase 2 security-review gaps before merging `phase-2-database` into `master`.

**Architecture:** PostgreSQL will enforce tenant-consistent relationships with composite foreign keys. `daily_closes` will become a single append-only event table containing `closed` and `reopened` events, with `event_sequence` as the authoritative deterministic event-ordering key and `recorded_at` retained as the immutable server timestamp. The root application page will move under the authenticated route group and render only the shops returned through the current user's real server-side Supabase session and RLS policies.

**Tech Stack:** PostgreSQL 17, Supabase CLI 2.115.0, pgTAP, Next.js 16.3.4, TypeScript, Supabase SSR, Playwright, Vitest.

**Spec:** `docs/product/ShopKhata-Product-Design-Specification.md`, especially Sections 12–14 and acceptance cases 12–14, 19–21.

## Global constraints

- Remain on branch `phase-2-database`; start from commit `b164910` with a clean working tree.
- Do not stage, commit, or merge the final review corrections yet.
- Do not begin Phase 3 or create financial command functions.
- Use only `pnpm exec supabase` in local mode. Never link, push, log in, or target another Supabase project.
- Do not modify Work_List or Mahira ERP.
- Keep `.env.local` ignored and never display or stage its values.
- Do not weaken append-only protections or RLS to make tests pass.
- Generate a new corrective migration with the pinned CLI; do not rewrite the three committed migrations.
- Preserve Windows-safe UTF-8 without BOM when regenerating `lib/supabase/database.types.ts`.
- Regenerate database types externally only after database GREEN; do not regenerate them during the final review corrections.

---

### Task 1: Establish genuine RED evidence for all three findings

**Files:**

- Modify: `supabase/tests/schema.test.sql`
- Modify: `tests/e2e/auth.spec.ts`

**Produces:**

- Ten behavioral tests rejecting cross-shop foreign-key relationships.
- Five behavioral tests defining the immutable, deterministically ordered daily-close event contract.
- Browser assertions requiring an authenticated server-rendered Shop 1 result and denying Shop 2 escalation through URL state.

- [ ] **Step 1: Confirm the review checkpoint**

  Run:

  ```powershell
  git branch --show-current
  git rev-parse --short HEAD
  git status --short
  ```

  Expected: branch `phase-2-database`, HEAD `b164910`, and only the approved RED-test and plan changes after they are applied.

- [ ] **Step 2: Verify the pgTAP plan count statically**

  `schema.test.sql` must declare `plan(97)`: the original 64 assertions plus ten tenant-consistency assertions, five daily-close event assertions, and the later remediation assertions.

  Run:

  ```powershell
  Select-String `
    -Path .\supabase\tests\schema.test.sql `
    -Pattern 'plan\(97\)','::regclass','::regprocedure','no_plan'
  ```

  Expected: only `plan(97)` is returned.

- [ ] **Step 3: Obtain database RED**

  Run:

  ```powershell
  pnpm exec supabase db reset --local
  pnpm exec supabase test db --local
  ```

  Expected: reset and database connection succeed. The existing 103 assertions remain healthy, while the ten cross-shop inserts are incorrectly accepted and the four daily-close event assertions fail against the old one-row mutable-status schema. SQL aborts, Docker failures, missing relations, and TAP plan errors are not valid RED.

- [ ] **Step 4: Obtain browser RED**

  Run:

  ```powershell
  pnpm test:e2e --grep "authenticates the seeded|preserves the authenticated|does not grant Shop 2" --workers=1
  ```

  Expected: authentication succeeds, but the three selected tests fail because `/` does not run under `app/(app)/layout.tsx` and does not render the RLS-filtered Shop 1 record. Browser startup, Supabase availability, or credential failures are not valid RED.

- [ ] **Step 5: Stop at RED**

  Record the exact failing assertion names and counts. Do not stage or commit RED-only work and do not write implementation until both database and browser RED are genuine.

---

### Task 2: Add tenant-consistent relational constraints

**Files:**

- Create: CLI-generated `supabase/migrations/20260902073650_phase2_security_remediation.sql`
- Test: `supabase/tests/schema.test.sql`

**Produces:** Composite foreign keys that make a child row's `shop_id` agree with every shop-owned parent.

- [ ] **Step 1: Generate the corrective migration**

  Run:

  ```powershell
  pnpm exec supabase migration new phase2_security_remediation
  Get-ChildItem .\supabase\migrations\*_phase2_security_remediation.sql |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 Name,Length
  ```

  Expected: one new zero-byte timestamped migration. Record its exact filename before editing it.

- [ ] **Step 2: Add parent composite candidate keys**

  In the new migration, add explicitly named unique constraints for:

  ```sql
  public.batches (shop_id, id)
  public.customers (shop_id, id)
  public.invoices (shop_id, id)
  public.payments (shop_id, id)
  ```

- [ ] **Step 3: Replace single-column shop-owned foreign keys**

  Drop the existing single-column foreign keys and replace them with explicitly named composite foreign keys using `on delete restrict`:

  ```text
  invoices(shop_id, batch_id)          -> batches(shop_id, id)
  invoices(shop_id, customer_id)       -> customers(shop_id, id)
  payments(shop_id, batch_id)          -> batches(shop_id, id)
  payments(shop_id, invoice_id)        -> invoices(shop_id, id)
  customer_credits(shop_id, customer_id) -> customers(shop_id, id)
  customer_credits(shop_id, invoice_id)  -> invoices(shop_id, id)
  attachments(shop_id, batch_id)       -> batches(shop_id, id)
  attachments(shop_id, invoice_id)     -> invoices(shop_id, id)
  corrections(shop_id, invoice_id)     -> invoices(shop_id, id)
  corrections(shop_id, payment_id)     -> payments(shop_id, id)
  ```

  Nullable parent IDs remain nullable through PostgreSQL's default `MATCH SIMPLE` behavior. Do not make them mandatory.

- [ ] **Step 4: Verify only the tenant tests turn GREEN**

  Run:

  ```powershell
  pnpm exec supabase db reset --local
  pnpm exec supabase test db --local
  ```

  Expected: all ten cross-shop tests pass with SQLSTATE `23503`; the daily-close RED assertions still fail.

---

### Task 3: Convert daily closes into immutable events

**Files:**

- Modify: the exact corrective migration generated in Task 2
- Modify: `supabase/tests/rls.test.sql`
- Test: `supabase/tests/schema.test.sql`

**Produces:** An append-only `daily_closes` event stream capable of close → reopen with reason → close again.

- [ ] **Step 1: Migrate the existing table without deleting history**

  In the corrective migration:

  1. Drop `daily_closes_shop_date_uq`.
  2. Rename `closed_at` to `recorded_at`.
  3. Rename `closed_by` to `actor_id` and rename its foreign-key constraint accordingly.
  4. Add `event_sequence bigint generated always as identity` before copying legacy reopen events, so migrated and newly inserted events receive monotonically increasing values. Use `event_sequence`, not `recorded_at`, as the authoritative key for determining the latest event.
  5. Add the explicitly named unique constraint `daily_closes_event_sequence_uq` on `event_sequence`.
  6. Add `event_type text not null default 'closed'`.
  7. Add `reason text`.
  8. Before dropping legacy reopening columns, insert one `reopened` event for every legacy row where `is_reopened = true`, copying `reopened_at`, `reopened_by`, and `reopen_reason`.
  9. Drop `is_reopened`, `reopened_at`, `reopened_by`, and `reopen_reason`.
  10. Add a named check allowing only `closed` and `reopened`.
  11. Add a named check requiring `btrim(reason) <> ''` for `reopened` while requiring `reason is null` for `closed`.
  12. Preserve the existing append-only trigger and RLS policy.

- [ ] **Step 2: Make the RLS fixture explicit**

  Update the two `daily_closes` fixture rows in `supabase/tests/rls.test.sql` to provide:

  ```sql
  event_type = 'closed'
  actor_id = '10000000-0000-4000-8000-000000000101'
  reason = null
  ```

  Keep `plan(39)` unchanged.

- [ ] **Step 3: Verify database GREEN**

  Run:

  ```powershell
  pnpm exec supabase db reset --local
  pnpm exec supabase test db --local
  pnpm exec supabase db lint --local --level warning --fail-on error
  ```

  Expected: the schema suite passes 99/99 and the RLS suite passes 39/39, for 138/138 database assertions total, and schema lint reports no errors.

---

### Task 4: Put the root application behind trusted SSR authorization

**Files:**

- Delete: `app/page.tsx`
- Create: `app/(app)/page.tsx`
- Modify only if required by the move: `app/page.module.css`
- Test: `tests/e2e/auth.spec.ts`

**Consumes:** `getCurrentActor(): Promise<Actor>` through `app/(app)/layout.tsx`, and the existing authenticated server Supabase client.

**Produces:** The `/` route wrapped by the trusted actor layout and a server-rendered list of only RLS-visible shops.

- [ ] **Step 1: Move the root page under the protected route group**

  Move the page implementation to `app/(app)/page.tsx`. Route groups do not change the URL, so it must still render at `/`. Keep the `ShopKhata` heading and existing shell styling.

- [ ] **Step 2: Query assigned shops through the real server session**

  Make the protected server page call `createServerSupabaseClient()` and execute:

  ```ts
  const { data: shops, error } = await supabase
    .from("shops")
    .select("id, name")
    .order("name");
  ```

  Fail closed on query error. Render each returned shop name as a level-two heading. Do not read or authorize from `searchParams.shopId`; URL state cannot expand RLS visibility.

- [ ] **Step 3: Verify targeted browser GREEN**

  Run:

  ```powershell
  pnpm test:e2e --grep "authenticates the seeded|preserves the authenticated|does not grant Shop 2" --workers=1
  ```

  Expected: all three pass; Shop 1 is visible and Shop 2 remains absent even when its UUID is supplied in the URL.

---

### Task 5: Regenerate types and run the complete Phase 2 gate

**Files:**

- Modify: `lib/supabase/database.types.ts`
- Review all remediation paths from Tasks 1–4

- [ ] **Step 1: Regenerate database types as strict UTF-8**

  Only after external database GREEN, generate from the reset local database using `pnpm exec supabase gen types typescript --local`, write with `.NET UTF8Encoding($false)`, preserve exactly one final newline, and verify the file is non-empty, contains no NUL bytes, and has no BOM. Database types must be regenerated externally, not during the final review-correction editing step.

- [ ] **Step 2: Run the complete verification matrix**

  ```powershell
  pnpm test --run
  pnpm test:migration-upgrade
  pnpm exec supabase db reset --local
  pnpm exec supabase test db --local
  pnpm exec supabase db lint --local --level warning --fail-on error
  pnpm lint
  pnpm typecheck
  pnpm build
  pnpm test:e2e
  pnpm audit
  git diff --check
  ```

  Expected: every command passes, including the 99-assertion schema pgTAP suite, the 39-assertion RLS pgTAP suite (138 database assertions total), the 2 migration integration tests (`pnpm test:migration-upgrade`), the complete unit suite (separate), and the complete seven-test browser suite. `pnpm typecheck` is the clean-checkout type-generation/type-check command and runs `next typegen && tsc --noEmit`.

  Migration integration tests are run with a dedicated command (`pnpm test:migration-upgrade`) using `vitest.integration.config.mts`, which disables file parallelism and uses exactly one worker. They require a running local Supabase stack and are excluded from the ordinary `pnpm test` unit suite.

  The CI `verify` job runs lint, typecheck, unit tests, build, and the unauthenticated redirect smoke boundary. The dedicated CI `integration` job starts local Supabase with stdout suppressed, runs `pnpm test:migration-upgrade`, resets the database, runs pgTAP, database lint, captures one unprinted `pnpm exec supabase status -o env` result, derives `API_URL` and `PUBLISHABLE_KEY` (falling back to `ANON_KEY` only when needed), writes only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to `.env.local`, verifies the variable names without printing values, runs `tests/e2e/auth.spec.ts`, and always stops Supabase during cleanup.

  The migration-upgrade malformed-data test verifies the exact three-row preflight diagnostic, migration-history rollback, legacy daily-close schema and unique-constraint preservation, absence of remediation columns and constraints, and byte-for-byte preservation of the three independent malformed fixtures. The valid-history test verifies original closed IDs, shop/date identity, timestamps, actors, exact reason, and increasing reopen event sequence.

  The complete authentication E2E suite remains a mandatory local Phase 2 verification gate.

- [ ] **Step 3: Review scope and secrets**

  Confirm that only the approved remediation paths changed. The authoritative changed-path list is:

  ```text
  .github/workflows/ci.yml
  app/(app)/page.tsx                                          [NEW]
  app/layout.tsx
  app/page.tsx                                                [DELETE]
  docs/plans/ShopKhata-Phase-2-Security-Review-Remediation-Plan.md
  lib/supabase/database.types.ts
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  supabase/migrations/20260902073650_phase2_security_remediation.sql  [NEW]
  supabase/tests/rls.test.sql
  supabase/tests/schema.test.sql
  tests/e2e/auth.spec.ts
  tests/e2e/smoke.spec.ts
  tests/integration/migration/upgrade-path.test.ts             [NEW]
  vitest.integration.config.mts                                [NEW]
  ```

  Search those files for `sb_secret_`, `sb_publishable_`, and `postgresql://`; expect no matches. Confirm `.env.local` remains ignored.

- [ ] **Step 4: Stop before integration**

  Confirm branch `phase-2-database` and review the exact staged and unstaged paths. Do not stage the final corrections, commit, merge, or begin Phase 3 yet.

---

### Emergent Final-Verification Dependency-Security Blocker (2026-09-12)

> **Important:** This is an emergent dependency-security blocker discovered during final verification on 2026-09-12. It was **not** part of the original three security review blockers (cross-shop composite foreign keys, append-only daily-close event stream, and root page SSR authorization).

#### Discovery

During final verification, `pnpm audit` initially found:
- two critical Next.js vulnerabilities affecting 16.3.2
- one high sharp vulnerability at 0.35.3
- one high js-yaml vulnerability at 4.3.1

#### Remediation and Dependency Adjustments

- `next` was upgraded exactly from 16.3.2 to 16.3.4.
- `eslint-config-next` was upgraded exactly from 16.3.2 to 16.3.4 to keep the framework and lint configuration synchronized.
- `sharp` consequently resolved from 0.35.3 to 0.35.4.
- `js-yaml` is transitive through ESLint and was overridden exactly to 4.3.2 in `pnpm-workspace.yaml`.
- ESLint remains on major version 9; no major-version upgrade was performed.
- Supabase CLI remains pinned at 2.115.0.
- `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` are therefore approved remediation paths.
- `pnpm audit` now reports “No known vulnerabilities found.”

#### Verification Results

Post-upgrade verification passed:
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test --run`: 26/26 (unit tests, separate from migration integration)
- `pnpm test:migration-upgrade`: 2/2 (migration integration tests)
- `pnpm build`
- `pnpm test:e2e`: 7/7
- `pnpm audit`
- `git diff --check`

Existing database verification remains:
- Schema pgTAP: 97 assertions
- RLS pgTAP: 39 assertions
- Database total: 136 assertions
- database lint found no schema errors

#### Repository Hygiene and Scope Constraints

- The accidental untracked file named “tatus --short” was moved outside the repository and must not be included.
- No staging, commit, merge, or Phase 3 work is authorized during this documentation edit.

### Emergent Build-Time Google Fonts Blocker (2026-09-15)

#### Reproducible blocker

- `pnpm build` failed while `app/layout.tsx` imported `Geist` and `Geist_Mono` from `next/font/google`.
- Next.js 16.3.4 attempted to fetch both Geist stylesheets from `fonts.googleapis.com` during the production build and failed when that service was unavailable.

#### Remediation and verification boundary

- The unused `next/font/google` import and its two font declarations were removed from `app/layout.tsx`; the root layout now preserves its metadata, stylesheet import, language, and children without a font-loader class name.
- No font package, local font binary, proxy configuration, or build weakening was added.
- Fresh `pnpm build` passed after removal of the loader. The complete final verification matrix remains required before recording the overall remediation as GREEN.

### Independent Final Review and Minor-Finding Corrections (2026-09-15)

#### Outcome

- An independent Phase 2 review of the complete remediation found no Critical or Important issues.
- The review identified exactly two Minor findings, and both have been corrected.

#### Minor findings corrected

1. Documentation scope-list drift: the authoritative changed-path list (Step 3, Review scope and secrets) omitted `tests/e2e/smoke.spec.ts`. The path has been added to the list.
2. Daily-close reason-constraint behavioral coverage: `supabase/tests/schema.test.sql` lacked isolated `throws_ok` assertions for the `daily_closes_event_reason_check` constraint covering both a `reopened` event with a `null` reason and a `closed` event with a non-null reason. Both `SQLSTATE 23514` assertions were added, using fixture IDs `d1000000-0000-4000-8000-000000000006` and `d1000000-0000-4000-8000-000000000007` respectively. The pgTAP plan count was updated from `plan(97)` to `plan(99)` to account for the two added assertions.

#### Updated totals

- Schema pgTAP: 99 assertions
- RLS pgTAP: 39 assertions
- Database total: 138 assertions
- No migration SQL or production code changed as part of these corrections.
