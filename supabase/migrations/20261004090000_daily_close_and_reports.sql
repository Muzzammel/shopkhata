-- BIG SLICE 4: governed daily close/reopen, closed-date enforcement at the
-- write boundary, and report projections over the existing source records.

-- 1. Close events -----------------------------------------------------------
-- daily_closes is already an append-only event log (closed / reopened+reason).
-- A close may carry an optional note; the reopen reason stays in `reason`.
alter table public.daily_closes
  add column note text,
  add constraint daily_closes_note_check
    check (note is null or (event_type = 'closed' and length(btrim(note)) between 1 and 2000));
create index daily_closes_shop_date_sequence_idx on public.daily_closes(shop_id, business_date, event_sequence desc);

-- Report filters are always (shop, business date range).
create index invoices_shop_business_date_idx on public.invoices(shop_id, business_date);
create index payments_shop_business_date_idx on public.payments(shop_id, business_date);
create index corrections_shop_business_date_idx on public.corrections(shop_id, business_date) where approved_by is not null;
create index customer_credits_shop_business_date_idx on public.customer_credits(shop_id, business_date) where approved_by is not null;
create index credit_applications_shop_business_date_idx on public.credit_applications(shop_id, business_date);
create index batches_shop_business_date_idx on public.batches(shop_id, business_date);

-- 2. Closed-date enforcement --------------------------------------------------
create function private.day_close_lock_key(p_shop_id uuid, p_date date) returns bigint
language sql immutable set search_path = '' as $$
  select hashtextextended('day-close:' || p_shop_id::text || ':' || p_date::text, 0)
$$;
revoke all on function private.day_close_lock_key(uuid, date) from public, anon, authenticated;

-- A writer holds the shared lock until it commits and a close takes the
-- exclusive one, so a write can never commit into a date that closed while it
-- was in flight: it either finishes before the close or sees the close.
create function private.assert_date_open(p_shop_id uuid, p_date date) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock_shared(private.day_close_lock_key(p_shop_id, p_date));
  if (select d.event_type from public.daily_closes d
      where d.shop_id = p_shop_id and d.business_date = p_date
      order by d.event_sequence desc limit 1) = 'closed' then
    raise exception 'CLOSED_DATE' using errcode = 'P0001';
  end if;
end $$;
revoke all on function private.assert_date_open(uuid, date) from public, anon, authenticated;

-- Every dated financial row passes through here, whichever RPC (or future
-- path) writes it. Exact idempotent retries return before inserting anything,
-- so they are unaffected by a later close.
create function private.enforce_open_business_date() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_date_open(new.shop_id, new.business_date);
  return new;
end $$;
revoke all on function private.enforce_open_business_date() from public, anon, authenticated;

do $$ declare t text; begin
  foreach t in array array['invoices','payments','corrections','customer_credits','credit_applications','expenses'] loop
    execute format('create trigger %I before insert on public.%I for each row execute function private.enforce_open_business_date()', t || '_open_business_date', t);
  end loop;
end $$;

-- An approved expense correction replaces the amount reported under the
-- expense's own business date, so that date must be open (reopen first).
-- Invoice/payment corrections are separate rows dated on their approval day
-- and are covered by the trigger above.
create function private.enforce_open_expense_correction() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.decision = 'approved' then
    perform private.assert_date_open(new.shop_id, (select x.business_date from public.expenses x where x.shop_id = new.shop_id and x.id = new.expense_id));
  end if;
  return new;
end $$;
revoke all on function private.enforce_open_expense_correction() from public, anon, authenticated;
create trigger expense_correction_decisions_open_business_date before insert on public.expense_correction_decisions
  for each row execute function private.enforce_open_expense_correction();

