# ShopKhata V1 release candidate 1 — executed verification

BIG SLICE 5: production acceptance, backup and restore, administration, release candidate.

Run on 2026-10-04 (Qatar time) on Windows 11, Node 24.15.0, pnpm 11.23.0, Supabase CLI 2.115.0, local Supabase stack (PostgreSQL 17.6) in Docker. Workspace `C:\Users\Reem\Desktop\shopkhata`, branch `phase-3-operational-ui`, starting HEAD `3695fad48eade477d58bb7e8205fc92ca864d259`.

Every command below was run on its own, one after another, against one local Supabase instance, after the last code change. Nothing was deployed.

> **Gate status: OPEN — one gate is incomplete, so the release candidate is not tagged.**
> The complete browser run on the final code was stopped by the host at 30 of 70 tests (30 passed, 0 failed) because the machine ran low on memory; it was not a test failure. The remaining 40 tests have not run against the final code as one suite. Every other gate below passed. The tag `shopkhata-v1-rc1` must not be created until `pnpm exec playwright test --workers=1` completes green and this section is updated with its totals.

## Final results

| Gate | Command | Result |
| --- | --- | --- |
| Frozen install | `pnpm install --frozen-lockfile` | PASS, already up to date; `pnpm-lock.yaml` unchanged; **no dependency added** |
| Lint | `pnpm lint` | PASS, exit 0 |
| Typecheck | `pnpm typecheck` | PASS, exit 0 |
| Unit | `pnpm test --run` | PASS, 17 files / **155 tests** (146 before this slice) |
| Coverage | `pnpm test --run --coverage` | PASS; statements 74.55%, branches 69.80%, functions 74.75%, lines 77.01% (73.34 / 68.53 / 74.00 / 76.09 before); no enforced threshold |
| Clean database | `pnpm exec supabase db reset --local` | PASS, 25 migrations (22 before) and seed applied from clean |
| Database tests | `pnpm exec supabase test db --local` | PASS, 10 files / **627 assertions** (8 files / 569 before) |
| Database lint | `pnpm exec supabase db lint --local --level warning --fail-on error` | PASS, exit 0; only the retained warnings in `private.is_valid_date_text` and `public.submit_batch`, none from this slice |
| Migration upgrade | `pnpm test:migration-upgrade` | PASS, 2 files / **5 tests** |
| Integration | `pnpm test:integration:batches` | PASS, **8** |
| Integration | `pnpm test:integration:payments` | PASS, **5** |
| Integration | `pnpm test:integration:overpayment` | PASS, **5** |
| Integration | `pnpm test:integration:operations` | PASS, **9** |
| Integration | `pnpm test:integration:customer-expenses` | PASS, **4** |
| Integration | `pnpm test:integration:offline-excel` | PASS, **15** |
| Integration | `pnpm test:integration:closing-reports` | PASS, **5** |
| Production acceptance (new) | `pnpm test:integration:acceptance` | PASS, **5**: administration, two-shop, authorization attack matrix, largest batch, financial scenario through a real backup and restore |
| Performance sanity (new) | `pnpm perf:check` | PASS, **5**; 19 reads within budget at one year of data |
| Build | `pnpm build` | PASS; `/admin` added as a dynamic route; fails with a named reason when configuration is missing |
| Browser, all engines | `pnpm exec playwright test --workers=1` | **INCOMPLETE.** 70 tests (59 before this slice): 30 passed, 0 failed, 40 not run — the run was stopped by the host for low memory. Run separately earlier in the slice, before the row-level-security, balance-view and batch-limit migrations: `release-acceptance.spec.ts` 7/7 (Chromium), `cross-browser.spec.ts` 3/3 (Chromium, Firefox, WebKit), `pwa.spec.ts` 4/4 (production build). Those results are indicative only |
| Backup | `pnpm backup:db` | PASS |
| Restore rehearsal | `pnpm backup:verify` | PASS, 9 checks, `RESTORE VERIFIED` |
| Production audit | `pnpm audit --prod` | PASS, no known vulnerabilities |
| Full audit | `pnpm audit` | exit 1 for only the documented dev-only `braces@3.0.3` advisory; still no patched version; not suppressed |
| Whitespace | `git diff --check` | PASS |

Integration total: 8 existing suites (56 tests) + acceptance (5) + performance (5) = **66**, all passing.

## Defects found by this gate and fixed

The purpose of the slice was to find what only shows up under production conditions. It found nine things; each was fixed and has a test.

