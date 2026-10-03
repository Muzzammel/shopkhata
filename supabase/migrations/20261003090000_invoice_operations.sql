-- BIG SLICE 1: governed, immutable invoice operations.

create table public.correction_requests (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  invoice_id uuid not null,
  payment_id uuid,
  amount_delta_dirham bigint not null check (amount_delta_dirham <> 0 and abs(amount_delta_dirham::numeric) <= 9007199254740991),
  foreign key (shop_id,payment_id) references public.payments(shop_id,id) on delete restrict,
  reason text not null check (length(btrim(reason)) between 1 and 2000),
  requested_by uuid not null references public.profiles(id) on delete restrict,
  requested_at timestamptz not null default now(),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 200),
  fingerprint text not null,
  unique(shop_id,idempotency_key),
  unique(shop_id,id,invoice_id),
  foreign key(shop_id,invoice_id) references public.invoices(shop_id,id) on delete restrict
);
create index correction_requests_invoice_idx on public.correction_requests(shop_id,invoice_id,requested_at);
create table public.correction_decisions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  request_id uuid not null unique,
  invoice_id uuid not null,
  decision text not null check (decision in ('approved','rejected')),
  expected_revision integer not null check (expected_revision >= 0),
  revision integer,
  reason text check (length(reason) <= 2000),
  decided_by uuid not null references public.profiles(id) on delete restrict,
  decided_at timestamptz not null default now(),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 200),
  fingerprint text not null,
  unique(shop_id,idempotency_key),
  foreign key(shop_id,request_id,invoice_id) references public.correction_requests(shop_id,id,invoice_id) on delete restrict,
  check (revision is null)
);
create index correction_decisions_invoice_idx on public.correction_decisions(shop_id,invoice_id);

alter table public.correction_requests enable row level security;
revoke all on public.correction_requests from public,anon,authenticated;
grant select on public.correction_requests to authenticated;
create policy correction_requests_read on public.correction_requests for select to authenticated using(private.has_shop_access(shop_id));
create trigger correction_requests_append_only before update or delete on public.correction_requests for each row execute function public.reject_append_only_mutation();

alter table public.correction_decisions enable row level security;
revoke all on public.correction_decisions from public,anon,authenticated;
grant select on public.correction_decisions to authenticated;
create policy correction_decisions_read on public.correction_decisions for select to authenticated using(private.has_shop_access(shop_id));
create trigger correction_decisions_append_only before update or delete on public.correction_decisions for each row execute function public.reject_append_only_mutation();

create table public.replacement_requests (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  invoice_id uuid not null,
  expected_revision integer not null check (expected_revision >= 0),
  invoice_number text not null check (invoice_number = btrim(invoice_number) and length(invoice_number) between 1 and 120),
  customer_id uuid,
  delivered boolean not null,
  foreign key (shop_id, customer_id) references public.customers(shop_id,id) on delete restrict,
  reason text not null check (length(btrim(reason)) between 1 and 2000),
  requested_by uuid not null references public.profiles(id) on delete restrict,
  requested_at timestamptz not null default now(),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 200),
  fingerprint text not null,
  unique(shop_id,idempotency_key),
  unique(shop_id,id,invoice_id),
  foreign key(shop_id,invoice_id) references public.invoices(shop_id,id) on delete restrict
);
create index replacement_requests_invoice_idx on public.replacement_requests(shop_id,invoice_id,requested_at);
create table public.replacement_decisions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  request_id uuid not null unique,
  invoice_id uuid not null,
  decision text not null check (decision in ('approved','rejected')),
  expected_revision integer not null check (expected_revision >= 0),
  revision integer,
  reason text check (length(reason) <= 2000),
  decided_by uuid not null references public.profiles(id) on delete restrict,
  decided_at timestamptz not null default now(),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 200),
  fingerprint text not null,
  unique(shop_id,idempotency_key),
  foreign key(shop_id,request_id,invoice_id) references public.replacement_requests(shop_id,id,invoice_id) on delete restrict,
  check ((decision='approved' and revision is not null and revision=expected_revision+1) or (decision='rejected' and revision is null)),
  unique(shop_id,invoice_id,revision)
);
create index replacement_decisions_invoice_idx on public.replacement_decisions(shop_id,invoice_id);

alter table public.replacement_requests enable row level security;
revoke all on public.replacement_requests from public,anon,authenticated;
grant select on public.replacement_requests to authenticated;
create policy replacement_requests_read on public.replacement_requests for select to authenticated using(private.has_shop_access(shop_id));
create trigger replacement_requests_append_only before update or delete on public.replacement_requests for each row execute function public.reject_append_only_mutation();

