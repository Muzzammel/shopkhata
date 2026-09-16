# ShopKhata Phase 3 Invoice Operations Design

**Status:** Approved — ready for implementation planning.
**Date:** 2026-09-16
**Branch / checkpoint:** `phase-3-operational-ui` at `878d27e`
**Governing specs:** `docs/product/ShopKhata-Product-Design-Specification.md`; `docs/plans/ShopKhata-V1-Implementation-Plan.md`; `docs/plans/ShopKhata-Phase-2-Security-Review-Remediation-Plan.md`
**Product boundary:** Standalone ShopKhata product; no Mahira ERP code, data, or integration.

## 0. Relationship to the existing V1 Implementation Plan

`ShopKhata-V1-Implementation-Plan.md` numbers its phases differently from this branch: its Phase 3 covers only atomic financial commands (Task 5–6), its Phase 4 covers the bulk-entry UI (Task 7–8), and corrections/closing are Phase 7 (Task 12). The `phase-3-operational-ui` branch consolidates the invoice-operations workstream — atomic batch submission, the rapid-entry UI, customer quick-add, invoice detail, and a governed correction path — into a single phase named "Phase 3" for this branch's own sequencing. This document governs that consolidated scope. It reuses interface names already approved in the V1 plan (for example `submit_batch`, `requestCorrection`, `approveCorrection`) where they still fit, and calls out explicitly where this design extends or narrows those original Task definitions. Nothing in this section changes any previously locked rule; it only reconciles phase numbering between the two documents.

Daily closing, reports, Excel import/export, offline sync, and expenses remain out of this phase, consistent with the V1 plan's later phases and with §11 below.

## 1. Objective

- Deliver ShopKhata's first genuinely usable operational workflow: shop-scoped rapid invoice entry, not a dashboard-first placeholder.
- Keep ShopKhata separate from Mahira ERP (no shared code, data, or auth).
- Each grid row represents one invoice summary — identity, total, received, delivery state, customer — never a product line item. The existing `invoices.quantity` column (default `1`) is not part of this design's input surface and is left untouched.

## 2. Entry workflow

1. A spreadsheet-style rapid-entry table holds multiple draft rows at once, keyed by a stable local row ID (never array index), consistent with the existing `lib/domain/batches.ts` `BatchRowDraft` shape.
2. One business date applies to the entire batch, not per row.
   - Staff default to today's date and cannot change it.
   - Owner may select an allowed historical date, which marks the batch backdated (see §6 and §14).
3. Typed entry and spreadsheet-style paste (tab-separated rows) are both supported by the same grid and the same draft rows; paste parsing rejects rows with an unexpected column count rather than silently shifting financial fields into the wrong field.
4. Full Excel-file import is deferred (§11).
5. Staff review the complete batch — every row, its computed due, and any blocking errors or warnings — before saving. Save commits the entire batch in one action.
6. There is no valid-row-only partial save: if any row has a blocking error, the whole batch is rejected and nothing commits. This matches the existing `validateBatch` contract, where `canSubmit` is `false` if any row has an error.
7. As an invoice number is typed, pasted, or changed, the grid checks it against the current shop per §17 and surfaces any amber/red row warning immediately, before the batch is reviewed or saved.

## 3. Approved layout — Layout A: unified daily workspace

- Compact top-level navigation: **Overview, Invoices, Customers, Payments**. This nav is new application chrome; today `app/(app)/layout.tsx` only gates on `getCurrentActor()` and renders `children` with no shell (see §14, item 8).
- The current shop and the authenticated staff member's identity are always visible.
  - Staff and manager accounts are assigned to shops through `user_shop_assignments`; in the common case of a single assignment, the "current shop" is that assignment with no picker needed.
  - Owner accounts (role `owner`, per the locked Task 4 decision that "Owner/Admin" is one persona mapped to exactly the `owner` role) can access every shop and therefore need an explicit shop switcher. This switcher is new UI state that does not exist today (§14, item 8).
- The rapid-entry grid uses the maximum available width on desktop/tablet.
- Live batch totals (invoiced, received, due) and a **Review Batch** action sit above or beside the grid, computed client-side from the same totals shape `validateBatch` already returns.
- Recent invoices for the current shop/date render below the grid.
- Responsive behavior degrades to the phone card layout described in the Product Design Specification (§16) without weakening the desktop keyboard-first workflow (Tab/Enter row navigation, no mouse required for a fully valid batch).

## 4. Entry fields

Each row carries exactly these fields, plus a client-only validation state:

| Field | Backing today | Notes |
|---|---|---|
| Invoice ID | `invoices.invoice_id` (text, unique per shop) | Required; unique key is `(shop_id, invoice_id)`. Entering, pasting, or changing this value triggers the same-shop duplicate-number check in §17. |
| Total amount | `invoices.total_amount_dirham` (bigint dirham) | Required; must be `> 0` (see §14, item 2 — the current check constraint only enforces `>= 0`). |
| Received now | Creates one `payments` row | Optional; `0` means nothing was received at entry time. |
| Payment method | `payments.payment_method` (text, default `'cash'`) | Fixed to the canonical value `cash` for this slice (§14.1). The browser validates this for immediate feedback only; the Next.js server action and every payment-writing `SECURITY DEFINER` RPC (§6, §15) independently reject any value other than `cash` — the client is never the authorization or integrity boundary for this rule (§7). Only presented/required when received `> 0`. |
| Calculated due | Derived, never stored | `total - received`, computed client-side for preview and recomputed server-side as truth; never a typed input. |
| Delivered (Yes/No) | **Not yet persisted** | The domain layer (`lib/domain/invoices.ts`) already accepts a `delivered` boolean and derives `ADVANCE` / `DELIVERED_PAID` / `DELIVERED_DUE` from it, but no `invoices` column stores it today (see §14, item 1). |
| Customer | `customers` (optional `name`/`mobile`, system `public_id`) with inline quick-add | Search by name/mobile/public ID; quick-add creates a customer row in the same transaction as the batch (§5). |
| Note | **Not yet persisted** | No `note` column exists on `invoices`, `batches`, or `payments` today; only `attachments.note` exists (see §14, item 3). |
| Row validation state | Client-only, from `BatchValidationResult.rowErrors` / `.warnings` | No schema involvement. |

`invoices.invoice_type` stays internal to the database for this slice: it remains free `text`, keeps its existing default `'advance'`, is not exposed as a field anywhere in this grid, and is not repurposed, removed, or broadened during this slice. This design expresses the full lifecycle the UI actually needs through the single `delivered` flag plus the received/total relationship, matching how `invoiceState()` already treats `READYMADE` as "always delivered" and `ADVANCE` as "delivered only when the flag is set." Delivery state and payment state remain separate concepts. This is a closed decision for this phase (§14.1); no reconciliation item remains open for `invoice_type`.