| # | Found by | Defect | Fix |
| --- | --- | --- | --- |
| 1 | Session hardening test | **Open redirect on sign-in.** A return address of `/\evil.example` passed the "starts with `/`, not `//`" check; browsers treat `/\` as `//` and left the site | `lib/auth/return-path.ts` resolves the address as the browser will and requires the same origin; used by the sign-in page and the proxy. Unit and browser tests cover six hostile forms |
| 2 | Performance fixture | **Row-level security evaluated per row.** Every policy called `private.has_shop_access(shop_id)` for each row: 1,364 ms to count one shop's 14,640 invoices; the workspace's recent-invoice list took 2,982 ms | Policies resolve the accessible shops once per statement (`private.accessible_shop_ids()`); same rule, asserted equivalent for every kind of account |
| 3 | Performance fixture | **Customer list unusable at one year of data.** The balance view ran a whole-shop scan per customer: the customers page hit the API statement timeout; 429 customers took 366 s even without row-level security | `customer_financial_balances` aggregates once per shop. Same columns and values: identical hash for 429 customers before and after |
| 4 | Large-batch acceptance | **The 100-row batch limit was not enforced by the database.** A direct RPC call accepted a batch of any size | `submit_batch` refuses more than 100 rows (`BATCH_TOO_LARGE`), for every role |
| 5 | Restore rehearsal | **A restored database was too slow to use until statistics existed.** The first API read after a restore hit the statement timeout | `ANALYZE` is part of the restore rehearsal and of the restore runbook |
| 6 | Cross-browser smoke (WebKit) | **Sign-in lost text typed before the page became interactive**, and a submit before the script loaded would have sent the password in the address bar (`GET`) | The sign-in form uses plain form fields read at submit and `method="post"` |
| 7 | Cross-browser smoke (WebKit) | An invoice number typed before the workspace became interactive left "Find invoice" disabled | The lookup form reads its own field at submit |
| 8 | Accessibility audit | Table header cells without `scope` on the customer, ledger, import-preview and report tables | `scope="col"` added |
| 9 | Responsive audit | The Reports page overflowed a phone-width screen: report tabs, date fields and "Show report" were cut off | The tab bar wraps and panels may shrink (`operations.module.css`) |

Also changed for safe operation: a signed-in account with no shop assigned sees an explanation instead of an error page, and a deactivated account sees why it can do nothing.

## 1–2. Backup architecture (database and receipt files)

`pnpm backup:db` (`scripts/backup.mjs`) writes one timestamped folder outside the repository (default `~/shopkhata-backups/shopkhata-<environment>-<UTC time>`):

- `data.sql`, `schema.sql`, `roles.sql` from `supabase db dump` (PostgreSQL `pg_dump`) — no proprietary format;
- `storage/expense-receipts/…` — every private receipt file, downloaded with the service-role key that only the operator holds;
- `manifest.json` — creation time, environment label, source host, application version and git commit, applied migrations, SHA-256 and size of every file, and a fingerprint of the data.

It refuses to back up a hosted database without the receipt files, refuses to write inside the repository, and exits non-zero when a dump fails, a receipt cannot be downloaded, a receipt record has no file, or the database changed during the dump. `supabase/seed.sql` and generated dumps are not tracked; `.env*` is ignored.

The fingerprint (`scripts/backup-fingerprint.sql`) is the row count and hash of **every** public table (found dynamically, so later tables are included), the sign-in accounts, the receipt object index, and per shop: sales, payment, expense and customer-due totals, and hashes of the invoice projection, customer balances, customer ledger, effective expenses, and the closed dates.

Runbook: [`docs/operations/backup-restore.md`](../operations/backup-restore.md).

## 3–4. Restore drill and post-restore reconciliation

`pnpm backup:verify` takes a backup, **destroys the local database**, rebuilds it from the migrations at the backup's migration state, restores the data in one transaction, uploads every receipt, and fails unless everything reconciles. Final run, as part of the acceptance scenario (invoices with part payments, a follow-up payment, an approved correction, a replacement, an approved overpayment credit that was applied, an expense with a receipt and an approved correction, a closed day):

