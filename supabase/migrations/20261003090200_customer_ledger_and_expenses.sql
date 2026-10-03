-- BIG SLICE 2: shop-scoped customer ledger, atomic allocation, expenses and private receipts.

alter table public.expenses
  add column category text not null default 'other'
    check (category in ('rent','utilities','supplies','transport','maintenance','other')),
  add column backdated_reason text,
  add column idempotency_key text,
  add column fingerprint text,
  add column idempotency_result jsonb;
alter table public.expenses add constraint expenses_idempotency_all_or_none check (
  (idempotency_key is null and fingerprint is null and idempotency_result is null)
  or (idempotency_key is not null and fingerprint is not null and idempotency_result is not null)
) not valid;
alter table public.expenses add constraint expenses_shop_idempotency_uq unique(shop_id,idempotency_key);
alter table public.expenses add constraint expenses_shop_id_id_uq unique(shop_id,id);
alter table public.customer_credits add constraint customer_credits_shop_id_id_uq unique(shop_id,id);

alter table public.attachments
  add column expense_id uuid,
  add column idempotency_key text,
  add column fingerprint text,
  add constraint attachments_shop_expense_fk foreign key(shop_id,expense_id)
    references public.expenses(shop_id,id) on delete restrict,
  add constraint attachments_shop_path_uq unique(shop_id,file_path),
  add constraint attachments_shop_idempotency_uq unique(shop_id,idempotency_key);
create trigger attachments_append_only before update or delete on public.attachments for each row execute function public.reject_append_only_mutation();
revoke insert,update,delete on public.attachments from public,anon,authenticated;
alter table public.payments add column customer_payment_batch_id uuid;

create table public.customer_payment_batches (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  customer_id uuid not null,
  amount_dirham bigint not null check(amount_dirham > 0),
  business_date date not null,
  idempotency_key text not null check(length(btrim(idempotency_key)) between 1 and 200),
  fingerprint text not null,
  idempotency_result jsonb not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  unique(shop_id,idempotency_key),
  unique(shop_id,id),
  unique(shop_id,id,customer_id),
  foreign key(shop_id,customer_id) references public.customers(shop_id,id) on delete restrict
);
alter table public.payments add constraint payments_shop_customer_batch_fk
  foreign key(shop_id,customer_payment_batch_id) references public.customer_payment_batches(shop_id,id) on delete restrict deferrable initially deferred;
create index customer_payment_batches_customer_date_idx on public.customer_payment_batches(shop_id,customer_id,business_date,recorded_at);

create table public.credit_application_batches (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  customer_id uuid not null,
  amount_dirham bigint not null check(amount_dirham > 0),
  business_date date not null,
  idempotency_key text not null check(length(btrim(idempotency_key)) between 1 and 200),
  fingerprint text not null,
  idempotency_result jsonb not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  unique(shop_id,idempotency_key),
  unique(shop_id,id,customer_id),
  foreign key(shop_id,customer_id) references public.customers(shop_id,id) on delete restrict
);
create table public.credit_applications (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  customer_id uuid not null,
  batch_id uuid not null,
  credit_id uuid not null,
  invoice_id uuid not null,
  amount_dirham bigint not null check(amount_dirham > 0),
  business_date date not null,
  recorded_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id) on delete restrict,
  foreign key(shop_id,batch_id,customer_id) references public.credit_application_batches(shop_id,id,customer_id) on delete restrict deferrable initially deferred,
  foreign key(shop_id,customer_id) references public.customers(shop_id,id) on delete restrict,
  foreign key(shop_id,credit_id) references public.customer_credits(shop_id,id) on delete restrict,
  foreign key(shop_id,invoice_id) references public.invoices(shop_id,id) on delete restrict
);
create index credit_applications_customer_idx on public.credit_applications(shop_id,customer_id,recorded_at);
create index credit_applications_invoice_idx on public.credit_applications(shop_id,invoice_id);
create index invoices_shop_customer_business_date_idx on public.invoices(shop_id,customer_id,business_date,id) where customer_id is not null;
create index customer_payments_invoice_ledger_idx on public.payments(shop_id,invoice_id,business_date,recorded_at,id);
create index customer_corrections_invoice_ledger_idx on public.corrections(shop_id,invoice_id,business_date,recorded_at,id) where approved_by is not null;
create index customer_corrections_payment_ledger_idx on public.corrections(shop_id,payment_id,business_date,recorded_at,id) where approved_by is not null;
create index customer_credits_available_fifo_idx on public.customer_credits(shop_id,customer_id,business_date,recorded_at,id) where approved_by is not null;
create index expenses_shop_business_date_idx on public.expenses(shop_id,business_date desc,recorded_at desc);

