# BIG SLICE 3 executed verification

Run on 2026-10-03 and 2026-10-04 (Qatar time). Workspace `C:\Users\Reem\Desktop\shopkhata`, branch `phase-3-operational-ui`, starting HEAD `d14e6ef005a20ff3735e82f4ee76ec936b1acc57`. Scope and semantics are described in [excel-offline.md](excel-offline.md): Excel invoice import through the existing batch path, Excel exports, durable per-user/per-shop drafts, a one-item invoice-batch queue with exact idempotent retry, conflict handling, local-draft privacy, the service-worker cache policy and the operational limits. No Daily Closing, reporting, backup/restore, deployment or Mahira ERP work was started. No migration, RPC or dependency changed.

## Final results

Every command below was run on its own, one after another, with one local Supabase instance and one Playwright worker.

| Gate | Result |
| --- | --- |
| `pnpm lint` | PASS, exit 0 |
| `pnpm typecheck` | PASS, exit 0 |
| `pnpm test --run` | PASS, 15 files / **123 tests** (61 before this slice) |
| `pnpm test --run --coverage` | PASS; statements 76.06%, branches 73.73%, functions 75.67%, lines 78.75% (72.00 / 70.11 / 71.95 / 75.35 before); no enforced threshold |
| `pnpm exec supabase db reset --local` | PASS, 21 migrations and seed applied from clean |
| `pnpm exec supabase test db --local` | PASS, 7 files / **448 assertions** |
| `pnpm exec supabase db lint --local --level warning --fail-on error` | PASS, exit 0; the same retained warnings in `private.is_valid_date_text` and `submit_batch` |
| `pnpm test:migration-upgrade` | PASS, 2 files / **5 tests** (from the interrupted run; no migration changed afterwards) |
| `pnpm test:integration:batches` | PASS, **8** |
| `pnpm test:integration:payments` | PASS, **5** |
| `pnpm test:integration:overpayment` | PASS, **5** |
| `pnpm test:integration:operations` | PASS, **9** |
| `pnpm test:integration:customer-expenses` | PASS, **4** |
| `pnpm test:integration:offline-excel` | PASS, **15** |
| `pnpm build` | PASS; routes `/`, `/customers`, `/customers/[customerId]`, `/expenses`, `/exports/[kind]`, `/shops/[shopId]/invoices/[invoiceId]` dynamic; `/login`, `/offline`, `/manifest.webmanifest` static |
| `pnpm test:e2e --workers=1` | PASS, **55/55**, 4.7 minutes: 38 pre-existing, 14 Excel/offline on the dev server, 3 offline-page tests on the production build |
| `pnpm audit --prod` | PASS, no known vulnerabilities |
| `pnpm audit` | exit 1 for only the documented dev-only `braces@3.0.3` advisory (GHSA-vfj7-8cjw-p6xm, no patched version); not suppressed |
| `pnpm install --frozen-lockfile` | PASS, already up to date; `pnpm-lock.yaml` unchanged |
| `git diff --check` | PASS |

No test is skipped. The project has no aggregate integration command; the six suites are separate scripts and were run sequentially. The Playwright run reused a production server started beforehand from the completed build, so only the development server was started alongside the browser.

## What the new tests prove

- **Unit (62 new):** import header validation, row normalisation, exact money handling, delivered parsing, in-file and in-shop duplicates, paste parsing, template and workbook round-trips through the read library; export sheets and their round-trips; draft serialisation, schema upgrade and refusal of unknown records, user/shop namespacing, queue transitions, backoff, conflict mapping, the status line, and retention of the original business date across a day change.
- **Integration, real Supabase sessions (15):** exact retry after a lost response returns the original receipt; eight repeated and concurrent retries leave one batch, invoice, payment, customer and audit event; an altered payload under a committed key is rejected; an offline-prepared duplicate number is rejected atomically and resolves to the existing invoice; a closed date rejects the batch and the same key commits once after reopening; revoked shop access, a deactivated user, a missing session and another shop's user are all refused with nothing written; a valid customer reference is kept and another shop's customer is refused; a committed batch keeps its business date on retry after that date has passed and cannot be re-dated under the same key; a never-sent batch dated before today is refused rather than moved; exports carry effective numbers, corrected balances and effective expenses, and return nothing for a shop the caller cannot see.
- **Browser (17 new):** template download and a three-row import through preview, review and save; merge and replace; malformed files, headers, rows and money values rejected before anything can be saved; a draft surviving reload with identical row IDs and error mapping; explicit discard; one user's draft never shown to another, and removed on sign-out; offline create, edit, import, paste and queue with one submission on a burst of reconnect events; editing a queued submission; a lost response resumed after reload with a byte-identical payload and no duplicates; the duplicate-number conflict with its link to the existing invoice; the closed-date conflict; the revoked-access conflict; the expired-session path; the three exports with unauthorized and anonymous requests refused; and, on a production build, a real offline page load, the offline page refusing to open a draft while the server is reachable, the manifest, and a cache holding only static assets.

