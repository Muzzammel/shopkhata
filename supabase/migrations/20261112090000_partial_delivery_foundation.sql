-- Partial delivery, step 1: database foundation for piece-based deliveries.
--
-- Additive only. Nothing existing is rewritten:
--   1. invoices.ordered_pieces (nullable). NULL = legacy invoice: the yes/no `delivered` flag keeps working exactly as
--      before (submit_batch, replacements, effective_delivered). Excel imports keep creating legacy invoices.
--   2. invoice_deliveries: append-only delivery events (whole pieces > 0, business date, actor, recorded time). The
--      initial delivery of a sale is written by submit_batch (batch_id set, no key); later deliveries by
--      record_invoice_delivery (idempotency key + fingerprint, no batch_id).
--   3. record_invoice_delivery(command): any active shop member; today's Qatar date only; refused on closed dates,
--      voided, legacy and inactive-shop invoices; never over the ordered pieces (invoice row locked FOR UPDATE).
--   4. submit_batch accepts the optional row keys ordered_pieces + delivered_pieces (both or neither). Rows without
--      them produce the same canonical command, so pending offline drafts and retries keep their fingerprints.
--   5. effective_invoices.effective_delivered, for tracked invoices only, becomes "net delivered pieces > 0". Same
--      columns, same order; legacy rows use the old formula, so every report reads them unchanged.
--   6. invoice_delivery_totals: ordered / delivered / remaining pieces and none|partial|full per tracked invoice.
--   7. Customer rule: a tracked invoice with any pieces delivered and money due must have a customer. Enforced by the
--      RPCs and by an AFTER INSERT guard on every write that can deliver pieces, raise the due or drop the customer
--      (invoice_deliveries, corrections, replacement_decisions), whichever RPC performs it.
-- Not in this step: delivery reversals and ordered-pieces corrections. Both need a new request/decision pair in the
-- existing approval framework; they stay unavailable until that is designed (no table, no RPC).

-- 1. Ordered pieces ---------------------------------------------------------------------------------------------------
alter table public.invoices add column ordered_pieces integer check (ordered_pieces > 0);

-- 2. Delivery events ---------------------------------------------------------------------------------------------------
create table public.invoice_deliveries (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  invoice_id uuid not null,
  pieces integer not null check (pieces > 0),
  business_date date not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  batch_id uuid references public.batches(id) on delete restrict,
  idempotency_key text check (length(btrim(idempotency_key)) between 1 and 200),
  fingerprint text,
  -- Exactly one source: the sale's own batch, or a keyed record_invoice_delivery call.
  check ((batch_id is not null and idempotency_key is null and fingerprint is null)
    or (batch_id is null and idempotency_key is not null and fingerprint is not null)),
  unique (shop_id, idempotency_key),
  foreign key (shop_id, invoice_id) references public.invoices(shop_id, id) on delete restrict
);
create index invoice_deliveries_invoice_idx on public.invoice_deliveries(shop_id, invoice_id);
-- A sale delivers at most once from its own batch.
create unique index invoice_deliveries_batch_once_uq on public.invoice_deliveries(invoice_id) where batch_id is not null;

alter table public.invoice_deliveries enable row level security;
revoke all on public.invoice_deliveries from public, anon, authenticated;
grant select on public.invoice_deliveries to authenticated;
create policy invoice_deliveries_read on public.invoice_deliveries for select to authenticated
  using (shop_id = any ((select private.accessible_shop_ids())::uuid[]));
create trigger invoice_deliveries_append_only before update or delete on public.invoice_deliveries
  for each row execute function public.reject_append_only_mutation();
create trigger invoice_deliveries_active_shop before insert on public.invoice_deliveries
  for each row execute function private.enforce_active_shop();
create trigger invoice_deliveries_open_business_date before insert on public.invoice_deliveries
  for each row execute function private.enforce_open_business_date();
create trigger invoice_deliveries_invoice_not_void before insert on public.invoice_deliveries
  for each row execute function private.enforce_invoice_not_void();

