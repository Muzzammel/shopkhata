-- OPS-01B slice 1: controlled invoice void.
--
-- Nothing is deleted or rewritten. A void is:
--   1. an approved corrections row dated TODAY (Qatar) of minus the invoice's current effective total, so every
--      existing projection (invoice_effective_balances, effective_invoices, customer balances, ledger, daily summary,
--      Daily Close) reads the invoice at 0 through the arithmetic it already uses;
--   2. an append-only invoice_voids marker (one per invoice) carrying the reason, actor and idempotency fingerprint;
--   3. an audit_events row 'invoice.void'.
-- Today's date must be open (the corrections trigger and an explicit check); the invoice's own date may be closed and
-- is never touched. Invoices with effective cash paid or customer credit applied are refused: reverse those first, so a
-- void can never create silent customer credit. A void cannot be undone.

-- 1. Marker table ------------------------------------------------------------------------------------------------
create table public.invoice_voids (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  invoice_id uuid not null unique,
  -- Null only when the effective total was already 0, so there was nothing to reverse.
  correction_id uuid unique references public.corrections(id) on delete restrict,
  reason text not null check (reason = btrim(reason) and length(reason) between 10 and 2000),
  actor_user_id uuid not null references public.profiles(id) on delete restrict,
  business_date date not null,
  created_at timestamptz not null default now(),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 200),
  fingerprint text not null,
  unique (shop_id, idempotency_key),
  foreign key (shop_id, invoice_id) references public.invoices(shop_id, id) on delete restrict
);

alter table public.invoice_voids enable row level security;
revoke all on public.invoice_voids from public, anon, authenticated;
grant select on public.invoice_voids to authenticated;
-- Once-per-statement shop list, as every shop-scoped read policy since 20261004110000.
create policy invoice_voids_read on public.invoice_voids for select to authenticated using (shop_id = any ((select private.accessible_shop_ids())::uuid[]));
create trigger invoice_voids_append_only before update or delete on public.invoice_voids
  for each row execute function public.reject_append_only_mutation();
create trigger invoice_voids_active_shop before insert on public.invoice_voids
  for each row execute function private.enforce_active_shop();

-- OPS-01A coverage rule, re-asserted with the new table: every shop-scoped base table except the audit history and
-- access assignments carries the active-shop INSERT guard.
do $$
declare uncovered text;
begin
  select string_agg(c.table_name::text, ', ') into uncovered
  from information_schema.columns c join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
  where c.table_schema = 'public' and c.column_name = 'shop_id' and tb.table_type = 'BASE TABLE'
    and c.table_name::text not in ('audit_events', 'user_shop_assignments')
    and not exists (select 1 from pg_trigger t where t.tgrelid = format('public.%I', c.table_name)::regclass
      and not t.tgisinternal and t.tgfoid = 'private.enforce_active_shop()'::regprocedure);
  if uncovered is not null then raise exception 'ops_01b: shop-scoped tables without the active-shop guard: %', uncovered; end if;
end $$;

-- 2. Post-void guard ------------------------------------------------------------------------------------------------
-- Any later write that would move or re-describe a voided invoice is refused, whichever RPC performs it: new correction
-- or replacement requests, approvals (a pending request made before the void can still be rejected), ledger
-- corrections, payments, credit applications and overpayment credits. FOR SHARE on the invoice row conflicts with
-- void_invoice's FOR UPDATE, so a write racing a void either commits first (and the void then sees it) or waits and
-- sees the void.
create function private.enforce_invoice_not_void() returns trigger
language plpgsql set search_path = '' as $$
declare r jsonb := to_jsonb(new); iid uuid;
begin
  if r ? 'decision' and r ->> 'decision' <> 'approved' then return new; end if;
  iid := coalesce((r ->> 'invoice_id')::uuid,
    (select p.invoice_id from public.payments p where p.shop_id = new.shop_id and p.id = (r ->> 'payment_id')::uuid));
  if iid is null then return new; end if;
  perform 1 from public.invoices i where i.shop_id = new.shop_id and i.id = iid for share;
  if exists (select 1 from public.invoice_voids v where v.invoice_id = iid) then
    raise exception 'INVOICE_VOID' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function private.enforce_invoice_not_void() from public, anon, authenticated;

