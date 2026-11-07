# OPS-01B Slice 1 — final invariant remediation: test evidence

Local evidence for the single remediation commit on top of `9f3a2dd57a84f481fa3280558aeae1e570d608ea`
(subject `fix: close final ops recovery invariants`). Everything here ran on the local Supabase stack and a local
`next dev`; **nothing touched production** (no preflight, migration, maintenance, firewall, deploy, push or PR update).

**PRODUCTION PREFLIGHT NOT YET EXECUTED — REQUIRED BEFORE RELEASE WINDOW.**

## 1. Identity

| What | Value |
|---|---|
| Tested remediation tree (working tree **excluding** this evidence directory) | `c47b5238e96c14f1654b6ec17f2031762e38b59d` |
| Parent commit | `9f3a2dd57a84f481fa3280558aeae1e570d608ea` |
| Evidence-only additions | `docs/release/evidence/ops-01b-slice1-final-invariants/**` (this README, `logs/`, `harness/`, `SHA256SUMS`) |
| Final commit / commit tree | see the commit itself (`git rev-parse HEAD`, `git rev-parse HEAD^{tree}`); the tree cannot name itself |

Every gate log starts with `# tree: <id>` computed by `harness/tree.sh` immediately before that gate ran; all 25 gate
logs record `c47b5238…`. To check that the commit contains exactly the tested tree plus this directory:

```
IDX=$(mktemp) && rm -f "$IDX"
GIT_INDEX_FILE="$IDX" git read-tree HEAD
GIT_INDEX_FILE="$IDX" git rm -r -q --cached docs/release/evidence/ops-01b-slice1-final-invariants
GIT_INDEX_FILE="$IDX" git write-tree        # must print c47b5238e96c14f1654b6ec17f2031762e38b59d
```

`AGENTS.md` is rewritten by every `next dev` start; the E2E harness restores it from HEAD after each run, and it is not
part of the tested tree or the commit.

## 2. Gates (all sequential, one at a time; ledger: `logs/gates.tsv`)

| # | Gate | Command (exact, see log header) | Result | Log |
|---|---|---|---|---|
| 1 | DB reset | `pnpm exec supabase db reset --local` | exit 0 | `logs/01-db-reset.log` |
| 2 | pgTAP (full) | `pnpm exec supabase test db --local` | **21 files, 1271 tests, PASS** | `logs/02-pgtap.log` |
| 3 | Unit (full) | `pnpm exec vitest run` | **38 files, 365 tests, PASS** | `logs/03-unit.log` |
| 4 | Integration: batches | `pnpm run test:integration:batches` | 1 file, 9 tests, PASS | `logs/04-int-batches.log` |
| 4 | Integration: payments | `pnpm run test:integration:payments` | 2 files, 14 tests, PASS | `logs/04-int-payments.log` |
| 4 | Integration: shops | `pnpm run test:integration:shops` | 2 files, 9 tests, PASS | `logs/04-int-shops.log` |
| 4 | Integration: overpayment | `pnpm run test:integration:overpayment` | 1 file, 5 tests, PASS | `logs/04-int-overpayment.log` |
| 4 | Integration: customer-expenses | `pnpm run test:integration:customer-expenses` | 1 file, 4 tests, PASS | `logs/04-int-customer-expenses.log` |
| 4 | Integration: offline-excel | `pnpm run test:integration:offline-excel` | 1 file, 15 tests, PASS | `logs/04-int-offline-excel.log` |
| 4 | Integration: closing-reports | `pnpm run test:integration:closing-reports` | 1 file, 5 tests, PASS | `logs/04-int-closing-reports.log` |
| 4 | Integration: acceptance (local) | `pnpm run test:integration:acceptance` | 1 file, 5 tests, PASS | `logs/04-int-acceptance.log` |
| 4 | Integration: operations | `pnpm exec vitest run --config vitest.integration.operations.config.mts --reporter=verbose` | **6 files, 42 tests, PASS** (attempt 3; history §3) | `logs/04-int-operations.log` |
| 5 | Migration upgrade | `pnpm exec vitest run --config vitest.integration.config.mts --reporter=verbose` | **3 files, 7 tests, PASS** (attempt 2; history §3) | `logs/05-migration-upgrade.log` |
| 6 | Maintenance E2E | `playwright test --project=maintenance --no-deps --workers=1` | **1 passed** | `logs/06-e2e-maintenance.log` (+ `.server.log`) |
| 7 | Chromium shard 1/3 | `playwright test --project=chromium --workers=1 --shard=1/3` | **70 passed**, 0 failed, 0 flaky | `logs/07-e2e-chromium-shard-1of3.log` (+ `.server.log`) |
| 8 | Chromium shard 2/3 | `… --shard=2/3` | **70 passed**, 0 failed, 0 flaky (attempt 3; history §3) | `logs/08-e2e-chromium-shard-2of3.log` (+ `.server.log`) |
| 9 | Chromium shard 3/3 | `… --shard=3/3` | **69 passed**, 0 failed, 0 flaky | `logs/09-e2e-chromium-shard-3of3.log` (+ `.server.log`) |
| — | **Chromium total** | `--list` of the repo config: 209 tests in 23 files | **209 / 209 passed**, 1 worker, shards strictly serial | |
| 10 | Typecheck | `pnpm run typecheck` (`next typegen && tsc --noEmit`) | exit 0 | `logs/10-typecheck.log` |
| 11 | Lint | `pnpm run lint` | exit 0 | `logs/11-lint.log` |
| 12 | Whitespace | `git diff --check` (tracked) and `git diff --cached --check` at commit time (incl. new files) | exit 0 | `logs/12-diff-check.log` |

