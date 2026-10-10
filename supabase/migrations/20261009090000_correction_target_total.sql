-- Invoice-total corrections state the corrected total, not an adjustment.
--
-- Until now a correction request carried only a signed delta. The entry screen
-- asked for an "adjustment amount", so a user who typed the total they wanted
-- (1500 on a 1000 invoice) got 1000 + 1500 = 2500. The request now carries the
-- corrected total and the total it was made against; the delta that the
-- append-only ledger stores is derived here, under the invoice lock.
--
-- Existing rows keep both new columns null. Payment corrections and the legacy
-- delta command are unchanged.

alter table public.correction_requests
  add column expected_total_dirham bigint,
  add column corrected_total_dirham bigint,
  add constraint correction_requests_target_total_check check (
    (expected_total_dirham is null and corrected_total_dirham is null)
    or (
      payment_id is null
      and expected_total_dirham is not null and corrected_total_dirham is not null
      and corrected_total_dirham between 0 and 9007199254740991
      and amount_delta_dirham = corrected_total_dirham - expected_total_dirham
    )
  );

create or replace function public.request_invoice_correction(command jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  sid uuid; iid uuid; actor uuid:=auth.uid(); cmd jsonb; fp text; old public.correction_requests; rid uuid;
  eff public.effective_invoices; has_target boolean; corrected bigint; delta bigint;
begin
  sid := private.invoice_operation_actor(command,array['shop_id','invoice_id','reason','idempotency_key','payment_id','amount_delta_dirham','corrected_total_dirham','expected_total_dirham'],false);
  if not private.is_valid_uuid_text(command->>'invoice_id')
    or jsonb_typeof(command->'reason') is distinct from 'string'
    or length(btrim(command->>'reason')) not between 1 and 2000 then
    raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
  iid := (command->>'invoice_id')::uuid;

  -- Exactly one of: a corrected invoice total, or a signed delta.
  has_target := command ? 'corrected_total_dirham';
  if has_target = (command ? 'amount_delta_dirham')
    or has_target <> (command ? 'expected_total_dirham')
    or not(command ? 'payment_id')
    or (jsonb_typeof(command->'payment_id') is distinct from 'null' and not private.is_valid_uuid_text(command->>'payment_id'))
  then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
  if has_target then
    if jsonb_typeof(command->'payment_id') is distinct from 'null'
      or not private.is_safe_bigint_jsonb(command->'corrected_total_dirham') or (command->>'corrected_total_dirham')::bigint<0
      or not private.is_safe_bigint_jsonb(command->'expected_total_dirham') or (command->>'expected_total_dirham')::bigint<0
    then raise exception 'INVALID_REQUEST' using errcode='P0001'; end if;
  elsif not private.is_safe_bigint_jsonb(command->'amount_delta_dirham') or (command->>'amount_delta_dirham')::bigint=0
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

  if has_target then
    -- The client's arithmetic is never trusted: the delta comes from the
    -- authoritative effective total, read while the invoice row is locked.
    select * into eff from public.effective_invoices where shop_id=sid and canonical_invoice_id=iid;
    corrected := (cmd->>'corrected_total_dirham')::bigint;
    if (cmd->>'expected_total_dirham')::bigint<>eff.effective_total_dirham then raise exception 'STALE_TOTAL' using errcode='P0001'; end if;
    delta := corrected-eff.effective_total_dirham;
    if delta=0 then raise exception 'CORRECTION_NO_CHANGE' using errcode='P0001'; end if;
    if corrected<eff.effective_paid_dirham+eff.effective_credit_applied_dirham then raise exception 'INVALID_FINANCIAL_RESULT' using errcode='P0001'; end if;
    if eff.effective_delivered and corrected>eff.effective_paid_dirham+eff.effective_credit_applied_dirham and eff.effective_customer_id is null then
      raise exception 'CUSTOMER_REQUIRED' using errcode='P0001'; end if;
  else
    delta := (cmd->>'amount_delta_dirham')::bigint;
  end if;

  insert into public.correction_requests(shop_id,invoice_id,payment_id,amount_delta_dirham,expected_total_dirham,corrected_total_dirham,reason,requested_by,idempotency_key,fingerprint)
  values(sid,iid,(cmd->>'payment_id')::uuid,delta,case when has_target then eff.effective_total_dirham end,corrected,cmd->>'reason',actor,cmd->>'idempotency_key',fp) returning id into rid;
  insert into public.audit_events(shop_id,actor_id,action,entity_type,entity_id,reason,metadata)
  values(sid,actor,'correction.request','invoice',iid::text,cmd->>'reason',jsonb_build_object('request_id',rid));
  return jsonb_build_object('ok',true,'request_id',rid,'invoice_id',iid);
end $$;
revoke all on function public.request_invoice_correction(jsonb) from public,anon;
grant execute on function public.request_invoice_correction(jsonb) to authenticated;

-- Identical to the previous definition except for the corrected-total block.
create or replace function public.decide_invoice_correction(command jsonb) returns jsonb
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
    -- A corrected-total request is only approvable against the total it was
    -- made for, so approval lands on exactly the requested total. If another
    -- correction moved the total since, reject this one and request again.
    if req.corrected_total_dirham is not null then
      if eff.effective_total_dirham<>req.expected_total_dirham then raise exception 'STALE_TOTAL' using errcode='P0001'; end if;
      if req.corrected_total_dirham<eff.effective_paid_dirham+eff.effective_credit_applied_dirham then raise exception 'INVALID_FINANCIAL_RESULT' using errcode='P0001'; end if;
    end if;
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