-- Make approved credit applications part of the shared invoice due projection.
-- Cash paid remains a separate amount; credit is exposed as its own column.
create or replace view public.invoice_effective_balances with(security_invoker=true) as
select i.id canonical_invoice_id,i.shop_id,
 (i.total_amount_dirham+coalesce((select sum(c.amount_delta_dirham) from public.corrections c where c.shop_id=i.shop_id and c.invoice_id=i.id and c.approved_by is not null),0))::bigint effective_total_dirham,
 (coalesce((select sum(p.amount_dirham) from public.payments p where p.shop_id=i.shop_id and p.invoice_id=i.id),0)+coalesce((select sum(c.amount_delta_dirham) from public.corrections c where c.shop_id=i.shop_id and c.payment_id in(select p.id from public.payments p where p.shop_id=i.shop_id and p.invoice_id=i.id) and c.approved_by is not null),0))::bigint effective_paid_dirham,
 (i.total_amount_dirham+coalesce((select sum(c.amount_delta_dirham) from public.corrections c where c.shop_id=i.shop_id and c.invoice_id=i.id and c.approved_by is not null),0)-coalesce((select sum(p.amount_dirham) from public.payments p where p.shop_id=i.shop_id and p.invoice_id=i.id),0)-coalesce((select sum(c.amount_delta_dirham) from public.corrections c where c.shop_id=i.shop_id and c.payment_id in(select p.id from public.payments p where p.shop_id=i.shop_id and p.invoice_id=i.id) and c.approved_by is not null),0)-coalesce((select sum(a.amount_dirham) from public.credit_applications a where a.shop_id=i.shop_id and a.invoice_id=i.id),0))::bigint effective_due_dirham
from public.invoices i;
revoke all on public.invoice_effective_balances from public,anon;
grant select on public.invoice_effective_balances to authenticated;

create or replace view public.effective_invoices with(security_invoker=true) as
select i.id as canonical_invoice_id, i.shop_id, i.invoice_id as original_invoice_number,
 coalesce(r.invoice_number,i.invoice_id) as effective_invoice_number,
 case when d.id is null then i.customer_id else r.customer_id end as effective_customer_id,
 case when d.id is null then i.delivered else r.delivered end as effective_delivered,
 coalesce(d.revision,0) as revision,i.total_amount_dirham as original_total_dirham,i.business_date,i.recorded_at,i.created_by,
 b.effective_total_dirham,b.effective_paid_dirham,b.effective_due_dirham,coalesce(ca.amount_dirham,0)::bigint effective_credit_applied_dirham
from public.invoices i join public.invoice_effective_balances b on b.canonical_invoice_id=i.id and b.shop_id=i.shop_id
left join lateral(select rd.* from public.replacement_decisions rd where rd.invoice_id=i.id and rd.shop_id=i.shop_id and rd.decision='approved' order by rd.revision desc limit 1)d on true
left join public.replacement_requests r on r.id=d.request_id and r.shop_id=i.shop_id
left join lateral(select sum(a.amount_dirham) amount_dirham from public.credit_applications a where a.shop_id=i.shop_id and a.invoice_id=i.id)ca on true;
revoke all on public.effective_invoices from public,anon;
grant select on public.effective_invoices to authenticated;

create table public.expense_correction_requests (
  id uuid primary key default gen_random_uuid(), shop_id uuid not null,
  expense_id uuid not null, amount_dirham bigint not null check(amount_dirham > 0),
  expected_correction_request_id uuid,
  category text not null check(category in ('rent','utilities','supplies','transport','maintenance','other')),
  description text not null check(length(btrim(description)) between 1 and 1000),
  reason text not null check(length(btrim(reason)) between 1 and 2000),
  requested_by uuid not null references public.profiles(id) on delete restrict,
  requested_at timestamptz not null default now(), idempotency_key text not null,
  fingerprint text not null, unique(shop_id,idempotency_key), unique(shop_id,id),
  foreign key(shop_id,expense_id) references public.expenses(shop_id,id) on delete restrict,
  foreign key(shop_id,expected_correction_request_id) references public.expense_correction_requests(shop_id,id) on delete restrict
);
create table public.expense_correction_decisions (
  id uuid primary key default gen_random_uuid(), shop_id uuid not null,
  request_id uuid not null unique, expense_id uuid not null,
  decision text not null check(decision in ('approved','rejected')),
  reason text, decided_by uuid not null references public.profiles(id) on delete restrict,
  decided_at timestamptz not null default now(), idempotency_key text not null,
  fingerprint text not null, unique(shop_id,idempotency_key),
  foreign key(shop_id,request_id) references public.expense_correction_requests(shop_id,id) on delete restrict,
  foreign key(shop_id,expense_id) references public.expenses(shop_id,id) on delete restrict
);
create index expense_correction_requests_expense_idx on public.expense_correction_requests(shop_id,expense_id,requested_at);

do $$ declare t text; begin
  foreach t in array array['customer_payment_batches','credit_application_batches','credit_applications','expense_correction_requests','expense_correction_decisions'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy %I on public.%I for select to authenticated using(private.has_shop_access(shop_id))',t||'_shop_read',t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.reject_append_only_mutation()',t||'_append_only',t);
  end loop;
end $$;
revoke insert,update,delete on public.expenses,public.attachments,public.payments from anon,authenticated;
revoke all on public.customer_payment_batches,public.credit_application_batches,public.credit_applications,public.expense_correction_requests,public.expense_correction_decisions from anon,authenticated;
grant select on public.customer_payment_batches,public.credit_application_batches,public.credit_applications,public.expense_correction_requests,public.expense_correction_decisions to authenticated;

