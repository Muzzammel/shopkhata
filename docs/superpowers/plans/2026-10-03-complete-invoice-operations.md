# Complete Invoice Operations Implementation Plan

**Authority:** BIG SLICE 1 user assignment, Product Design Specification sections 3.2 and 12, approved Phase 3 Invoice Operations Design sections 8, 9, 15–17. This supersedes historical task stop gates for this assignment only.

**Goal:** Deliver the complete canonical invoice lifecycle without rewriting committed financial records.

**Architecture:** Separate append-only financial correction requests/decisions and replacement requests/decisions. Approval appends the existing financial correction ledger or an immutable replacement revision. Canonical invoice locks serialize decisions with payments. Registry uniqueness reserves all historical/current numbers. An invoker-security effective invoice view composes one latest approved revision with the existing independently aggregated financial view.

**Execution:** Inline, one editor. Preserve the initial four modified files, untracked detail foundation, historical plans, and `_tmp_*` files. Only task changes enter commits; existing foundation changes used by the slice are explicitly documented.

- [x] Inspect branch, HEAD, status, governing specifications, migrations, UI, permission rules, and testing conventions.
- [x] Run existing unit baseline: 8 files, 45 tests PASS.
- [ ] Add failing database and validator tests for governed requests, decisions, registry/version semantics, authorization, and retries.
- [ ] Add a new migration with immutable request/decision schema, authenticated RPCs, atomic approvals, bounded financial validation, and effective invoice projection.
- [ ] Verify database reset, pgTAP, DB lint; regenerate database types.
- [ ] Add validators and mapped errors; implement detail payment, correction, replacement, approval/history UI.
- [ ] Use effective projection in detail, recent invoices, payment lookup; add canonical duplicate navigation including historical numbers.
- [ ] Add real Supabase integration tests including concurrency and complete Playwright workflows.
- [ ] Run full regression matrix, fix regressions, record attributable results.
- [ ] Update implementation documentation and create coherent scoped commits.

**Decisions:** Financial requests reference either the canonical invoice total or one canonical payment, and propose a signed integer-dirham delta. Approval never UPDATEs a pending correction row: it appends a decision and a new approved `corrections` row. Rejections append decisions. New corrections use today's Qatar business date; closed dates reject new approvals, exact decision replay precedes date/state checks. Reject changes producing negative totals/paid/due, a negative corrected payment, or delivered due without a customer. Existing credits stay attached to their original customer; replacement does not transfer credits. No cancellation state exists in the current schema/design, so rejection is the supported terminal negative decision.

**Completion evidence:** All user-required gates must pass before claiming completion. Earlier plans and retained user artifacts remain historical. No offline, import/export, expenses, closing UI, reports, or deployment work.