```
PASS artifact integrity: 3 dump files and 4 receipt file(s) match their recorded SHA-256
PASS migration compatibility: backup is at 20261004120000 (25 of 25 migrations in this checkout)
PASS database restore: 55 tables restored from data.sql in one transaction, then analyzed
PASS receipt restore: 4 file(s) uploaded and read back byte-identical; all 4 receipt record(s) have their file
PASS table reconciliation: 23 tables, 390 rows: every count and row hash identical
PASS financial reconciliation …0001: invoices 107, total 1257450, paid 395000, due 857450, customer due 101000, available credit 0 (dirham); ledger, balances, expenses and closed dates identical
PASS financial reconciliation …0002: invoices 3, total 24000, paid 7500, due 16500, customer due 16500, available credit 500 (dirham); ledger, balances, expenses and closed dates identical
PASS shop isolation: every active non-owner account sees only its own shops' invoices and receipt objects under row-level security
PASS application reads: a restored owner signed in and read the invoice projection and customer-due report through the API; both match for every shop
RESTORE VERIFIED: 9 checks passed.
```

Post-restore hashes, identical before and after (`differences: []`):

| Projection | Shop 1 (`…0001`) | Shop 2 (`…0002`) |
| --- | --- | --- |
| Effective invoices | `107:918dbabfef72898c74e1e036bd03e244` | `3:5b18fd54c187dc371fc50fc38cd6f5e4` |
| Customer balances | `3:91d854030bfef1d0ee4b6342348a9c98` | `2:d58746219960c7ea9951aed00986bb9f` |
| Customer ledger | `11:c073e8b32788276235e1f91b2c52b24b` | `7:852aca6aa5286af653cca4c38f4b9c32` |
| Effective expenses | `3:b92a981a6c74718a55983fab144a17c9` | `4:d305ccbf894f0f14aab00fbb15e4ca31` |
| Closed dates | `2026-10-04` | none |

Source tables, identical before and after: invoices `110:6b817673…`, payments `60:26985707…`, corrections `1:f95b1927…`, correction requests `3:b0227480…`, replacement requests `2:382ca942…` and decisions `1:75ca67af…`, customers `5:90395e17…`, customer credits `2:709917a6…`, credit applications `1:2c07d21d…`, expenses `7:642c6d3c…`, expense corrections `2:1d33ea0c…`/`1:916d534e…`, daily closes `5:0c1e4a22…`, attachments `4:d538a4b3…`, audit events `54:3ed3f072…`, registry `111:4dcca003…`, profiles `4:6ccec8b4…`, assignments `5:8f9392bc…`.

Then, through the application's API with freshly signed-in restored accounts, the acceptance test compared its own before/after snapshot and found it **equal**: the three scenario invoices' balances, the customer balance (due 40,000 dirham, credit 0) and ledger, and for both shops the daily summary, sales, customer-due, expense and payment report totals and all five exported workbooks cell by cell. The restored receipt read back byte-identical for its shop's staff and was refused to the other shop's staff. The restored system kept its rules: the closed day still refused a payment, was reopened by the manager, then accepted one; a new customer received the next unused public ID (sequences restored).

Not verified here: the same restore against a **hosted** Supabase project. The commands are in the runbook; rehearsing them once against a scratch project is on the production checklist.

## 5. Owner user and shop administration

`/admin` ("Accounts"), owner only. It lists every account with role, status and **effective access** in words, and lets an owner register an existing sign-in with a role, change role, activate/deactivate, and add or remove each shop. The last 50 account changes are shown.

All writes go through three owner-only `SECURITY DEFINER` functions (`admin_register_account`, `admin_update_account`, `admin_set_shop_assignment`) that take a lock, recheck the caller's stored role, validate the command (unknown fields rejected) and write an audit row with the before/after state. No application role can insert, update or delete `profiles`, `user_shop_assignments` or `shops` directly. **The application holds no service-role key**; none is needed.

Safety rules: an owner cannot change their own role or status (so an active owner always remains, including when two owners act at the same moment); only an owner can grant any role; a change applies to the account's next request because access is read from the database on every request.

Accounts are created in two steps (sign-in in the Supabase dashboard, then registration here). No invitation system was added.

## 6. Security and environment hardening