alter table public.replacement_decisions enable row level security;
revoke all on public.replacement_decisions from public,anon,authenticated;
grant select on public.replacement_decisions to authenticated;
create policy replacement_decisions_read on public.replacement_decisions for select to authenticated using(private.has_shop_access(shop_id));
create trigger replacement_decisions_append_only before update or delete on public.replacement_decisions for each row execute function public.reject_append_only_mutation();

alter table public.corrections add column request_id uuid unique references public.correction_requests(id) on delete restrict;

-- Scalar financial aggregates stay independent of version cardinality.
create view public.effective_invoices with (security_invoker=true) as
select i.id as canonical_invoice_id, i.shop_id, i.invoice_id as original_invoice_number,
  coalesce(r.invoice_number,i.invoice_id) as effective_invoice_number,
  case when d.id is null then i.customer_id else r.customer_id end as effective_customer_id,
  case when d.id is null then i.delivered else r.delivered end as effective_delivered,
  coalesce(d.revision,0) as revision,
  i.total_amount_dirham as original_total_dirham, i.business_date, i.recorded_at, i.created_by,
  b.effective_total_dirham,b.effective_paid_dirham,b.effective_due_dirham
from public.invoices i
join public.invoice_effective_balances b on b.canonical_invoice_id=i.id and b.shop_id=i.shop_id
left join lateral (
  select rd.* from public.replacement_decisions rd
  where rd.invoice_id=i.id and rd.shop_id=i.shop_id and rd.decision='approved'
  order by rd.revision desc limit 1
) d on true
left join public.replacement_requests r on r.id=d.request_id and r.shop_id=i.shop_id;
revoke all on public.effective_invoices from public,anon;
grant select on public.effective_invoices to authenticated;

-- Shared validation is private and callable only by the owning definer RPCs.
create function private.invoice_operation_actor(command jsonb, allowed_keys text[], privileged boolean)
returns uuid language plpgsql security definer set search_path='' as $$
declare sid uuid;
begin
  if auth.uid() is null or not private.is_active_actor() then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
  if jsonb_typeof(command) is distinct from 'object'
    or not private.jsonb_object_keys_subset(command,allowed_keys)
    or not private.is_valid_uuid_text(command->>'shop_id')
    or jsonb_typeof(command->'idempotency_key') is distinct from 'string'
    or length(btrim(command->>'idempotency_key')) not between 1 and 200
  then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
  sid := (command->>'shop_id')::uuid;
  if not private.has_shop_access(sid) then raise exception 'UNAUTHORIZED_SHOP' using errcode='42501'; end if;
  if privileged and not exists(select 1 from public.profiles where id=auth.uid() and role in ('owner','manager')) then
    raise exception 'INSUFFICIENT_ROLE' using errcode='42501'; end if;
  return sid;
end $$;
revoke all on function private.invoice_operation_actor(jsonb,text[],boolean) from public,anon,authenticated;


