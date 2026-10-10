# Complete invoice operations — BIG SLICE 1

Implemented on `phase-3-operational-ui`, starting from `5c47ebead137938fbc4d476fe23d5f20f714752e`. The Product Design Specification and approved Phase 3 Invoice Operations Design remain the governing authorities. Historical implementation plans retain their original statements and checkpoints.

## Database and effective semantics

- `20261003090000_invoice_operations.sql` adds append-only `correction_requests`, `correction_decisions`, `replacement_requests`, and `replacement_decisions`; RLS, composite shop foreign keys, separate request/decision idempotency keys and fingerprints, and four authenticated RPCs.
- `request_invoice_correction(command)` proposes a signed integer-dirham adjustment to the canonical invoice total or one of its payments. `decide_invoice_correction(command)` approves or rejects that proposal. Approval atomically appends a decision, an approved existing `corrections` ledger row, and an audit event. It never changes a pending request, invoice, or payment. A unique correction `request_id` prevents double application. Rejection appends a decision without a financial adjustment.
- `request_invoice_replacement(command)` proposes a complete non-financial version: invoice number, customer (including explicit null), delivered boolean, expected current revision, and reason. `decide_invoice_replacement(command)` approves or rejects it. Approval atomically appends the next revision, reserves its number, and records its audit event. It never inserts another financial invoice.
- `effective_invoices`, an invoker-security view, exposes canonical UUID, original/effective numbers, effective customer/delivery, approved revision (original = 0), original total, dates/creator, and authoritative effective total/paid/due. A lateral latest-approved-version lookup composes with `invoice_effective_balances`; payment, financial correction, and version rows are not joined into a multiplying financial aggregate.
- `20261003090100_invoice_overpayment_projection.sql` makes the existing governed overpayment RPC use authoritative balances and the effective customer, with Qatar business-date validation. Existing credits remain attached to their original customer. Replacement does not transfer or rewrite any credit. The ordinary `record_payment` RPC already reads the financial projection and shares the canonical invoice lock.

Financial correction approvals use today's Qatar business date, enforce the current closed-date rule, and reject negative effective totals/paid/due, amounts beyond the safe application integer range, negative corrected individual payment totals, or delivered due without an effective customer. They do not silently create customer credit; excess money remains subject to the existing separately governed overpayment mechanism. Replacement inputs reject all monetary fields. Customer references must belong to the canonical shop.

## Authorization, isolation, and retry semantics

The existing database role set is unchanged: `staff`, `manager`, `owner`. All new RPCs derive actors from `auth.uid()`, active profiles, and authoritative shop access. They accept no caller-supplied actor/role authority. Staff and assigned managers can request changes within their assigned shops; owners can request within accessible shops. Only manager/owner can decide, including deciding their own request. Named capabilities are `correction.request`, existing `correction.approve`, `invoice.replacement.request`, and `invoice.replacement.approve`.

Public tables allow authenticated RLS-scoped reads only. Requests, decisions, canonical invoices, payments, ledger corrections, registry entries, and audit history reject UPDATE/DELETE. Financial writes and request/decision writes happen through the transaction RPCs, never browser table writes or a service-role client.

Each of the four new operations has its own `(shop_id, idempotency_key)` uniqueness and fingerprint covering the command, normalized reason/number, expected revision where relevant, and authenticated actor. Exact replay returns the original request or decision identity without writing another row, revision, reservation, ledger correction, or audit event. A changed fingerprint fails explicitly. Transaction advisory locks serialize same-key retries; canonical invoice row locks serialize approvals with payments and prevent branching versions. Approval rejects stale expected versions; stale requests can still receive a deliberate rejected decision against the current version. There is exactly one decision per request.

The registry preserves all historical numbers. Approval uses an insert-on-conflict reservation followed by a canonical-owner check inside the decision transaction. A collision with another canonical invoice rolls back the whole approval. Reusing the same canonical invoice's registered number is legal. Two different shops can use the same normalized number. Racing reservations and approvals are covered by real-session integration tests.