-- 3. Daily summary --------------------------------------------------------------
-- One row per business date that has activity. Every amount is integer dirham
-- and is grouped by business date, never by the recorded timestamp.
create function public.report_daily_summary(p_shop_id uuid, p_from date, p_to date)
returns table(
  business_date date, invoice_count bigint, gross_invoice_dirham bigint, initial_received_dirham bigint,
  due_created_dirham bigint, followup_payments_dirham bigint, customer_payments_dirham bigint,
  payment_corrections_dirham bigint, invoice_corrections_dirham bigint, credit_created_dirham bigint,
  credit_applied_dirham bigint, expense_count bigint, expenses_dirham bigint, cash_received_dirham bigint,
  net_cash_movement_dirham bigint, net_due_movement_dirham bigint
) language sql stable set search_path = '' as $$
  with flows as (
    select i.business_date d, count(*) invoice_count, sum(i.total_amount_dirham) gross, 0::numeric initial_received,
      0::numeric followup, 0::numeric customer_paid, 0::numeric payment_corrections, 0::numeric invoice_corrections,
      0::numeric credit_created, 0::numeric credit_applied, 0::bigint expense_count, 0::numeric expenses
    from public.invoices i where i.shop_id = p_shop_id and i.business_date between p_from and p_to group by 1
    union all
    select p.business_date, 0, 0,
      coalesce(sum(p.amount_dirham) filter (where p.batch_id is not null), 0),
      coalesce(sum(p.amount_dirham) filter (where p.batch_id is null and p.customer_payment_batch_id is null), 0),
      coalesce(sum(p.amount_dirham) filter (where p.batch_id is null and p.customer_payment_batch_id is not null), 0),
      0, 0, 0, 0, 0, 0
    from public.payments p where p.shop_id = p_shop_id and p.business_date between p_from and p_to group by 1
    union all
    select c.business_date, 0, 0, 0, 0, 0,
      coalesce(sum(c.amount_delta_dirham) filter (where c.payment_id is not null), 0),
      coalesce(sum(c.amount_delta_dirham) filter (where c.invoice_id is not null), 0),
      0, 0, 0, 0
    from public.corrections c where c.shop_id = p_shop_id and c.business_date between p_from and p_to and c.approved_by is not null group by 1
    union all
    select cc.business_date, 0, 0, 0, 0, 0, 0, 0, sum(cc.amount_dirham), 0, 0, 0
    from public.customer_credits cc where cc.shop_id = p_shop_id and cc.business_date between p_from and p_to and cc.approved_by is not null group by 1
    union all
    select a.business_date, 0, 0, 0, 0, 0, 0, 0, 0, sum(a.amount_dirham), 0, 0
    from public.credit_applications a where a.shop_id = p_shop_id and a.business_date between p_from and p_to group by 1
    union all
    select x.business_date, 0, 0, 0, 0, 0, 0, 0, 0, 0, count(*), sum(x.amount_dirham)
    from public.effective_expenses x where x.shop_id = p_shop_id and x.business_date between p_from and p_to group by 1
  ), days as (
    select d, sum(invoice_count)::bigint invoice_count, sum(gross)::bigint gross, sum(initial_received)::bigint initial_received,
      sum(followup)::bigint followup, sum(customer_paid)::bigint customer_paid, sum(payment_corrections)::bigint payment_corrections,
      sum(invoice_corrections)::bigint invoice_corrections, sum(credit_created)::bigint credit_created,
      sum(credit_applied)::bigint credit_applied, sum(expense_count)::bigint expense_count, sum(expenses)::bigint expenses
    from flows where p_to - p_from between 0 and 366 group by d
  )
  select d, invoice_count, gross, initial_received, gross - initial_received, followup, customer_paid, payment_corrections,
    invoice_corrections, credit_created, credit_applied, expense_count, expenses,
    initial_received + followup + customer_paid + payment_corrections + credit_created,
    initial_received + followup + customer_paid + payment_corrections + credit_created - expenses,
    gross + invoice_corrections - initial_received - followup - customer_paid - payment_corrections - credit_applied
  from days order by d
$$;
revoke all on function public.report_daily_summary(uuid, date, date) from public, anon;
grant execute on function public.report_daily_summary(uuid, date, date) to authenticated;

-- Requests still waiting for a decision against records dated on this day.
-- Informational for the close screen; they do not block a close.
create function public.report_day_pending_requests(p_shop_id uuid, p_date date)
returns table(pending_invoice_corrections bigint, pending_invoice_replacements bigint, pending_expense_corrections bigint)
language sql stable set search_path = '' as $$
  select
    (select count(*) from public.correction_requests r join public.invoices i on i.shop_id = r.shop_id and i.id = r.invoice_id
      where r.shop_id = p_shop_id and i.business_date = p_date and not exists (select 1 from public.correction_decisions d where d.request_id = r.id)),
    (select count(*) from public.replacement_requests r join public.invoices i on i.shop_id = r.shop_id and i.id = r.invoice_id
      where r.shop_id = p_shop_id and i.business_date = p_date and not exists (select 1 from public.replacement_decisions d where d.request_id = r.id)),
    (select count(*) from public.expense_correction_requests r join public.expenses x on x.shop_id = r.shop_id and x.id = r.expense_id
      where r.shop_id = p_shop_id and x.business_date = p_date and not exists (select 1 from public.expense_correction_decisions d where d.request_id = r.id))