- **Environment**: `.env.example` lists names only. `docs/operations/environment.md` classes every variable (browser-safe, deployment-only, operator-only). The application has no server-only secret. `next build`/`next start` stop with a list of problems when a variable is missing, the URL is not HTTPS, the public key variable holds a service-role key, or a `NEXT_PUBLIC_` variable is named like a secret.
- **Secret scan**: current tree and full git history searched for Supabase keys (JWT, `sb_secret_`, `sbp_`), JWT secrets, database URLs with passwords, private keys, GitHub/AWS/API tokens, committed `.env` files and dumps. **None found.** The only `.env` file ever committed is `.env.example`.
- **Headers** on every response: Content-Security-Policy (own origin plus the configured Supabase project; no framing, no plugins, forms only to own origin), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`; HSTS only with `SHOPKHATA_ENABLE_HSTS=true`. Verified in the browser on development and production builds with sign-in, invoice save, expenses and receipts working and no policy violation logged.
- **Sessions**: every protected route redirects an anonymous visitor to sign-in; exports return no data; hostile return addresses are ignored; sign-out clears the session cookie; a removed session fails closed on the next save (nothing written, draft kept) and on the next navigation; no token is stored in localStorage, sessionStorage or IndexedDB.
- **Failure visibility**: one JSON line per failed operation on the server log (`lib/server-log.ts`) with the operation, error code, shop and account ID — never a payload, amount, name, error detail or token.

## 7. Authorization acceptance

`tests/integration/production-acceptance.test.ts`, real sessions through the public API. For each of three attackers (Shop 1 staff, Shop 1 manager, anonymous) against Shop 2's records:

- reads of 22 tables and views by shop, plus invoice, customer, ledger, expense, receipt record, shop, other profiles and assignments by ID or number;
- all six report functions;
- the private receipt: download, signed URL, list, upload, overwrite, delete, move;
- 37 write commands: every RPC naming the other shop (including the batch an offline replay sends); every RPC with the caller's own shop ID wrapped around the other shop's record IDs; client-supplied `role`/`created_by`; backdating; reopening an old date; all three administration RPCs;
- 16 direct table writes (insert, update, delete on invoices, payments, expenses, credits, corrections, close events, audit events, attachments, customers, profiles, assignments, shops);

and Shop 2's own staff attempting the five manager-only actions. **Every one was rejected, and the row count and hash of every table and the receipt objects were identical before and after.** 296 unauthorized requests in total (97 per attacker, 5 by Shop 2 staff; the count is asserted so an attack cannot be dropped silently), 0 allowed.

pgTAP adds 42 assertions for administration (non-owner attempts by RPC and by direct table write, validation, immediate effect of assignment removal and deactivation, owner hand-over, the last-owner rule, audit) and 16 for the access rule and the batch limit.

Browser: staff and manager are offered no Accounts link and get a 404 for `/admin`; a full owner workflow registers an account, assigns a shop, deactivates and re-roles it, with each change taking effect on the account's next page load.

**Two-shop acceptance** (same suite): the same invoice number saved independently in each shop and refused twice in one; each staff account sees only its shop while the owner sees and operates both; customer balances and sales reports move only by their own shop's invoices; receipts are readable only by their shop; assigning and removing a shop works on a live session; closing Shop 1 today leaves Shop 2 open and writable.

## 8. Performance fixture and findings

`scripts/perf-fixture.sql`, loaded only by `pnpm perf:check` into a freshly reset local database (it refuses to run unless the local seed accounts exist and the database is empty). Deterministic; every row is labelled `PERF`/`Perf`; the eight generated accounts cannot sign in. Roughly one year of trading for two small shops:

| | |
| --- | --- |
| Shops | 2 (40 and 20 invoices a day for 366 days) |
| Accounts | 12 |
| Customers | 3,000 |
| Invoices | 21,960 |
| Payments | 18,764 |
| Expenses | 4,392 |
| Approved corrections | 230 |
| Approved replacements | 96 |
| Credit applications | 26 |
| Close/reopen events | 758 |

This is a sanity check for obvious problems, not a benchmark. Reads are made as the application makes them: through the API, as signed-in Shop 1 staff under row-level security, best of three.

Before and after the two optimizations (defects 2 and 3), same data, same machine:

| Read | Before | After |
| --- | --- | --- |
| Count one shop's invoices (policy cost alone, in the database) | 1,364 ms | 3 ms |
| Workspace: 30 recent invoices (in the database) | 2,982 ms | 122 ms |
| Customer list query (in the database) | 185 ms | 1.3 ms |
| Customer balances, 429 customers (in the database, no row-level security) | 366,284 ms | 474 ms |
| Customers page: list with balances (API) | statement timeout (> 8 s) | 466 ms |
| Sales report, 31 days (API) | 2,788 ms | 76 ms |

Final measurements (budget 1,500 ms per screen read; 6,000 ms for whole-year and every-row reads):

| Read | ms | Requests | KB | Rows |
| --- | --- | --- | --- | --- |
| Workspace: 30 recent invoices | 112 | 1 | 17 | 30 |
| Workspace: all invoice numbers (duplicate check) | 593 | 30 | 603 | 14,704 |
| Duplicate lookup: one invoice number | 3 | 1 | 0 | 1 |
| Invoice Detail | 13 | 5 | 1 | — |
| Customers: first page with balances | 466 | 2 | 10 | 31 |
| Customers: search by name | 7 | 1 | 4 | 31 |
| Customer Detail, busiest customer (369 invoices, 692 ledger rows) | 370 | 5 | 366 | — |
| Report: customer due | 749 | 4 | 58 | 201 |
| Expenses: first page | 5 | 1 | 10 | 30 |
| Daily summary: one day | 6 | 1 | 0 | 1 |
| Daily summary: 31 days | 8 | 1 | 14 | 31 |
| Report: sales, today | 14 | 3 | 20 | 40 |
| Report: sales, 31 days | 76 | 3 | 98 | 1,240 |
| Report: sales, 366 days | 753 | 3 | 97 | 14,640 |
| Report: payments, 31 days | 20 | 4 | 98 | 201 |
| Report: expenses, 31 days | 9 | 3 | 55 | 186 |
| Export: invoices, 31 days, every row | 201 | 7 | 593 | 1,240 |
| Export: expenses, 31 days, every row | 9 | 2 | 55 | 186 |
| Daily close screen | 4 | 1 | 1 | 3 |

Query plans, as the application role: invoice by ID, invoice-number lookup, invoices/payments/expenses of a business date, payments of an invoice, invoices of a customer, close state of a date and customer by ID all use an index, and shop access appears once as an `InitPlan`, never as a per-row filter.

**No index was added.** The existing indexes were sufficient once access was evaluated once per statement.

Findings left as they are:

- **The workspace loads every invoice number of the shop** (593 ms, about 600 KB at 14,704 numbers) so duplicate warnings are instant and work offline. It grows linearly with history. Acceptable for V1; move the check to the server, or to a per-year list, before a shop passes roughly 30,000 invoices.
- The customer ledger for the busiest customer is read in full (366 KB for a customer who buys every day for a year). Acceptable; paginate if a customer's history grows much larger.
- No N+1 pattern was found: related rows are fetched in chunks of up to 200 IDs, and every report takes its totals from one database function.

## 9. Large Excel batch

At the documented V1 maximum, 100 rows (`MAX_IMPORT_ROWS`; the limit was not raised):

- Browser (`release-acceptance.spec.ts`): a 101-row workbook is refused whole; a 100-row workbook with two bad rows reports `Row 58` and `Row 100` and no neighbouring row, and cannot be added to the draft; the valid workbook is parsed and previewed within the asserted 10 s (the test passed in 8.7 s in total, including three imports and the save; exact timings are printed as `[large-excel]` by the full run); the last row remains editable; the review shows the exact total; the save is asserted under 30 s and commits one batch of 100 invoices, 50 quick-added customers and every payment.
- API (`production-acceptance.test.ts`): 100 rows with two bad rows — refused, the error detail names only those two row IDs, nothing saved; 101 rows — refused, nothing saved; 100 valid rows — one batch, committed in **28 ms**; an exact retry returns the same receipt and writes nothing more.

## 10. Responsive and accessibility acceptance

`release-acceptance.spec.ts` drives the whole product as the owner at **1366×768, 820×1180 and 390×844** and audits each of 16 screens/states (sign-in, invoice entry with review, entry with errors, Excel import preview, Invoice Detail, customers, customer ledger, expenses, daily close, the five reports, administration, offline state).

Usability, checked in the page: no control is cut off by the screen edge outside a deliberately scrollable table; the page is not wider than the window; the main navigation reaches every workspace.

Accessibility, checked in the page: `lang` and title set; exactly one `h1`; every visible field has a label; every button, link and summary has a name; tables have header cells with scope; no image without `alt`; no empty status message; no duplicate ID. Checked by interaction: sign-in works from the keyboard alone; password field and submit button show a focus outline; a saved batch is announced with `role="status"`; a rejected row is described in words next to its own row and announced with `role="alert"`; open/closed day state, delivery state, account status and offline state are text, not colour alone.

Result after fixes 8 and 9: **no issue at any size** (run of these three tests on their own; see the gate status for the full-suite run).

Limits of this review, stated plainly: it is an automated structural audit plus scripted keyboard interaction. **No screen reader session and no colour-contrast measurement was performed**, and no accessibility dependency was added. The browser dialogs used to confirm discarding a draft are native and keyboard-accessible. A person typing in the first moment before a page becomes interactive may have to type again (see Known exceptions).

## 11. PWA and device result

On the **production build** (`pwa.spec.ts`, 4 tests):

- the manifest is served as `application/manifest+json` with name, short name, id, start URL, scope, standalone display, colours and a maskable icon; each icon is a real PNG of exactly its declared size;
- the service worker registers at scope `/` and reaches `activated`;
- Chromium's own installability check (`Page.getInstallabilityErrors`) reports **no error** other than `in-incognito`, which every automated browser profile reports and no real profile does;
- offline: a draft can be created, edited, reloaded with no network and commits exactly once on reconnect; the offline page never opens a draft while the server is reachable;
- authenticated pages and exports are served `no-store`; the service worker's cache holds only the offline page, build assets and icons — no page, data or export.

**No physical device was available.** Installation on a real Android or Windows device was not performed and remains a manual item on the production checklist.

## 12. Cross-browser result

`cross-browser.spec.ts`, the critical workflow (sign in, save an invoice with a part payment, open Invoice Detail, record a follow-up payment, record an expense, open customers, a report and daily close, sign out, confirm the session is gone): **PASS on Chromium, Firefox and WebKit** when run on its own, before the later database migrations; to be confirmed by the full run. The full financial suite remains on Chromium as the deterministic gate. WebKit here is Playwright's WebKit build on Windows, not Safari on Apple hardware.

## 13. CI

`.github/workflows/ci.yml`:

- `verify` (no database): frozen install, **production dependency audit**, lint, typecheck, unit tests with coverage, a check that the build **fails** without configuration, the build, `git diff --check`.
- `integration` (local Supabase): migration upgrade, clean reset, pgTAP, database lint, all eight integration suites (`closing-reports` was missing from CI before), production acceptance with the restore drill, a standalone `pnpm backup:verify`, the performance check, then the complete browser suite on Chromium, Firefox, WebKit and the production-build PWA project. Browser failure evidence is uploaded.

Least-privilege token (`contents: read`), superseded runs cancelled, pnpm store and Playwright browsers cached (no build output or database state is cached). The only credentials are the fixed, public keys of the throwaway local stack. The workflow could not be executed from this environment; it has not run on GitHub yet.

## Existing tests changed

None removed, none weakened. `tests/e2e/pwa.spec.ts` gained one test; `playwright.config.ts` gained the Firefox and WebKit projects.

## Known exceptions and V1 decisions

- Manager reopen is limited to today; historical reopen is owner-only.
- Reports are shop-scoped; there is no combined report.
- The customer-due report is the current position, not "as of" a past date.
- No accounting profit or cost of goods.
- No customer merge or removal.
- `braces@3.0.3` (development-only, through `eslint-config-next`): advisory GHSA-vfj7-8cjw-p6xm, **no patched version published** as of this run (3.0.3 is the latest release). Not suppressed.
- The Content-Security-Policy keeps `'unsafe-inline'` for scripts and styles (this Next.js version emits inline bootstrap scripts; a nonce policy would force every page to render dynamically). Scripts are still limited to the application's origin.
- Text typed into a form in the moment before the page becomes interactive may not register and must be typed again. Sign-in and the invoice lookup were hardened; the invoice entry workspace already disables its fields until it is ready. Other forms were not rewritten.
- The workspace loads all of a shop's invoice numbers (see Performance).
- Database timestamps in row hashes assume the source and the restore target use the same time zone setting (both UTC on Supabase).

## Open before tagging

- Complete `pnpm exec playwright test --workers=1` on the final code (needs roughly 4 GB of free memory for the development server, the production server, the browsers and the local Supabase stack), record its totals above, and only then create the tag `shopkhata-v1-rc1`.

## Manual checks still required before go-live

1. Install the application on the real shop device(s) and repeat the offline check there.
2. Rehearse the hosted restore procedure once against a scratch Supabase project.
3. Run the complete checklist in [`docs/operations/production-checklist.md`](../operations/production-checklist.md) against the production project (sign-ups disabled, HTTPS, headers, second owner, off-host backup).
4. One pass with a screen reader and a contrast check, if accessibility for such users is required.
5. Safari on Apple hardware, if anyone will use it.
6. Confirm the CI workflow passes on its first run on GitHub.