Worker counts: Vitest operations/integration configs run `maxWorkers: 1`, `fileParallelism: false`; Playwright `--workers=1`.
Each E2E gate (`harness/e2e-run.ps1`): `supabase db reset --local`, wait until the Data API answers from a loaded schema
cache 3× in a row, start a fresh `pnpm dev` on :3000 with its own log, run ONE Playwright invocation, stop the server tree,
restore `AGENTS.md`. `harness/pw.config.ts` is the repository's `playwright.config.ts` with only `webServer` removed (so the
harness owns the dev server and its log, and the `pwa` project's production build on :3100 is not started); it lists the
same 209 Chromium tests as the repository config.

Coverage of the remediation inside these gates:

| Remediation | Where proven |
|---|---|
| Restore context requires maintenance ON (open under L1; MAINTENANCE_NOT_ACTIVE / MAINTENANCE_STATE_MISSING; no row, log or audit on refusal) | pgTAP `maintenance.test.sql` §2, §3, §7b |
| Disable clears the context (logged `cleared`); OFF→ON never revives it; stale-period listing refused | pgTAP §7b; operations `maintenance.test.ts` "restore race 1/2", "restore abandonment" (real Storage API) |
| Uncertain W3 never reopens (executable classifier, 4 cases; runbook regression incl. the 9f3a2dd wording) | unit `ops-01b-w3-state.test.ts` (24); operations `release-gates.test.ts` (real `supabase db query`, hung enable) |
| P00/P08 expected state (w2b strict; restore mode; unknown/absent mode STOP) | operations `release-gates.test.ts`; `release-window-rehearsal.test.ts` (W2b PASS at real 36); `locked-restore.test.ts` (restore mode) |
| Smoke material fields (invoice_type, quantity, customer, payment_method, delivery, …) | unit `window-compare.test.ts` (41); rehearsal W12/W15 on real smoke data |
| Complete Storage inventory; skipped empty sections proven empty at source and target; non-empty unsupported section still fails | operations `locked-restore.test.ts` |
| Hash of the reviewed function bodies (post-36 P03 = `3822757383203729978b7c00aea758bc`) | rehearsal W2b PASS; `locked-restore` restore-mode PASS |

## 3. Attempt history (nothing hidden)

**Operations integration**
- Attempt 1 (`logs/04-int-operations.attempt1-worker-crash.log`): 41/42 completed; **a Vitest worker exited unexpectedly**
  ("Worker exited unexpectedly"); **no assertion failed**; the default reporter did not name the file. Free memory was
  low at the time (≈2.8 GB of 16 GB; the next gate was stopped for low memory, see below). Not counted as a pass.
- Attempt 2 (`logs/04-int-operations.attempt2-pass.log`): **42/42 PASS** (the `--` made pnpm pass `--reporter` literally,
  so no per-test listing).
- Attempt 3 (`logs/04-int-operations.log`): **42/42 PASS**, verbose per-test listing. This is the gate result.