## 5. Customer rules

- Customer and mobile are optional in general, matching `customers.name`/`customers.mobile` being nullable; existing-customer selection remains optional except where the delivered-with-due rule below requires one.
- Customer becomes mandatory exactly when a row is marked delivered **and** still has a positive due (`DELIVERED_DUE` in `invoiceState()` terms) — already enforced by `validateBatch`'s `customerId` check for that state, and must additionally be enforced inside the server-side transaction function, not only client-side.
- Search covers existing shop customers by name, mobile, or system `public_id`, scoped by `private.has_shop_access(shop_id)`.
- Inline quick-add creates a minimal customer (`name?`, `mobile?`) without leaving the batch. Before validation, both fields are normalized: a blank or whitespace-only string is treated as `null`, never as an empty string. A quick-add request is rejected as a blocking error when, after normalization, both `name` and `mobile` are `null` — at least one nonblank human identifier is required to create a customer record, preventing meaningless, unidentifiable customer rows. The created customer becomes immediately selectable on that row and is created for real only when the batch itself commits (see §6).

## 6. Persistence architecture

- The browser holds only draft rows (in React/component state for this phase; no offline/IndexedDB persistence is in scope — that remains the V1 plan's Phase 5).
- A Next.js server action receives the full batch, re-validates it with the same `validateBatch` domain function used for the client preview, and only then calls one PostgreSQL transaction function as the authenticated user.
- The transaction function is `SECURITY DEFINER`, follows the existing convention in `supabase/migrations/20260828164246_rls.sql` (`set search_path = ''`, fully schema-qualified references, minimal `execute` grants to `authenticated` only — never to `anon` or `public`), and is the **only** authorized write path for these records. A service-role bypass is never used.
- `SECURITY DEFINER` alone is not the security boundary. The function must independently: confirm the caller is an authenticated, active actor; derive the actor's identity from `auth.uid()` only — the RPC must never accept or trust a caller-supplied actor ID as authoritative; verify that actor's access to the target `shop_id` using the same rule `private.has_shop_access` encodes; verify the actor's role/capability for the specific action being performed (for example, backdated-batch submission requires the `owner` role, §14 item 9); and validate that every shop-owned record the request references (customers, invoices, the batch itself) actually belongs to the claimed `shop_id`. This explicit, in-function authorization logic — not Row-Level Security — is the write-security boundary for this function.
- RLS is not merely a secondary safeguard here — it is structurally incapable of being the write boundary, because `authenticated` holds **no `insert` grant at all** on any financial table (only `select` is granted; `update`/`delete` are explicitly revoked), and a `SECURITY DEFINER` function executes with its owning role's privileges rather than the caller's. RLS's role in this design is limited to (a) gating which rows an authenticated actor may `select` directly, and (b) guaranteeing that no client can write to these tables outside a `SECURITY DEFINER` function, since no direct write grant exists for any role other than the function's owner. RLS must not be described as the final write-isolation boundary for this or any other `SECURITY DEFINER` function in this design.
- Inside one transaction, the function:
  1. confirms the caller is an authenticated, active actor and derives the actor id from `auth.uid()` (never a client-supplied actor id);
  2. re-derives the actor's role and shop access from `public.profiles` / `public.user_shop_assignments` for the request's `shop_id` (never trusts a client-asserted role or shop id);
  3. if the batch is marked backdated, verifies the actor holds backdate authority for that business date (§14, item 9);
  4. validates the complete request — every row, field, and reference — before any write occurs, including the same-shop invoice-number checks in §17 and, for every row where `received_now` is greater than zero, that `payment_method` is exactly `cash` — any other value is rejected here, before any write occurs, regardless of what the browser or server action already validated (§4/§7);
  5. verifies idempotency semantics for the supplied `(shop_id, idempotency_key)` (§9): an exact repeat returns the original result without writing again; a key reused with a different request fingerprint fails with an explicit idempotency-conflict error before anything is written;
  6. creates any valid inline (quick-add) customers that passed validation (§5);
  7. inserts the batch record;
  8. for each row, in the batch's deterministic row order (§9): inserts that row's canonical invoice, then immediately reserves its `(shop_id, invoice_number)` in the invoice-number registry (§14, item 11), linking the reservation to that invoice's newly created database id — the invoice insertion and its registry reservation happen as one atomic step within the transaction, and it is the registry's unique `(shop_id, invoice_number)` constraint, not step 4's prevalidation, that is authoritative against a concurrent submission of the same number; then, if `received_now` is greater than zero for that row, inserts its initial payment (with `payment_method` fixed to the `cash` value validated in step 4);
  9. records one audit event for the batch;
  10. commits everything atomically.
- Prevalidation in step 4 remains required for fast, well-formed rejection, but it is advisory only; the invoice-number registry's unique constraint from step 8 is the authoritative protection against concurrency, exactly as §17 describes for the read-side check.
- Any failure at any step — a duplicate invoice ID, a duplicate or already-registered invoice number, a missing required customer, an unauthorized shop, insufficient backdate authority, a closed date, a total that fails validation, a non-`cash` payment method, or an idempotency conflict — rolls back the entire transaction: any customers, the batch, the invoices, the payments, the invoice-number registry reservations, and the audit write are all undone together. No partial commit is possible.
- Every row in the request carries the client's stable row ID (§2, item 1; the existing `BatchRowDraft.rowId` shape). Structured validation errors returned by the function — and by the server action that calls it — always include that `rowId` so the browser can map each error back to the exact grid row, reusing the existing `{ rowId, field, code, message }` shape.
- This reuses and extends the V1 Implementation Plan Task 5 interface (`submit_batch(command jsonb) returns jsonb`), which did not originally enumerate quick-add customer creation, the duplicate-number check (§17), or the idempotency-fingerprint check (§9); these are the required extensions to Task 5's original scope.
- A second write path — the follow-up payment operation — is required to satisfy §7's rule that outstanding balances on an already-committed invoice are settled through that invoice, not through a new invoice row. Its full contract is defined in §15; it follows the same pattern (server action → one `SECURITY DEFINER` transaction function → actor derived from `auth.uid()` → RLS limited to the read boundary), and its implementation and migration remain future work (§14, item 5).

## 7. Financial rules

- Invoice ID is required and unique per shop; enforced today by `invoices_shop_invoice_id_uq` on `(shop_id, invoice_id)`. This constraint is authoritative and is never overridden — no user, administrator, warning confirmation, or override may bypass it. This constraint governs the immutable original `invoice_id` column on the `invoices` table, which is never reassigned or reused; uniqueness of the *effective* invoice number across replacement versions (§16), including every historical number a canonical invoice has ever carried, is separately and permanently enforced by the invoice-number registry (§14, item 11 / §17).
- The same invoice ID may exist in a different shop — the composite key already allows this; it may not be duplicated within one shop under any circumstance.
- Total must be greater than zero (see §14, item 2 for the constraint gap).
- Received must be between zero and total for a **given payment event**; the transaction function must reject a received amount that would push the sum of an invoice's payments above its total, since there is no automatic overpayment-to-credit conversion in this phase's batch path (overpayment approval is V1 Plan Task 6 / Phase-3-of-the-original-numbering territory and is not re-specified here — an overpayment attempt in this phase's grid is a blocking row error, not an approval workflow).
- Due equals total minus received and is never directly typed; it is a computed preview client-side and a recomputed truth server-side, never trusted from the client.
- Payment method is fixed to the canonical value `cash` for this slice (§4). `payments.payment_method` has no check constraint today, and no database check constraint is required in this phase, because `authenticated` holds no direct insert grant on `payments` (§14.1) — the `SECURITY DEFINER` RPCs are the only authorized payment-write paths, and enforcement lives there. The browser validates `payment_method = 'cash'` for immediate feedback; the Next.js server action re-validates it; and both the batch-submission RPC (§6) and the follow-up-payment RPC (§15) each independently reject any request whose `payment_method` is not exactly `cash`, regardless of what the client sent or whether the client was bypassed entirely. The client is never an authorization or integrity boundary for this or any other rule in this design. Server-side/RPC enforcement of this rule, and tests proving a bypassed browser cannot defeat it, are mandatory (§12).
- A delivered row with remaining due requires a customer (§5).
- Duplicate invoice IDs within one submitted batch are blocked client-side (`validateBatch`) and server-side (unique index) as defence in depth.
- An invoice ID that already exists in the same shop — active or historical — is never silently recreated and never treated as an update: submitting it again as a "new invoice" row is always a blocking error. §17 defines the row-level detection and warning behavior; the only governed ways to act on an existing invoice are:
  - a follow-up payment against it (§15), when it has effective due remaining; or
  - viewing it, when it is already fully paid; or
  - following its current effective version, when one or more approved nonfinancial replacements exist for it (§16).
  None of these paths ever creates another `invoices` row under the same `(shop_id, invoice_id)`; a replacement is an append-only version attached to the same canonical invoice, not a new row.
- A partial payment recorded against an existing invoice (§15) attaches to that invoice's payment history; it never creates a second invoice row.
- Overpayment and disputed duplicate-entry handling are both outside the rapid-entry batch operation's scope; the batch operation must fail safely (a blocking row error, no partial write) rather than attempt to resolve either case itself.

## 8. Audit and correction

- Saved invoices and payments are never directly edited or deleted — already guaranteed at the database level by the append-only triggers and the `revoke update, delete ... from anon, authenticated` statement in `supabase/migrations/20260826095753_financial_schema.sql`. Direct administrator editing of a saved invoice is explicitly rejected as a correction mechanism; no such path exists or is proposed anywhere in this design.
- Two distinct correction classes exist, and this phase does not conflate them:
  - **Financial correction** — changes an invoice's amount or another monetary value, via an append-only `corrections` row (`amount_delta_dirham`, `reason` `not null`) referencing the original `invoice_id` or `payment_id`. This is what the existing `corrections` table already supports, unchanged by this design.
  - **Nonfinancial replacement** — corrects an invoice's effective number, customer, or delivered status without touching any monetary total, via an approved append-only replacement version attached to the canonical invoice, defined in §16. This is new to this design and has no schema support yet (§14, item 6).
  Amount-only correction support is not, by itself, sufficient for this phase's operational release: a mistyped invoice ID, a wrong delivered flag, or a wrong customer cannot be fixed through `corrections` and requires §16.
- A financial correction requires a reason, matching `corrections.reason` being `not null`. Who may request versus approve one follows the already-locked role matrix (Product Design Specification §3.2): any actor with shop access may request; only manager or owner may approve. This design does not change that matrix.
- Invoice Detail shows: the invoice (ID, total, business date, recorded timestamp), its payments, its delivery state, its customer (if any), the creating actor, its financial correction history (original amount plus every `corrections` row against it), and its replacement-version history/status (§16) when applicable. This is in-scope UI for this phase; it is the same screen where a follow-up payment (§15), a financial correction request, and a replacement request are initiated.

## 9. Reliability

- Every batch submission carries an idempotency key generated client-side and sent to the server action and transaction function together, scoped by `(shop_id, idempotency_key)`.
- The transaction function persists (or deterministically derives) a canonical batch fingerprint covering every field that affects the transaction's outcome:
  - shop ID
  - business date
  - normalized backdate reason
  - every row's stable client row ID (§2, item 1)
  - the batch's deterministic row order
  - every row's normalized invoice number
  - every row's total
  - every row's received amount
  - every row's canonical payment method
  - every row's delivered status
  - every row's existing-customer reference, when one is selected
  - every row's normalized inline-customer name and mobile number, when one is quick-added (§5)
  - every row's normalized invoice note
- Canonicalization before hashing is deterministic: a blank or whitespace-only optional string normalizes to `null` (the same rule §5 already applies to quick-add `name`/`mobile`, applied uniformly to every optional string field including the invoice note); fields are serialized in a fixed, documented order; batch row order is preserved exactly as submitted and never re-sorted; every monetary field uses its normalized integer-dirham value, never a floating-point or display-formatted string. An exact semantic replay of the same batch — same rows, same order, same values — always produces the same fingerprint, and changing any field that affects the transaction's outcome always changes the fingerprint.
- Repeating the same `(shop_id, idempotency_key)` with the same fingerprint returns the original successful result without any duplicate write.
- Repeating the same `(shop_id, idempotency_key)` with a different fingerprint fails with an explicit idempotency-conflict error and writes nothing.
- This requires a unique constraint/index that does not exist yet — today `batches.idempotency_key` is a plain nullable `text` column with no unique index and no fingerprint column (§14, item 7).
- The follow-up payment operation (§15), the replacement-request operation (§16.1), and the replacement-decision (approval/rejection) operation (§16.1) each apply the identical `(shop_id, idempotency_key)` + fingerprint + conflict semantics, using their own canonical fingerprint covering the fields relevant to that operation (§15 for follow-up payment; §16.1 for both the request and the decision) — request idempotency and decision idempotency are defined and enforced separately from each other, and each of these operations needs its own idempotency-key and fingerprint columns, since neither `payments` nor the future `replacement_requests` or `replacement_decisions` tables carry one today (§14, item 7).
- All validation that determines whether a batch actually commits happens inside the transaction function, not only in the server action or the browser.
- Errors returned to the browser map to the specific row and field where possible, reusing the `{ rowId, field, code, message }` shape already defined in `BatchValidationResult`.
- A network or session failure must never render as a false success; the UI only treats a batch as committed on an explicit server-confirmed result carrying a batch ID.
- Draft rows visible in the grid are cleared only after that confirmed commit — never optimistically.

## 10. Included scope

- Compact operational navigation (Overview, Invoices, Customers, Payments).
- The invoice rapid-entry workspace (Layout A).
- Multi-row manual entry plus spreadsheet-style paste.
- Business-date control, including the owner-only backdated path already modeled by `batches.is_backdated` / `batches.backdated_reason`.
- Customer search and inline quick-add.
- Atomic invoice + initial-payment creation in one transaction.
- Review-before-save with live batch totals.
- Recent invoice list for the current shop/date.
- Invoice detail, including its follow-up-payment action and its correction-request entry point.
- The governed correction flow (amount-delta reversal/adjustment with required reason and manager/owner approval).
- The dedicated follow-up-payment operation for an already-committed invoice (§15).
- The governed nonfinancial replacement-version operation for correcting an invoice's effective number, customer, or delivered status (§16).
- Row-level, same-shop existing-invoice-number detection and warning in the rapid-entry grid (§17).

## 11. Deferred scope

- Full Excel-file import/export (`lib/excel/*`, V1 Plan Task 8).
- Handwritten-image extraction / OCR (excluded from V1 entirely per the Product Design Specification §22).
- Expense entry (V1 Plan Task 11).
- A standalone payment-collection screen decoupled from a specific invoice (distinct from the Invoice Detail follow-up-payment action in §6/§10/§15, which **is** in scope).
- A full customer-ledger management screen (V1 Plan Task 10); this phase's customer quick-add and search are limited to what the batch grid needs.
- Dashboard analytics / owner reporting (V1 Plan Task 13).
- Daily-close UI (close/reopen screens, V1 Plan Task 12) — the underlying `daily_closes` event table already exists and this phase's transaction function must still refuse to write against a closed date, but the screens to close/reopen a date are not built in this phase.

## 12. Required verification

- **Domain unit tests** — extend `tests/unit/domain/batches.test.ts` and `tests/unit/domain/invoices.test.ts` to cover the note field, the persisted-delivered-flag round trip, the quick-add blank-identifier rejection (§5), and the "existing invoice ID is not a duplicate row error when it is a legitimate follow-up payment" distinction from §7.
- **Component tests** — a reducer test (paste parsing, add/remove/update row, stable row IDs, Tab/Enter navigation) following the V1 Plan Task 7 pattern (`features/batches/draft-reducer.ts` and its test), plus a test for the row-level duplicate-number warning states (amber due / red fully-paid / blocked historical) from §17.
- **pgTAP transaction/security tests** — new assertions (extending `supabase/tests/schema.test.sql` and/or a new `supabase/tests/submit_batch.test.sql`) covering, at minimum:
  - an unauthorized (unauthenticated, wrong-shop, or insufficient-role) call to the `SECURITY DEFINER` function is rejected;
  - a request that attempts to inject a cross-shop customer, invoice, or batch reference is rejected;
  - a quick-add row with both `name` and `mobile` blank (or whitespace-only) is rejected;
  - a delivered row with due and no customer is rejected;
  - a same-shop duplicate invoice number is rejected, including when the number is a historical (no-longer-effective) number already registered to any canonical invoice (§14, item 11 / §17);
  - the same invoice ID is accepted across two different shops;
  - a successful batch creates the batch record and links every invoice to it;
  - any single invalid row rolls back the entire batch — customers, batch, invoices, payments, and audit event all undone together;
  - replaying an identical `(shop_id, idempotency_key)` + fingerprint returns the original result with no new writes;
  - replaying the same `(shop_id, idempotency_key)` with a changed fingerprint fails with an explicit conflict error;
  - a total-not-greater-than-zero row is rejected;
  - quick-add customer creation happens inside the same transaction as the batch;
  - the closed-date rejection path is enforced;
  - a backdated batch from a non-`owner` actor is rejected, and from `owner` is accepted (§14, item 9);
  - a row with `received_now > 0` and a `payment_method` other than `cash` is rejected by the RPC (§4/§7), including when called directly with the browser and server action bypassed entirely;
  - a successful row's invoice insertion and its invoice-number registry reservation commit as one atomic step — a simulated failure between the two leaves neither the invoice nor the registry row committed (§6/§14, item 11);
  - the invoice-number registry reservations for every row roll back together with the rest of a failed batch, alongside the customers, batch, invoices, payments, and audit event (§6);
  - two concurrent submissions attempting to reserve the same `(shop_id, invoice_number)` resolve to exactly one success and one rejection via the registry's unique constraint, not the prevalidation step (§6/§17);
  - the canonical batch fingerprint changes when a row's stable client row ID, row order, inline-customer name/mobile, or invoice note changes, and is stable across an exact semantic replay (§9).
- **Follow-up payment tests** (§15) — a valid partial payment against an existing invoice succeeds and returns updated effective paid/due; a payment that would exceed effective outstanding due is rejected; a backdated follow-up payment from a non-authorized actor is rejected; a non-`cash` `payment_method` is rejected by the RPC, including when called directly with the browser bypassed entirely (§4/§7); idempotent replay and conflict semantics match §9; the payment never creates a second invoice row.
- **Replacement-version tests** (§16) — a request is rejected without `invoice.replacement.request`; an approval is rejected without `invoice.replacement.approve`; `staff` can request but is rejected on any approval attempt; `manager`/`owner` can both request and approve, including approving their own request, and doing so still creates separate append-only request and decision records (never a merged or updated request row); the canonical `invoices` row is never mutated, deleted, or duplicated by either a request or an approval; a rejected request leaves all effective invoice data unchanged; an approved request becomes the next linear effective version with an atomically allocated revision sequence; at most one decision row ever exists per request; a request whose expected version no longer matches the invoice's current effective version is rejected as stale at approval time (a second replacement approved after the request was created); two concurrent approval attempts against the same canonical invoice resolve to exactly one committed version and one rejected/conflicting approval, never a branching history; the replacement's proposed effective invoice number, when it changes the current effective number, must satisfy the invoice-number registry's `(shop_id, invoice_number)` uniqueness (§14, item 11) and is rejected when already registered to a different canonical invoice; the same canonical invoice may reuse its own already-registered number across further replacements without a new registry entry; the effective-invoice projection (§14, item 10) returns the latest approved version's number/customer/delivered status when one exists and the original invoice's fields when none exists, plus the full version history; an attempt to change any monetary total or received amount through a replacement request is rejected (must use financial correction instead, §8); no payment, correction, or other financial row is created, changed, or referenced differently by a replacement; the whole approval operation — decision record, revision allocation, registry reservation when the number changes, and audit event — commits or rolls back atomically; idempotent replay and conflict semantics for the request match §9; a replacement-decision replay with an identical `(shop_id, idempotency_key)` and fingerprint is idempotent and returns the original decision result with no new write (§16.1); a retried decision key carrying different decision data (a different outcome, reason, or expected version) fails with an explicit idempotency-conflict error; an approval retry under the same decision key never allocates a second revision sequence; and a schema check confirms no mutable revision-counter column exists on `invoices` at any point (§16.1/§16.2).
- **Duplicate invoice-number detection tests** (§17) — an existing invoice with outstanding due produces the amber warning showing its effective due and routes to the Record Payment / follow-up payment workflow; an existing fully paid invoice produces the red warning and blocks the row; both cases block the batch from saving that row as a new invoice; a historical invoice number registered to any canonical invoice cannot be reused for a new invoice (§14, item 11); the identical invoice number remains valid and unblocked in a different shop; a user without access to another shop cannot discover that shop's invoice through this check, even by supplying its shop ID directly; server-side duplicate rejection still fires when client-side detection is stale or bypassed entirely; two concurrent same-shop submissions of the same invoice number resolve to exactly one committed invoice and one rejected/conflicting submission; the registry backfill migration registers every existing invoice's current number to its canonical invoice with no gaps.
- **Local-Supabase integration tests** — `tests/integration/batches/submit-batch.test.ts` per the V1 Plan Task 5 naming, plus equivalent integration coverage for the follow-up-payment, replacement-request, and replacement-approval functions, run against the real local Supabase stack, not mocks.
- **Playwright operational tests** — an end-to-end spec exercising every step of the expanded §13 completion gate (batch entry/review/atomic save, exact idempotent replay, recent-invoice and invoice-detail verification, the §17 duplicate-number amber/red warning flows and their Record Payment/View Invoice actions, follow-up partial cash payment, non-cash-payment and overpayment rejection with the browser bypassed, the full §16 replacement request-and-approval flow including staff-cannot-approve and manager/owner self-approval, invoice-number-vs-customer-only-vs-delivered-only replacement retention, historical-number reuse blocking, and Shop 2 isolation throughout), against the seeded local `staff1@shopkhata.local` (Shop 1 staff), `owner@shopkhata.local`, and (for approval/replacement authorization) a manager account. No expanded completion-gate behavior in §13 may be exercised only manually — each has Playwright coverage.
- **Database reset and lint** — `pnpm exec supabase db reset --local`, `pnpm exec supabase test db --local`, `pnpm exec supabase db lint --local --level warning --fail-on error`.
- **Generated types** — regenerate `lib/supabase/database.types.ts` only after database GREEN, as strict UTF-8 with no BOM and exactly one trailing newline, per the convention already established in the Phase 2 remediation plan.
- **Lint / Typecheck / Build** — `pnpm lint`, `pnpm typecheck` (`next typegen && tsc --noEmit`), `pnpm build`.
- **Audit** — `pnpm audit` reporting no known vulnerabilities.
- **Full regression matrix** — rerun the existing schema pgTAP suite (99 assertions), RLS pgTAP suite (39 assertions), `pnpm test:migration-upgrade` (2 tests), the full unit suite, and the full `tests/e2e` suite (currently `auth.spec.ts` and `smoke.spec.ts`) alongside every new Phase 3 test, so nothing already GREEN regresses.

## 13. Completion gate

This gate must pass end to end, using the seeded accounts already referenced in §12 (`staff1@shopkhata.local`, seeded in `supabase/seed.sql`, for Shop 1 staff; `owner@shopkhata.local` for owner; and a seeded manager account for manager-role steps). Phase 3 cannot be declared complete unless every step below passes.

1. Sign in as Shop 1 staff (`staff1@shopkhata.local`).
2. Enter a mixed invoice batch in the rapid-entry grid — at least one row delivered-and-paid, one row delivered-with-due-and-a-customer, and one advance-with-partial-payment row — review it (live totals, no blocking errors), and save it atomically in one action.
3. Replay the exact same batch submission under the same idempotency key and confirm no duplicate batch, invoices, or payments are created (§9).
4. See the resulting invoices and their initial payments reflected in the recent-invoices list, and open an invoice's detail page to see its invoice, payments, delivery state, customer, creating actor, and timestamps.
5. Enter a new row using an invoice number that already exists in the shop and is fully paid; confirm it produces a red blocking warning and a **View Invoice** action (§17), and that the row cannot be saved as a new invoice.
6. Enter a new row using an invoice number that already exists in the shop and still has outstanding due; confirm it produces an amber blocking warning showing the existing due and a **Record Payment** action (§17), and that the row cannot be saved as a new invoice.
7. Use the Record Payment / follow-up-payment workflow (§15) to record a successful partial `cash` payment against that existing invoice, and confirm its effective paid/due update correctly.
8. Attempt a follow-up payment with a non-`cash` payment method by calling the RPC directly, bypassing the browser entirely; confirm it is rejected (§4/§7/§15).
9. Attempt a follow-up payment that would exceed the invoice's effective outstanding due; confirm it is rejected as an overpayment (§7/§15).
10. As Shop 1 staff, submit a nonfinancial replacement request against a committed invoice with a reason (§16).
11. Confirm Shop 1 staff cannot approve that request, or any replacement request (§16.3).
12. As a manager or owner, approve the staff-submitted request and confirm it becomes the invoice's new effective version.
13. As a manager or owner, create a separate replacement request and self-approve it, confirming separate append-only request and decision records are created even when the same actor performs both steps (§16.3).
14. Confirm a customer-only replacement retains the invoice's existing effective invoice number.
15. Confirm a delivered-status-only replacement retains the invoice's existing effective invoice number.
16. Confirm an invoice-number-changing replacement permanently reserves the new number in the invoice-number registry (§14, item 11).
17. Confirm the invoice's prior (now-historical) number remains permanently blocked from reuse by any other invoice in the shop (§17).
18. Confirm the original canonical `invoices` row itself remains completely unchanged (same id, same immutable original fields) throughout every replacement above.
19. Confirm payments and financial-correction references continue to point at the canonical invoice's database id regardless of how many replacement versions now exist.
20. Confirm the effective-invoice projection (§14, item 10) shows the invoice's current effective number/customer/delivered status alongside its complete version history.
21. Confirm the effective-invoice projection's `effective_total`/`effective_paid`/`effective_due` correctly include any approved financial corrections recorded against the invoice or its payments.
22. Throughout every step above, confirm Shop 2 remains completely isolated — no Shop 2 record is readable or affected at any point, including by supplying a Shop 2 ID directly.

## 14. Schema and application reconciliation

### 14.1 What already matches this design (no change needed)

- Invoice identity `(shop_id, invoice_id)` uniqueness — `invoices_shop_invoice_id_uq`. This constraint remains intact unchanged: a nonfinancial replacement (§16) is an append-only version attached to the existing canonical `invoices` row, never a new `invoices` row, so it never interacts with or needs to satisfy this constraint again.
- Money as integer dirham (`bigint`) columns — `total_amount_dirham`, `amount_dirham` — matching `lib/domain/money.ts`'s `parseQar`/`formatQar` contract.
- Payment method defaulting to `'cash'` — `payments.payment_method`; this design canonicalizes it to `cash` only for this slice (§4/§7). Enforcement of that canonicalization is server-side, not a UI-level decision: the browser and the Next.js server action validate it for feedback, and every payment-writing `SECURITY DEFINER` RPC (§6, §15) independently rejects any non-`cash` value. No database check constraint is required in this phase, because those RPCs are the only authorized payment-write paths — but the server-side/RPC enforcement itself, and tests proving a bypassed browser cannot defeat it, are mandatory (§12) and are not satisfied by schema alone.
- `invoices.invoice_type` remains free `text`, default `'advance'`, unconstrained, internal-only, and unexposed in the UI for this slice (§4) — a decision, not an open item; no schema change is required.
- `authenticated` holds **no `insert` grant** on any financial table today — only `select` is granted, and `update`/`delete` are explicitly revoked (`supabase/migrations/20260828164246_rls.sql`, `supabase/migrations/20260826095753_financial_schema.sql`). Every write in this design, including the follow-up payment (§15) and replacement-request/approval (§16) operations, must therefore go through a `SECURITY DEFINER` function; RLS's role is limited to permitted reads and to blocking any direct client write, never to authorizing what a `SECURITY DEFINER` function itself may write (§6).
- Append-only enforcement on every financial table — triggers plus revoked `update`/`delete` grants — already blocks any direct `UPDATE`/`DELETE` of a saved invoice at the database level; this design adds no exception to that (§8, §16).
- Business date vs. immutable recorded timestamp kept as two separate columns — present on `batches`, `invoices`, and `payments`.
- Backdated-batch modeling — `batches.is_backdated` / `batches.backdated_reason` already exist and need no new columns.
- Composite tenant-consistent foreign keys (every shop-owned child row's `shop_id` agrees with its parent) — `supabase/migrations/20260902073650_phase2_security_remediation.sql`.
- Customer optional name/mobile with a system-generated `public_id` — `customers` table and its sequence-backed default.
- RLS `select` policies scoped by `private.has_shop_access(shop_id)` on every relevant table, with `owner` seeing both shops and `manager`/`staff` seeing only assigned shops — `supabase/migrations/20260828164246_rls.sql`.
- The single "Owner/Admin" persona mapped to exactly the `owner` database role, with no separate `admin` role — locked by V1 Plan Task 4 and reused unchanged here.
- The domain-level lifecycle derivation (`ADVANCE` / `DELIVERED_PAID` / `DELIVERED_DUE`) and the batch validator's duplicate/overpayment/customer-required checks — `lib/domain/invoices.ts`, `lib/domain/batches.ts`.

### 14.2 Required future schema/application changes (not made in this document)

1. **Persist the delivered flag.** `invoices` has no column for it today; the domain layer already expects one. A future migration must add something like `delivered boolean not null default false`.
2. **Tighten the total-amount constraint.** `invoices_total_amount_nonnegative` currently allows `total_amount_dirham = 0`; this design requires strictly greater than zero. A future migration must replace or add a check enforcing `> 0`.
3. **Add a note column.** No `invoices`, `batches`, or `payments` column exists for the optional per-row note this design requires; only `attachments.note` exists today. A future migration must add it to `invoices` only (rows represent invoices, per §1) — not to `batches` and not to `payments`. The follow-up-payment command and RPC do not accept a note/reference in this phase (§15); that scope is closed, not conditional.
4. **Create the batch-submission transaction function.** No write RPC of any kind exists in the database today — confirmed by grepping every migration for `create function`, which returns only the three `private.*` RLS helpers and the append-only trigger function. This `SECURITY DEFINER` function (extending V1 Plan Task 5's `submit_batch` per §6) must implement the full authorization boundary in §6, the duplicate-number check in §17, and the idempotency/fingerprint semantics in §9 — it is the only way any of this design's batch writes can happen at all.
5. **Build the follow-up-payment function.** Its full contract is now defined in §15; only its implementation and migration remain future work.
6. **Build the append-only nonfinancial replacement-version schema and function(s).** The `replacement_requests` table, the `replacement_decisions` table, the revision-sequence bookkeeping on the canonical invoice's replacement state, the approval RPC's optimistic-concurrency and atomic-revision-allocation logic, and the two new named authorization capabilities are all defined in §16 but not implemented by this document (§16.4).
7. **Add idempotency-key uniqueness and a request fingerprint.** `batches.idempotency_key` exists but carries no unique index and there is no fingerprint column anywhere; §9's retry-safety and conflict-detection guarantees need a unique index scoped to `(shop_id, idempotency_key)` plus a fingerprint column on `batches`, and equivalent columns on `payments` (§15) and the future `replacement_requests` and `replacement_decisions` tables (§16.1). The request and the decision are separately idempotent (§16.1), so `replacement_requests` and `replacement_decisions` each need their own key/fingerprint columns rather than sharing one.
8. **Build the "current shop" and navigation shell.** Today `app/(app)/layout.tsx` only authorizes and passes `children` through with no chrome, and `app/(app)/page.tsx` lists every RLS-visible shop with no selection state. §3's compact navigation, current-shop indicator, and owner shop-switcher are new application code, not present today.
9. **Add an explicit backdated-entry authorization rule in code.** `lib/auth/permissions.ts`'s `batch.enter` permission is granted uniformly to `staff`, `manager`, and `owner` with no notion of "is this business date backdated." The rule that only `owner` may submit a backdated batch (Product Design Specification §14) must be enforced explicitly — either as a new `Permission` or as a check inside the transaction function(s) — since no such check exists in code today. This applies to batch submission (§6) and to a backdated follow-up payment (§15) alike.
10. **Build the authoritative effective-invoice projection.** No such projection exists today. Once §16's replacement-version schema exists, one database projection/function/view must resolve, for each canonical invoice: its canonical database invoice id; its current effective user-facing invoice number, customer, and delivered status (the latest approved replacement version's values, or the original invoice's own fields when no replacement has been approved); its immutable original monetary values and business date; its current approved revision sequence; its replacement history/status; and its `effective_total`, `effective_paid`, and `effective_due`, computed as:

   ```text
   effective_total =
     original invoice total
     + sum of approved invoice financial-correction deltas

   effective_paid =
     sum of original append-only payment amounts
     + sum of approved payment financial-correction deltas

   effective_due =
     effective_total - effective_paid
   ```

   Operational lists, invoice detail, customer-balance computations, the duplicate-number check (§17), and payment operations (§15) must all read from this single projection rather than independently reimplementing replacement or correction logic.
11. **Build the invoice-number registry.** No registry exists today. A future migration must add an append-only table uniquely keyed on `(shop_id, invoice_number)`, where every entry points to exactly one canonical invoice root. Existing invoice numbers must be backfilled into it during that migration. Creating a new invoice must reserve its number atomically with the invoice; an approved replacement that changes a canonical invoice's effective number (§16) must reserve the new number atomically during approval; a number already registered to a different canonical invoice must cause rejection; a historical number is never deleted, released, or reassigned to a different canonical invoice; and the same canonical invoice may continue using its own already-registered effective number for later customer-only or delivered-status-only replacements without creating another registry entry. §17's same-shop duplicate-number lookup must be performed against this registry, not against `invoices.invoice_id` alone, since an approved replacement can change a canonical invoice's effective number without changing that original column (§14.1, §7).

No item above contradicts an already-locked requirement; each is an addition or a tightening of an existing, looser column, permission, or authorization rule, and none of them are implemented by this document.

## 15. Follow-up payment contract

Recording a payment against an already-committed invoice is a dedicated, authenticated server action backed by its own transactional `SECURITY DEFINER` RPC — separate from batch submission (§6) — because the invoice and any prior payments already exist and must not be re-created.

The server action accepts:

- `shop_id`
- the invoice's database `id` (not its user-facing `invoice_id` text)
- `amount_dirham` (positive integer dirham)
- `payment_method` (canonical `cash` for this slice, per §4/§7)
- `business_date`
- `idempotency_key`

Follow-up payment does not accept, store, or display a note or reference in this phase. This is a closed decision, not conditional on any future schema approval: the invoice note (§4, §14, item 3) is scoped to the canonical invoice only, and a note/reference on the follow-up-payment command and RPC is deferred out of Phase 3 entirely.

The RPC must:

- derive the actor identity from `auth.uid()` only — it never accepts or trusts a caller-supplied actor id;
- verify the actor has access to `shop_id` using the same rule `private.has_shop_access` encodes;
- verify the target invoice belongs to `shop_id` (reject cross-shop injection even if the invoice `id` is otherwise valid);
- enforce that `payment_method` is exactly the canonical value `cash` — reject any other value with no exception, regardless of what the browser or server action already validated (§4/§7);
- enforce that `amount_dirham` is a positive integer number of dirham;
- compute the invoice's current `effective_total`, `effective_paid`, and `effective_due` from the effective-invoice projection (§14, item 10) and reject any amount that would push `effective_paid` beyond `effective_total` — no overpayment-to-credit conversion in this path (§7);
- if `business_date` is earlier than today, verify the actor holds backdate authority (§14, item 9) before proceeding;
- insert one append-only `payments` row;
- record one `audit_events` row for the payment;
- return the invoice's updated effective paid and due amounts;
- apply the `(shop_id, idempotency_key)` + request-fingerprint semantics from §9: an identical replay returns the original result; a reused key with a different fingerprint fails with an explicit conflict error, and neither path performs a duplicate write.

This function is new; no interface for it exists in any previously approved plan. Its exact name and signature are decided during implementation, not fixed here, but every requirement above is binding on that implementation. Its migration and RPC creation remain future work (§14, item 5).

## 16. Governed nonfinancial replacement (append-only version model)

Saved invoices are immutable (§8): there is no direct `UPDATE` or `DELETE` of an original invoice, and this design does not add one. A wrong invoice number, wrong customer, or wrong delivered status is corrected only through this governed replacement operation. Direct administrator editing of a saved invoice is rejected as a correction mechanism, with no generic bypass for any role.

The original `invoices` row is the permanent canonical financial invoice root. It is never mutated, deleted, or duplicated by this operation. Payments and financial corrections always reference that canonical row's database id, regardless of how many replacement versions exist for it. A nonfinancial correction never creates another `invoices` row; instead, an approved replacement request becomes an append-only nonfinancial version attached to the canonical invoice. The latest approved version determines the invoice's effective user-facing invoice number, customer, and delivered status; if no replacement has ever been approved, the original invoice's own fields remain effective. Every version — the original and every approved replacement — remains permanently queryable for audit.

The user-facing workflow may still be described to users as "governed replacement." It does not insert a replacement financial invoice row, and there is no payment chain across multiple invoice rows — there is exactly one `invoices` row per canonical invoice, always.

### 16.1 Data model

Two new append-only tables capture the replacement workflow. Neither one is, or ever creates, an `invoices` row.

**Replacement request** — an append-only row proposing a nonfinancial change:

- `id`
- `shop_id`
- `canonical_invoice_id` (database id of the immutable original `invoices` row)
- the expected current version/revision identifier the request was based on
- proposed effective invoice number
- proposed effective customer id (nullable, when a null customer is allowed per §5)
- proposed effective delivered status
- `reason` (required, not null)
- requester actor id, derived from `auth.uid()` only
- requested timestamp
- `idempotency_key` (§9)
- canonical request fingerprint (§9)

**Replacement decision** — a separate append-only row recording the outcome of exactly one request:

- request id
- decision (`approved` or `rejected`)
- deciding actor id, derived from `auth.uid()` only
- decision timestamp
- optional decision reason (normalized before use in the fingerprint below)
- approved revision sequence, present only when the decision is `approved`
- `idempotency_key` (§9)
- canonical decision fingerprint (§9), covering: shop ID, request ID, the expected current version the decision was made against, the approved/rejected decision itself, the normalized decision reason, and the authenticated deciding actor as derived server-side from `auth.uid()`

At most one decision row may exist per request. An approved request is the next effective immutable version. A rejected request never changes any effective invoice data. Approval is never modeled by updating the request row — the request row is never mutated after it is written.

The decision operation carries its own `(shop_id, idempotency_key)` + fingerprint semantics (§9), defined and enforced separately from the request's own idempotency — either as explicit `idempotency_key`/fingerprint columns on the decision record itself, or an equivalent authoritative operation-receipt mechanism — and must guarantee: an exact replay of the same decision returns the original decision result with no new write; a retried key carrying different decision data (a different outcome, reason, or expected version) fails with an explicit idempotency-conflict error and writes nothing; concurrent decision attempts against the same request produce at most one committed decision row, never two; no request can end up both approved and rejected; a retried approval never allocates a second revision sequence; and a retried approval never duplicates a registry reservation (§14, item 11) or an audit event. No mutable revision counter is stored on the canonical `invoices` row — the approved revision sequence is derived transactionally from the append-only decision/version records themselves, using uniqueness and row-level locking (§16.2), never from a counter column that could be concurrently incremented out of order.

These tables, their constraints, and their supporting RPC(s) do not exist today and are future schema/application work (§14, item 6).

### 16.2 Rules

- The canonical `invoices` row is never mutated, deleted, or duplicated by this operation. Payments and financial corrections always reference that canonical row.
- An approved replacement request becomes the invoice's next effective, immutable version — an append-only fact, not an edit — and does not create another `invoices` row.
- Each request identifies the effective version it was based on. During approval, the transactional RPC must: lock or otherwise serialize the canonical invoice's replacement state (via row-level locking on the canonical invoice row or its latest decision record — never via a mutable revision-counter column, which does not and must not exist on `invoices`); confirm the request still targets the current effective version; reject the request as stale if a different replacement was approved for that invoice after the request was created; allocate the next revision sequence atomically, derived from the append-only decision/version records under that lock, not from any stored counter; create the decision record atomically with that allocation, applying the decision-idempotency guarantees in §16.1; and change no financial invoice, payment, or correction row. This produces exactly one linear sequence of approved effective versions per canonical invoice — branching replacement histories are prevented by construction, not by convention — and guarantees that a retried approval call never allocates a second revision sequence for the same decision.
- This operation is allowed only when it changes no monetary total and no received amount — it exists to fix effective identity fields (invoice number, customer, delivered status), not amounts. Any request that would also change `total_amount_dirham` or the recorded payments is rejected; an amount change must go through the existing financial-correction mechanism (§8) instead, never through this operation.
- An approved replacement that changes the effective invoice number must reserve that new number in the invoice-number registry (§14, item 11) atomically within the same approval transaction; a number already registered to a different canonical invoice causes rejection. The same canonical invoice may continue using its own already-registered effective number for later customer-only or delivered-status-only replacements without creating another registry entry.
- The entire approval operation — the decision record, the revision allocation, the registry reservation when the number changes, and the audit event — is atomic: it commits completely or not at all.
- The replacement *request* and the replacement *decision* each apply the `(shop_id, idempotency_key)` + fingerprint semantics from §9 identically to batch submission and follow-up payment, but as two separately keyed, separately fingerprinted operations (§16.1) — replaying or conflicting on the request's key never affects the decision's key, and vice versa.

### 16.3 Authorization

Exactly two named capabilities govern this operation, added to `lib/auth/permissions.ts`:

- `invoice.replacement.request`
- `invoice.replacement.approve`

Role mapping:

- `staff` may request `invoice.replacement.request` for a shop it is assigned to and has access to; `staff` may never approve.
- `manager` may request and approve (`invoice.replacement.approve`) for a shop it is assigned to and has access to, including approving its own request.
- `owner` may request and approve for any shop it has access to, including approving its own request.

V1 does not require a second person to decide a request: a `manager` or `owner` may request and immediately approve their own replacement request. Even then, the system must still create separate append-only request and decision records — approval is never merged into or inferred from the request row. Approval must never rely on caller-supplied actor or role data; all actor identity and authority are derived from `auth.uid()` and verified server-side, following the same authorization pattern as §6. Requester, approver (once decided), reason, and both timestamps are always recorded. This design does not invent a generic "admin" bypass, and no such bypass exists anywhere in this document.

### 16.4 Future implementation scope

Schema objects (the `replacement_requests` and `replacement_decisions` tables and their constraints, including the "at most one decision per request," "one linear version sequence per canonical invoice," and "no mutable revision-counter column on `invoices`" invariants, plus the request's and the decision's separate `idempotency_key`/fingerprint columns per §14 item 7), the RPC(s), the effective-invoice projection this section depends on (§14, item 10), the invoice-number registry this section depends on (§14, item 11), the two new named capabilities in `lib/auth/permissions.ts`, pgTAP tests, integration tests, and Playwright/E2E coverage are all future implementation work (§14, item 6), not implemented by this document.

## 17. Existing invoice-number detection and warning

The rapid-entry workflow gives explicit, row-level feedback when an entered invoice number already exists, scoped to the currently selected shop only. Invoice uniqueness is scoped to the current shop; the same invoice number may exist in another shop.

Because an approved replacement can change a canonical invoice's effective user-facing number without changing the original `invoices.invoice_id` (§16), this check is always performed against the invoice-number registry (§14, item 11), never by comparing directly against `invoices.invoice_id` alone.

When an invoice number is typed, pasted, or changed in the grid, the registry is searched within the current shop. If a registry entry exists, it is resolved to its canonical invoice and that invoice's latest approved effective version via the effective-invoice projection (§14, item 10), which supplies the effective due and governed status used below.

- If no registry entry exists for that number in the current shop, entry proceeds normally.
- If the invoice's effective outstanding due is greater than zero:
  - the row shows an amber warning;
  - the warning displays the existing invoice's effective due amount;
  - the row is blocked from being saved as a new invoice;
  - the warning offers a **Record Payment** action that opens the governed follow-up payment workflow (§15) for the existing invoice.
- If the invoice's effective outstanding due is zero:
  - the row shows a red warning stating that the invoice already exists and is fully paid;
  - the row (and therefore the batch, since any blocking error blocks the whole batch per §2) is blocked from saving as a new invoice;
  - the warning offers a **View Invoice** action.
- If the canonical invoice behind that registry entry has one or more approved replacement versions (§16), in addition to the amber/red status above:
  - the row shows that governed status, including the currently effective invoice number, customer, and delivered status;
  - when the entered number is an earlier, no-longer-effective number for that canonical invoice, the warning links to its current effective version.
- Reuse of a registered number for a *different* canonical invoice is permanently blocked by the registry's `(shop_id, invoice_number)` uniqueness (§14, item 11); the same canonical invoice may continue using its own already-registered number across further replacements without conflict.
- The same invoice number remains valid and unblocked when entered in a different shop — the registry's uniqueness is scoped to `(shop_id, invoice_number)`, never shop-agnostic.
- These warnings never expose any record from a shop the current actor cannot access; the check is scoped by the same `private.has_shop_access(shop_id)` rule as every other read in this design, so an actor cannot discover another shop's invoice by supplying its shop id directly.
- This client-side detection is advisory only, for immediate feedback. The transactional RPC (§6) performs the authoritative same-shop registry uniqueness check again at submission time, regardless of what the client displayed.
- A concurrent insertion detected at submission time — for example, two staff saving the same invoice number in the same shop at nearly the same moment — returns a structured row-level duplicate error carrying the request's stable client row ID (§6), so exactly one submission commits and the other is rejected with a mapped error, never two invoice rows.
- No user, administrator, warning confirmation, or override may bypass the registry's `(shop_id, invoice_number)` uniqueness rule or the underlying `invoices_shop_invoice_id_uq` constraint. There is no override path anywhere in this design (§7).
- Re-entering an invoice number that has due does not create a duplicate invoice under any circumstance; it always routes to the follow-up payment workflow (§15) instead.
