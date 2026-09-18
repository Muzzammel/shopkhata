create or replace function private.canonical_overpayment_command(
  p_shop_id uuid,
  p_invoice_id uuid,
  p_amount bigint,
  p_payment_method text,
  p_business_date date,
  p_reason text
) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'shop_id', p_shop_id,
    'invoice_id', p_invoice_id,
    'amount_dirham', p_amount,
    'payment_method', p_payment_method,
    'business_date', p_business_date::text,
    'reason', p_reason
  );
$$;

create or replace function public.approve_overpayment(command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text;
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
  v_invoice record;
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
    if v_business_date > current_date then
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
  if v_business_date < current_date and v_actor_role is distinct from 'owner' then
    raise exception 'INSUFFICIENT_ROLE' using errcode = '42501';
  end if;

  select d.event_type into v_close_state
  from public.daily_closes d
  where d.shop_id = v_shop_id and d.business_date = v_business_date
  order by d.event_sequence desc
  limit 1;

  if v_close_state = 'closed' then
    raise exception 'CLOSED_DATE' using errcode = 'P0001';
  end if;

  select i.id, i.shop_id, i.customer_id, i.total_amount_dirham
  into v_invoice
  from public.invoices i
  where i.id = v_invoice_id and i.shop_id = v_shop_id;

  if not found then
    raise exception 'OVERPAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('field', 'invoice_id', 'code', 'INVOICE_NOT_FOUND', 'message', 'Invoice was not found in this shop.'))::text;
  end if;

  -- Design decision 2: customer is derived from the invoice, never client-supplied.
  if v_invoice.customer_id is null then
    raise exception 'OVERPAYMENT_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('field', 'invoice_id', 'code', 'INVOICE_HAS_NO_CUSTOMER', 'message', 'This invoice has no customer to credit; attach a customer before recording an overpayment.'))::text;
  end if;
  v_customer_id := v_invoice.customer_id;

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

  -- Design decision 5: effective totals computed identically to record_payment.
  select
    v_invoice.total_amount_dirham
      + coalesce((select sum(c.amount_delta_dirham) from public.corrections c
                  where c.invoice_id = v_invoice.id and c.approved_by is not null), 0),
    coalesce((select sum(p.amount_dirham) from public.payments p
              where p.invoice_id = v_invoice.id), 0)
      + coalesce((select sum(c.amount_delta_dirham) from public.corrections c
                  where c.payment_id in (select p.id from public.payments p where p.invoice_id = v_invoice.id)
                    and c.approved_by is not null), 0)
  into v_effective_total, v_effective_paid;

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
