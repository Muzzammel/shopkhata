# Phase 3C: Overpayment Approval and Customer Credit (`approve_overpayment` RPC)

**Status:** Draft — ready for implementation. Written to close the gap the Phase 3B plan explicitly deferred (overpayment/credit was "not re-specified" by the authoritative design doc at that time).
**Depends on:** Phase 3A (`submit_batch`), Phase 3B (`record_payment`, `payments` idempotency columns), both merged.
**Spec sources:** V1 Implementation Plan Global Constraints ("Overpayment requires approval, a reason, and a selected customer; excess becomes customer credit.") and Task 6; `docs/plans/ShopKhata-Phase-3-Invoice-Operations-Design.md` §7 (explicitly defers this) and §14.1 (confirms `customer_credits` needs no RLS/grant changes — same "no direct authenticated write, RPC-only" shape as `payments`/`corrections`).

## Scope

Implements exactly the follow-up-payment case where the amount offered exceeds the invoice's effective due: the excess is recorded as the customer's store credit, requiring a reason, and requiring the invoice to have a customer already attached. This is the last piece of V1 Plan Task 6; it does not touch anything else in Task 6 that doesn't exist yet (there is no separate "request now, approve later" queue — see Design decision 1).

**Explicitly out of scope:**
- Spending/redeeming a customer's existing credit balance against a future invoice. No schema or UI exists for that yet (`customer_credits` only ever grows in this design); redemption is a distinct future feature.
- A UI for any of this. Same as Phase 3A/3B, this is backend-RPC-only.
- A two-actor asynchronous request/approve queue (see Design decision 1) — deferred until there is a UI that could show a manager a pending queue.

## Design decisions

1. **Single-actor authorization, not a two-phase request/approve queue.** The V1 plan's Task 6 step 4 describes separate `requested_by`/`approved_by` audit fields, which reads as a staff-requests / manager-approves workflow. But no UI exists anywhere in this app yet — there is nowhere for a "pending overpayment" to be shown to a manager for later decision. Building a real asynchronous queue now would mean inventing a pending-state table and a decision RPC with no consumer. Instead, this RPC may only be called by an actor who already holds override authority (role `owner` or `manager` — the same two roles `lib/auth/permissions.ts` grants `payment.override_excess`); staff cannot call it at all and continue to get `record_payment`'s existing `OVERPAYMENT_NOT_ALLOWED` rejection, at which point they escalate to a manager or owner in person, who then calls this RPC themselves. `requested_by` and `approved_by` are therefore the same actor for now. This exactly mirrors the backdate-authorization precedent already shipped twice in this codebase (`submit_batch`, `record_payment`): a single actor with sufficient standing performs the whole action in one call, rather than a multi-party workflow. A future phase can add a genuine pending-request queue without changing this RPC's authorized-actor code path.
2. **The customer is derived from the invoice, never taken from the client.** The command does not accept a `customer_id` field. The RPC reads `invoices.customer_id` for the target invoice; if it is `null`, the request is rejected with `INVOICE_HAS_NO_CUSTOMER` rather than letting the caller name an arbitrary customer to credit — this is both simpler and closes an injection class (a caller could otherwise credit a customer unrelated to the invoice).
3. **Backdate authority is unchanged: owner only, not manager.** Even though `manager` holds `payment.override_excess` and may call this RPC for today's date, backdating one still requires strictly the `owner` role, identical to the rule already enforced in `submit_batch` and `record_payment` (`payment.override_excess` grants the overpayment action; it does not grant backdate authority, which is a separate, narrower rule).
4. **The invoice is always left fully paid; the excess always becomes credit — never a partial credit/partial rejection.** `amount_dirham` must be strictly greater than the invoice's effective due (§ Design decision 5); the RPC rejects a non-overpaying amount with `NOT_AN_OVERPAYMENT` and tells the caller to use `record_payment` instead. This keeps the two RPCs' responsibilities crisp: `record_payment` is the only path for an amount at or under due; `approve_overpayment` is the only path for an amount over due.
5. **Effective-due computation is identical to `record_payment`'s** (`docs/plans/ShopKhata-Phase-3-Invoice-Operations-Design.md` §14.2 item 10's interim direct-computation formula, unchanged). `applied_amount` is always exactly the invoice's effective due at the moment of the call; `credit_amount` is always exactly `amount_dirham - applied_amount`.
6. **One `payments` row for the applied amount, one `customer_credits` row for the excess, in the same transaction.** `payments.amount_dirham` records only the amount actually applied to the invoice (never the full cash tendered), so `sum(payments.amount_dirham)` for an invoice never exceeds its total, and the existing `record_payment`/`submit_batch` effective-due formula needs no changes to stay correct for invoices that went through an overpayment. The `customer_credits` row carries the excess, the required `reason`, and the invoice for traceability.
7. **Idempotency reuses the `payments` idempotency columns added in Phase 3B — no new columns on `customer_credits` for this.** The advisory-lock + fingerprint + `(shop_id, idempotency_key)` replay/conflict semantics are identical to `record_payment`, checked against the `payments` row this call would create. Because the `payments` row and the `customer_credits` row are always written together in the same transaction, detecting replay via the `payments` row alone is sufficient — a successful replay returns the original stored result (which already includes `credit_id`) without touching `customer_credits` again.
8. **`customer_credits` gets one new column: `approved_at timestamptz`, nullable.** Every other column it needs already exists (`created_by`, `approved_by`, `reason`, `business_date`, `recorded_at`). Since this design's single-actor authorization means creation and approval are simultaneous, `approved_at` is always set equal to `recorded_at` on insert — but the V1 plan explicitly lists `approved_at` as a required audit field, so it is added now rather than backfilled awkwardly later when a real async queue arrives.