create function public.request_invoice_correction(command jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  sid uuid; iid uuid; actor uuid:=auth.uid(); cmd jsonb; fp text; old public.correction_requests; rid uuid;
begin
  sid := private.invoice_operation_actor(command,array['shop_id','invoice_id','reason','idempotency_key','payment_id','amount_delta_dirham'],false);
  if not private.is_valid_uuid_text(command->>'invoice_id')
    or jsonb_typeof(command->'reason') is distinct from 'string'
    or length(btrim(command->>'reason')) not between 1 and 2000 then
    raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
  iid := (command->>'invoice_id')::uuid;

  if not private.is_safe_bigint_jsonb(command->'amount_delta_dirham')
    or (command->>'amount_delta_dirham')::bigint=0
    or not(command ? 'payment_id')
    or (jsonb_typeof(command->'payment_id') is distinct from 'null' and not private.is_valid_uuid_text(command->>'payment_id'))
  then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
  cmd := command;
  cmd := cmd || jsonb_build_object('reason',btrim(command->>'reason'),'actor',actor);
  fp := encode(extensions.digest(cmd::text::bytea,'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended('correction-request:'||sid::text||':'||(command->>'idempotency_key'),0));
  select * into old from public.correction_requests where shop_id=sid and idempotency_key=command->>'idempotency_key';
  if found then
    if old.fingerprint<>fp then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='P0001'; end if;
    return jsonb_build_object('ok',true,'request_id',old.id,'invoice_id',old.invoice_id);
  end if;
  perform 1 from public.invoices where shop_id=sid and id=iid for update;
  if not found then raise exception 'INVOICE_NOT_FOUND' using errcode='P0001'; end if;

  if cmd->>'payment_id' is not null and not exists(select 1 from public.payments where shop_id=sid and invoice_id=iid and id=(cmd->>'payment_id')::uuid) then
    raise exception 'PAYMENT_NOT_FOUND' using errcode='P0001'; end if;
  insert into public.correction_requests(shop_id,invoice_id,payment_id,amount_delta_dirham,reason,requested_by,idempotency_key,fingerprint)
  values(sid,iid,(cmd->>'payment_id')::uuid,(cmd->>'amount_delta_dirham')::bigint,cmd->>'reason',actor,cmd->>'idempotency_key',fp) returning id into rid;
  insert into public.audit_events(shop_id,actor_id,action,entity_type,entity_id,reason,metadata)
  values(sid,actor,'correction.request','invoice',iid::text,cmd->>'reason',jsonb_build_object('request_id',rid));
  return jsonb_build_object('ok',true,'request_id',rid,'invoice_id',iid);
end $$;
revoke all on function public.request_invoice_correction(jsonb) from public,anon;
grant execute on function public.request_invoice_correction(jsonb) to authenticated;

create function public.decide_invoice_correction(command jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  sid uuid; rid uuid; actor uuid:=auth.uid(); cmd jsonb; fp text;
  old public.correction_decisions; req public.correction_requests; eff public.effective_invoices;
  did uuid; next_revision integer; total bigint; paid bigint; payment_total bigint;
  today date:=(now() at time zone 'Asia/Qatar')::date;
begin
  sid := private.invoice_operation_actor(command,array['shop_id','request_id','decision','reason','expected_revision','idempotency_key'],true);
  if not private.is_valid_uuid_text(command->>'request_id')
    or command->>'decision' not in ('approved','rejected') or command->>'decision' is null
    or not private.is_safe_bigint_jsonb(command->'expected_revision')
    or (command->>'expected_revision')::numeric not between 0 and 2147483646
    or (command->>'reason' is not null and (jsonb_typeof(command->'reason')<>'string' or length(command->>'reason')>2000))
  then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
  rid := (command->>'request_id')::uuid;
  cmd := command || jsonb_build_object('reason',nullif(btrim(command->>'reason'),''),'actor',actor);
  fp := encode(extensions.digest(cmd::text::bytea,'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended('correction-decision:'||sid::text||':'||(command->>'idempotency_key'),0));
  select * into old from public.correction_decisions where shop_id=sid and idempotency_key=command->>'idempotency_key';
  if found then
    if old.fingerprint<>fp then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='P0001'; end if;
    return jsonb_build_object('ok',true,'decision_id',old.id,'invoice_id',old.invoice_id,'request_id',old.request_id,'decision',old.decision);
  end if;
  select * into req from public.correction_requests where shop_id=sid and id=rid;
  if not found then raise exception 'REQUEST_NOT_FOUND' using errcode='P0001'; end if;
  perform 1 from public.invoices where shop_id=sid and id=req.invoice_id for update;
  if exists(select 1 from public.correction_decisions where request_id=rid) then raise exception 'ALREADY_DECIDED' using errcode='P0001'; end if;
  select * into eff from public.effective_invoices where shop_id=sid and canonical_invoice_id=req.invoice_id;
  if (cmd->>'expected_revision')::integer<>eff.revision then raise exception 'STALE_REVISION' using errcode='P0001'; end if;
  if cmd->>'decision'='approved' then

    if (select event_type from public.daily_closes where shop_id=sid and business_date=today order by event_sequence desc limit 1)='closed' then
      raise exception 'CLOSED_DATE' using errcode='P0001'; end if;
    total:=eff.effective_total_dirham;
    paid:=eff.effective_paid_dirham;
    if req.payment_id is null then total:=total+req.amount_delta_dirham;
    else
      paid:=paid+req.amount_delta_dirham;
      select p.amount_dirham + coalesce((select sum(c.amount_delta_dirham) from public.corrections c where c.payment_id=p.id and c.approved_by is not null),0)
      into payment_total from public.payments p where p.id=req.payment_id and p.shop_id=sid;
      if payment_total+req.amount_delta_dirham<0 then raise exception 'INVALID_FINANCIAL_RESULT' using errcode='P0001'; end if;
    end if;
    if total<0 or paid<0 or paid>total or total>9007199254740991 or paid>9007199254740991 then raise exception 'INVALID_FINANCIAL_RESULT' using errcode='P0001'; end if;
    if eff.effective_delivered and total>paid and eff.effective_customer_id is null then raise exception 'CUSTOMER_REQUIRED' using errcode='P0001'; end if;
    insert into public.corrections(shop_id,invoice_id,payment_id,amount_delta_dirham,reason,business_date,created_by,approved_by,request_id)
    values(sid,case when req.payment_id is null then req.invoice_id else null end,req.payment_id,req.amount_delta_dirham,req.reason,today,req.requested_by,actor,req.id);
  end if;
  insert into public.correction_decisions(shop_id,request_id,invoice_id,decision,expected_revision,revision,reason,decided_by,idempotency_key,fingerprint)
  values(sid,rid,req.invoice_id,cmd->>'decision',eff.revision,next_revision,cmd->>'reason',actor,cmd->>'idempotency_key',fp) returning id into did;
  insert into public.audit_events(shop_id,actor_id,action,entity_type,entity_id,reason,metadata)
  values(sid,actor,'correction.decide','invoice',req.invoice_id::text,cmd->>'reason',jsonb_build_object('request_id',rid,'decision_id',did,'decision',cmd->>'decision'));
  return jsonb_build_object('ok',true,'decision_id',did,'invoice_id',req.invoice_id,'request_id',rid,'decision',cmd->>'decision');
end $$;
revoke all on function public.decide_invoice_correction(jsonb) from public,anon;
grant execute on function public.decide_invoice_correction(jsonb) to authenticated;

create function public.request_invoice_replacement(command jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  sid uuid; iid uuid; actor uuid:=auth.uid(); cmd jsonb; fp text; old public.replacement_requests; rid uuid;
begin
  sid := private.invoice_operation_actor(command,array['shop_id','invoice_id','reason','idempotency_key','expected_revision','invoice_number','customer_id','delivered'],false);
  if not private.is_valid_uuid_text(command->>'invoice_id')
    or jsonb_typeof(command->'reason') is distinct from 'string'
    or length(btrim(command->>'reason')) not between 1 and 2000 then
    raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
  iid := (command->>'invoice_id')::uuid;

  if not private.is_safe_bigint_jsonb(command->'expected_revision')
    or (command->>'expected_revision')::numeric not between 0 and 2147483646
    or jsonb_typeof(command->'invoice_number') is distinct from 'string'
    or length(btrim(command->>'invoice_number')) not between 1 and 120
    or jsonb_typeof(command->'delivered') is distinct from 'boolean'
    or not (command ? 'customer_id')
    or (jsonb_typeof(command->'customer_id') is distinct from 'null' and not private.is_valid_uuid_text(command->>'customer_id'))
  then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
  cmd := command || jsonb_build_object('invoice_number',btrim(command->>'invoice_number'));
  cmd := cmd || jsonb_build_object('reason',btrim(command->>'reason'),'actor',actor);
  fp := encode(extensions.digest(cmd::text::bytea,'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended('replacement-request:'||sid::text||':'||(command->>'idempotency_key'),0));
  select * into old from public.replacement_requests where shop_id=sid and idempotency_key=command->>'idempotency_key';
  if found then
    if old.fingerprint<>fp then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='P0001'; end if;
    return jsonb_build_object('ok',true,'request_id',old.id,'invoice_id',old.invoice_id);
  end if;
  perform 1 from public.invoices where shop_id=sid and id=iid for update;
  if not found then raise exception 'INVOICE_NOT_FOUND' using errcode='P0001'; end if;

  if (cmd->>'expected_revision')::integer <> (select revision from public.effective_invoices where canonical_invoice_id=iid and shop_id=sid) then
    raise exception 'STALE_REVISION' using errcode='P0001'; end if;
  if cmd->>'customer_id' is not null and not exists(select 1 from public.customers where shop_id=sid and id=(cmd->>'customer_id')::uuid) then
    raise exception 'CUSTOMER_NOT_FOUND' using errcode='P0001'; end if;
  insert into public.replacement_requests(shop_id,invoice_id,expected_revision,invoice_number,customer_id,delivered,reason,requested_by,idempotency_key,fingerprint)
  values(sid,iid,(cmd->>'expected_revision')::integer,cmd->>'invoice_number',(cmd->>'customer_id')::uuid,(cmd->>'delivered')::boolean,cmd->>'reason',actor,cmd->>'idempotency_key',fp) returning id into rid;
  insert into public.audit_events(shop_id,actor_id,action,entity_type,entity_id,reason,metadata)
  values(sid,actor,'replacement.request','invoice',iid::text,cmd->>'reason',jsonb_build_object('request_id',rid));
  return jsonb_build_object('ok',true,'request_id',rid,'invoice_id',iid);
end $$;
revoke all on function public.request_invoice_replacement(jsonb) from public,anon;
grant execute on function public.request_invoice_replacement(jsonb) to authenticated;

create function public.decide_invoice_replacement(command jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  sid uuid; rid uuid; actor uuid:=auth.uid(); cmd jsonb; fp text;
  old public.replacement_decisions; req public.replacement_requests; eff public.effective_invoices;
  did uuid; next_revision integer;
begin
  sid := private.invoice_operation_actor(command,array['shop_id','request_id','decision','reason','expected_revision','idempotency_key'],true);
  if not private.is_valid_uuid_text(command->>'request_id')
    or command->>'decision' not in ('approved','rejected') or command->>'decision' is null
    or not private.is_safe_bigint_jsonb(command->'expected_revision')
    or (command->>'expected_revision')::numeric not between 0 and 2147483646
    or (command->>'reason' is not null and (jsonb_typeof(command->'reason')<>'string' or length(command->>'reason')>2000))
  then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
  rid := (command->>'request_id')::uuid;
  cmd := command || jsonb_build_object('reason',nullif(btrim(command->>'reason'),''),'actor',actor);
  fp := encode(extensions.digest(cmd::text::bytea,'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended('replacement-decision:'||sid::text||':'||(command->>'idempotency_key'),0));
  select * into old from public.replacement_decisions where shop_id=sid and idempotency_key=command->>'idempotency_key';
  if found then
    if old.fingerprint<>fp then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='P0001'; end if;
    return jsonb_build_object('ok',true,'decision_id',old.id,'invoice_id',old.invoice_id,'request_id',old.request_id,'decision',old.decision);
  end if;
  select * into req from public.replacement_requests where shop_id=sid and id=rid;
  if not found then raise exception 'REQUEST_NOT_FOUND' using errcode='P0001'; end if;
  perform 1 from public.invoices where shop_id=sid and id=req.invoice_id for update;
  if exists(select 1 from public.replacement_decisions where request_id=rid) then raise exception 'ALREADY_DECIDED' using errcode='P0001'; end if;
  select * into eff from public.effective_invoices where shop_id=sid and canonical_invoice_id=req.invoice_id;
  if (cmd->>'expected_revision')::integer<>eff.revision then raise exception 'STALE_REVISION' using errcode='P0001'; end if;
  if cmd->>'decision'='approved' then

    if req.expected_revision<>eff.revision then raise exception 'STALE_REVISION' using errcode='P0001'; end if;
    if req.delivered and eff.effective_due_dirham>0 and req.customer_id is null then raise exception 'CUSTOMER_REQUIRED' using errcode='P0001'; end if;
    insert into public.invoice_number_registry(shop_id,invoice_number,canonical_invoice_id)
    values(sid,req.invoice_number,req.invoice_id) on conflict(shop_id,normalized_invoice_number) do nothing;
    if not exists(select 1 from public.invoice_number_registry where shop_id=sid and normalized_invoice_number=lower(btrim(req.invoice_number)) and canonical_invoice_id=req.invoice_id) then
      raise exception 'NUMBER_ALREADY_REGISTERED' using errcode='P0001'; end if;
    next_revision := eff.revision+1;
  end if;
  insert into public.replacement_decisions(shop_id,request_id,invoice_id,decision,expected_revision,revision,reason,decided_by,idempotency_key,fingerprint)
  values(sid,rid,req.invoice_id,cmd->>'decision',eff.revision,next_revision,cmd->>'reason',actor,cmd->>'idempotency_key',fp) returning id into did;
  insert into public.audit_events(shop_id,actor_id,action,entity_type,entity_id,reason,metadata)
  values(sid,actor,'replacement.decide','invoice',req.invoice_id::text,cmd->>'reason',jsonb_build_object('request_id',rid,'decision_id',did,'decision',cmd->>'decision'));
  return jsonb_build_object('ok',true,'decision_id',did,'invoice_id',req.invoice_id,'request_id',rid,'decision',cmd->>'decision');
end $$;
revoke all on function public.decide_invoice_replacement(jsonb) from public,anon;
grant execute on function public.decide_invoice_replacement(jsonb) to authenticated;