create view public.customer_financial_balances with(security_invoker=true) as
select c.shop_id,c.id customer_id,
  coalesce(sum(e.effective_due_dirham),0)::bigint outstanding_due_dirham,
  coalesce((select sum(cc.amount_dirham) from public.customer_credits cc where cc.shop_id=c.shop_id and cc.customer_id=c.id and cc.approved_by is not null),0)::bigint
   -coalesce((select sum(ca.amount_dirham) from public.credit_applications ca where ca.shop_id=c.shop_id and ca.customer_id=c.id),0)::bigint available_credit_dirham,
  count(e.canonical_invoice_id)::bigint invoice_count,
  max(greatest(e.business_date,e.recorded_at::date)) last_activity_date
from public.customers c left join public.effective_invoices e
  on e.shop_id=c.shop_id and e.effective_customer_id=c.id
group by c.shop_id,c.id;
revoke all on public.customer_financial_balances from public,anon;
grant select on public.customer_financial_balances to authenticated;

create view public.customer_ledger with(security_invoker=true) as
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
 case when c.invoice_id is not null then 'invoice_correction' else 'payment_correction' end,
 e.effective_invoice_number,e.effective_invoice_number,c.created_by,e.canonical_invoice_id,
 case when c.invoice_id is not null then greatest(c.amount_delta_dirham,0) else greatest(-c.amount_delta_dirham,0) end,
 case when c.invoice_id is not null then greatest(-c.amount_delta_dirham,0) else greatest(c.amount_delta_dirham,0) end
from public.corrections c join public.effective_invoices e on e.shop_id=c.shop_id and e.canonical_invoice_id=coalesce(c.invoice_id,(select p.invoice_id from public.payments p where p.shop_id=c.shop_id and p.id=c.payment_id))
where c.approved_by is not null and e.effective_customer_id is not null
union all
select ca.shop_id,e.effective_customer_id,ca.business_date,ca.recorded_at,ca.id,'credit_application',e.effective_invoice_number,e.effective_invoice_number,ca.created_by,e.canonical_invoice_id,0::bigint,ca.amount_dirham
from public.credit_applications ca join public.effective_invoices e on e.shop_id=ca.shop_id and e.canonical_invoice_id=ca.invoice_id;
revoke all on public.customer_ledger from public,anon;
grant select on public.customer_ledger to authenticated;

create or replace view public.customer_financial_balances with(security_invoker=true) as
select c.shop_id,c.id customer_id,
  coalesce(sum(e.effective_due_dirham),0)::bigint outstanding_due_dirham,
  coalesce((select sum(cc.amount_dirham) from public.customer_credits cc where cc.shop_id=c.shop_id and cc.customer_id=c.id and cc.approved_by is not null),0)::bigint
   -coalesce((select sum(ca.amount_dirham) from public.credit_applications ca where ca.shop_id=c.shop_id and ca.customer_id=c.id),0)::bigint available_credit_dirham,
  count(e.canonical_invoice_id)::bigint invoice_count,
  (select max(greatest(l.business_date,l.recorded_at::date)) from public.customer_ledger l where l.shop_id=c.shop_id and l.customer_id=c.id) last_activity_date
from public.customers c left join public.effective_invoices e
  on e.shop_id=c.shop_id and e.effective_customer_id=c.id
group by c.shop_id,c.id;
revoke all on public.customer_financial_balances from public,anon;
grant select on public.customer_financial_balances to authenticated;

create view public.effective_expenses with(security_invoker=true) as
select x.id,x.shop_id,x.business_date,x.recorded_at,x.created_by,
 coalesce(r.description,x.description) description,coalesce(r.amount_dirham,x.amount_dirham) amount_dirham,
 coalesce(r.category,x.category) category,r.id correction_request_id,x.backdated_reason
from public.expenses x left join lateral (
 select q.* from public.expense_correction_requests q join public.expense_correction_decisions d on d.shop_id=q.shop_id and d.request_id=q.id and d.decision='approved'
 where q.shop_id=x.shop_id and q.expense_id=x.id order by d.decided_at desc,d.id desc limit 1
) r on true;
revoke all on public.effective_expenses from public,anon;
grant select on public.effective_expenses to authenticated;

