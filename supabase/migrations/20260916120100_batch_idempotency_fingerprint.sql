do $$
declare
  duplicate_count integer;
begin
  select count(*) into duplicate_count
  from (
    select shop_id, idempotency_key
    from public.batches
    where idempotency_key is not null
    group by shop_id, idempotency_key
    having count(*) > 1
  ) dupes;

  if duplicate_count > 0 then
    raise exception 'Migration batch_idempotency_fingerprint preflight failed: found % existing (shop_id, idempotency_key) pair(s) shared by more than one batch row. Resolve these duplicates before adding the unique constraint.', duplicate_count;
  end if;
end $$;

alter table public.batches
  add column fingerprint text,
  add column idempotency_result jsonb;

-- NOT VALID: enforces the invariant on every future write without scanning
-- or rejecting a row that predates this migration. batches is append-only
-- (batches_append_only rejects UPDATE/DELETE for every role, including one
-- issued by a migration), so an existing row that has an idempotency_key
-- but no fingerprint cannot be brought into compliance by rewriting it —
-- it can only be grandfathered in.
alter table public.batches
  add constraint batches_idempotency_fields_all_or_none check (
    (idempotency_key is null and fingerprint is null and idempotency_result is null)
    or (idempotency_key is not null and fingerprint is not null and idempotency_result is not null)
  ) not valid;

alter table public.batches
  add constraint batches_shop_id_idempotency_key_uq unique (shop_id, idempotency_key);
