# BIG SLICE 1 executed verification

Date: 2026-10-03. Workspace: `C:\Users\Reem\Desktop\shopkhata`. Branch: `phase-3-operational-ui`. Starting HEAD: `5c47ebead137938fbc4d476fe23d5f20f714752e`.

The invoice implementation is usable end-to-end. Formal BIG SLICE 1 closure requires every gate GREEN; the existing dependency audit prevents that closure. No dependency upgrade or advisory suppression was made, in accordance with the assignment's dependency scope. The optional dependency-remediation question did not authorize a scope expansion.

## Executed gates

All commands use the repository-pinned toolchain. `pnpm.cmd` is the Windows executable. The installed Supabase CLI initially could not write its telemetry directory inside the sandbox; the same installed CLI was executed with authorized elevated access. No product defect or fake RED was inferred from that environment failure.

| Gate | Result |
| --- | --- |
| `pnpm.cmd lint` | PASS, exit 0, no final lint warnings/errors |
| `pnpm.cmd typecheck` | PASS, exit 0, Next route generation and TypeScript |
| `pnpm.cmd test --run` | PASS, 10 files / 55 tests, exit 0 |
| `pnpm.cmd test --run --coverage` | PASS, 10 files / 55 tests, exit 0; statements 70.05%, branches 69.55%, functions 68.49%, lines 73.54%; repository has no enforced coverage threshold |
| `node node_modules/supabase/dist/supabase.js --agent no db reset --local` | PASS, all old and new migrations plus local seeds applied, exit 0 |
| `node node_modules/supabase/dist/supabase.js --agent no test db --local` | PASS, 6 files / 381 assertions, exit 0, including 54 new invoice-operation assertions |
| `node node_modules/supabase/dist/supabase.js --agent no db lint --local --level warning --fail-on error` | PASS, exit 0, no errors or new-function warnings; retained warnings in unchanged `private.is_valid_date_text` and `submit_batch` |
| `pnpm.cmd test:migration-upgrade` | PASS, 2 files / 5 tests, exit 0, 255.01 seconds |
| `pnpm.cmd test:integration:batches` | PASS, 1 file / 8 tests, exit 0, 67.39 seconds |
| `pnpm.cmd test:integration:payments` | PASS, 1 file / 5 tests, exit 0, 66.86 seconds |
| `pnpm.cmd test:integration:overpayment` | PASS, 1 file / 5 tests, exit 0, 66.52 seconds |
| `pnpm.cmd test:integration:operations` | PASS, 1 file / 9 tests, exit 0, 36.26 seconds |
| `pnpm.cmd build` | PASS, exit 0, production build includes canonical invoice-detail route |
| `pnpm.cmd test:e2e --workers=1` | PASS, complete suite 37/37 tests, exit 0, 2.7 minutes |
| `pnpm.cmd audit` | FAIL, exit 1: 19 existing advisories (1 critical, 8 high, 7 moderate, 3 low) |
| `git -c core.excludesFile= diff --check` | PASS, exit 0; staged and whole-slice whitespace checks also executed |

The CLI form above is the same project-pinned Supabase package requested through `pnpm exec supabase`. Integration harnesses use `pnpm exec supabase --agent no` internally. Database suites run sequentially because they reset the same local stack. Complete Playwright runs with one worker to avoid shared seeded-shop fixture interference; every pre-existing test remains selected.

## Test coverage and evidence limits

The new pgTAP suite covers table/view existence, requester identity, staff requests/approval denial, strict reasons and monetary input, isolation/RLS/direct-write denial, request and decision replay/conflict, financial ledger application once, registry collision rollback, old/current same-canonical resolution, cross-shop number legality, latest-version semantics, stale approvals, deliberate rejection, same-canonical number reuse, financial aggregation across multiple versions, later payment, invalid negative financial outcome, append-only triggers, and composite FK isolation.

Real-session integration tests prove later payment and correction receipts, payment-specific corrections, historical/current duplicate creation rejection, concurrent competing revisions, concurrent approve/reject decisions, concurrent normalized registry collisions, exact concurrent approval retry with one audit event, trusted-actor fingerprints, direct-write/shop denial, and effective-customer future credits with original-credit and original-receipt retention. Manager self-request/self-approval is exercised through the replacement-aware credit scenario.

Unit tests cover input schemas, signed safe integer money, reason requirements, strict non-financial inputs, revision inputs, normalized invoice numbers, fixed error mapping including inherited object keys, permission matrix, complete paginated reads, payment-panel refresh, and retaining exact command payloads through uncertainty and a later denied retry. Browser tests exercise the complete staff → owner lifecycle, current/original history, due updates, old/current duplicates, cross-shop legality, malicious URL/RPC input, lost-response payment retry, and fully paid duplicate navigation.

Source-only review found four important UI/read defects during development: payment's own uncertainty disabled its retry, initial payment props became stale after refresh, a denied retry cleared earlier uncertainty, and ledger reads truncated at the API cap. All four were corrected, re-reviewed CLOSED — SOURCE_INSPECTED, and covered by executed component/full-history tests. Review did not execute tests; execution results above belong to the primary agent.

Earlier failures remain history: new validators failed on their missing module; new database contracts failed assertions for the missing request/decision tables, view and RPCs before schema implementation. First browser execution caught a server-only authentication import in a client component. Subsequent test failures exposed premature Next navigation URL capture and an ambiguous duplicate heading locator. Those test locators were corrected by awaiting canonical navigation and scoping the effective invoice heading, preserving all assertions. A component assertion was corrected to inspect native fieldset disabled semantics. The first complete browser regression run passed 35/37 tests and exposed two earlier-detail locator ambiguities caused by repeated canonical identity/balance displays in the new embedded payment panel. The redundant displays were removed from the embedded panel; the existing tests were left unchanged. The final results supersede those development failures without relabeling them as passes.

## Audit blocker

The untouched dependency tree reports advisories in Next.js, undici, brace-expansion, and braces. The Next.js advisory lists 16.3.6 as patched; installed 16.3.4 remains unchanged. The braces advisory currently lists no published patched version. This is dependency-audit evidence, not proof of exploitation of this application's routes. See [Next.js advisory](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j) and [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).

The required audit is neither skipped nor silently waived. The all-GREEN completion standard is not met. Targeted dependency security remediation and re-verification are the remaining gate work, subject to the user’s stated scope restriction.

## Git provenance and retained work

- `a7f04af` — `feat: govern immutable invoice corrections and replacement versions`
- `c8d5b93` — `feat: complete canonical invoice operations and duplicate navigation`
- The final verification commit records integration/E2E tests, CI, documentation, and the embedded-payment regression correction; exact final HEAD and status are reported at handoff.

The existing uncommitted canonical detail foundation was adopted into the slice and its commits. The user's older `tests/e2e/invoice-entry.spec.ts` changes and historical foundation note in the status document remain outside these commits. All pre-existing `_tmp_*` files and the two untracked older implementation plans remain preserved. No temporary file, environment credential, production deployment, Mahira ERP change, or dependency upgrade was committed.

Next product recommendation after closing the audit gate: customer operations, including customer ledger, dues, and governed credit application. No next slice was started.