**Migration upgrade**
- Attempt 1 (`logs/05-migration-upgrade.attempt1-killed-low-memory.log`): stopped by Claude Code because the machine was
  critically low on memory (2 of 7 tests had passed, none failed). Not a test result.
- Attempt 2 (`logs/05-migration-upgrade.log`), run fresh after stopping a stale Playwright test-server: **7/7 PASS**.

**Chromium shard 2/3**
- Attempt 1 (`logs/08-e2e-chromium-shard-2of3.attempt1-postgrest-not-ready.log`, `.server.log`, `.attempt1.postgrest.log`,
  `.attempt1.error-context.md`): 69 passed, **1 failed** — the shard's first test (`invoices.spec.ts:15`) at sign-in.
  Root cause (class C, test infrastructure, proven by timestamps): the harness started the run right after
  `supabase db reset`; PostgREST had lost its connections when the database was recreated (19:38:52Z) and was in
  exponential back-off; at 19:39:28Z it answered `GET /profiles` and `GET /user_shop_assignments` with **503 PGRST002**
  ("Could not query the database for the schema cache"); the app correctly **failed closed** (`TRUSTED_PROFILE_REQUIRED`
  → sign-in page); PostgREST loaded its schema cache at 19:39:29.36Z. Fix (harness only, no product change): wait for the
  Data API to answer from a loaded schema cache before the dev server and tests start.
- Attempt 2 (`logs/08-e2e-chromium-shard-2of3.attempt2-probe-error.log`): the first version of that readiness probe
  treated anon's `401 / 42501 permission denied for table shops` as not-ready and timed out; **no test executed**.
- Attempt 3 (`logs/08-e2e-chromium-shard-2of3.log`): **70/70 PASS**. The probe fix (accept 200 or 42501 — both prove a
  loaded schema cache; 503 PGRST00x is not ready) applies to shards 1 and 3 equally; they had already passed without it.

**Observed outside the gates (diagnostics, recorded for completeness).** While investigating the hydration warnings
(§4) a diagnostic run of `dashboard.spec.ts` + `ui-v2-shell.spec.ts` on a non-reset database had 1 of 30 tests fail:
`dashboard.spec.ts:75` ("an empty historical window…") — `locator('main').innerText` met two `<main>` elements (the
`aria-busy` loading skeleton and the page) for a moment. This is a pre-existing test-timing weakness in an unchanged
test (the ui-v2 tests already wait for `main:not([aria-busy=true])`); it passed in the gate shard. Not fixed here (out of
scope); worth a follow-up.

## 4. Chromium / E2E server-log classification

Every ERROR / exception / warning-like line of the four final server logs (`06`, `07`, `08`, `09` `.server.log`) falls into
the categories below. Classes: **A** expected authorization/refusal, **B** expected aborted request/navigation,
**C** test/infrastructure behaviour, **D** application defect. Method: every line of the four logs that is not a plain request/action line (`GET|POST …`, `└─ ƒ …`, startup banner, stack/diff continuation) was listed and grouped; each group is below. **One category is D: a pre-existing defect outside this remediation (last row); everything else is A, B or C.**

