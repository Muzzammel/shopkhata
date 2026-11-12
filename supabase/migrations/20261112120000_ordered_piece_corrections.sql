-- Partial delivery, step 6B: ordered-piece corrections.
--
-- Additive only; money is untouched (no payments, corrections, credits or ledger rows are written).
--   1. invoice_piece_corrections: append-only events, one per change of a tracked invoice's ordered pieces. Each row
--      keeps before/after, reason (10..2000 trimmed characters), actor, business date and recorded time.
--      invoices.ordered_pieces is never changed: it stays the ORIGINAL ordered quantity.
--      The effective ordered quantity is ordered_after of the latest correction (highest seq), else the original. seq is
--      assigned at insert time, so a session that waited on the invoice lock always sorts after the one it waited for.
--   2. correct_invoice_ordered_pieces(command): owner or manager only; today's Qatar date; refused on closed dates,
--      void, legacy and inactive-shop invoices. The invoice row is locked FOR UPDATE (as every delivery, reversal and
--      void), then the command's expected_ordered_pieces must equal the current effective quantity (STALE_ORDERED_PIECES
--      otherwise), and the new quantity must differ from it and be >= net delivered pieces.
--   3. Read models: effective_invoices.ordered_pieces and invoice_delivery_totals.ordered_pieces become the EFFECTIVE
--      ordered quantity (same columns, same order); invoice_delivery_totals gains trailing original_ordered_pieces.
--      delivery_status, remaining pieces and every report built on them follow automatically.
--   4. record_invoice_delivery checks over-delivery against the effective quantity; both delivery RPCs log it in audit.

-- 1. Correction events -------------------------------------------------------------------------------------------------
create table public.invoice_piece_corrections (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,
  shop_id uuid not null references public.shops(id) on delete restrict,
  invoice_id uuid not null,
  ordered_before integer not null check (ordered_before > 0),
  ordered_after integer not null check (ordered_after > 0),
  reason text not null check (reason = btrim(reason) and length(reason) between 10 and 2000),
  business_date date not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 200),
  fingerprint text not null,
  check (ordered_after <> ordered_before),
  unique (shop_id, idempotency_key),
  foreign key (shop_id, invoice_id) references public.invoices(shop_id, id) on delete restrict
);
create index invoice_piece_corrections_invoice_idx on public.invoice_piece_corrections(shop_id, invoice_id, seq desc);

alter table public.invoice_piece_corrections enable row level security;
revoke all on public.invoice_piece_corrections from public, anon, authenticated;
grant select on public.invoice_piece_corrections to authenticated;
create policy invoice_piece_corrections_read on public.invoice_piece_corrections for select to authenticated
  using (shop_id = any ((select private.accessible_shop_ids())::uuid[]));
create trigger invoice_piece_corrections_append_only before update or delete on public.invoice_piece_corrections
  for each row execute function public.reject_append_only_mutation();
create trigger invoice_piece_corrections_active_shop before insert on public.invoice_piece_corrections
  for each row execute function private.enforce_active_shop();
create trigger invoice_piece_corrections_open_business_date before insert on public.invoice_piece_corrections
  for each row execute function private.enforce_open_business_date();
create trigger invoice_piece_corrections_invoice_not_void before insert on public.invoice_piece_corrections
  for each row execute function private.enforce_invoice_not_void();

