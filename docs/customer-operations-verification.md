# Customer operations verification record

Run date: 2026-10-03 (Qatar time). Final verification was run on branch `phase-3-operational-ui`, based on implementation HEAD `a3f161d4f532893cc0069dbb3f8db0e79a424898`. No Daily Closing or other business feature was started.

## Migration and local services

- Docker Desktop was present and running. Docker CLI 29.6.2 and its `desktop-linux` daemon responded successfully. The sandbox shell did not expose Docker on PATH; the installed per-user CLI was invoked directly through a scoped PATH.
- Supabase CLI 2.115.0 is installed through the repository package. Its telemetry write had failed under the original user profile. CLI invocations used the supported `USERPROFILE` redirection to the writable temp directory and `SUPABASE_TELEMETRY_DISABLED=1`; application behavior was not changed for this workaround.
- The unverified future-dated migration was renamed to `20261003090200_customer_ledger_and_expenses.sql`. It follows `20261003090100_invoice_overpayment_projection.sql` and does not collide.
- The first clean reset caught an invalid replacement of `invoice_effective_balances`: the prior migration had renamed its first column to `canonical_invoice_id`. The new migration now preserves that column name and uses it for the subsequent view join. A schema assertion locks this contract.
- `pnpm exec supabase start` and `pnpm exec supabase db reset --local` completed from a clean database. All 21 migrations applied in order and `supabase/seed.sql` completed.

## Database and migration results

- `pnpm exec supabase test db --local` â€” PASS; 7 pgTAP files, **448 assertions**, zero skips. The schema suite plans 162 assertions; `customer_expenses.test.sql` plans and passes 33.
- `pnpm exec supabase db lint --local` â€” exit 0. It reports six existing warnings in `private.is_valid_date_text` and `public.submit_batch` (immutability/stability, two text-to-array assignments, two loop-variable shadow notices, and one unused variable). No warning is attributed to the Big Slice 2 migration.
- `pnpm run test:migration-upgrade` â€” PASS; 2 files, **5 tests**, including the supported legacy schema checkpoint and restoration to the complete seeded chain.
- All five live Supabase integration suites passed with zero skips: batches **8**, payments **5**, overpayment/credit **5**, invoice operations **9**, and customer/expenses/receipts **4**. These include FIFO payment allocation and races, credit issuance/application and races, expense retry/correction/approval, and real Storage upload/read, MIME/size rejection, generated UUID paths, registration idempotency, and shop isolation.

## Application regression and audits

- `pnpm.cmd test:e2e --workers=1` â€” PASS; **38/38 Playwright tests**. This includes the new customer/expense workflow and all Big Slice 1 invoice tests. Running with one worker avoids shared seeded-database contention. A separate six-worker run passed 37/38 and timed out while filling the customer payment amount; the complete serial run passed.
- `pnpm.cmd lint` â€” PASS.
- `pnpm.cmd typecheck` â€” PASS; Next route type generation and TypeScript completed.
- `pnpm.cmd test --run` â€” PASS; 12 files, **61 tests**.
- `pnpm.cmd test --run --coverage` â€” PASS; 12 files, **61 tests**. Coverage: **72.00% statements, 70.11% branches, 71.95% functions, 75.35% lines**.
- `pnpm.cmd build` â€” PASS; optimized production build completed with Customers and Expenses routes.
- `pnpm.cmd install --frozen-lockfile` â€” PASS (`Already up to date`); `pnpm-lock.yaml` remained unchanged.
- `pnpm.cmd audit --prod` â€” PASS; no known production vulnerabilities.
- `pnpm.cmd audit` â€” exit 1 for only the documented high-severity dev-only `braces@3.0.3` advisory in the `eslint-config-next` path. The advisory has no published patched version and was not suppressed or changed.
- `git diff --check` â€” PASS; no whitespace errors. Git emitted only existing LF-to-CRLF working-copy notices.

The first pgTAP run also exposed two fixture issues (temporary result-table grants and UUID/text comparison); both were corrected and the complete 448-assertion suite then passed. The first customer integration run exposed a missing local Shop 2 staff password/identity; the local-only seed now provides it, and the final customer suite passes. These verification corrections do not alter production credentials or remote data.
