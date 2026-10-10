# Phase 3B: Follow-up Payment (record_payment RPC)

**Status:** Draft — ready for implementation.
**Depends on:** Phase 3A (`docs/superpowers/plans/2026-09-16-phase-3a-secure-invoice-foundation.md`), already merged (`main`/`phase-3-operational-ui`).
**Spec source:** `docs/plans/ShopKhata-Phase-3-Invoice-Operations-Design.md` §15 (contract), §7 (financial rules), §9 (idempotency), §14.1/§14.2 items 5, 7, 9 (schema gap and future-work list).

## Scope

This plan implements exactly and only the follow-up-payment operation defined in §15: recording a cash payment against an already-committed invoice, from the same actor/shop/role authorization boundary as `submit_batch`, with the same `(shop_id, idempotency_key)` + fingerprint idempotency semantics.

**Explicitly out of scope** (matches §7 and §11, unchanged by this plan):
- Overpayment-to-credit conversion or an overpayment-approval workflow. §7 is explicit that automatic overpayment-to-credit conversion does not exist in this phase's transaction functions; an overpayment attempt is a blocking error. The `customer_credits` table and `payment.override_excess` permission already exist in the schema/permissions layer but are not read, written, or otherwise implemented by this plan — they remain fully unspecified until a dedicated design pass gives them the same rigor Phase 3A gave `submit_batch`.
- A standalone payment-collection screen decoupled from an invoice (§11) — no UI is built by this plan; only the database RPC.
- Financial corrections (§8, `corrections` table) — already exist, unchanged, but this plan's effective-due computation must account for *approved* correction deltas already recorded against the invoice or its payments (see Design decision 2).
- The nonfinancial replacement-version system (§16) and the full "authoritative effective-invoice projection" (§14.2 item 10) that depends on it. No replacement rows exist yet, so this plan computes effective totals directly from `invoices` + `payments` + `corrections`, which is sufficient and correct until §16 lands; once it does, this RPC's effective-amount computation will need to be revisited to read from that projection instead.

## Design decisions

1. **Idempotency/fingerprint columns on `payments`, not a new table.** `payments` has no `idempotency_key` column at all today (unlike `batches`, which had a bare nullable one before Phase 3A Task 2). This plan adds `idempotency_key text`, `fingerprint text`, `idempotency_result jsonb`, an all-or-none `NOT VALID` check constraint, and a `unique (shop_id, idempotency_key)` constraint — the exact pattern Phase 3A Task 2 used for `batches`, with no preflight-duplicate migration step needed since the columns are new (every existing row is trivially all-null-compliant).

2. **Effective-due computed directly, not via a projection.** Per §14.2 item 10, the full "authoritative effective-invoice projection" is future work gated on §16 (replacement versions), which does not exist yet. Until it does:
   ```
   effective_total = invoices.total_amount_dirham
                    + sum(corrections.amount_delta_dirham
                          where invoice_id = <this invoice> and approved_by is not null)
   effective_paid  = sum(payments.amount_dirham where invoice_id = <this invoice>)
                    + sum(corrections.amount_delta_dirham
                          where payment_id in (payments of this invoice) and approved_by is not null)
   effective_due   = effective_total - effective_paid
   ```
   This matches §14.2 item 10's formula exactly, minus the replacement-version term (always zero today, since no replacement can exist). `corrections.approved_by` (nullable) is the existing schema's only signal for "approved" — a correction row with `approved_by is null` is a request, not yet applied.

3. **`amount_dirham` must be strictly positive.** §15 says "a positive integer number of dirham"; a zero-amount follow-up payment is rejected (`REQUEST_INVALID`), consistent with `submit_batch`'s treatment of non-positive amounts.

4. **Backdate authority reuses the same rule as `submit_batch`.** §14.2 item 9 says this rule "applies to batch submission (§6) and to a backdated follow-up payment (§15) alike." Unlike `submit_batch`, §15's contract lists no `is_backdated`/`backdated_reason` fields on the follow-up-payment command — only `business_date`. So the rule here is simpler: if `business_date < current_date`, the actor's role must be `owner`, full stop, no reason field to validate. A future date is still rejected the same way `submit_batch` rejects one.