create or replace function public.create_customer(command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare sid uuid; cid uuid:=gen_random_uuid(); nm text; mob text; result jsonb;
begin
 if auth.uid() is null or not private.is_active_actor() then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if jsonb_typeof(command) is distinct from 'object' or not private.jsonb_object_keys_subset(command,array['shop_id','name','mobile']) or not private.is_valid_uuid_text(command->>'shop_id') then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 if command ? 'name' and jsonb_typeof(command->'name') not in ('string','null') or command ? 'mobile' and jsonb_typeof(command->'mobile') not in ('string','null') then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 sid:=(command->>'shop_id')::uuid; if not private.has_shop_access(sid) then raise exception 'UNAUTHORIZED_SHOP' using errcode='42501'; end if;
 nm:=private.normalize_optional_text(command->>'name'); mob:=private.normalize_optional_text(command->>'mobile');
 if nm is null and mob is null then raise exception 'CUSTOMER_IDENTITY_REQUIRED' using errcode='P0001'; end if;
 if length(nm)>160 or length(mob)>40 then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 perform pg_advisory_xact_lock(hashtextextended(sid::text||':customer:'||coalesce(lower(mob),lower(nm)),0));
 if exists(select 1 from public.customers c where c.shop_id=sid and ((mob is not null and c.mobile=mob) or (nm is not null and lower(btrim(c.name))=lower(nm) and coalesce(c.mobile,'')=coalesce(mob,'')))) then raise exception 'DUPLICATE_CUSTOMER' using errcode='P0001'; end if;
 insert into public.customers(id,shop_id,name,mobile,created_by) values(cid,sid,nm,mob,auth.uid());
 insert into public.audit_events(shop_id,actor_id,action,entity_type,entity_id,metadata) values(sid,auth.uid(),'create_customer','customer',cid::text,jsonb_build_object('public_id',(select public_id from public.customers where id=cid)));
 select jsonb_build_object('ok',true,'customer_id',id,'public_id',public_id) into result from public.customers where id=cid; return result;
end $$;
revoke all on function public.create_customer(jsonb) from public,anon; grant execute on function public.create_customer(jsonb) to authenticated;

create or replace function public.record_customer_payment(command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare sid uuid; cid uuid; amt bigint; dt date; ik text; fp text; existing record; batch uuid:=gen_random_uuid(); today date:=(now() at time zone 'Asia/Qatar')::date; rem bigint; due bigint; take bigint; inv record; result jsonb; allocations jsonb:='[]'::jsonb;
begin
 if auth.uid() is null or not private.is_active_actor() then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if jsonb_typeof(command) is distinct from 'object' or not private.jsonb_object_keys_subset(command,array['shop_id','customer_id','amount_dirham','business_date','idempotency_key']) or not private.is_valid_uuid_text(command->>'shop_id') or not private.is_valid_uuid_text(command->>'customer_id') or not private.is_safe_bigint_jsonb(command->'amount_dirham') or jsonb_typeof(command->'idempotency_key') is distinct from 'string' then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 sid:=(command->>'shop_id')::uuid; cid:=(command->>'customer_id')::uuid; amt:=(command->>'amount_dirham')::bigint; ik:=btrim(command->>'idempotency_key');
 if amt<=0 or length(ik) not between 1 and 200 or not private.is_valid_date_text(command->>'business_date') then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if; dt:=(command->>'business_date')::date;
 if not private.has_shop_access(sid) then raise exception 'UNAUTHORIZED_SHOP' using errcode='42501'; end if;
 if not exists(select 1 from public.customers where id=cid and shop_id=sid) then raise exception 'CUSTOMER_NOT_FOUND' using errcode='P0001'; end if;
 fp:=encode(extensions.digest(jsonb_build_object('shop_id',sid,'customer_id',cid,'amount_dirham',amt,'business_date',dt)::text::bytea,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(sid::text||':'||ik,0));
 select idempotency_result,fingerprint into existing from public.customer_payment_batches where shop_id=sid and idempotency_key=ik;
 if found then if existing.fingerprint=fp then return existing.idempotency_result; else raise exception 'IDEMPOTENCY_CONFLICT' using errcode='P0001'; end if; end if;
 if dt<>today then raise exception 'INVALID_DATE' using errcode='P0001'; end if;
 if exists(select 1 from public.daily_closes d where d.shop_id=sid and d.business_date=dt and d.event_type='closed' and not exists(select 1 from public.daily_closes r where r.shop_id=sid and r.business_date=dt and r.event_type='reopened' and r.event_sequence>d.event_sequence)) then raise exception 'CLOSED_DATE' using errcode='P0001'; end if;
 -- Lock the complete eligible invoice set in a stable order before recomputing due.
 perform i.id from public.invoices i join public.effective_invoices e on e.shop_id=i.shop_id and e.canonical_invoice_id=i.id
 where e.shop_id=sid and e.effective_customer_id=cid and e.effective_due_dirham>0 order by i.business_date,i.id for update of i;
 rem:=amt;
 for inv in select e.canonical_invoice_id,e.effective_invoice_number,e.business_date,e.effective_due_dirham from public.effective_invoices e where e.shop_id=sid and e.effective_customer_id=cid and e.effective_due_dirham>0 order by e.business_date,e.canonical_invoice_id loop
  exit when rem=0; due:=inv.effective_due_dirham; take:=least(rem,due); rem:=rem-take;
  insert into public.payments(shop_id,invoice_id,amount_dirham,business_date,payment_method,created_by,customer_payment_batch_id) values(sid,inv.canonical_invoice_id,take,dt,'cash',auth.uid(),batch);
  allocations:=allocations||jsonb_build_array(jsonb_build_object('invoice_id',inv.canonical_invoice_id,'invoice_number',inv.effective_invoice_number,'amount_dirham',take));
 end loop;
 if rem>0 then raise exception 'AMOUNT_EXCEEDS_DUE' using errcode='P0001'; end if;
 result:=jsonb_build_object('ok',true,'batch_id',batch,'customer_id',cid,'allocations',allocations);
 insert into public.customer_payment_batches(id,shop_id,customer_id,amount_dirham,business_date,idempotency_key,fingerprint,idempotency_result,created_by) values(batch,sid,cid,amt,dt,ik,fp,result,auth.uid());
 insert into public.audit_events(shop_id,actor_id,action,entity_type,entity_id,metadata) values(sid,auth.uid(),'record_customer_payment','customer_payment_batch',batch::text,jsonb_build_object('customer_id',cid,'amount_dirham',amt,'allocations',allocations));
 return result;
end $$;
revoke all on function public.record_customer_payment(jsonb) from public,anon; grant execute on function public.record_customer_payment(jsonb) to authenticated;

create or replace function public.apply_customer_credit(command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare sid uuid; cid uuid; amt bigint; dt date; ik text; fp text; existing record; batch uuid:=gen_random_uuid(); rem bigint; take bigint; due bigint; cr record; inv record; result jsonb; allocations jsonb:='[]'::jsonb;
begin
 if auth.uid() is null or not private.is_active_actor() then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if jsonb_typeof(command) is distinct from 'object' or not private.jsonb_object_keys_subset(command,array['shop_id','customer_id','amount_dirham','business_date','idempotency_key']) or not private.is_valid_uuid_text(command->>'shop_id') or not private.is_valid_uuid_text(command->>'customer_id') or not private.is_safe_bigint_jsonb(command->'amount_dirham') or jsonb_typeof(command->'idempotency_key') is distinct from 'string' or not private.is_valid_date_text(command->>'business_date') then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 sid:=(command->>'shop_id')::uuid; cid:=(command->>'customer_id')::uuid; amt:=(command->>'amount_dirham')::bigint; dt:=(command->>'business_date')::date; ik:=btrim(command->>'idempotency_key');
 if amt<=0 or length(ik) not between 1 and 200 then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 if not private.has_shop_access(sid) then raise exception 'UNAUTHORIZED_SHOP' using errcode='42501'; end if;
 fp:=encode(extensions.digest(jsonb_build_object('shop_id',sid,'customer_id',cid,'amount_dirham',amt,'business_date',dt)::text::bytea,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(sid::text||':'||ik,0));
 select idempotency_result,fingerprint into existing from public.credit_application_batches where shop_id=sid and idempotency_key=ik;
 if found then if existing.fingerprint=fp then return existing.idempotency_result; else raise exception 'IDEMPOTENCY_CONFLICT' using errcode='P0001'; end if; end if;
 if dt<>(now() at time zone 'Asia/Qatar')::date then raise exception 'INVALID_DATE' using errcode='P0001'; end if;
 if exists(select 1 from public.daily_closes d where d.shop_id=sid and d.business_date=dt and d.event_type='closed' and not exists(select 1 from public.daily_closes r where r.shop_id=sid and r.business_date=dt and r.event_type='reopened' and r.event_sequence>d.event_sequence)) then raise exception 'CLOSED_DATE' using errcode='P0001'; end if;
 if not exists(select 1 from public.customers where id=cid and shop_id=sid) then raise exception 'CUSTOMER_NOT_FOUND' using errcode='P0001'; end if;
 perform cc.id from public.customer_credits cc where cc.shop_id=sid and cc.customer_id=cid and cc.approved_by is not null order by cc.business_date,cc.recorded_at,cc.id for update;
 perform i.id from public.invoices i join public.effective_invoices e on e.shop_id=i.shop_id and e.canonical_invoice_id=i.id where e.shop_id=sid and e.effective_customer_id=cid and e.effective_due_dirham>0 order by i.business_date,i.id for update of i;
 rem:=amt;
 for inv in select e.canonical_invoice_id,e.effective_invoice_number,e.effective_due_dirham,e.business_date from public.effective_invoices e where e.shop_id=sid and e.effective_customer_id=cid and e.effective_due_dirham>0 order by e.business_date,e.canonical_invoice_id loop
  exit when rem=0; due:=inv.effective_due_dirham;
  for cr in select cc.id,cc.amount_dirham-coalesce((select sum(a.amount_dirham) from public.credit_applications a where a.shop_id=cc.shop_id and a.credit_id=cc.id),0) available from public.customer_credits cc where cc.shop_id=sid and cc.customer_id=cid and cc.approved_by is not null order by cc.business_date,cc.recorded_at,cc.id loop
   exit when due=0 or rem=0; take:=least(rem,due,cr.available); if take>0 then
    insert into public.credit_applications(shop_id,customer_id,batch_id,credit_id,invoice_id,amount_dirham,business_date,created_by) values(sid,cid,batch,cr.id,inv.canonical_invoice_id,take,dt,auth.uid());
    allocations:=allocations||jsonb_build_array(jsonb_build_object('invoice_id',inv.canonical_invoice_id,'invoice_number',inv.effective_invoice_number,'credit_id',cr.id,'amount_dirham',take)); rem:=rem-take; due:=due-take;
   end if;
  end loop;
 end loop;
 if rem>0 then raise exception 'CREDIT_OR_DUE_INSUFFICIENT' using errcode='P0001'; end if;
 result:=jsonb_build_object('ok',true,'batch_id',batch,'customer_id',cid,'allocations',allocations);
 insert into public.credit_application_batches(id,shop_id,customer_id,amount_dirham,business_date,idempotency_key,fingerprint,idempotency_result,created_by) values(batch,sid,cid,amt,dt,ik,fp,result,auth.uid());
 insert into public.audit_events(shop_id,actor_id,action,entity_type,entity_id,metadata) values(sid,auth.uid(),'apply_customer_credit','credit_application_batch',batch::text,jsonb_build_object('customer_id',cid,'amount_dirham',amt,'allocations',allocations)); return result;
end $$;
revoke all on function public.apply_customer_credit(jsonb) from public,anon; grant execute on function public.apply_customer_credit(jsonb) to authenticated;

create or replace function public.create_expense(command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare sid uuid; eid uuid:=gen_random_uuid(); amt bigint; dt date; ik text; fp text; cat text; descr text; back_reason text; existing record; res jsonb; today date:=(now() at time zone 'Asia/Qatar')::date;
begin
 if auth.uid() is null or not private.is_active_actor() then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if jsonb_typeof(command) is distinct from 'object' or not private.jsonb_object_keys_subset(command,array['shop_id','amount_dirham','business_date','category','description','backdated_reason','idempotency_key']) or not private.is_valid_uuid_text(command->>'shop_id') or not private.is_safe_bigint_jsonb(command->'amount_dirham') or not private.is_valid_date_text(command->>'business_date') then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 if command ? 'backdated_reason' and jsonb_typeof(command->'backdated_reason') not in ('string','null') then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 if jsonb_typeof(command->'category') is distinct from 'string' or jsonb_typeof(command->'description') is distinct from 'string' or jsonb_typeof(command->'idempotency_key') is distinct from 'string' then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 sid:=(command->>'shop_id')::uuid; amt:=(command->'amount_dirham')::bigint; dt:=(command->>'business_date')::date; cat:=command->>'category'; descr:=btrim(command->>'description'); back_reason:=private.normalize_optional_text(command->>'backdated_reason'); ik:=btrim(command->>'idempotency_key');
 if amt<=0 or length(descr) not between 1 and 1000 or cat not in ('rent','utilities','supplies','transport','maintenance','other') or length(ik) not between 1 and 200 or length(back_reason)>2000 then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 if not private.has_shop_access(sid) then raise exception 'UNAUTHORIZED_SHOP' using errcode='42501'; end if;
 fp:=encode(extensions.digest(jsonb_build_object('shop_id',sid,'amount_dirham',amt,'business_date',dt,'category',cat,'description',descr,'backdated_reason',back_reason)::text::bytea,'sha256'),'hex'); perform pg_advisory_xact_lock(hashtextextended(sid::text||':'||ik,0));
 select idempotency_result,fingerprint into existing from public.expenses where shop_id=sid and idempotency_key=ik; if found then if existing.fingerprint=fp then return existing.idempotency_result; else raise exception 'IDEMPOTENCY_CONFLICT' using errcode='P0001'; end if; end if;
 if dt>today then raise exception 'INVALID_DATE' using errcode='P0001'; end if;
 if dt<today and (not exists(select 1 from public.profiles where id=auth.uid() and role='owner') or back_reason is null) then raise exception 'INSUFFICIENT_ROLE' using errcode='42501'; end if;
 if dt=today and back_reason is not null then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 if exists(select 1 from public.daily_closes d where d.shop_id=sid and d.business_date=dt and d.event_type='closed' and not exists(select 1 from public.daily_closes r where r.shop_id=sid and r.business_date=dt and r.event_type='reopened' and r.event_sequence>d.event_sequence)) then raise exception 'CLOSED_DATE' using errcode='P0001'; end if;
 res:=jsonb_build_object('ok',true,'expense_id',eid);
 insert into public.expenses(id,shop_id,description,amount_dirham,business_date,category,backdated_reason,idempotency_key,fingerprint,idempotency_result,created_by) values(eid,sid,descr,amt,dt,cat,back_reason,ik,fp,res,auth.uid());
 insert into public.audit_events(shop_id,actor_id,action,entity_type,entity_id,reason,metadata) values(sid,auth.uid(),'create_expense','expense',eid::text,back_reason,jsonb_build_object('amount_dirham',amt,'category',cat,'business_date',dt)); return res;
end $$;
revoke all on function public.create_expense(jsonb) from public,anon; grant execute on function public.create_expense(jsonb) to authenticated;

create or replace function public.request_expense_correction(command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare sid uuid; eid uuid; amt bigint; cat text; descr text; reason text; ik text; fp text; rid uuid:=gen_random_uuid(); expected uuid; old record;
begin
 if auth.uid() is null or not private.is_active_actor() then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if jsonb_typeof(command) is distinct from 'object' or not private.jsonb_object_keys_subset(command,array['shop_id','expense_id','amount_dirham','category','description','reason','idempotency_key']) or not private.is_valid_uuid_text(command->>'shop_id') or not private.is_valid_uuid_text(command->>'expense_id') or not private.is_safe_bigint_jsonb(command->'amount_dirham') then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 if jsonb_typeof(command->'category') is distinct from 'string' or jsonb_typeof(command->'description') is distinct from 'string' or jsonb_typeof(command->'reason') is distinct from 'string' or jsonb_typeof(command->'idempotency_key') is distinct from 'string' then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 sid:=(command->>'shop_id')::uuid; eid:=(command->>'expense_id')::uuid; amt:=(command->>'amount_dirham')::bigint; cat:=command->>'category'; descr:=btrim(command->>'description'); reason:=btrim(command->>'reason'); ik:=btrim(command->>'idempotency_key');
 if amt<=0 or cat not in ('rent','utilities','supplies','transport','maintenance','other') or length(descr) not between 1 and 1000 or length(reason) not between 1 and 2000 or length(ik) not between 1 and 200 then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 if not private.has_shop_access(sid) then raise exception 'UNAUTHORIZED_SHOP' using errcode='42501'; end if; if not exists(select 1 from public.expenses where id=eid and shop_id=sid) then raise exception 'EXPENSE_NOT_FOUND' using errcode='P0001'; end if;
 fp:=encode(extensions.digest(jsonb_build_object('shop_id',sid,'expense_id',eid,'amount_dirham',amt,'category',cat,'description',descr,'reason',reason)::text::bytea,'sha256'),'hex'); perform pg_advisory_xact_lock(hashtextextended(sid::text||':'||ik,0));
 select id,fingerprint into old from public.expense_correction_requests where shop_id=sid and idempotency_key=ik; if found then if old.fingerprint=fp then return jsonb_build_object('ok',true,'request_id',old.id); else raise exception 'IDEMPOTENCY_CONFLICT' using errcode='P0001'; end if; end if;
 select correction_request_id into expected from public.effective_expenses where shop_id=sid and id=eid;
 insert into public.expense_correction_requests(id,shop_id,expense_id,amount_dirham,expected_correction_request_id,category,description,reason,requested_by,idempotency_key,fingerprint) values(rid,sid,eid,amt,expected,cat,descr,reason,auth.uid(),ik,fp);
 insert into public.audit_events(shop_id,actor_id,action,entity_type,entity_id,reason,metadata) values(sid,auth.uid(),'request_expense_correction','expense',eid::text,reason,jsonb_build_object('request_id',rid)); return jsonb_build_object('ok',true,'request_id',rid);
end $$;
revoke all on function public.request_expense_correction(jsonb) from public,anon; grant execute on function public.request_expense_correction(jsonb) to authenticated;

create or replace function public.decide_expense_correction(command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare sid uuid; rid uuid; dec text; reason text; ik text; fp text; actor_role text; req record; prior record; current_correction uuid; did uuid:=gen_random_uuid();
begin
 if auth.uid() is null or not private.is_active_actor() then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if jsonb_typeof(command) is distinct from 'object' or not private.jsonb_object_keys_subset(command,array['shop_id','request_id','decision','reason','idempotency_key']) or not private.is_valid_uuid_text(command->>'shop_id') or not private.is_valid_uuid_text(command->>'request_id') then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 if jsonb_typeof(command->'decision') is distinct from 'string' or jsonb_typeof(command->'idempotency_key') is distinct from 'string' or command ? 'reason' and jsonb_typeof(command->'reason') not in ('string','null') then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 sid:=(command->>'shop_id')::uuid; rid:=(command->>'request_id')::uuid; dec:=command->>'decision'; reason:=private.normalize_optional_text(command->>'reason'); ik:=btrim(command->>'idempotency_key');
 if dec not in ('approved','rejected') or length(ik) not between 1 and 200 then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 if not private.has_shop_access(sid) then raise exception 'UNAUTHORIZED_SHOP' using errcode='42501'; end if;
 select role into actor_role from public.profiles where id=auth.uid(); if actor_role not in ('owner','manager') then raise exception 'INSUFFICIENT_ROLE' using errcode='42501'; end if;
 fp:=encode(extensions.digest(jsonb_build_object('shop_id',sid,'request_id',rid,'decision',dec,'reason',reason)::text::bytea,'sha256'),'hex'); perform pg_advisory_xact_lock(hashtextextended(sid::text||':'||ik,0));
 select id,fingerprint into prior from public.expense_correction_decisions where shop_id=sid and idempotency_key=ik; if found then if prior.fingerprint=fp then return jsonb_build_object('ok',true,'decision_id',prior.id); else raise exception 'IDEMPOTENCY_CONFLICT' using errcode='P0001'; end if; end if;
 select * into req from public.expense_correction_requests where shop_id=sid and id=rid for update; if not found then raise exception 'REQUEST_NOT_FOUND' using errcode='P0001'; end if;
 if exists(select 1 from public.expense_correction_decisions where request_id=rid) then raise exception 'ALREADY_DECIDED' using errcode='P0001'; end if;
 perform 1 from public.expenses where shop_id=sid and id=req.expense_id for update;
 select correction_request_id into current_correction from public.effective_expenses where shop_id=sid and id=req.expense_id;
 if current_correction is distinct from req.expected_correction_request_id then raise exception 'STALE_CORRECTION' using errcode='P0001'; end if;
 insert into public.expense_correction_decisions(id,shop_id,request_id,expense_id,decision,reason,decided_by,idempotency_key,fingerprint) values(did,sid,rid,req.expense_id,dec,reason,auth.uid(),ik,fp);
 insert into public.audit_events(shop_id,actor_id,action,entity_type,entity_id,reason,metadata) values(sid,auth.uid(),'decide_expense_correction','expense',req.expense_id::text,reason,jsonb_build_object('request_id',rid,'decision',dec,'amount_dirham',req.amount_dirham)); return jsonb_build_object('ok',true,'decision_id',did);
end $$;
revoke all on function public.decide_expense_correction(jsonb) from public,anon; grant execute on function public.decide_expense_correction(jsonb) to authenticated;

create or replace function public.register_expense_attachment(command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare sid uuid; eid uuid; aid uuid:=gen_random_uuid(); pth text; size bigint; mime text; ik text; fp text; prior record;
begin
 if auth.uid() is null or not private.is_active_actor() then raise exception 'AUTHENTICATION_REQUIRED' using errcode='28000'; end if;
 if jsonb_typeof(command) is distinct from 'object' or not private.jsonb_object_keys_subset(command,array['shop_id','expense_id','file_path','file_name','content_type','byte_size','idempotency_key']) or not private.is_valid_uuid_text(command->>'shop_id') or not private.is_valid_uuid_text(command->>'expense_id') or not private.is_safe_bigint_jsonb(command->'byte_size') then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 if jsonb_typeof(command->'file_path') is distinct from 'string' or jsonb_typeof(command->'file_name') is distinct from 'string' or jsonb_typeof(command->'content_type') is distinct from 'string' or jsonb_typeof(command->'idempotency_key') is distinct from 'string' then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
 sid:=(command->>'shop_id')::uuid; eid:=(command->>'expense_id')::uuid; pth:=command->>'file_path'; size:=(command->>'byte_size')::bigint; mime:=command->>'content_type'; ik:=btrim(command->>'idempotency_key');
 if not private.has_shop_access(sid) then raise exception 'UNAUTHORIZED_SHOP' using errcode='42501'; end if;
 if length(btrim(command->>'file_name'))=0 or length(command->>'file_name')>255 or not exists(select 1 from public.expenses where id=eid and shop_id=sid)
  or split_part(pth,'/',1)<>sid::text or split_part(pth,'/',2)<>eid::text
  or coalesce(array_length(string_to_array(pth,'/'),1),0)<>3
  or not private.is_valid_uuid_text(split_part(split_part(pth,'/',3),'.',1))
  or (mime='image/jpeg' and split_part(pth,'.',array_length(string_to_array(pth,'.'),1))<>'jpg')
  or (mime='image/png' and split_part(pth,'.',array_length(string_to_array(pth,'.'),1))<>'png')
  or (mime='image/webp' and split_part(pth,'.',array_length(string_to_array(pth,'.'),1))<>'webp')
  or (mime='application/pdf' and split_part(pth,'.',array_length(string_to_array(pth,'.'),1))<>'pdf')
  or size<=0 or size>10485760 or mime not in ('image/jpeg','image/png','image/webp','application/pdf') or length(ik) not between 1 and 200 then raise exception 'INVALID_ATTACHMENT' using errcode='P0001'; end if;
 fp:=encode(extensions.digest(jsonb_build_object('shop_id',sid,'expense_id',eid,'file_path',pth,'file_name',command->>'file_name','content_type',mime,'byte_size',size)::text::bytea,'sha256'),'hex'); perform pg_advisory_xact_lock(hashtextextended(sid::text||':expense-attachment:'||ik,0));
 select id,fingerprint into prior from public.attachments where shop_id=sid and idempotency_key=ik; if found then if prior.fingerprint=fp then return jsonb_build_object('ok',true,'attachment_id',prior.id); else raise exception 'IDEMPOTENCY_CONFLICT' using errcode='P0001'; end if; end if;
 if not exists(select 1 from storage.objects o where o.bucket_id='expense-receipts' and o.name=pth) then raise exception 'ATTACHMENT_NOT_UPLOADED' using errcode='P0001'; end if;
 insert into public.attachments(id,shop_id,expense_id,file_path,file_name,content_type,byte_size,idempotency_key,fingerprint,created_by) values(aid,sid,eid,pth,left(command->>'file_name',255),mime,size,ik,fp,auth.uid());
 insert into public.audit_events(shop_id,actor_id,action,entity_type,entity_id,metadata) values(sid,auth.uid(),'attach_expense_receipt','expense',eid::text,jsonb_build_object('attachment_id',aid)); return jsonb_build_object('ok',true,'attachment_id',aid);
end $$;
revoke all on function public.register_expense_attachment(jsonb) from public,anon; grant execute on function public.register_expense_attachment(jsonb) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('expense-receipts','expense-receipts',false,10485760,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=10485760,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists expense_receipts_shop_read on storage.objects;
create policy expense_receipts_shop_read on storage.objects for select to authenticated using(
 bucket_id='expense-receipts'
 and private.is_valid_uuid_text((storage.foldername(name))[1])
 and private.has_shop_access(((storage.foldername(name))[1])::uuid)
 and exists(select 1 from public.attachments a where a.shop_id=((storage.foldername(name))[1])::uuid and a.file_path=name and a.expense_id is not null)
);
create policy expense_receipts_shop_insert on storage.objects for insert to authenticated with check(
 bucket_id='expense-receipts'
 and private.is_valid_uuid_text((storage.foldername(name))[1])
 and private.has_shop_access(((storage.foldername(name))[1])::uuid)
 and private.is_valid_uuid_text((storage.foldername(name))[2])
 and coalesce(array_length(storage.foldername(name),1),0)=2
 and exists(select 1 from public.expenses e where e.shop_id=((storage.foldername(name))[1])::uuid and e.id=((storage.foldername(name))[2])::uuid)
 and split_part(name,'/',3) ~ '^[0-9a-f-]{36}\.(jpg|png|webp|pdf)$'
);
create policy expense_receipts_no_update on storage.objects for update to authenticated using(false) with check(false);
create policy expense_receipts_no_delete on storage.objects for delete to authenticated using(false);