do $$ declare t text; begin
  foreach t in array array['correction_requests', 'correction_decisions', 'corrections', 'replacement_requests',
    'replacement_decisions', 'payments', 'credit_applications', 'customer_credits'] loop
    execute format('create trigger %I before insert on public.%I for each row execute function private.enforce_invoice_not_void()', t || '_invoice_not_void', t);
  end loop;
end $$;

-- 3. Read models ------------------------------------------------------------------------------------------------
-- effective_invoices: unchanged columns and formulas, is_void appended at the end.
create or replace view public.effective_invoices with(security_invoker=true) as
select i.id as canonical_invoice_id, i.shop_id, i.invoice_id as original_invoice_number,
 coalesce(r.invoice_number,i.invoice_id) as effective_invoice_number,
 case when d.id is null then i.customer_id else r.customer_id end as effective_customer_id,
 case when d.id is null then i.delivered else r.delivered end as effective_delivered,
 coalesce(d.revision,0) as revision,i.total_amount_dirham as original_total_dirham,i.business_date,i.recorded_at,i.created_by,
 b.effective_total_dirham,b.effective_paid_dirham,b.effective_due_dirham,coalesce(ca.amount_dirham,0)::bigint effective_credit_applied_dirham,
 exists(select 1 from public.invoice_voids v where v.shop_id=i.shop_id and v.invoice_id=i.id) as is_void
from public.invoices i join public.invoice_effective_balances b on b.canonical_invoice_id=i.id and b.shop_id=i.shop_id
left join lateral(select rd.* from public.replacement_decisions rd where rd.invoice_id=i.id and rd.shop_id=i.shop_id and rd.decision='approved' order by rd.revision desc limit 1)d on true
left join public.replacement_requests r on r.id=d.request_id and r.shop_id=i.shop_id
left join lateral(select sum(a.amount_dirham) amount_dirham from public.credit_applications a where a.shop_id=i.shop_id and a.invoice_id=i.id)ca on true;

-- customer_ledger: same columns and amounts; the void's correction line is labelled 'invoice_void'.
create or replace view public.customer_ledger with(security_invoker=true) as
select e.shop_id,e.effective_customer_id customer_id,e.business_date,e.recorded_at,e.canonical_invoice_id sequence_id,
 'invoice'::text entry_type,e.effective_invoice_number reference,e.effective_invoice_number invoice_number,
 e.created_by actor_id,i.id invoice_id,i.total_amount_dirham debit_dirham,0::bigint credit_dirham
from public.effective_invoices e join public.invoices i on i.shop_id=e.shop_id and i.id=e.canonical_invoice_id where e.effective_customer_id is not null
union all
select e.shop_id,e.effective_customer_id,p.business_date,p.recorded_at,p.id,'payment',e.effective_invoice_number,e.effective_invoice_number,p.created_by,e.canonical_invoice_id,0::bigint,p.amount_dirham
from public.payments p join public.effective_invoices e on e.shop_id=p.shop_id and e.canonical_invoice_id=p.invoice_id
where e.effective_customer_id is not null
union all
select c.shop_id,e.effective_customer_id,c.business_date,c.recorded_at,c.id,
 case when exists(select 1 from public.invoice_voids v where v.shop_id=c.shop_id and v.correction_id=c.id) then 'invoice_void'
  when c.invoice_id is not null then 'invoice_correction' else 'payment_correction' end,
 e.effective_invoice_number,e.effective_invoice_number,c.created_by,e.canonical_invoice_id,
 case when c.invoice_id is not null then greatest(c.amount_delta_dirham,0) else greatest(-c.amount_delta_dirham,0) end,
 case when c.invoice_id is not null then greatest(-c.amount_delta_dirham,0) else greatest(c.amount_delta_dirham,0) end
from public.corrections c join public.effective_invoices e on e.shop_id=c.shop_id and e.canonical_invoice_id=coalesce(c.invoice_id,(select p.invoice_id from public.payments p where p.shop_id=c.shop_id and p.id=c.payment_id))
where c.approved_by is not null and e.effective_customer_id is not null
union all
select ca.shop_id,e.effective_customer_id,ca.business_date,ca.recorded_at,ca.id,'credit_application',e.effective_invoice_number,e.effective_invoice_number,ca.created_by,e.canonical_invoice_id,0::bigint,ca.amount_dirham
from public.credit_applications ca join public.effective_invoices e on e.shop_id=ca.shop_id and e.canonical_invoice_id=ca.invoice_id;