$$;
revoke all on function public.report_day_pending_requests(uuid, date) from public, anon;
grant execute on function public.report_day_pending_requests(uuid, date) to authenticated;

-- 4. Close / reopen -------------------------------------------------------------
create function private.record_day_close_event(command jsonb, p_event text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid; dt date; actor uuid := auth.uid(); actor_role text; txt text; latest text;
  eid uuid := gen_random_uuid(); seq bigint; summary jsonb;
  today date := (now() at time zone 'Asia/Qatar')::date;
  text_key text := case when p_event = 'closed' then 'note' else 'reason' end;
begin
  if actor is null or not private.is_active_actor() then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000'; end if;
  if jsonb_typeof(command) is distinct from 'object'
    or not private.jsonb_object_keys_subset(command, array['shop_id', 'business_date', text_key])
    or not private.is_valid_uuid_text(command ->> 'shop_id')
    or jsonb_typeof(command -> 'business_date') is distinct from 'string'
    or not private.is_valid_date_text(command ->> 'business_date')
    or (command ? text_key and jsonb_typeof(command -> text_key) not in ('string', 'null'))
  then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  sid := (command ->> 'shop_id')::uuid; dt := (command ->> 'business_date')::date;
  if not private.has_shop_access(sid) then raise exception 'UNAUTHORIZED_SHOP' using errcode = '42501'; end if;
  select p.role into actor_role from public.profiles p where p.id = actor;
  if actor_role is null or actor_role not in ('owner', 'manager') then raise exception 'INSUFFICIENT_ROLE' using errcode = '42501'; end if;
  txt := private.normalize_optional_text(command ->> text_key);
  if length(txt) > 2000 then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  if p_event = 'reopened' and txt is null then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if dt > today then raise exception 'INVALID_DATE' using errcode = 'P0001'; end if;
  -- A manager cannot write to an earlier date, so cannot reopen one either.
  if p_event = 'reopened' and actor_role <> 'owner' and dt <> today then raise exception 'INSUFFICIENT_ROLE' using errcode = '42501'; end if;

  perform pg_advisory_xact_lock(private.day_close_lock_key(sid, dt));
  select d.event_type into latest from public.daily_closes d
  where d.shop_id = sid and d.business_date = dt order by d.event_sequence desc limit 1;
  if p_event = 'closed' and latest = 'closed' then raise exception 'ALREADY_CLOSED' using errcode = 'P0001'; end if;
  if p_event = 'reopened' and latest is distinct from 'closed' then raise exception 'NOT_CLOSED' using errcode = 'P0001'; end if;

  select to_jsonb(s) into summary from public.report_daily_summary(sid, dt, dt) s;
  insert into public.daily_closes(id, shop_id, business_date, event_type, actor_id, reason, note)
  values (eid, sid, dt, p_event, actor, case when p_event = 'reopened' then txt end, case when p_event = 'closed' then txt end)
  returning event_sequence into seq;
  -- The audit row keeps the day's totals as they stood at this decision.
  insert into public.audit_events(shop_id, actor_id, action, entity_type, entity_id, reason, metadata)
  values (sid, actor, case when p_event = 'closed' then 'date.close' else 'date.reopen' end, 'business_date', dt::text, txt,
    jsonb_build_object('event_id', eid, 'event_sequence', seq, 'business_date', dt, 'summary', summary));
  return jsonb_build_object('ok', true, 'event_id', eid, 'event_sequence', seq, 'business_date', dt,
    'state', case when p_event = 'closed' then 'closed' else 'open' end);
end $$;
revoke all on function private.record_day_close_event(jsonb, text) from public, anon, authenticated;

create function public.close_business_date(command jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select private.record_day_close_event(command, 'closed') $$;
create function public.reopen_business_date(command jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select private.record_day_close_event(command, 'reopened') $$;
revoke all on function public.close_business_date(jsonb), public.reopen_business_date(jsonb) from public, anon;
grant execute on function public.close_business_date(jsonb), public.reopen_business_date(jsonb) to authenticated;

-- 5. Report projections -----------------------------------------------------------
-- Money movements, one row per source record. Corrections are their own rows on
-- their own business date, so nothing is counted twice and cash rows for a
-- date add up to report_daily_summary.cash_received_dirham.
create view public.report_payments with (security_invoker = true) as
select p.shop_id, p.id entry_id, p.business_date, p.recorded_at,
  case when p.batch_id is not null then 'invoice_entry' when p.customer_payment_batch_id is not null then 'customer_payment' else 'follow_up' end source,
  p.payment_method method, p.amount_dirham, p.invoice_id, p.created_by,
  coalesce(p.customer_payment_batch_id, p.id)::text reference
from public.payments p
union all
select c.shop_id, c.id, c.business_date, c.recorded_at, 'payment_correction', 'cash', c.amount_delta_dirham,
  (select p.invoice_id from public.payments p where p.shop_id = c.shop_id and p.id = c.payment_id), c.approved_by, c.payment_id::text
from public.corrections c where c.payment_id is not null and c.approved_by is not null
union all
select cc.shop_id, cc.id, cc.business_date, cc.recorded_at, 'overpayment_credit', 'cash', cc.amount_dirham, cc.invoice_id, cc.created_by, cc.id::text
from public.customer_credits cc where cc.approved_by is not null
union all
select a.shop_id, a.id, a.business_date, a.recorded_at, 'credit_application', 'credit', a.amount_dirham, a.invoice_id, a.created_by, a.credit_id::text
from public.credit_applications a;
revoke all on public.report_payments from public, anon;
grant select on public.report_payments to authenticated;

-- source/method null = subtotal; both null = grand total of all rows.
create function public.report_payment_totals(p_shop_id uuid, p_from date, p_to date)
returns table(source text, method text, entry_count bigint, amount_dirham bigint)
language sql stable set search_path = '' as $$
  select r.source, r.method, count(*), coalesce(sum(r.amount_dirham), 0)::bigint
  from public.report_payments r where r.shop_id = p_shop_id and r.business_date between p_from and p_to
  group by grouping sets ((r.source, r.method), (r.method), ())
$$;

create function public.report_sales_totals(p_shop_id uuid, p_from date, p_to date)
returns table(invoice_count bigint, effective_total_dirham bigint, effective_paid_dirham bigint, credit_applied_dirham bigint,
  effective_due_dirham bigint, delivered_count bigint, undelivered_count bigint)
language sql stable set search_path = '' as $$
  select count(*), coalesce(sum(e.effective_total_dirham), 0)::bigint, coalesce(sum(e.effective_paid_dirham), 0)::bigint,
    coalesce(sum(e.effective_credit_applied_dirham), 0)::bigint, coalesce(sum(e.effective_due_dirham), 0)::bigint,
    count(*) filter (where e.effective_delivered), count(*) filter (where not e.effective_delivered)
  from public.effective_invoices e where e.shop_id = p_shop_id and e.business_date between p_from and p_to
$$;

-- unassigned_due is due on invoices that have no customer yet, so
-- outstanding_due + unassigned_due = all effective invoice due in the shop.
create function public.report_customer_due_totals(p_shop_id uuid)
returns table(customers_with_due bigint, outstanding_due_dirham bigint, available_credit_dirham bigint, unassigned_due_dirham bigint)
language sql stable set search_path = '' as $$
  select count(*) filter (where b.outstanding_due_dirham > 0), coalesce(sum(b.outstanding_due_dirham), 0)::bigint,
    coalesce(sum(b.available_credit_dirham), 0)::bigint,
    (select coalesce(sum(e.effective_due_dirham), 0)::bigint from public.effective_invoices e where e.shop_id = p_shop_id and e.effective_customer_id is null)
  from public.customer_financial_balances b where b.shop_id = p_shop_id
$$;

-- category null = total.
create function public.report_expense_totals(p_shop_id uuid, p_from date, p_to date)
returns table(category text, expense_count bigint, amount_dirham bigint)
language sql stable set search_path = '' as $$
  select x.category, count(*), coalesce(sum(x.amount_dirham), 0)::bigint
  from public.effective_expenses x where x.shop_id = p_shop_id and x.business_date between p_from and p_to
  group by grouping sets ((x.category), ())
$$;

revoke all on function public.report_payment_totals(uuid, date, date), public.report_sales_totals(uuid, date, date),
  public.report_customer_due_totals(uuid), public.report_expense_totals(uuid, date, date) from public, anon;
grant execute on function public.report_payment_totals(uuid, date, date), public.report_sales_totals(uuid, date, date),
  public.report_customer_due_totals(uuid), public.report_expense_totals(uuid, date, date) to authenticated;

-- 6. record_payment: a backdated follow-up payment now requires a reason ------------
create or replace function public.record_payment(command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_today date := (now() at time zone 'Asia/Qatar')::date;
  v_shop_id_text text;
  v_shop_id uuid;
  v_invoice_id_text text;
  v_invoice_id uuid;
  v_amount bigint;
  v_payment_method text;
  v_business_date_text text;
  v_business_date date;
  v_idempotency_key text;
  v_backdated_reason text;
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

  if not private.jsonb_object_keys_subset(command, array['shop_id','invoice_id','amount_dirham','payment_method','business_date','idempotency_key','backdated_reason']) then
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
  end if;

  if command ? 'backdated_reason' and jsonb_typeof(command -> 'backdated_reason') not in ('string', 'null') then
    v_errors := v_errors || jsonb_build_object('field', 'backdated_reason', 'code', 'REQUEST_INVALID', 'message', 'backdated_reason must be a string or null.');
  else
    v_backdated_reason := private.normalize_optional_text(command ->> 'backdated_reason');
    if length(v_backdated_reason) > 2000 then
      v_errors := v_errors || jsonb_build_object('field', 'backdated_reason', 'code', 'REQUEST_INVALID', 'message', 'backdated_reason is too long.');
    end if;
  end if;

  if jsonb_array_length(v_errors) > 0 then
    raise exception 'PAYMENT_VALIDATION_FAILED' using errcode = 'P0001', detail = v_errors::text;
  end if;

  -- A payment for an earlier business date is owner-only and must say why.
  -- The reason is audit data, not part of the fingerprint, so payments
  -- recorded before this rule remain exactly replayable.

  -- Locked for update: without this, two concurrent calls against the same
  -- invoice can both read the pre-payment effective_due and both pass the
  -- overpayment check, double-booking the invoice. The lock forces the
  -- second call to wait and re-read the first call's committed payment.
  select i.id, i.shop_id, i.total_amount_dirham
  into v_invoice
  from public.invoices i
  where i.id = v_invoice_id and i.shop_id = v_shop_id
  for update;

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
  -- Resolve exact retries before evaluating today's date so a response lost
  -- before midnight remains replayable by the same authorized actor.
  if v_business_date > v_today then
    raise exception 'PAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('field', 'business_date', 'code', 'REQUEST_INVALID', 'message', 'Business date cannot be in the future.'))::text;
  end if;

  if v_business_date < v_today and v_actor_role is distinct from 'owner' then
    raise exception 'INSUFFICIENT_ROLE' using errcode = '42501';
  end if;
  if (v_business_date < v_today) is distinct from (v_backdated_reason is not null) then
    raise exception 'PAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('field', 'backdated_reason', 'code', 'BACKDATE_REASON_REQUIRED', 'message', 'A reason is required for, and only for, a payment on an earlier business date.'))::text;
  end if;
  select d.event_type into v_close_state
  from public.daily_closes d
  where d.shop_id = v_shop_id and d.business_date = v_business_date
  order by d.event_sequence desc
  limit 1;

  if v_close_state = 'closed' then
    raise exception 'CLOSED_DATE' using errcode = 'P0001';
  end if;

  -- Read the same approved-correction projection used by invoice lookup and display.
  select b.effective_total_dirham, b.effective_paid_dirham
  into v_effective_total, v_effective_paid
  from public.invoice_effective_balances b
  where b.shop_id = v_shop_id and b.canonical_invoice_id = v_invoice.id;

  if not found then
    raise exception 'PAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('field', 'invoice_id', 'code', 'INVOICE_NOT_FOUND', 'message', 'Invoice was not found in this shop.'))::text;
  end if;

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

  insert into public.audit_events (shop_id, actor_id, action, entity_type, entity_id, reason, metadata, recorded_at)
  values (v_shop_id, v_actor_id, 'record_payment', 'payment', v_payment_id::text, v_backdated_reason,
          jsonb_build_object('invoice_id', v_invoice_id, 'amount_dirham', v_amount, 'idempotency_key', v_idempotency_key,
                             'business_date', v_business_date, 'is_backdated', v_business_date < v_today),
          v_recorded_at);

  return v_result;
end;
$$;

revoke all on function public.record_payment(jsonb) from public, anon;
grant execute on function public.record_payment(jsonb) to authenticated;

-- 7. approve_overpayment: resolve an exact retry before the closed-date rule ---------
create or replace function public.approve_overpayment(command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_today date := (now() at time zone 'Asia/Qatar')::date;
  v_shop_id_text text;
  v_shop_id uuid;
  v_invoice_id_text text;
  v_invoice_id uuid;
  v_amount bigint;
  v_payment_method text;
  v_business_date_text text;
  v_business_date date;
  v_reason text;
  v_idempotency_key text;
  v_fingerprint text;
  v_lock_key bigint;
  v_existing record;
  v_close_state text;
  v_customer_id uuid;
  v_effective_total bigint;
  v_effective_paid bigint;
  v_effective_due bigint;
  v_applied_amount bigint;
  v_credit_amount bigint;
  v_payment_id uuid := gen_random_uuid();
  v_credit_id uuid := gen_random_uuid();
  v_recorded_at timestamptz := now();
  v_result jsonb;
  v_errors jsonb := '[]'::jsonb;
begin
  if v_actor_id is null or not private.is_active_actor() then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000';
  end if;

  select p.role into v_actor_role from public.profiles p where p.id = v_actor_id;

  if jsonb_typeof(command) is distinct from 'object' then
    raise exception 'OVERPAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('field', 'request', 'code', 'REQUEST_INVALID', 'message', 'The command must be a JSON object.'))::text;
  end if;

  if not private.jsonb_object_keys_subset(command, array['shop_id','invoice_id','amount_dirham','payment_method','business_date','idempotency_key','reason']) then
    raise exception 'OVERPAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('field', 'request', 'code', 'REQUEST_INVALID', 'message', 'The command contains an unsupported field.'))::text;
  end if;

  v_shop_id_text := command ->> 'shop_id';
  if jsonb_typeof(command -> 'idempotency_key') is distinct from 'string' then
    raise exception 'OVERPAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('field', 'idempotency_key', 'code', 'REQUEST_INVALID', 'message', 'idempotency_key must be a JSON string.'))::text;
  end if;
  v_idempotency_key := command ->> 'idempotency_key';

  if not private.is_valid_uuid_text(v_shop_id_text) or btrim(v_idempotency_key) = '' then
    raise exception 'OVERPAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
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
    if v_business_date > v_today then
      v_errors := v_errors || jsonb_build_object('field', 'business_date', 'code', 'REQUEST_INVALID', 'message', 'Business date cannot be in the future.');
    end if;
  end if;

  if jsonb_typeof(command -> 'reason') is distinct from 'string' or btrim(command ->> 'reason') = '' then
    v_errors := v_errors || jsonb_build_object('field', 'reason', 'code', 'MISSING_REASON', 'message', 'A non-empty reason is required.');
  else
    v_reason := btrim(command ->> 'reason');
  end if;

  if jsonb_array_length(v_errors) > 0 then
    raise exception 'OVERPAYMENT_VALIDATION_FAILED' using errcode = 'P0001', detail = v_errors::text;
  end if;

  -- Design decision 1: only owner/manager (payment.override_excess holders)
  -- may call this RPC at all.
  if v_actor_role is distinct from 'owner' and v_actor_role is distinct from 'manager' then
    raise exception 'INSUFFICIENT_ROLE' using errcode = '42501';
  end if;

  -- Design decision 3: backdate authority is unchanged -- owner only.
  if v_business_date < v_today and v_actor_role is distinct from 'owner' then
    raise exception 'INSUFFICIENT_ROLE' using errcode = '42501';
  end if;

  -- Locked for update: same race as record_payment (see its migration) --
  -- without this, two concurrent overpayment approvals against the same
  -- invoice can both read the pre-payment effective_due and both succeed.
  perform 1
  from public.invoices i
  where i.id = v_invoice_id and i.shop_id = v_shop_id
  for update;

  if not found then
    raise exception 'OVERPAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('field', 'invoice_id', 'code', 'INVOICE_NOT_FOUND', 'message', 'Invoice was not found in this shop.'))::text;
  end if;

  v_fingerprint := encode(
    extensions.digest(
      private.canonical_overpayment_command(v_shop_id, v_invoice_id, v_amount, v_payment_method, v_business_date, v_reason)::text::bytea,
      'sha256'
    ),
    'hex'
  );

  v_lock_key := hashtextextended(v_shop_id::text || ':' || v_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- Design decision 7: replay/conflict is detected via the payments row alone,
  -- since the payments row and customer_credits row are always written together.
  select p.fingerprint, p.idempotency_result into v_existing
  from public.payments p
  where p.shop_id = v_shop_id and p.idempotency_key = v_idempotency_key;

  if found then
    if v_existing.fingerprint = v_fingerprint then
      return v_existing.idempotency_result;
    end if;
    raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'P0001';
  end if;

  -- Checked after the replay above: an approval that committed while the date
  -- was open stays replayable once the date has closed.
  select d.event_type into v_close_state
  from public.daily_closes d
  where d.shop_id = v_shop_id and d.business_date = v_business_date
  order by d.event_sequence desc
  limit 1;

  if v_close_state = 'closed' then
    raise exception 'CLOSED_DATE' using errcode = 'P0001';
  end if;

  -- Use effective customer after replay; historic credits remain immutable.
  select effective_customer_id into v_customer_id from public.effective_invoices
  where shop_id=v_shop_id and canonical_invoice_id=v_invoice_id;
  if v_customer_id is null then
    raise exception 'OVERPAYMENT_VALIDATION_FAILED' using errcode='P0001';
  end if;

  select effective_total_dirham,effective_paid_dirham
  into v_effective_total,v_effective_paid
  from public.effective_invoices where shop_id=v_shop_id and canonical_invoice_id=v_invoice_id;

  v_effective_due := v_effective_total - v_effective_paid;

  -- Design decision 4: this RPC only ever handles a genuine overpayment.
  if v_amount <= v_effective_due then
    raise exception 'OVERPAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('field', 'amount_dirham', 'code', 'NOT_AN_OVERPAYMENT', 'message', 'This amount does not exceed the amount due; use record_payment instead.'))::text;
  end if;

  v_applied_amount := v_effective_due;
  v_credit_amount := v_amount - v_effective_due;

  v_result := jsonb_build_object(
    'ok', true,
    'payment_id', v_payment_id,
    'credit_id', v_credit_id,
    'invoice_id', v_invoice_id,
    'customer_id', v_customer_id,
    'recorded_at', to_char(v_recorded_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'applied_amount', v_applied_amount,
    'credit_amount', v_credit_amount,
    'effective_paid', v_effective_paid + v_applied_amount,
    'effective_due', v_effective_due - v_applied_amount
  );

  -- Design decision 6: one payments row for the applied amount only (never
  -- the full cash tendered), one customer_credits row for the excess.
  insert into public.payments (
    id, shop_id, invoice_id, amount_dirham, business_date, payment_method,
    idempotency_key, fingerprint, idempotency_result, created_by, recorded_at
  ) values (
    v_payment_id, v_shop_id, v_invoice_id, v_applied_amount, v_business_date, v_payment_method,
    v_idempotency_key, v_fingerprint, v_result, v_actor_id, v_recorded_at
  );

  -- Design decision 8: approved_at = recorded_at since creation and approval
  -- are simultaneous under this single-actor authorization model.
  insert into public.customer_credits (
    id, shop_id, customer_id, invoice_id, amount_dirham, business_date,
    reason, recorded_at, created_by, approved_by, approved_at
  ) values (
    v_credit_id, v_shop_id, v_customer_id, v_invoice_id, v_credit_amount, v_business_date,
    v_reason, v_recorded_at, v_actor_id, v_actor_id, v_recorded_at
  );

  insert into public.audit_events (shop_id, actor_id, action, entity_type, entity_id, metadata, recorded_at)
  values (v_shop_id, v_actor_id, 'approve_overpayment', 'payment', v_payment_id::text,
          jsonb_build_object('invoice_id', v_invoice_id, 'credit_id', v_credit_id,
                              'applied_amount', v_applied_amount, 'credit_amount', v_credit_amount,
                              'reason', v_reason, 'idempotency_key', v_idempotency_key),
          v_recorded_at);

  return v_result;
end;
$$;

revoke all on function public.approve_overpayment(jsonb) from public, anon;
grant execute on function public.approve_overpayment(jsonb) to authenticated;