5. **Idempotency lock and replay use the same advisory-lock pattern as `submit_batch`** (`pg_advisory_xact_lock(hashtextextended(shop_id || ':' || idempotency_key, 0))`), so a concurrent retry with the same key is serialized against the existing-row check rather than relying on the unique constraint alone to decide the outcome.

## Error codes

| `errcode` | message | when |
|---|---|---|
| `28000` | `AUTHENTICATION_REQUIRED` | no `auth.uid()`, or actor not active |
| `P0001` | `PAYMENT_VALIDATION_FAILED` (detail: `[{field, code, message}]`) | malformed request shape, invalid amount, invalid payment_method, invoice not found, overpayment |
| `42501` | `UNAUTHORIZED_SHOP` | actor lacks shop access |
| `42501` | `INSUFFICIENT_ROLE` | non-owner attempts a backdated payment |
| `P0001` | `CLOSED_DATE` | `business_date` is closed for this shop (same `daily_closes` check as `submit_batch`) |
| `P0001` | `IDEMPOTENCY_CONFLICT` | same `(shop_id, idempotency_key)`, different fingerprint |

`PAYMENT_VALIDATION_FAILED` field codes: `REQUEST_INVALID` (shape/type errors, non-positive amount, future date), `INVALID_PAYMENT_METHOD` (anything but `'cash'`), `INVOICE_NOT_FOUND` (missing or cross-shop invoice id), `OVERPAYMENT_NOT_ALLOWED` (amount would exceed effective due).

## Command shape

```jsonc
{
  "shop_id": "uuid",
  "invoice_id": "uuid",       // invoices.id, not invoices.invoice_id
  "amount_dirham": 100,        // positive integer
  "payment_method": "cash",    // must be exactly "cash"
  "business_date": "2026-09-17",
  "idempotency_key": "client-generated-key"
}
```

Response on success:
```jsonc
{
  "ok": true,
  "payment_id": "uuid",
  "invoice_id": "uuid",
  "recorded_at": "2026-09-17T12:00:00.000Z",
  "effective_paid": 500,
  "effective_due": 0
}
```

---

## Task 1 — Schema: idempotency/fingerprint columns on `payments`

**Files:**
- Create: `supabase/migrations/20260917090000_payment_idempotency_fingerprint.sql`
- Modify: `supabase/tests/schema.test.sql` (currently `plan(120)`)

### Step 1: Migration

```sql
alter table public.payments
  add column idempotency_key text,
  add column fingerprint text,
  add column idempotency_result jsonb;

alter table public.payments
  add constraint payments_idempotency_fields_all_or_none check (
    (idempotency_key is null and fingerprint is null and idempotency_result is null)
    or (idempotency_key is not null and fingerprint is not null and idempotency_result is not null)
  ) not valid;

alter table public.payments
  add constraint payments_shop_id_idempotency_key_uq unique (shop_id, idempotency_key);


No preflight duplicate-check block is needed (unlike Phase 3A Task 2's `batches` migration) because these are brand-new columns — every existing `payments` row is `null`/`null`/`null`, which trivially satisfies both new constraints.

### Step 2: pgTAP schema assertions

Bump `schema.test.sql` to `plan(126)` (120 + 6 new assertions) and add, immediately after the existing `payments` table assertions:

- columns `idempotency_key`, `fingerprint`, `idempotency_result` exist with the right types (3 assertions, `has_column`/`col_type_is` style already used elsewhere in this file)
- `payments_idempotency_fields_all_or_none` constraint exists, using the exact `pg_get_constraintdef` probe pattern Phase 3A Task 2 established (get the real string via `docker exec <db-container> psql -U postgres -c "select pg_get_constraintdef(oid) from pg_constraint where conname = 'payments_idempotency_fields_all_or_none';"` before writing the literal — do **not** guess the parenthesization) (1 assertion)
- `payments_shop_id_idempotency_key_uq` unique constraint exists on `(shop_id, idempotency_key)` (1 assertion)
- unique-constraint enforcement: inserting a second `payments` row with the same `(shop_id, idempotency_key)` as an already-existing one throws (1 assertion) — reuse the existing `payments` fixture rows already present in this file for the insert target.

### Step 3: Verify

```powershell
pnpm.cmd exec supabase db reset --local
pnpm.cmd exec supabase test db --local
```

Expected: 126/126 schema assertions, RLS and `submit_batch` suites unchanged and still passing.

### Step 4: Commit

```powershell
git add supabase/migrations/20260917090000_payment_idempotency_fingerprint.sql supabase/tests/schema.test.sql
git commit -m "feat: add payment idempotency-key uniqueness and fingerprint storage"
```

---

## Task 2 — `record_payment` RPC

**Files:**
- Create: `supabase/migrations/20260917090100_record_payment_rpc.sql`
- Create: `supabase/tests/record_payment.test.sql`
- Modify: `supabase/tests/rls.test.sql` (guard assertion; still `plan(40)`, no count change)

### Step 1: Migration

```sql
create or replace function private.canonical_payment_command(
  p_shop_id uuid,
  p_invoice_id uuid,
  p_amount bigint,
  p_payment_method text,
  p_business_date date
) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'shop_id', p_shop_id,
    'invoice_id', p_invoice_id,
    'amount_dirham', p_amount,
    'payment_method', p_payment_method,
    'business_date', p_business_date::text
  );