## Interrupted first run

The first attempt ran the whole matrix as one background command, started at 23:49 on 2026-10-03. It was stopped by the system for low memory while the Playwright step was starting. That termination was a resource limit, not a test result. Before it was stopped, lint, typecheck, unit tests, coverage, the clean reset, pgTAP (448), DB lint, the migration upgrade (5), five integration suites and the build had passed, and one suite had genuinely failed.

### Failure 1: offline/Excel integration suite, 11 of 13 tests failed

The suite started at 23:59:41 Qatar time. It read the operating date once, when the file loaded, and then spent about a minute resetting the database. Every test therefore ran after midnight while still submitting 3 October as "today".

The server was right. `submit_batch` treats a date before the current Qatar date as a backdate: nine staff and manager submissions were refused with `INSUFFICIENT_ROLE`, and the owner's ordinary submission in the duplicate-number test failed validation because a backdate needs a reason. The two tests that passed did not depend on today's date: the closed-date test submits an explicit owner backdate, and the deactivated-user test is refused before any date rule.

No production code was wrong, and the invariant held: a new submission carrying yesterday's date is refused, never silently re-dated, and an exact retry of an already committed batch is answered from the stored result before any date rule runs (pgTAP scenario 21, "a real PostgreSQL calendar-date change must not invalidate an exact retry").

**Fix (test construction only).** The suite now pins the operating date at the start of each test. A test that would begin in the last 90 seconds of the Qatar day waits for the new day first, so no test can cross midnight between pinning the date and submitting. Two deterministic tests were added that need no clock at all: a committed batch whose date is already past is retried and returns the original receipt and date, and cannot be moved to today under the same key; a never-sent staff batch dated yesterday is refused with nothing written. A unit test covers the browser side: a stored submission keeps its original business date and key while the editable draft's date moves to the new day.

### Failure 2, found while re-verifying: UTC dates in two older suites

Re-running the suites between 00:00 and 03:00 Qatar time exposed the same class of defect in tests from earlier slices. During those three hours the UTC date is one day behind the Qatar operating date.

- `tests/integration/overpayment/approve-overpayment.test.ts` built its business date from `toISOString()`. All 5 tests failed with `INSUFFICIENT_ROLE`.
- `supabase/tests/approve_overpayment.test.sql` and `supabase/tests/customer_expenses.test.sql` used `current_date` under the session's UTC timezone. pgTAP fell to 403 assertions run with 5 failures and two aborted files (`INVALID_DATE`).

Again the RPCs were correct; the fixtures were not. The integration suite now uses `qatarBusinessDate`, as the other suites do. The two pgTAP files now begin with `set local timezone = 'Asia/Qatar'`, the convention `submit_batch.test.sql` already used. No assertion was changed.

### Evidence that it no longer reproduces

All of the following ran inside the 00:00–03:00 window on 2026-10-04, where the UTC and Qatar dates differ:

- offline/Excel suite: 15/15 alone; its four date and retry tests in isolation, 4/4; 15/15 again after the sequential run of the other five suites;
- overpayment suite: 5/5 failed before the fix, 5/5 passed after it;
- pgTAP: 403 run with failures before the fix, 448/448 after it, and 448/448 again after a clean reset;
- the complete Playwright suite, 55/55, including the existing midnight tests.

The pre-midnight case was already covered by the first run, where every suite other than the one above passed.

## Other corrections made during verification

- `tests/e2e/customer-expenses.spec.ts` failed on the unmodified checkpoint commit as well on this machine. Two clicks trigger a page reload that the test did not wait for, so later steps raced it. The test now waits for the reload at both points; every assertion is unchanged.
- A development server cannot start a page without its hot-reload connection, so offline page loads cannot be exercised there. `playwright.config.ts` gained a `pwa` project that runs `tests/e2e/pwa.spec.ts` against a production build on port 3100.
- Under Playwright's offline emulation a freshly loaded page still reports `navigator.onLine` as true. The offline page therefore treats itself as offline unconditionally and polls the server to know when to leave, which is also the correct behaviour on a connected network with no route to the server.

## Not verified

- Installation was checked through the manifest, icons and service worker, not by installing the app on a device.
- The 30-day draft expiry and the three-step backoff are covered by unit tests, not by a browser test that waits them out.
- Conflict B (customer changed) is proven at the RPC boundary only, because the product has no operation that removes or merges a customer.

## Git provenance and retained work

Commits for this slice are listed in the hand-off. The user's uncommitted changes to `docs/phase-3-operational-ui-slice-status.md` and `tests/e2e/invoice-entry.spec.ts`, the two untracked historical plans and all `_tmp_*` files are preserved and are not part of these commits.

Recommended next slice: Daily Closing. Not started.