-- 4. void_invoice(command) ---------------------------------------------------------------------------------------
-- command: {shop_id, invoice_id, reason, idempotency_key}. Owner or manager with access to the shop.
-- Exact replay (same key, same fingerprint) returns the original result before any date or state check, so a lost
-- response stays retryable even after today closes. Same key, different command: IDEMPOTENCY_CONFLICT.
create function public.void_invoice(command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); sid uuid; iid uuid; why text; cmd jsonb; fp text;
  old public.invoice_voids; inv public.invoices; eff public.effective_invoices;
  today date := (now() at time zone 'Asia/Qatar')::date; cid uuid; vid uuid;
begin
  sid := private.invoice_operation_actor(command, array['shop_id', 'invoice_id', 'reason', 'idempotency_key'], true);
  if not private.is_valid_uuid_text(command ->> 'invoice_id') or jsonb_typeof(command -> 'reason') is distinct from 'string' then
    raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  iid := (command ->> 'invoice_id')::uuid;
  -- Every kind of surrounding whitespace (tabs, newlines), not only spaces, as the app trims it.
  why := regexp_replace(command ->> 'reason', '^\s+|\s+$', '', 'g');
  if why = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if length(why) < 10 then raise exception 'REASON_TOO_SHORT' using errcode = 'P0001'; end if;
  if length(why) > 2000 then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  cmd := command || jsonb_build_object('reason', why, 'actor', actor);
  fp := encode(extensions.digest(convert_to(cmd::text, 'UTF8'), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended('invoice-void:' || sid::text || ':' || (command ->> 'idempotency_key'), 0));
  select * into old from public.invoice_voids where shop_id = sid and idempotency_key = command ->> 'idempotency_key';
  if found then
    if old.fingerprint <> fp then raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'P0001'; end if;
    return jsonb_build_object('ok', true, 'void_id', old.id, 'invoice_id', old.invoice_id, 'correction_id', old.correction_id, 'business_date', old.business_date);
  end if;

  if (select s.is_active from public.shops s where s.id = sid) is not true then raise exception 'SHOP_INACTIVE' using errcode = 'P0001'; end if;
  select * into inv from public.invoices where shop_id = sid and id = iid for update;
  if not found then raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from public.invoice_voids v where v.invoice_id = iid) then raise exception 'ALREADY_VOID' using errcode = 'P0001'; end if;
  select * into eff from public.effective_invoices where shop_id = sid and canonical_invoice_id = iid;
  if eff.effective_paid_dirham <> 0 then raise exception 'PAYMENTS_OUTSTANDING' using errcode = 'P0001'; end if;
  if eff.effective_credit_applied_dirham <> 0 then raise exception 'CREDIT_APPLIED' using errcode = 'P0001'; end if;
  perform private.assert_date_open(sid, today);

  if eff.effective_total_dirham <> 0 then
    insert into public.corrections(shop_id, invoice_id, payment_id, amount_delta_dirham, reason, business_date, created_by, approved_by)
    values (sid, iid, null, -eff.effective_total_dirham, why, today, actor, actor) returning id into cid;
  end if;
  insert into public.invoice_voids(shop_id, invoice_id, correction_id, reason, actor_user_id, business_date, idempotency_key, fingerprint)
  values (sid, iid, cid, why, actor, today, command ->> 'idempotency_key', fp) returning id into vid;
  insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, reason, metadata)
  values (sid, actor, 'invoice.void', 'invoice', iid::text, why, jsonb_build_object(
    'invoice_id', iid, 'invoice_number', eff.effective_invoice_number, 'original_invoice_number', inv.invoice_id, 'shop_id', sid,
    'original_business_date', inv.business_date, 'void_business_date', today, 'original_total_dirham', inv.total_amount_dirham,
    'effective_total_before_dirham', eff.effective_total_dirham, 'paid_before_dirham', eff.effective_paid_dirham,
    'correction_id', cid, 'void_id', vid, 'reason', why, 'actor', actor));
  return jsonb_build_object('ok', true, 'void_id', vid, 'invoice_id', iid, 'correction_id', cid, 'business_date', today);
end $$;
revoke all on function public.void_invoice(jsonb) from public, anon;
grant execute on function public.void_invoice(jsonb) to authenticated;