$$;

create or replace function public.record_payment(command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_shop_id_text text;
  v_shop_id uuid;
  v_invoice_id_text text;
  v_invoice_id uuid;
  v_amount bigint;
  v_payment_method text;
  v_business_date_text text;
  v_business_date date;
  v_idempotency_key text;
  v_fingerprint text;
  v_lock_key bigint;
  v_existing record;
  v_close_state text;
  v_invoice record;
  v_effective_total bigint;
  v_effective_paid bigint;
  v_effective_due bigint;
  v_payment_id uuid := gen_random_uuid();
  v_recorded_at timestamptz := now();
  v_result jsonb;
  v_errors jsonb := '[]'::jsonb;
begin
  if v_actor_id is null or not private.is_active_actor() then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000';
  end if;

  select p.role into v_actor_role from public.profiles p where p.id = v_actor_id;

  if jsonb_typeof(command) is distinct from 'object' then
    raise exception 'PAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('field', 'request', 'code', 'REQUEST_INVALID', 'message', 'The command must be a JSON object.'))::text;
  end if;

  if not private.jsonb_object_keys_subset(command, array['shop_id','invoice_id','amount_dirham','payment_method','business_date','idempotency_key']) then
    raise exception 'PAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('field', 'request', 'code', 'REQUEST_INVALID', 'message', 'The command contains an unsupported field.'))::text;
  end if;

  v_shop_id_text := command ->> 'shop_id';
  if jsonb_typeof(command -> 'idempotency_key') is distinct from 'string' then
    raise exception 'PAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('field', 'idempotency_key', 'code', 'REQUEST_INVALID', 'message', 'idempotency_key must be a JSON string.'))::text;
  end if;
  v_idempotency_key := command ->> 'idempotency_key';

  if not private.is_valid_uuid_text(v_shop_id_text) or btrim(v_idempotency_key) = '' then
    raise exception 'PAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('field', 'request', 'code', 'REQUEST_INVALID', 'message', 'shop_id must be a UUID and idempotency_key is required.'))::text;
  end if;
  v_shop_id := v_shop_id_text::uuid;

  if not private.has_shop_access(v_shop_id) then
    raise exception 'UNAUTHORIZED_SHOP' using errcode = '42501';
  end if;

  v_invoice_id_text := case when jsonb_typeof(command -> 'invoice_id') = 'string' then command ->> 'invoice_id' else null end;
  if not private.is_valid_uuid_text(v_invoice_id_text) then
    v_errors := v_errors || jsonb_build_object('field', 'invoice_id', 'code', 'REQUEST_INVALID', 'message', 'invoice_id must be a UUID.');
  else
    v_invoice_id := v_invoice_id_text::uuid;
  end if;

  if not private.is_safe_bigint_jsonb(command -> 'amount_dirham') or (command ->> 'amount_dirham')::bigint <= 0 then
    v_errors := v_errors || jsonb_build_object('field', 'amount_dirham', 'code', 'REQUEST_INVALID', 'message', 'amount_dirham must be a positive integer.');
  else
    v_amount := (command ->> 'amount_dirham')::bigint;
  end if;

  if jsonb_typeof(command -> 'payment_method') is distinct from 'string' then
    v_errors := v_errors || jsonb_build_object('field', 'payment_method', 'code', 'REQUEST_INVALID', 'message', 'payment_method must be a string.');
  else
    v_payment_method := command ->> 'payment_method';
    if v_payment_method is distinct from 'cash' then
      v_errors := v_errors || jsonb_build_object('field', 'payment_method', 'code', 'INVALID_PAYMENT_METHOD', 'message', 'payment_method must be cash.');
    end if;
  end if;

  v_business_date_text := command ->> 'business_date';
  if not private.is_valid_date_text(v_business_date_text) then
    v_errors := v_errors || jsonb_build_object('field', 'business_date', 'code', 'REQUEST_INVALID', 'message', 'business_date must be a valid YYYY-MM-DD date.');
  else
    v_business_date := v_business_date_text::date;
    if v_business_date > current_date then
      v_errors := v_errors || jsonb_build_object('field', 'business_date', 'code', 'REQUEST_INVALID', 'message', 'Business date cannot be in the future.');
    end if;
  end if;

  if jsonb_array_length(v_errors) > 0 then
    raise exception 'PAYMENT_VALIDATION_FAILED' using errcode = 'P0001', detail = v_errors::text;
  end if;

  -- Design decision 4: no is_backdated/backdated_reason fields on this
  -- command (§15's contract lists none) — the rule is simply role-gated.
  if v_business_date < current_date and v_actor_role is distinct from 'owner' then
    raise exception 'INSUFFICIENT_ROLE' using errcode = '42501';
  end if;

  select d.event_type into v_close_state
  from public.daily_closes d
  where d.shop_id = v_shop_id and d.business_date = v_business_date
  order by d.event_sequence desc
  limit 1;

  if v_close_state = 'closed' then
    raise exception 'CLOSED_DATE' using errcode = 'P0001';
  end if;

  select i.id, i.shop_id, i.total_amount_dirham
  into v_invoice
  from public.invoices i
  where i.id = v_invoice_id and i.shop_id = v_shop_id;

  if not found then
    raise exception 'PAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('field', 'invoice_id', 'code', 'INVOICE_NOT_FOUND', 'message', 'Invoice was not found in this shop.'))::text;
  end if;

  v_fingerprint := encode(
    extensions.digest(
      private.canonical_payment_command(v_shop_id, v_invoice_id, v_amount, v_payment_method, v_business_date)::text::bytea,
      'sha256'
    ),
    'hex'
  );

  v_lock_key := hashtextextended(v_shop_id::text || ':' || v_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  select p.fingerprint, p.idempotency_result into v_existing
  from public.payments p
  where p.shop_id = v_shop_id and p.idempotency_key = v_idempotency_key;

  if found then
    if v_existing.fingerprint = v_fingerprint then
      return v_existing.idempotency_result;
    end if;
    raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'P0001';
  end if;

  -- Design decision 2: effective totals computed directly (no replacement
  -- system exists yet — §14.2 item 10 is future work).
  select
    v_invoice.total_amount_dirham
      + coalesce((select sum(c.amount_delta_dirham) from public.corrections c
                  where c.invoice_id = v_invoice.id and c.approved_by is not null), 0),
    coalesce((select sum(p.amount_dirham) from public.payments p
              where p.invoice_id = v_invoice.id), 0)
      + coalesce((select sum(c.amount_delta_dirham) from public.corrections c
                  where c.payment_id in (select p.id from public.payments p where p.invoice_id = v_invoice.id)
                    and c.approved_by is not null), 0)
  into v_effective_total, v_effective_paid;

  v_effective_due := v_effective_total - v_effective_paid;

  if v_amount > v_effective_due then
    raise exception 'PAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('field', 'amount_dirham', 'code', 'OVERPAYMENT_NOT_ALLOWED', 'message', 'This payment would exceed the amount due.'))::text;
  end if;

  v_result := jsonb_build_object(
    'ok', true,
    'payment_id', v_payment_id,
    'invoice_id', v_invoice_id,
    'recorded_at', to_char(v_recorded_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effective_paid', v_effective_paid + v_amount,
    'effective_due', v_effective_due - v_amount
  );

  insert into public.payments (
    id, shop_id, invoice_id, amount_dirham, business_date, payment_method,
    idempotency_key, fingerprint, idempotency_result, created_by, recorded_at
  ) values (
    v_payment_id, v_shop_id, v_invoice_id, v_amount, v_business_date, v_payment_method,
    v_idempotency_key, v_fingerprint, v_result, v_actor_id, v_recorded_at
  );

  insert into public.audit_events (shop_id, actor_id, action, entity_type, entity_id, metadata, recorded_at)
  values (v_shop_id, v_actor_id, 'record_payment', 'payment', v_payment_id::text,
          jsonb_build_object('invoice_id', v_invoice_id, 'amount_dirham', v_amount, 'idempotency_key', v_idempotency_key),
          v_recorded_at);

  return v_result;
end;
$$;

revoke all on function public.record_payment(jsonb) from public, anon;
grant execute on function public.record_payment(jsonb) to authenticated;
```

*(This SQL is implementation-ready but not yet verified against the real schema/functions during this planning pass — the usual pre-implementation check, same as Phase 3A Task 4, must confirm exact column/function names before this is transcribed into the migration file: `private.is_safe_bigint_jsonb`, `private.jsonb_object_keys_subset`, `private.is_valid_uuid_text`, `private.is_valid_date_text`, `private.has_shop_access`, `private.is_active_actor`, `extensions.digest`, `daily_closes.event_type`/`event_sequence` — all of these are already confirmed present and were used identically by `submit_batch`.)*

### Step 2: pgTAP test file (`supabase/tests/record_payment.test.sql`)

`plan(N)` covering at minimum:
- anon cannot execute `record_payment` (`EXECUTE` revoked)
- missing/inactive actor rejected (`AUTHENTICATION_REQUIRED`)
- wrong-shop actor rejected (`UNAUTHORIZED_SHOP`)
- malformed command shapes: non-object, unsupported top-level key, non-string idempotency_key, non-UUID shop_id/invoice_id, non-positive/non-integer/overflow amount_dirham, non-string/wrong-value payment_method, invalid/future business_date
- invoice not found in this shop (including a valid UUID for an invoice that exists in the *other* shop — cross-shop injection rejected)
- happy path: partial payment against a due invoice, verify `payments` row, `audit_events` row, returned `effective_paid`/`effective_due`
- a second partial payment bringing the invoice to fully paid (effective_due = 0)
- overpayment rejected (`OVERPAYMENT_NOT_ALLOWED`) when amount exceeds current effective due — including after a prior partial payment already reduced it
- exact idempotent replay returns the original result with no second `payments` row
- same key, different fingerprint → `IDEMPOTENCY_CONFLICT`, no write
- closed-date rejection (mirrors `submit_batch`'s `CLOSED_DATE` fixture)
- backdated payment: staff/manager rejected (`INSUFFICIENT_ROLE`), owner accepted
- an approved `corrections` row against the invoice changes `effective_total`/`effective_due` as expected (proves Design decision 2's formula); an *unapproved* correction (`approved_by is null`) does **not** change it

### Step 3: `rls.test.sql` guard update

Extend the existing "Phase 3A implements submit_batch only" assertion (added in Phase 3A) to also confirm `record_payment` now exists, while `approve_overpayment`/`create_expense` still do not:

```sql
select ok(
  exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'submit_batch'
  )
  and exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'record_payment'
  )
  and not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prokind = 'f'
      and p.proname in ('approve_overpayment', 'create_expense')
  ),
  'Phase 3B implements submit_batch and record_payment only, not overpayment/expense commands'
);
```

### Step 4: Verify

```powershell
pnpm.cmd exec supabase db reset --local
pnpm.cmd exec supabase test db --local
```

Expected: 126 schema, 40 RLS, 57 `submit_batch`, N `record_payment` — all pass.

### Step 5: Commit

```powershell
git add supabase/migrations/20260917090100_record_payment_rpc.sql supabase/tests/record_payment.test.sql supabase/tests/rls.test.sql
git commit -m "feat: implement record_payment RPC for follow-up payments"
```

---

## Task 3 — Integration-test harness: `record-payment.test.ts`

**Files:**
- Create: `tests/integration/payments/record-payment.test.ts`
- Create: `vitest.integration.payments.config.mts`
- Modify: `package.json` (`test:integration:payments` script)

Same rationale as Phase 3A Task 5: pgTAP proves the RPC's logic via spoofed claims; this proves it over real PostgREST with real sessions and real concurrency. Copy the `run`/`runSupabase`/`isSupabaseRunning` helpers verbatim from `tests/integration/batches/submit-batch.test.ts` (which already copied them from `upgrade-path.test.ts`), following this repo's established pattern of each integration test file being self-contained.

Minimum coverage:
- staff records a payment against a real invoice created via `submit_batch` in the same test, reads the payment back through RLS
- a payment that would overpay is rejected with `OVERPAYMENT_NOT_ALLOWED`
- backdated payment: staff rejected, owner accepted (real sessions, mirroring the `submit_batch` integration test's backdate test)
- exact-replay idempotency (real network round-trip)
- concurrency: two simultaneous payments against the same invoice, amounts that together would overpay — exactly one commits, the other rejects, and the invoice's final effective_paid/effective_due reflects only the winner (this is the payments-table analogue of `submit_batch`'s "different keys racing" concurrency test, and is the test most likely to surface a real bug, the same way it did in Phase 3A)

### Verify

```powershell
pnpm.cmd exec supabase start
pnpm.cmd test:integration:payments
```

### Commit

```powershell
git add supabase/seed.sql tests/integration/payments/record-payment.test.ts vitest.integration.payments.config.mts package.json
git commit -m "test: add real-session integration coverage for record_payment"
```

(`supabase/seed.sql` is listed only in case any fixture gap surfaces during this step, mirroring Phase 3A Task 5's file list — the owner/staff1 credentials it needs already exist from Phase 3A.)

---

## Task 4 — Regenerate `lib/supabase/database.types.ts`

Identical mechanics to Phase 3A Task 6 (pinned CLI, strict UTF-8, no BOM, one trailing newline, run only after Task 3 is green).

```powershell
pnpm.cmd exec supabase db reset --local
$generated = (pnpm.cmd exec supabase gen types typescript --local) -join "`n"
$normalized = $generated.TrimEnd("`r", "`n") + "`n"
$targetPath = (Resolve-Path "lib/supabase/database.types.ts").Path
[System.IO.File]::WriteAllText($targetPath, $normalized, [System.Text.UTF8Encoding]::new($false))
```

Verify it references `record_payment` and the new `payments` columns; `pnpm.cmd typecheck` passes. Commit: `chore: regenerate database types for record_payment`.

---

## Task 5 — CI wiring

Add a step to the `integration` job, after the existing "Run submit_batch integration tests" step:

```yaml
      - name: Run record_payment integration tests
        run: pnpm test:integration:payments
```

Verify locally with the same full sequence Phase 3A Task 7 used, substituting/adding the new script. Commit: `ci: run record_payment integration tests`.

---

## Final verification (run once after Task 5)

Same full-regression sequence as Phase 3A's, with `pnpm.cmd test:integration:payments` added alongside `pnpm.cmd test:integration:batches`. Expected: schema 126/126, RLS 40/40, `submit_batch` 57/57, `record_payment` N/N, migration-upgrade 5/5, batches integration 8/8, payments integration M/M, unit/e2e unchanged and green, `pnpm audit` clean.

## Explicitly out of scope for this plan (unchanged from Phase 3A's own list, plus)

Everything Phase 3A already excluded, plus: overpayment approval, customer credit, the standalone payment-collection screen, any `app/`/`features/` UI change. `payment.override_excess` and `customer_credits` remain present in the schema/permissions layer but untouched and unimplemented.
