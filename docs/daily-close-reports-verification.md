# BIG SLICE 4 executed verification

Run on 2026-10-04 (Qatar time). Workspace `C:\Users\Reem\Desktop\shopkhata`, branch `phase-3-operational-ui`, starting HEAD `7c24f8be63c484aa0cb47105d4f6c5ba72c6f8d3`. Scope and semantics are in [daily-close-reports.md](daily-close-reports.md).

## Final results

Every command was run on its own, one after another, against one local Supabase instance, after the last code change.

| Gate | Result |
| --- | --- |
| `pnpm lint` | PASS, exit 0 |
| `pnpm typecheck` | PASS, exit 0 |
| `pnpm test --run` | PASS, 16 files / **146 tests** (123 before this slice) |
| `pnpm test --run --coverage` | PASS; statements 73.34%, branches 68.53%, functions 74.00%, lines 76.09% (76.06 / 73.73 / 75.67 / 78.75 before); no enforced threshold |
| `pnpm exec supabase db reset --local` | PASS, 22 migrations and seed applied from clean |
| `pnpm exec supabase test db --local` | PASS, 8 files / **569 assertions** (448 before) |
| `pnpm exec supabase db lint --local --level warning --fail-on error` | PASS, exit 0; only the retained warnings in `private.is_valid_date_text` and `submit_batch`, none from this slice |
| `pnpm test:migration-upgrade` | PASS, 2 files / **5 tests** |
| `pnpm test:integration:batches` | PASS, **8** |
| `pnpm test:integration:payments` | PASS, **5** |
| `pnpm test:integration:overpayment` | PASS, **5** |
| `pnpm test:integration:operations` | PASS, **9** |
| `pnpm test:integration:customer-expenses` | PASS, **4** |
| `pnpm test:integration:offline-excel` | PASS, **15** |
| `pnpm test:integration:closing-reports` (new) | PASS, **5** |
| `pnpm build` | PASS; `/closing` and `/reports` added as dynamic routes |
| `pnpm exec playwright test --workers=1` | PASS, **59/59**, 4.9 minutes (55 before) |
| `pnpm audit --prod` | PASS, no known vulnerabilities |
| `pnpm audit` | exit 1 for only the documented dev-only `braces@3.0.3` advisory (no patched version); not suppressed |
| `pnpm install --frozen-lockfile` | PASS, already up to date; `pnpm-lock.yaml` unchanged; no dependency added |
| `git diff --check` | PASS |

No test is skipped. The Playwright run reused a production server started from the completed build for the offline-shell project, and started its own development server.

Coverage fell by about three points. `lib/reports.ts` contains the report fetch functions, which need a database; they are exercised by the integration and browser suites, which the unit coverage figure does not count. Its filters, mappers and sheet builders are unit-tested.

## Existing tests changed

Two existing tests were changed, both to a stricter rule and neither removed:

- `supabase/tests/record_payment.test.sql`: the two owner backdated-payment cases now pass a `backdated_reason`, because a backdated payment without one is now rejected.
- `tests/integration/payments/record-payment.test.ts`: the owner backdated payment now first asserts that omitting the reason fails with `BACKDATE_REASON_REQUIRED`, then succeeds with one.

## What the new tests prove

**Unit, 23 new (`tests/unit/closing-reports.test.ts`).** The Qatar date at 20:59, 21:00 and 23:59 UTC and across a year end; report filter parsing, including invalid, future, reversed, incomplete and over-long ranges; close and reopen input validation; close state from events in any order; the manager reopen limit; backdate reason validation and a draft that has silently become backdated; closed-date conflict classification for a queued draft; report mappers passing database values through unchanged and refusing unsafe amounts; no label containing profit, margin or cost of goods; all five report sheets round-tripped through the read library.

**pgTAP, 121 new (`supabase/tests/daily_close_reports.test.sql`).** Schema and privileges; the fifteen daily-summary formulas against a scripted day with invoices, a follow-up payment, a customer payment, an overpayment, a credit application, approved and pending corrections, a corrected expense and a replacement; the reconciliation rules; close and reopen authorization for staff, another shop's staff, manager and owner; required reasons; every mutation path rejected on a closed date, including a direct table insert; another shop unaffected; six exact retries returning their stored receipts after the close; the closed day's summary unchanged; reopen, re-close and the three-event history; immutability of close and audit history; backdating rules on batches, expenses and payments; a closed earlier date; correction behaviour against a closed period; shop isolation of every report; Qatar date semantics under session time zones on both sides of the date line.

**Integration, 5 new, real sessions through the API (`tests/integration/closing-reports.test.ts`).**

1. Manager closes and reopens with a reason; anonymous, staff, other-shop staff and an unassigned manager are rejected; history and audit rows are exact; history cannot be updated or deleted.
2. With the date closed: an offline-prepared batch, a follow-up payment, a customer payment, a credit application, an overpayment, an expense, and expense- and invoice-correction approvals are all rejected and write nothing, for the owner too; six commands committed before the close replay to their original receipts; a changed payload under a committed key conflicts; the day's summary is unchanged; after the reopen the same prepared batch and the pending approvals succeed.
3. Staff and manager cannot backdate; the owner cannot without a reason; the owner's backdated batch keeps its business date, reason and a current recorded time; a closed earlier date blocks the owner; a manager cannot reopen it; the owner can, and the backdated payment's reason is in the audit trail.
4. The full report scenario: the daily summary equals the expected fifteen values exactly; sales, customer due, expense and payment totals equal their source projections; each credit application and correction appears once; the replaced invoice is one row; exported workbooks carry the same values; a non-assigned actor gets nothing from any report; closing one shop leaves the other writable and invisible.
5. The database's Qatar date equals the app's; tomorrow cannot be closed; a record stamped 22:30 UTC with the next day's business date is reported, exported and closed under the business date, while the previous day stays open.

**Browser, 4 new (`tests/e2e/closing-reports.spec.ts`).** An owner selects a shop and date, reviews the summary, closes with a note, sees closed state, closer and history, is refused a new entry, reopens with a reason and saves the entry; staff are offered neither action and cannot see another shop. Staff cannot change the date; an owner backdates an expense only with a reason and the close screen and expense report show it as backdated with both dates. A manager closes a date through the app while another device holds an offline draft: the draft is rejected, kept intact, the manager cannot reopen the earlier date, the owner reopens it, and the draft then saves once on its original date. Reports for a scripted day show the expected values on screen for all five reports, the five exports match them, and another shop's staff get neither screen nor export (403).

## A defect found by the gate

The first browser run closed the date but stored no note. The close form used controlled React fields, and text typed before hydration finished was discarded. The form now uses plain form fields with a form action, so the browser keeps what was typed and enforces the confirmation and the reopen reason. All gates were rerun after this change.

## Query plans

With sequential scans disabled on the local database, the date filter of each report resolves through an index: `invoices_shop_business_date_idx` (daily summary, sales rows and totals), `payments_shop_business_date_idx` and `credit_applications_shop_business_date_idx` (payment report), `expenses_shop_business_date_idx` (expense report), `daily_closes_shop_date_sequence_idx` (close state). The local data set is small; no production-sized volume was measured.