-- 3. Read models -------------------------------------------------------------------------------------------------------
-- effective_invoices: identical to 20261103150000 except effective_delivered for tracked invoices. The subquery sits
-- inside CASE, so legacy rows never evaluate it.
create or replace view public.effective_invoices with(security_invoker=true) as
select i.id as canonical_invoice_id, i.shop_id, i.invoice_id as original_invoice_number,
 coalesce(r.invoice_number,i.invoice_id) as effective_invoice_number,
 case when d.id is null then i.customer_id else r.customer_id end as effective_customer_id,
 case when i.ordered_pieces is not null then coalesce((select sum(x.pieces) from public.invoice_deliveries x where x.shop_id=i.shop_id and x.invoice_id=i.id),0) > 0
  when d.id is null then i.delivered else r.delivered end as effective_delivered,
 coalesce(d.revision,0) as revision,i.total_amount_dirham as original_total_dirham,i.business_date,i.recorded_at,i.created_by,
 b.effective_total_dirham,b.effective_paid_dirham,b.effective_due_dirham,coalesce(ca.amount_dirham,0)::bigint effective_credit_applied_dirham,
 exists(select 1 from public.invoice_voids v where v.shop_id=i.shop_id and v.invoice_id=i.id) as is_void
from public.invoices i join public.invoice_effective_balances b on b.canonical_invoice_id=i.id and b.shop_id=i.shop_id
left join lateral(select rd.* from public.replacement_decisions rd where rd.invoice_id=i.id and rd.shop_id=i.shop_id and rd.decision='approved' order by rd.revision desc limit 1)d on true
left join public.replacement_requests r on r.id=d.request_id and r.shop_id=i.shop_id
left join lateral(select sum(a.amount_dirham) amount_dirham from public.credit_applications a where a.shop_id=i.shop_id and a.invoice_id=i.id)ca on true;

-- Piece totals for tracked invoices only (legacy invoices have no row here).
create view public.invoice_delivery_totals with(security_invoker=true) as
select i.id as canonical_invoice_id, i.shop_id, i.ordered_pieces,
  s.pieces as delivered_pieces, i.ordered_pieces - s.pieces as remaining_pieces,
  case when s.pieces = 0 then 'none' when s.pieces < i.ordered_pieces then 'partial' else 'full' end as delivery_status
from public.invoices i
cross join lateral (select coalesce(sum(x.pieces), 0)::integer as pieces from public.invoice_deliveries x
  where x.shop_id = i.shop_id and x.invoice_id = i.id) s
where i.ordered_pieces is not null;
revoke all on public.invoice_delivery_totals from public, anon;
grant select on public.invoice_delivery_totals to authenticated;

-- 4. Customer rule guard -----------------------------------------------------------------------------------------------
-- AFTER INSERT, so it sees the row just written (and, for submit_batch, the payment written before the delivery).
create function private.enforce_delivery_customer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r jsonb := to_jsonb(new); ids uuid[];
begin
  if r ? 'decision' and r ->> 'decision' <> 'approved' then return new; end if;
  ids := array_remove(array[(r ->> 'invoice_id')::uuid,
    (select p.invoice_id from public.payments p where p.shop_id = new.shop_id and p.id = (r ->> 'payment_id')::uuid)], null);
  if exists (select 1 from public.effective_invoices e join public.invoices i on i.shop_id = e.shop_id and i.id = e.canonical_invoice_id
    where e.shop_id = new.shop_id and e.canonical_invoice_id = any (ids) and i.ordered_pieces is not null
      and e.effective_delivered and e.effective_due_dirham > 0 and e.effective_customer_id is null) then
    raise exception 'CUSTOMER_REQUIRED' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function private.enforce_delivery_customer() from public, anon, authenticated;
do $$ declare t text; begin
  foreach t in array array['invoice_deliveries', 'corrections', 'replacement_decisions'] loop
    execute format('create trigger %I after insert on public.%I for each row execute function private.enforce_delivery_customer()', t || '_delivery_customer', t);
  end loop;
end $$;

