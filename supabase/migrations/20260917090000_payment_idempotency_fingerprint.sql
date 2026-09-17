-- Phase 3B Task 1: idempotency/fingerprint columns on payments.
--
-- Unlike batches (which already had a bare nullable idempotency_key before
-- Phase 3A Task 2), payments has none of these columns yet, so no preflight
-- duplicate-check block is needed: every existing row is trivially
-- null/null/null, which satisfies both new constraints below.

alter table public.payments
  add column idempotency_key text,
  add column fingerprint text,
  add column idempotency_result jsonb;

-- NOT VALID: enforces the invariant on every future write without scanning
-- or rejecting a row that predates this migration. payments is append-only
-- (payments_append_only rejects UPDATE/DELETE for every role, including one
-- issued by a migration), so an existing row cannot be rewritten to comply
-- retroactively -- it can only be grandfathered in, exactly like batches'
-- equivalent constraint in 20260916120100_batch_idempotency_fingerprint.sql.
alter table public.payments
  add constraint payments_idempotency_fields_all_or_none check (
    (idempotency_key is null and fingerprint is null and idempotency_result is null)
    or (idempotency_key is not null and fingerprint is not null and idempotency_result is not null)
  ) not valid;

alter table public.payments
  add constraint payments_shop_id_idempotency_key_uq unique (shop_id, idempotency_key);