## Error codes

| `errcode` | message | when |
|---|---|---|
| `28000` | `AUTHENTICATION_REQUIRED` | no `auth.uid()`, or actor not active |
| `P0001` | `OVERPAYMENT_VALIDATION_FAILED` (detail: `[{field, code, message}]`) | malformed request shape, invalid amount/date, invoice not found, invoice has no customer, amount does not exceed due, missing reason |
| `42501` | `UNAUTHORIZED_SHOP` | actor lacks shop access |
| `42501` | `INSUFFICIENT_ROLE` | actor role is not `owner`/`manager` (no override authority), or a non-owner attempts a backdated overpayment |
| `P0001` | `CLOSED_DATE` | `business_date` is closed for this shop |
| `P0001` | `IDEMPOTENCY_CONFLICT` | same `(shop_id, idempotency_key)`, different fingerprint |

`OVERPAYMENT_VALIDATION_FAILED` field codes: `REQUEST_INVALID` (shape/type errors, non-positive amount, future date), `INVALID_PAYMENT_METHOD` (anything but `'cash'`), `INVOICE_NOT_FOUND`, `INVOICE_HAS_NO_CUSTOMER`, `NOT_AN_OVERPAYMENT` (amount does not exceed effective due), `MISSING_REASON` (blank/whitespace-only reason).

## Command shape

```jsonc
{
  "shop_id": "uuid",
  "invoice_id": "uuid",
  "amount_dirham": 700,          // must exceed effective due
  "payment_method": "cash",
  "business_date": "2026-09-18",
  "idempotency_key": "client-generated-key",
  "reason": "customer overpaid by mistake, keeping balance on account"
}
```

Response on success:
```jsonc
{
  "ok": true,
  "payment_id": "uuid",
  "credit_id": "uuid",
  "invoice_id": "uuid",
  "customer_id": "uuid",
  "recorded_at": "2026-09-18T12:00:00.000Z",
  "applied_amount": 600,
  "credit_amount": 100,
  "effective_paid": 1000,
  "effective_due": 0
}
```

---

## Task 1 — Schema: `customer_credits.approved_at`

**Files:**
- Create: `supabase/migrations/20260918090000_customer_credits_approved_at.sql`
- Modify: `supabase/tests/schema.test.sql` (currently `plan(126)`)

### Step 1: Migration

```sql
alter table public.customer_credits
  add column approved_at timestamptz;
```

No backfill/preflight needed: the table has no write path yet (§14.1 of the Phase 3 design doc), so every existing row (if any, from seed/test fixtures only) is compatible with a new nullable column.

### Step 2: pgTAP schema assertions

Bump to `plan(128)` (126 + 2): `customer_credits.approved_at` exists as a nullable `timestamptz` column; a legacy-shaped insert with `approved_at` omitted is still accepted (`lives_ok`, reusing the existing `customer_credits` fixture pattern in this file).

### Step 3: Verify / Commit

Same PowerShell sequence as every prior task: `supabase db reset --local` then `supabase test db --local`, expect 128/128 with RLS/submit_batch/record_payment suites unchanged. Commit: `feat: add approved_at to customer_credits for overpayment approval audit`.

---

## Task 2 — `approve_overpayment` RPC

**Files:**
- Create: `supabase/migrations/20260918090100_approve_overpayment_rpc.sql`
- Create: `supabase/tests/approve_overpayment.test.sql`
- Modify: `supabase/tests/rls.test.sql` (guard assertion; still `plan(40)`, no count change)

The full SQL is written directly into the migration file during implementation, verified line-by-line against the real helper-function names exactly as `record_payment` was — following the exact structural pattern of `record_payment` (same helper functions, same validation-then-mutate shape, same idempotency mechanics), extended with: role gate (`owner`/`manager` only), reason validation, customer derivation from the invoice, `NOT_AN_OVERPAYMENT` gate, and a dual insert into `payments` + `customer_credits` + `audit_events` in one transaction.