-- 5. record_invoice_delivery(command) ----------------------------------------------------------------------------------
-- command: {shop_id, invoice_id, pieces, idempotency_key}. Any active member of the shop (as submit_batch).
-- Exact replay returns the original result before any date or state check; same key, other command: IDEMPOTENCY_CONFLICT.
create function public.record_invoice_delivery(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid; sid uuid; iid uuid; n integer; cmd jsonb; fp text;
  old public.invoice_deliveries; inv public.invoices; eff public.effective_invoices;
  today date; delivered bigint; did uuid;
begin
  perform private.assert_not_in_maintenance();
  actor := auth.uid(); today := (now() at time zone 'Asia/Qatar')::date;
  sid := private.invoice_operation_actor(command, array['shop_id', 'invoice_id', 'pieces', 'idempotency_key'], false);
  if not private.is_valid_uuid_text(command ->> 'invoice_id') or not private.is_safe_bigint_jsonb(command -> 'pieces') then
    raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  if (command ->> 'pieces')::numeric not between 1 and 2147483647 then raise exception 'PIECES_INVALID' using errcode = 'P0001'; end if;
  iid := (command ->> 'invoice_id')::uuid; n := (command ->> 'pieces')::integer;
  cmd := command || jsonb_build_object('actor', actor);
  fp := encode(extensions.digest(convert_to(cmd::text, 'UTF8'), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended('invoice-delivery:' || sid::text || ':' || (command ->> 'idempotency_key'), 0));
  select * into old from public.invoice_deliveries where shop_id = sid and idempotency_key = command ->> 'idempotency_key';
  if found then
    if old.fingerprint <> fp then raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'P0001'; end if;
    return jsonb_build_object('ok', true, 'delivery_id', old.id, 'invoice_id', old.invoice_id, 'pieces', old.pieces, 'business_date', old.business_date);
  end if;

  if (select s.is_active from public.shops s where s.id = sid) is not true then raise exception 'SHOP_INACTIVE' using errcode = 'P0001'; end if;
  -- Serializes every delivery (and void) of this invoice: the sum below sees all committed deliveries.
  select * into inv from public.invoices where shop_id = sid and id = iid for update;
  if not found then raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from public.invoice_voids v where v.invoice_id = iid) then raise exception 'INVOICE_VOID' using errcode = 'P0001'; end if;
  if inv.ordered_pieces is null then raise exception 'LEGACY_INVOICE' using errcode = 'P0001'; end if;
  perform private.assert_date_open(sid, today);
  select coalesce(sum(x.pieces), 0) into delivered from public.invoice_deliveries x where x.shop_id = sid and x.invoice_id = iid;
  if delivered + n > inv.ordered_pieces then raise exception 'OVER_DELIVERY' using errcode = 'P0001'; end if;
  select * into eff from public.effective_invoices where shop_id = sid and canonical_invoice_id = iid;
  if eff.effective_due_dirham > 0 and eff.effective_customer_id is null then raise exception 'CUSTOMER_REQUIRED' using errcode = 'P0001'; end if;

  insert into public.invoice_deliveries(shop_id, invoice_id, pieces, business_date, created_by, idempotency_key, fingerprint)
  values (sid, iid, n, today, actor, command ->> 'idempotency_key', fp) returning id into did;
  insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, metadata)
  values (sid, actor, 'delivery.record', 'invoice', iid::text, jsonb_build_object(
    'delivery_id', did, 'pieces', n, 'business_date', today, 'ordered_pieces', inv.ordered_pieces, 'delivered_before', delivered));
  return jsonb_build_object('ok', true, 'delivery_id', did, 'invoice_id', iid, 'pieces', n, 'business_date', today);
end $$;
revoke all on function public.record_invoice_delivery(jsonb) from public, anon;
grant execute on function public.record_invoice_delivery(jsonb) to authenticated;

-- 6. submit_batch: optional ordered_pieces + delivered_pieces -----------------------------------------------------------
-- Re-created from the stored definitions with exact-once substitutions (as 20261021090000), so every other line stays as
-- deployed. The migration stops if an anchor is not found exactly once.
-- One session may apply every migration (supabase start): drop a helper left by an earlier one (20261021090000).
drop function if exists pg_temp.redefine(text, text[]);
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
      raise exception 'partial_delivery: % edit % did not match exactly once', p_signature, i;
    end if;
    def := replace(def, anchor, p_edits[2 * i]);
  end loop;
  execute def;
end
$redefine$;

