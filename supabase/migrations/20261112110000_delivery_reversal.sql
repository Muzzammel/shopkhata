-- Partial delivery, step 6A: delivery reversals.
--
-- Additive only; money is untouched (no payments, corrections, credits or ledger rows are written).
--   1. invoice_deliveries gains reverses_delivery_id + reason. A reversal is a new append-only event with NEGATIVE pieces
--      that points at the delivery it reverses. The original event is never changed. Row shapes:
--        delivery: pieces > 0, reverses_delivery_id null, reason null (every existing row);
--        reversal: pieces < 0, reverses_delivery_id set, reason 10..2000 trimmed characters, keyed (no batch).
--      Once only: unique (reverses_delivery_id). Same shop and invoice: composite foreign key. Full reversal of a
--      delivery (never of a reversal): BEFORE INSERT guard, whichever function writes the row.
--   2. reverse_invoice_delivery(command): owner or manager only; today's Qatar date (so a delivery from a closed date
--      is reversed by an event on an open date; the closed day itself is not rewritten); refused on void, legacy and
--      inactive-shop invoices. The invoice row is locked FOR UPDATE before anything is validated, exactly as
--      record_invoice_delivery and void_invoice, so deliveries, reversals and voids of one invoice are serialized.
--   3. Read models need no change: invoice_delivery_totals, effective_invoices (effective_delivered, delivered_pieces,
--      delivery_status) and the reports built on them already SUM(pieces), which is now the NET delivered count.
--   4. The customer rule guard (AFTER INSERT on invoice_deliveries) keeps running for reversal rows.
-- Not in this step: ordered-pieces corrections.

-- 1. Reversal events ---------------------------------------------------------------------------------------------------
alter table public.invoice_deliveries
  add column reverses_delivery_id uuid,
  add column reason text,
  drop constraint invoice_deliveries_pieces_check,
  add constraint invoice_deliveries_shape_check check (
    (reverses_delivery_id is null and reason is null and pieces > 0)
    or (reverses_delivery_id is not null and pieces < 0 and batch_id is null
      and reason is not null and reason = btrim(reason) and length(reason) between 10 and 2000)),
  -- A delivery is reversed at most once, even by two sessions that never see each other's rows.
  add constraint invoice_deliveries_reversed_once_uq unique (reverses_delivery_id),
  add constraint invoice_deliveries_invoice_event_uq unique (shop_id, invoice_id, id),
  -- The reversed delivery belongs to the same shop and the same invoice.
  add constraint invoice_deliveries_reverses_fkey foreign key (shop_id, invoice_id, reverses_delivery_id)
    references public.invoice_deliveries(shop_id, invoice_id, id) on delete restrict;

-- Full reversal of a delivery, never of a reversal. With "once only" above, net delivered pieces can never go below 0:
-- every negative row cancels exactly one distinct positive row.
create function private.enforce_delivery_reversal() returns trigger
language plpgsql security definer set search_path = '' as $$
declare target integer;
begin
  select d.pieces into target from public.invoice_deliveries d where d.id = new.reverses_delivery_id;
  if target is null or target <= 0 or new.pieces <> -target then
    raise exception 'REVERSAL_INVALID' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function private.enforce_delivery_reversal() from public, anon, authenticated;
create trigger invoice_deliveries_full_reversal before insert on public.invoice_deliveries
  for each row when (new.reverses_delivery_id is not null) execute function private.enforce_delivery_reversal();