-- Effective ordered pieces of one invoice; NULL for legacy invoices. Used by the RPCs (the views inline the same rule).
create function private.effective_ordered_pieces(p_shop_id uuid, p_invoice_id uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce((select c.ordered_after from public.invoice_piece_corrections c
    where c.shop_id = i.shop_id and c.invoice_id = i.id order by c.seq desc limit 1), i.ordered_pieces)
  from public.invoices i where i.shop_id = p_shop_id and i.id = p_invoice_id and i.ordered_pieces is not null
$$;
revoke all on function private.effective_ordered_pieces(uuid, uuid) from public, anon, authenticated;

-- 2. correct_invoice_ordered_pieces(command) ---------------------------------------------------------------------------
-- command: {shop_id, invoice_id, expected_ordered_pieces, ordered_pieces, reason, idempotency_key}. Owner or manager.
-- Exact replay returns the original result before any date or state check; same key, other command: IDEMPOTENCY_CONFLICT.
create function public.correct_invoice_ordered_pieces(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid; sid uuid; iid uuid; expected integer; n integer; why text; cmd jsonb; fp text;
  old public.invoice_piece_corrections; inv public.invoices; today date; current_ordered integer; delivered bigint; cid uuid;
begin
  perform private.assert_not_in_maintenance();
  actor := auth.uid(); today := (now() at time zone 'Asia/Qatar')::date;
  sid := private.invoice_operation_actor(command,
    array['shop_id', 'invoice_id', 'expected_ordered_pieces', 'ordered_pieces', 'reason', 'idempotency_key'], true);
  if not private.is_valid_uuid_text(command ->> 'invoice_id') or jsonb_typeof(command -> 'reason') is distinct from 'string'
    or not private.is_safe_bigint_jsonb(command -> 'expected_ordered_pieces') or not private.is_safe_bigint_jsonb(command -> 'ordered_pieces') then
    raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  if (command ->> 'ordered_pieces')::numeric not between 1 and 2147483647
    or (command ->> 'expected_ordered_pieces')::numeric not between 1 and 2147483647 then
    raise exception 'PIECES_INVALID' using errcode = 'P0001'; end if;
  iid := (command ->> 'invoice_id')::uuid;
  expected := (command ->> 'expected_ordered_pieces')::integer; n := (command ->> 'ordered_pieces')::integer;
  why := regexp_replace(command ->> 'reason', '^\s+|\s+$', '', 'g');
  if why = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if length(why) < 10 then raise exception 'REASON_TOO_SHORT' using errcode = 'P0001'; end if;
  if length(why) > 2000 then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  cmd := command || jsonb_build_object('reason', why, 'actor', actor);
  fp := encode(extensions.digest(convert_to(cmd::text, 'UTF8'), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended('invoice-piece-correction:' || sid::text || ':' || (command ->> 'idempotency_key'), 0));
  select * into old from public.invoice_piece_corrections where shop_id = sid and idempotency_key = command ->> 'idempotency_key';
  if found then
    if old.fingerprint <> fp then raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'P0001'; end if;
    return jsonb_build_object('ok', true, 'correction_id', old.id, 'invoice_id', old.invoice_id,
      'ordered_before', old.ordered_before, 'ordered_after', old.ordered_after, 'business_date', old.business_date);
  end if;

  if (select s.is_active from public.shops s where s.id = sid) is not true then raise exception 'SHOP_INACTIVE' using errcode = 'P0001'; end if;
  -- Serializes every correction, delivery, reversal and void of this invoice: everything below sees all committed events.
  select * into inv from public.invoices where shop_id = sid and id = iid for update;
  if not found then raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from public.invoice_voids v where v.invoice_id = iid) then raise exception 'INVOICE_VOID' using errcode = 'P0001'; end if;
  if inv.ordered_pieces is null then raise exception 'LEGACY_INVOICE' using errcode = 'P0001'; end if;
  perform private.assert_date_open(sid, today);
  current_ordered := private.effective_ordered_pieces(sid, iid);
  if current_ordered <> expected then raise exception 'STALE_ORDERED_PIECES' using errcode = 'P0001'; end if;
  if n = current_ordered then raise exception 'NO_CHANGE' using errcode = 'P0001'; end if;
  select coalesce(sum(x.pieces), 0) into delivered from public.invoice_deliveries x where x.shop_id = sid and x.invoice_id = iid;
  if n < delivered then raise exception 'BELOW_DELIVERED' using errcode = 'P0001'; end if;

  insert into public.invoice_piece_corrections(shop_id, invoice_id, ordered_before, ordered_after, reason, business_date, created_by, idempotency_key, fingerprint)
  values (sid, iid, current_ordered, n, why, today, actor, command ->> 'idempotency_key', fp) returning id into cid;
  insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, reason, metadata)
  values (sid, actor, 'delivery.correct_ordered', 'invoice', iid::text, why, jsonb_build_object(
    'correction_id', cid, 'ordered_before', current_ordered, 'ordered_after', n, 'original_ordered_pieces', inv.ordered_pieces,
    'delivered', delivered, 'business_date', today));
  return jsonb_build_object('ok', true, 'correction_id', cid, 'invoice_id', iid, 'ordered_before', current_ordered, 'ordered_after', n, 'business_date', today);
end $$;
revoke all on function public.correct_invoice_ordered_pieces(jsonb) from public, anon;
grant execute on function public.correct_invoice_ordered_pieces(jsonb) to authenticated;

-- 3. Read models -------------------------------------------------------------------------------------------------------
-- effective_invoices: identical to 20261112100000 except ordered_pieces (and the status it drives) is the effective one.
create or replace view public.effective_invoices with(security_invoker=true) as
select i.id as canonical_invoice_id, i.shop_id, i.invoice_id as original_invoice_number,
 coalesce(r.invoice_number,i.invoice_id) as effective_invoice_number,
 case when d.id is null then i.customer_id else r.customer_id end as effective_customer_id,
 case when i.ordered_pieces is not null then dp.pieces > 0
  when d.id is null then i.delivered else r.delivered end as effective_delivered,
 coalesce(d.revision,0) as revision,i.total_amount_dirham as original_total_dirham,i.business_date,i.recorded_at,i.created_by,
 b.effective_total_dirham,b.effective_paid_dirham,b.effective_due_dirham,coalesce(ca.amount_dirham,0)::bigint effective_credit_applied_dirham,
 exists(select 1 from public.invoice_voids v where v.shop_id=i.shop_id and v.invoice_id=i.id) as is_void,
 dp.ordered as ordered_pieces, dp.pieces as delivered_pieces,
 case when i.ordered_pieces is null then case when (case when d.id is null then i.delivered else r.delivered end) then 'full' else 'none' end
  when dp.pieces = 0 then 'none' when dp.pieces < dp.ordered then 'partial' else 'full' end as delivery_status
from public.invoices i join public.invoice_effective_balances b on b.canonical_invoice_id=i.id and b.shop_id=i.shop_id
left join lateral(select rd.* from public.replacement_decisions rd where rd.invoice_id=i.id and rd.shop_id=i.shop_id and rd.decision='approved' order by rd.revision desc limit 1)d on true
left join public.replacement_requests r on r.id=d.request_id and r.shop_id=i.shop_id
left join lateral(select sum(a.amount_dirham) amount_dirham from public.credit_applications a where a.shop_id=i.shop_id and a.invoice_id=i.id)ca on true
-- NULL for legacy rows; the outer-reference filter means their delivery and correction ledgers are never scanned.
left join lateral(select coalesce(sum(x.pieces),0)::integer pieces,
  coalesce((select c.ordered_after from public.invoice_piece_corrections c where c.shop_id=i.shop_id and c.invoice_id=i.id order by c.seq desc limit 1), i.ordered_pieces) ordered
  from public.invoice_deliveries x
  where i.ordered_pieces is not null and x.shop_id=i.shop_id and x.invoice_id=i.id)dp on i.ordered_pieces is not null;

create or replace view public.invoice_delivery_totals with(security_invoker=true) as
select i.id as canonical_invoice_id, i.shop_id, o.ordered as ordered_pieces,
  s.pieces as delivered_pieces, o.ordered - s.pieces as remaining_pieces,
  case when s.pieces = 0 then 'none' when s.pieces < o.ordered then 'partial' else 'full' end as delivery_status,
  i.ordered_pieces as original_ordered_pieces
from public.invoices i
cross join lateral (select coalesce(sum(x.pieces), 0)::integer as pieces from public.invoice_deliveries x
  where x.shop_id = i.shop_id and x.invoice_id = i.id) s
cross join lateral (select coalesce((select c.ordered_after from public.invoice_piece_corrections c
  where c.shop_id = i.shop_id and c.invoice_id = i.id order by c.seq desc limit 1), i.ordered_pieces) as ordered) o
where i.ordered_pieces is not null;

-- 4. Delivery RPCs read the effective ordered quantity -----------------------------------------------------------------
create function pg_temp.redefine(p_signature text, p_edits text[]) returns void
language plpgsql as $redefine$
declare
  def text := pg_get_functiondef(p_signature::regprocedure);
  anchor text;
  i integer;
begin
  for i in 1 .. array_length(p_edits, 1) / 2 loop
    anchor := p_edits[2 * i - 1];
    if (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'ordered_piece_corrections: % edit % did not match exactly once', p_signature, i;
    end if;
    def := replace(def, anchor, p_edits[2 * i]);
  end loop;
  execute def;
end
$redefine$;

select pg_temp.redefine('public.record_invoice_delivery(jsonb)', array[
  $a$if delivered + n > inv.ordered_pieces then$a$,
  $b$if delivered + n > private.effective_ordered_pieces(sid, iid) then$b$,
  $a$'ordered_pieces', inv.ordered_pieces,$a$,
  $b$'ordered_pieces', private.effective_ordered_pieces(sid, iid),$b$
]);
select pg_temp.redefine('public.reverse_invoice_delivery(jsonb)', array[
  $a$'ordered_pieces', inv.ordered_pieces,$a$,
  $b$'ordered_pieces', private.effective_ordered_pieces(sid, iid),$b$
]);