| Category | Where (file:line) | Class | Why |
|---|---|---|---|
| Structured `{"level":"warn","code":"P0001",…}` refusals | `06:42,45,48,51` (submit_batch, record_payment, create_expense, close_business_date); `07:61` create_expense; `07:108` submit_batch; `08:224` submit_batch; `08:549` admin_register_account; `08:1227` submit_batch | A | Each follows the request of a test that expects a refusal: the maintenance E2E (already-open tabs refused with MAINTENANCE_ACTIVE); writes to a **closed business date** (`closeBusinessDate … 2014-06-07`, `close-off-…`, `closed-…`); registration of an email with **no sign-in** ("No sign-in exists for that email", `release-acceptance.spec.ts`); a sale on a **deactivated shop** right after `setShopStatus(is_active:false)` (`shop-management.spec.ts`). |
| `⨯ Error: TRUSTED_PROFILE_REQUIRED` (`lib/auth/permissions.ts:212`) | `08:528` | A | `release-acceptance.spec.ts:26–52` deliberately creates a sign-in with **no ShopKhata profile** and asserts it reaches nothing; the request sequence (staff/manager `/admin` 404 probes, then the hire's sign-in) matches. The layout redirects to `/login` as designed. (In shard-2 attempt 1 the same message had the infrastructure cause in §3.) |
| `[browser] Encountered a script tag while rendering React component` | `07:40,231,475,477,511,733`; `08:518,524,784,1372`; `09:42,44,50,52,172,178,184,250` | C (framework, dev mode) | Every occurrence directly follows a deliberate **404** (`/admin`, `/admin/backup`, `/admin/shops` for non-owners; another shop's invoice/customer/expense id) — the A-class refusals of the shop-isolation and admin tests. The app renders no `<script>` (`grep -rn "<script\|dangerouslySetInnerHTML\|next/script" app components lib` → none); the tag comes from Next.js's dev not-found rendering. |
| `[browser] A tree hydrated but some attributes … didn't match` (only `data-aria-hidden` / `aria-hidden` differ) | `08:799,976,1092,1231`; `09:442,660` | C | Always on `/dashboard`, in tests that open a Radix layer immediately after the page appears: `ui-v2-shell.spec.ts` (Notifications dialog, Ctrl+K quick find, shop-switcher menu) and the shop-management/switching flows. Only Radix Dialog/Menu/Popover/Select write `data-aria-hidden` (via `aria-hidden` `hideOthers`; Next's dev tools do not); with React streaming the dashboard segment's HTML is in the DOM before React hydrates it, so a layer opened in that window marks not-yet-hydrated nodes and the dev build reports the attribute difference. Hiding the background while a modal is open is the correct behaviour, and Radix removes the attributes on close. A diagnostic probe (8 dashboard loads with no interaction) found **0** warnings and **0** `[data-aria-hidden]` elements after load; the shell's layers open only on user input (`components/shell/app-shell.tsx`). |
| `⨯ Error: The destination stream errored while writing data.` | `09:409` | B | Follows `GET /dashboard…7d` then `GET /invoices?…&q=INV-42`: the Ctrl+K test hands the search to the invoice list while the dashboard response is still streaming, so the browser aborts it. |
| `[browser] Encountered two children with the same key, Nov` (×3) | `07:257–259` | **D (pre-existing, out of scope)** | Follows `GET /dashboard…&period=year` (`dashboard.spec.ts` "Week, Month and Year…"). The year view buckets by month and labels each bucket with the month name only (`lib/dashboard-view.ts:47`); on 2026-11-04 the 12-month window spans Nov 2025 → Nov 2026, so two buckets are `Nov`, and the chart keys rows/bars by label (`components/dashboard/charts.tsx:30`, `:120`). React warns that duplicate keys may duplicate or omit children on update. The page renders and the test passes, but this **is an application defect**. It is not introduced or touched by this remediation (no file under `components/`, `lib/` or `app/` changes; last change `0c6a7ce`, already in the reviewed base `9f3a2dd`). Recommended follow-up: key buckets by their `YYYY-MM` key, not the display label. Not fixed here: a product change outside the review scope would need its own review and the browser gates again. |
| Infrastructure: 503 PGRST002 + `TRUSTED_PROFILE_REQUIRED` | `08…attempt1…server.log`, `08…attempt1.postgrest.log` | C | §3, shard 2 attempt 1. Not in any final log. |

## 5. Secrets

Before committing, every retained file was scanned for JWTs (`eyJ…`), Supabase keys (`sb_secret_…`, `sb_publishable_…`,
`SERVICE_ROLE_KEY=`), connection strings with credentials, `Bearer`/`Authorization`/`Cookie` headers, auth-token cookies,
`PGPASSWORD=`, Vercel tokens and password literals, and for any 40+-character token-like string. The only findings were the
seeded **local-only** E2E passwords inside the copied Playwright page snapshot (`…attempt1.error-context.md`, which embeds
`tests/e2e/offline-helpers.ts`); they were replaced with `<redacted>`. The harness reads the local publishable key at run
time and never writes it.

## 6. Hashes

`SHA256SUMS` (in this directory) lists the SHA-256 of every file in `logs/` and `harness/`
(`cd docs/release/evidence/ops-01b-slice1-final-invariants && sha256sum -c SHA256SUMS`). The directory's `.gitattributes` (`* -text -whitespace`) stores every file byte-for-byte, so the hashes hold on any checkout, and exempts the raw logs from whitespace checks (`git diff --check` covers the code; the logs keep their original trailing spaces).