### Step 2: pgTAP test file (`supabase/tests/approve_overpayment.test.sql`)

`plan(N)` covering at minimum:
- anon cannot execute (`EXECUTE` revoked)
- missing/inactive actor rejected (`AUTHENTICATION_REQUIRED`)
- wrong-shop actor rejected (`UNAUTHORIZED_SHOP`)
- staff (no `payment.override_excess`) rejected with `INSUFFICIENT_ROLE` even for a valid overpayment
- malformed command shapes: non-object, unsupported top-level key, non-UUID shop_id/invoice_id, non-positive/fractional amount, wrong payment_method, invalid/future business_date, missing/blank reason
- invoice not found in this shop; cross-shop invoice injection rejected
- invoice with no customer rejected (`INVOICE_HAS_NO_CUSTOMER`)
- an amount at or under effective due rejected (`NOT_AN_OVERPAYMENT`)
- happy path (manager, then separately owner): invoice with a customer and a due balance, amount exceeding due — verify the `payments` row (`amount_dirham = applied_amount`), the `customer_credits` row (`amount_dirham = credit_amount`, `approved_by`/`approved_at` set, `reason` stored), and the returned `applied_amount`/`credit_amount`/`effective_due = 0`
- closed-date rejection (owner, closed historical date)
- backdated: manager rejected (`INSUFFICIENT_ROLE`), owner accepted
- exact idempotent replay returns the original result (including `credit_id`) with no second `payments` or `customer_credits` row
- same key, different fingerprint → `IDEMPOTENCY_CONFLICT`, no write to either table

### Step 3: `rls.test.sql` guard update

Extend the existing "Phase 3B implements submit_batch and record_payment only" assertion to also confirm `approve_overpayment` now exists, while `create_expense` still does not.

### Step 4: Verify / Commit

Same PowerShell sequence; expect 128 schema, 40 RLS, 57 `submit_batch`, 33 `record_payment`, N `approve_overpayment` — all pass. Commit: `feat: implement approve_overpayment RPC for overpayment-to-credit`.

---

## Task 3 — Integration-test harness: `approve-overpayment.test.ts`

**Files:**
- Create: `tests/integration/overpayment/approve-overpayment.test.ts`
- Create: `vitest.integration.overpayment.config.mts`
- Modify: `package.json` (`test:integration:overpayment` script)

Same rationale and structure as the `record_payment` integration suite: real sessions, real network, real Postgres. Minimum coverage:
- a manager records an overpayment against a real invoice (created via `submit_batch`, with a real customer attached via quick-add) and reads back both the `payments` and `customer_credits` rows through RLS
- staff attempting the same call is rejected with `INSUFFICIENT_ROLE`
- an invoice with no customer is rejected with `INVOICE_HAS_NO_CUSTOMER`
- exact-replay idempotency (real network round-trip)
- concurrency: two simultaneous overpayment attempts against the same invoice — exactly one commits (the loser's fingerprint/lock path is exercised for real, not just in pgTAP)

### Verify / Commit

`pnpm.cmd test:integration:overpayment`, then `git add ... && git commit -m "test: add real-session integration coverage for approve_overpayment"`.

---

## Task 4 — Regenerate `lib/supabase/database.types.ts`

Identical mechanics to Phase 3B Task 4. Verify it references `approve_overpayment` and `customer_credits.approved_at`; `pnpm.cmd typecheck` passes. Commit: `chore: regenerate database types for approve_overpayment`.

---

## Task 5 — CI wiring

Add a step to the `integration` job, after "Run record_payment integration tests":

```yaml
      - name: Run approve_overpayment integration tests
        run: pnpm test:integration:overpayment
```

Commit: `ci: run approve_overpayment integration tests`.

---

## Final verification (run once after Task 5)

Full-regression sequence identical in shape to Phase 3B's, with `approve_overpayment` pgTAP and `test:integration:overpayment` added. Expected: schema 128/128, RLS 40/40, `submit_batch` 57/57, `record_payment` 33/33, `approve_overpayment` N/N, migration-upgrade 5/5, batches/payments/overpayment integration all green, unit/e2e unchanged and green, `pnpm audit` clean.

## What this closes and what remains open

This completes V1 Plan Task 6 in full: partial payments (`record_payment`, Phase 3B) and overpayment approval with customer credit (`approve_overpayment`, this phase). Redeeming an existing credit balance against a future invoice is not part of Task 6's own scope either (the V1 plan's Task 6 tests only ever create credit, never spend it) and remains open for whichever future phase first needs it. With Task 6 closed, the V1 plan's own execution order (§ "Execution order and review policy") clears the way for Phase 4 (Task 7: the bulk-entry grid UI; Task 8: Excel import/export) — the first work in this app that produces an actual screen beyond login.