-- The piece keys enter the fingerprint only when sent, so a row without them hashes exactly as before.
select pg_temp.redefine('private.canonical_batch_command(uuid,date,boolean,text,jsonb)', array[
  $a$order by ordinality$a$,
  $b$|| case when row_value ? 'ordered_pieces' or row_value ? 'delivered_pieces' then jsonb_build_object(
          'ordered_pieces', (row_value ->> 'ordered_pieces')::integer,
          'delivered_pieces', (row_value ->> 'delivered_pieces')::integer) else '{}'::jsonb end
        order by ordinality$b$
]);

select pg_temp.redefine('private.submit_batch(jsonb)', array[
  $a$v_delivered boolean;$a$,
  $b$v_delivered boolean;
  v_ordered_pieces integer;
  v_delivered_pieces integer;$b$,
  $a$'payment_method','delivered','note','customer']$a$,
  $b$'payment_method','delivered','note','customer','ordered_pieces','delivered_pieces']$b$,
  -- Both keys or neither. A tracked row's delivered flag is derived from its pieces; if sent, it must agree.
  $a$if v_row ? 'note' and jsonb_typeof(v_row -> 'note') not in ('string', 'null') then$a$,
  $b$v_ordered_pieces := null;
    v_delivered_pieces := null;
    if v_row ? 'ordered_pieces' or v_row ? 'delivered_pieces' then
      if private.is_safe_bigint_jsonb(v_row -> 'ordered_pieces') and private.is_safe_bigint_jsonb(v_row -> 'delivered_pieces') then
        if (v_row ->> 'ordered_pieces')::numeric between 1 and 2147483647
          and (v_row ->> 'delivered_pieces')::numeric between 0 and (v_row ->> 'ordered_pieces')::numeric then
          v_ordered_pieces := (v_row ->> 'ordered_pieces')::integer;
          v_delivered_pieces := (v_row ->> 'delivered_pieces')::integer;
        end if;
      end if;
      if v_ordered_pieces is null then
        v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'pieces', 'code', 'PIECES_INVALID', 'message', 'Ordered pieces must be a whole number of at least 1 and delivered pieces a whole number from 0 to the ordered pieces.');
      elsif v_row ? 'delivered' and v_delivered is distinct from (v_delivered_pieces > 0) then
        v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'delivered', 'code', 'REQUEST_INVALID', 'message', 'delivered must match whether any pieces are delivered.');
      else
        v_delivered := v_delivered_pieces > 0;
      end if;
    end if;

    if v_row ? 'note' and jsonb_typeof(v_row -> 'note') not in ('string', 'null') then$b$,
  $a$'delivered', v_delivered,$a$,
  $b$'delivered', v_delivered,
      'ordered_pieces', v_ordered_pieces,
      'delivered_pieces', v_delivered_pieces,$b$,
  $a$id, shop_id, batch_id, customer_id, invoice_id, delivered, note,$a$,
  $b$id, shop_id, batch_id, customer_id, invoice_id, delivered, note, ordered_pieces,$b$,
  $a$v_prepared_row ->> 'note', (v_prepared_row ->> 'total')::bigint,$a$,
  $b$v_prepared_row ->> 'note', (v_prepared_row ->> 'ordered_pieces')::integer, (v_prepared_row ->> 'total')::bigint,$b$,
  -- Initial deliveries after every invoice and payment of the batch exist, so the customer guard sees the final due.
  $a$insert into public.audit_events (shop_id, actor_id, action, entity_type, entity_id, metadata)$a$,
  $b$insert into public.invoice_deliveries (shop_id, invoice_id, pieces, business_date, created_by, recorded_at, batch_id)
  select v_shop_id, (p ->> 'invoice_id')::uuid, (p ->> 'delivered_pieces')::integer, v_business_date, v_actor_id, v_recorded_at, v_batch_id
  from jsonb_array_elements(v_prepared) with ordinality as t(p, ord)
  where coalesce((p ->> 'delivered_pieces')::integer, 0) > 0
  order by ord;

  insert into public.audit_events (shop_id, actor_id, action, entity_type, entity_id, metadata)$b$
]);

drop function pg_temp.redefine(text, text[]);