UI mutations accept success only on a validated server receipt. Network-uncertain operations retain the original command, canonical UUID, business date where relevant, and idempotency key. A later denied retry does not clear earlier uncertainty. Controls allow exact retry while preventing another draft mutation; success refreshes detail and recent state. Retry state lives in the current client screen; durable offline/outbox handling remains outside this slice.

## Operational UI

`/shops/[shopId]/invoices/[invoiceId]` is the canonical detail/operations route. It distinguishes original and effective identity, canonical UUID, original/effective financial amounts, business/recorded dates, creator, customer/delivery, original version, full payment and approved ledger correction history, and pending/approved/rejected financial and replacement request/decision history. Ledger and request history queries paginate beyond the Supabase row cap; payment correction lookups chunk canonical payment IDs.

The screen offers cash follow-up payment only for authorized actors with positive due, request forms with required reasons, bounded server-side customer search, and manager/owner decision forms beside pending requests. Ordinary cash payments cannot exceed authoritative due. Refreshed projection values update the payment panel when no unresolved attempt exists. Display permissions come from server-side rules; server actions independently authenticate/authorize and RPCs enforce the final boundary. SQL errors are mapped to fixed user messages.

Recent invoices show effective identity, delivery, totals and due. Rapid-entry duplicate warnings display authoritative due, link to canonical detail (`Record payment` or `View invoice`), and identify the current number when an entered number is historical. New creation remains blocked by both draft validation and the database registry/RPC boundary. Back navigation retains the authorized selected shop through `?shop=`.

The pre-existing uncommitted detail foundation (`lib/invoice-detail.ts`, detail route/not-found, recent-link and detail CSS changes) was incorporated into this feature. Existing unrelated `_tmp_*` files, two untracked historical plans, and the user's additions to the older invoice-entry E2E file are preserved.

## Verification

See `invoice-operations-verification.md` for the final executed regression results, earlier failures and their resolutions, review status, audit blocker, and Git provenance. No test was deleted or weakened. CI now runs the new invoice-operation integration suite and the complete browser suite after the existing database suites.

No offline synchronization, Excel import/export, expenses, closing UI, reports, or deployment was implemented. No cancellation state exists in the current approved request schema; explicit rejection is the supported auditable negative decision. The next product slice should be chosen after this slice's remaining verification blocker is resolved.

## Invoice-total corrections state the corrected total

`20261009090000_correction_target_total.sql` changes how an invoice-total correction is requested. The request carries `corrected_total_dirham` (the total the invoice should have) and `expected_total_dirham` (the effective total the requester saw). It no longer carries an adjustment: `request_invoice_correction` derives `amount_delta_dirham = corrected − current effective total` itself, under the invoice row lock, and stores all three on the append-only request. A 1000.00 invoice corrected to 1500.00 therefore stores +500.00 and ends at 1500.00.

The database, not the screen, decides validity:

- `STALE_TOTAL` — the expected total is not the current effective total (at request), or the effective total has moved since the request was made (at approval). A corrected-total request is only approvable against the total it was made for, so two pending requests can never stack. A stale request can still be rejected.
- `CORRECTION_NO_CHANGE` — the corrected total equals the current total.
- `INVALID_FINANCIAL_RESULT` — the corrected total is below cash paid plus customer credit applied (the due would be negative). Checked at request and again at approval.
- `CUSTOMER_REQUIRED` — unchanged rule: a delivered invoice left with due needs a customer.

A command must carry either a corrected total or a delta, never both. Payment corrections still carry a signed delta against one payment. The application's server action accepts only the corrected-total form for invoice totals; the delta form against an invoice total remains accepted by the RPC for existing callers and stays under the same approval rules. Idempotency, fingerprints, approval roles, the closed-date rule and the append-only ledger are unchanged; requests made before this migration keep both new columns null.

The request form shows the current total, the corrected total, the calculated difference, current payments and the resulting due before submitting. Refusals appear in a persistent alert and on the field they concern; the save confirmation is a toast.