-- 2. reverse_invoice_delivery(command) ---------------------------------------------------------------------------------
-- command: {shop_id, invoice_id, delivery_id, reason, idempotency_key}. Owner or manager with access to the shop.
-- Exact replay returns the original result before any date or state check; same key, other command: IDEMPOTENCY_CONFLICT.
-- Keys share one namespace with record_invoice_delivery (same unique index, same advisory lock).
create function public.reverse_invoice_delivery(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid; sid uuid; iid uuid; did uuid; why text; cmd jsonb; fp text;
  old public.invoice_deliveries; target public.invoice_deliveries; inv public.invoices;
  today date; delivered bigint; rid uuid;
begin
  perform private.assert_not_in_maintenance();
  actor := auth.uid(); today := (now() at time zone 'Asia/Qatar')::date;
  sid := private.invoice_operation_actor(command, array['shop_id', 'invoice_id', 'delivery_id', 'reason', 'idempotency_key'], true);
  if not private.is_valid_uuid_text(command ->> 'invoice_id') or not private.is_valid_uuid_text(command ->> 'delivery_id')
    or jsonb_typeof(command -> 'reason') is distinct from 'string' then
    raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  iid := (command ->> 'invoice_id')::uuid; did := (command ->> 'delivery_id')::uuid;
  why := regexp_replace(command ->> 'reason', '^\s+|\s+$', '', 'g');
  if why = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if length(why) < 10 then raise exception 'REASON_TOO_SHORT' using errcode = 'P0001'; end if;
  if length(why) > 2000 then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  cmd := command || jsonb_build_object('reason', why, 'actor', actor);
  fp := encode(extensions.digest(convert_to(cmd::text, 'UTF8'), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended('invoice-delivery:' || sid::text || ':' || (command ->> 'idempotency_key'), 0));
  select * into old from public.invoice_deliveries where shop_id = sid and idempotency_key = command ->> 'idempotency_key';
  if found then
    if old.fingerprint <> fp then raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'P0001'; end if;
    return jsonb_build_object('ok', true, 'reversal_id', old.id, 'delivery_id', old.reverses_delivery_id, 'invoice_id', old.invoice_id,
      'pieces', -old.pieces, 'business_date', old.business_date);
  end if;

  if (select s.is_active from public.shops s where s.id = sid) is not true then raise exception 'SHOP_INACTIVE' using errcode = 'P0001'; end if;
  -- Serializes every delivery, reversal and void of this invoice: everything below sees all committed events.
  select * into inv from public.invoices where shop_id = sid and id = iid for update;
  if not found then raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from public.invoice_voids v where v.invoice_id = iid) then raise exception 'INVOICE_VOID' using errcode = 'P0001'; end if;
  if inv.ordered_pieces is null then raise exception 'LEGACY_INVOICE' using errcode = 'P0001'; end if;
  perform private.assert_date_open(sid, today);
  select * into target from public.invoice_deliveries where shop_id = sid and invoice_id = iid and id = did;
  if not found then raise exception 'DELIVERY_NOT_FOUND' using errcode = 'P0001'; end if;
  if target.pieces <= 0 then raise exception 'NOT_A_DELIVERY' using errcode = 'P0001'; end if;
  if exists (select 1 from public.invoice_deliveries r where r.reverses_delivery_id = did) then
    raise exception 'ALREADY_REVERSED' using errcode = 'P0001'; end if;
  select coalesce(sum(x.pieces), 0) into delivered from public.invoice_deliveries x where x.shop_id = sid and x.invoice_id = iid;
  if delivered - target.pieces < 0 then raise exception 'NEGATIVE_DELIVERY' using errcode = 'P0001'; end if;

  insert into public.invoice_deliveries(shop_id, invoice_id, pieces, business_date, created_by, idempotency_key, fingerprint, reverses_delivery_id, reason)
  values (sid, iid, -target.pieces, today, actor, command ->> 'idempotency_key', fp, did, why) returning id into rid;
  insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, reason, metadata)
  values (sid, actor, 'delivery.reverse', 'invoice', iid::text, why, jsonb_build_object(
    'reversal_id', rid, 'delivery_id', did, 'pieces', target.pieces, 'delivery_business_date', target.business_date,
    'business_date', today, 'ordered_pieces', inv.ordered_pieces, 'delivered_before', delivered, 'delivered_after', delivered - target.pieces));
  return jsonb_build_object('ok', true, 'reversal_id', rid, 'delivery_id', did, 'invoice_id', iid, 'pieces', target.pieces, 'business_date', today);
end $$;
revoke all on function public.reverse_invoice_delivery(jsonb) from public, anon;
grant execute on function public.reverse_invoice_delivery(jsonb) to authenticated;
