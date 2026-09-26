-- Replace submit_batch without editing applied migrations. Exact backdated
-- replay requires current active-owner authority; date and close rules still
-- apply only to new submissions.
create or replace function public.submit_batch(command jsonb)
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
  v_business_date_text text;
  v_business_date date;
  v_today date := (now() at time zone 'Asia/Qatar')::date;
  v_is_backdated boolean;
  v_backdated_reason text;
  v_idempotency_key text;
  v_rows jsonb;
  v_row jsonb;
  v_idx integer;
  v_row_id text;
  v_display_number text;
  v_normalized_number text;
  v_total bigint;
  v_received bigint;
  v_payment_method text;
  v_delivered boolean;
  v_note text;
  v_customer jsonb;
  v_customer_type text;
  v_customer_id_text text;
  v_customer_id uuid;
  v_customer_name text;
  v_customer_mobile text;
  v_seen_row_ids text[] := '{}';
  v_seen_numbers text[] := '{}';
  v_row_errors jsonb := '[]'::jsonb;
  v_prepared jsonb := '[]'::jsonb;
  v_prepared_row jsonb;
  v_batch_id uuid := gen_random_uuid();
  v_recorded_at timestamptz := now();
  v_canonical jsonb;
  v_fingerprint text;
  v_legacy_fingerprint text;
  v_lock_key bigint;
  v_existing record;
  v_close_state text;
  v_row_results jsonb;
  v_result jsonb;
  v_prepared_customer_id uuid;
  v_prepared_payment_id uuid;
  v_conflicting_numbers text[];
  v_registry_conflicts jsonb;
begin
  if v_actor_id is null or not private.is_active_actor() then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000';
  end if;

  select p.role into v_actor_role from public.profiles p where p.id = v_actor_id;

  if jsonb_typeof(command) is distinct from 'object' then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'request', 'code', 'REQUEST_INVALID', 'message', 'The command must be a JSON object.'))::text;
  end if;

  if not private.jsonb_object_keys_subset(command, array['shop_id','business_date','is_backdated','backdated_reason','idempotency_key','rows']) then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'request', 'code', 'REQUEST_INVALID', 'message', 'The command contains an unsupported field.'))::text;
  end if;

  v_shop_id_text := command ->> 'shop_id';

  if jsonb_typeof(command -> 'idempotency_key') is distinct from 'string' then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'idempotency_key', 'code', 'REQUEST_INVALID', 'message', 'idempotency_key must be a JSON string.'))::text;
  end if;
  v_idempotency_key := command ->> 'idempotency_key';

  if not private.is_valid_uuid_text(v_shop_id_text) or btrim(v_idempotency_key) = '' then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'request', 'code', 'REQUEST_INVALID', 'message', 'shop_id must be a UUID and idempotency_key is required.'))::text;
  end if;
  v_shop_id := v_shop_id_text::uuid;

  if not private.has_shop_access(v_shop_id) then
    raise exception 'UNAUTHORIZED_SHOP' using errcode = '42501';
  end if;

  v_business_date_text := command ->> 'business_date';
  if not private.is_valid_date_text(v_business_date_text) then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'business_date', 'code', 'REQUEST_INVALID', 'message', 'business_date must be a valid YYYY-MM-DD date.'))::text;
  end if;
  v_business_date := v_business_date_text::date;

  if command ? 'is_backdated' and jsonb_typeof(command -> 'is_backdated') <> 'boolean' then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'is_backdated', 'code', 'REQUEST_INVALID', 'message', 'is_backdated must be a boolean.'))::text;
  end if;
  v_is_backdated := coalesce((command ->> 'is_backdated')::boolean, false);

  if command ? 'backdated_reason' and jsonb_typeof(command -> 'backdated_reason') not in ('string', 'null') then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'backdated_reason', 'code', 'REQUEST_INVALID', 'message', 'backdated_reason must be a string or null.'))::text;
  end if;
  v_backdated_reason := private.normalize_optional_text(command ->> 'backdated_reason');

  if not (command ? 'rows') or jsonb_typeof(command -> 'rows') <> 'array' then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'rows', 'code', 'REQUEST_INVALID', 'message', 'rows must be a JSON array.'))::text;
  end if;
  v_rows := command -> 'rows';

  if jsonb_array_length(v_rows) = 0 then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'rows', 'code', 'BATCH_EMPTY', 'message', 'A batch must contain at least one row.'))::text;
  end if;

  for v_idx in 0 .. jsonb_array_length(v_rows) - 1 loop
    v_row := v_rows -> v_idx;

    if jsonb_typeof(v_row) <> 'object' then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', null, 'field', 'row', 'code', 'REQUEST_INVALID', 'message', 'Every row must be a JSON object.');
      continue;
    end if;

    if not private.jsonb_object_keys_subset(v_row, array['row_id','invoice_number','total_dirham','received_dirham','payment_method','delivered','note','customer']) then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row ->> 'row_id', 'field', 'row', 'code', 'REQUEST_INVALID', 'message', 'Row contains an unsupported field.');
      continue;
    end if;

    v_row_id := case when jsonb_typeof(v_row -> 'row_id') = 'string' then v_row ->> 'row_id' else null end;

    if v_row_id is null or btrim(v_row_id) = '' then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row ->> 'row_id', 'field', 'row_id', 'code', 'ROW_ID_REQUIRED', 'message', 'Every row requires a stable client row id.');
    elsif v_row_id = any(v_seen_row_ids) then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'row_id', 'code', 'ROW_ID_DUPLICATE', 'message', 'row_id is duplicated within this batch.');
    else
      v_seen_row_ids := v_seen_row_ids || v_row_id;
    end if;

    v_display_number := case when jsonb_typeof(v_row -> 'invoice_number') = 'string' then btrim(v_row ->> 'invoice_number') else null end;
    v_normalized_number := case when v_display_number is not null then lower(v_display_number) else null end;

    if v_display_number is null or v_display_number = '' then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'invoice_number', 'code', 'INVOICE_NUMBER_REQUIRED', 'message', 'Invoice number is required.');
    elsif v_normalized_number = any(v_seen_numbers) then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'invoice_number', 'code', 'DUPLICATE_INVOICE', 'message', 'Invoice number is duplicated within this batch.');
    else
      v_seen_numbers := v_seen_numbers || v_normalized_number;
    end if;

    if private.is_safe_bigint_jsonb(v_row -> 'total_dirham') then
      v_total := (v_row ->> 'total_dirham')::bigint;
    else
      v_total := null;
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'total_dirham', 'code', 'AMOUNT_INVALID', 'message', 'Total must be a whole number of dirham representable as a 64-bit integer.');
    end if;
    if v_total is not null and v_total <= 0 then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'total_dirham', 'code', 'AMOUNT_INVALID', 'message', 'Total must be a positive whole number of dirham.');
    end if;

    if not (v_row ? 'received_dirham') or jsonb_typeof(v_row -> 'received_dirham') = 'null' then
      v_received := 0;
    elsif private.is_safe_bigint_jsonb(v_row -> 'received_dirham') then
      v_received := (v_row ->> 'received_dirham')::bigint;
    else
      v_received := null;
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'received_dirham', 'code', 'AMOUNT_INVALID', 'message', 'Received must be a whole number of dirham representable as a 64-bit integer.');
    end if;
    if v_received is not null and (v_received < 0 or (v_total is not null and v_received > v_total)) then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'received_dirham', 'code', 'AMOUNT_INVALID', 'message', 'Received must be between zero and the total.');
    end if;

    if v_row ? 'payment_method' and jsonb_typeof(v_row -> 'payment_method') not in ('string', 'null') then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'payment_method', 'code', 'REQUEST_INVALID', 'message', 'payment_method must be a string or null.');
      v_payment_method := null;
    else
      v_payment_method := v_row ->> 'payment_method';
    end if;
    if v_received is not null and v_received > 0 and v_payment_method is distinct from 'cash' then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'payment_method', 'code', 'PAYMENT_METHOD_INVALID', 'message', 'Only the cash payment method is supported.');
    end if;

    if v_row ? 'delivered' and jsonb_typeof(v_row -> 'delivered') <> 'boolean' then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'delivered', 'code', 'REQUEST_INVALID', 'message', 'delivered must be a boolean.');
      v_delivered := false;
    else
      v_delivered := coalesce((v_row ->> 'delivered')::boolean, false);
    end if;

    if v_row ? 'note' and jsonb_typeof(v_row -> 'note') not in ('string', 'null') then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'note', 'code', 'REQUEST_INVALID', 'message', 'note must be a string or null.');
      v_note := null;
    else
      v_note := private.normalize_optional_text(v_row ->> 'note');
    end if;

    v_customer := v_row -> 'customer';
    v_customer_type := null;
    v_customer_id := null;
    v_customer_name := null;
    v_customer_mobile := null;

    if v_customer is null or jsonb_typeof(v_customer) = 'null' then
      null; -- no customer supplied; valid.
    elsif jsonb_typeof(v_customer) <> 'object' then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_REFERENCE_INVALID', 'message', 'customer must be a JSON object or null.');
    else
      v_customer_type := case when jsonb_typeof(v_customer -> 'type') = 'string' then v_customer ->> 'type' else null end;

      if v_customer_type = 'existing' then
        if not private.jsonb_object_keys_subset(v_customer, array['type','customer_id']) then
          v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_REFERENCE_INVALID', 'message', 'customer contains an unsupported field.');
        else
          v_customer_id_text := case when jsonb_typeof(v_customer -> 'customer_id') = 'string' then v_customer ->> 'customer_id' else null end;
          if not private.is_valid_uuid_text(v_customer_id_text) then
            v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_REFERENCE_INVALID', 'message', 'customer_id must be a UUID.');
          else
            v_customer_id := v_customer_id_text::uuid;
            if not exists (select 1 from public.customers c where c.id = v_customer_id and c.shop_id = v_shop_id) then
              v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_NOT_FOUND', 'message', 'Customer was not found in this shop.');
              v_customer_id := null;
            end if;
          end if;
        end if;
      elsif v_customer_type = 'quick_add' then
        if not private.jsonb_object_keys_subset(v_customer, array['type','name','mobile']) then
          v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_REFERENCE_INVALID', 'message', 'customer contains an unsupported field.');
        elsif (v_customer ? 'name' and jsonb_typeof(v_customer -> 'name') not in ('string', 'null'))
          or (v_customer ? 'mobile' and jsonb_typeof(v_customer -> 'mobile') not in ('string', 'null')) then
          v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_REFERENCE_INVALID', 'message', 'name and mobile must be strings when present.');
        else
          v_customer_name := private.normalize_optional_text(v_customer ->> 'name');
          v_customer_mobile := private.normalize_optional_text(v_customer ->> 'mobile');
          if v_customer_name is null and v_customer_mobile is null then
            v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_IDENTIFIER_REQUIRED', 'message', 'A quick-add customer needs a name or mobile number.');
          end if;
        end if;
      else
        v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_REFERENCE_INVALID', 'message', 'customer.type must be existing or quick_add.');
      end if;
    end if;

    if v_delivered and v_total is not null and v_received is not null and (v_total - v_received) > 0 and v_customer_type is null then
      v_row_errors := v_row_errors || jsonb_build_object('row_id', v_row_id, 'field', 'customer', 'code', 'CUSTOMER_REQUIRED', 'message', 'A customer is required for a delivered invoice with due.');
    end if;

    if v_received is null then
      v_received := 0; -- keep downstream arithmetic well-defined; this row already carries an AMOUNT_INVALID error
    end if;

    v_prepared_customer_id := case when v_customer_type = 'quick_add' then gen_random_uuid() else v_customer_id end;
    v_prepared_payment_id := case when v_received > 0 then gen_random_uuid() else null end;

    v_prepared := v_prepared || jsonb_build_object(
      'row_id', v_row_id,
      'invoice_id', gen_random_uuid(),
      'invoice_number', v_display_number,
      'total', v_total,
      'received', v_received,
      'delivered', v_delivered,
      'note', v_note,
      'customer_type', v_customer_type,
      'customer_id', v_prepared_customer_id,
      'customer_name', v_customer_name,
      'customer_mobile', v_customer_mobile,
      'payment_id', v_prepared_payment_id
    );
  end loop;

  if jsonb_array_length(v_row_errors) > 0 then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001', detail = v_row_errors::text;
  end if;

  -- Every scalar in v_rows is now known to be well-shaped, so this cast-heavy
  -- helper is safe to call.
  v_canonical := private.canonical_batch_command(v_shop_id, v_business_date, v_is_backdated, v_backdated_reason, v_rows);
  v_fingerprint := encode(extensions.digest(v_canonical::text::bytea, 'sha256'), 'hex');
  -- Earlier batches used a canonical command without is_backdated. Preserve
  -- their stored fingerprint, but require the request flag to match the row.
  v_legacy_fingerprint := encode(extensions.digest((v_canonical - 'is_backdated')::text::bytea, 'sha256'), 'hex');

  -- Serialize concurrent calls for this exact (shop_id, idempotency_key) so
  -- the existing-row check below, rather than the batches INSERT unique
  -- constraint, is what a concurrent identical or conflicting retry
  -- observes. See "Design decisions", item 4.
  v_lock_key := hashtextextended(v_shop_id::text || ':' || v_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  select b.fingerprint, b.idempotency_result, b.is_backdated into v_existing
  from public.batches b
  where b.shop_id = v_shop_id and b.idempotency_key = v_idempotency_key;

  if found then
    if v_existing.fingerprint = v_fingerprint
      or (v_existing.fingerprint = v_legacy_fingerprint and v_existing.is_backdated = v_is_backdated) then
      if v_existing.is_backdated and v_actor_role is distinct from 'owner' then
        raise exception 'INSUFFICIENT_ROLE' using errcode = '42501';
      end if;
      return v_existing.idempotency_result;
    end if;
    raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'P0001';
  end if;

  if v_business_date > v_today then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'business_date', 'code', 'FUTURE_DATE_NOT_ALLOWED', 'message', 'Business date cannot be in the future.'))::text;
  end if;

  if v_business_date < v_today then
    if v_actor_role is distinct from 'owner' then
      raise exception 'INSUFFICIENT_ROLE' using errcode = '42501';
    end if;
    if not v_is_backdated or v_backdated_reason is null then
      raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
        detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'backdated_reason', 'code', 'BACKDATE_REASON_REQUIRED', 'message', 'A reason is required to submit a backdated batch.'))::text;
    end if;
  elsif v_is_backdated then
    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
      detail = jsonb_build_array(jsonb_build_object('row_id', null, 'field', 'is_backdated', 'code', 'BACKDATE_FLAG_INVALID', 'message', 'is_backdated may only be true for a date before today.'))::text;
  end if;

  select d.event_type into v_close_state
  from public.daily_closes d
  where d.shop_id = v_shop_id and d.business_date = v_business_date
  order by d.event_sequence desc
  limit 1;

  if v_close_state = 'closed' then
    raise exception 'CLOSED_DATE' using errcode = 'P0001';
  end if;

  -- Advisory-only: reject a doomed batch before creating anything for it.
  -- The registry's own unique constraint in the write loop below remains
  -- the authoritative defense against a genuinely concurrent registration.
  select array_agg(distinct r.normalized_invoice_number)
  into v_conflicting_numbers
  from public.invoice_number_registry r
  where r.shop_id = v_shop_id
    and r.normalized_invoice_number = any(v_seen_numbers);

  if v_conflicting_numbers is not null then
    select jsonb_agg(jsonb_build_object(
      'row_id', p ->> 'row_id', 'field', 'invoice_number',
      'code', 'INVOICE_NUMBER_ALREADY_REGISTERED',
      'message', 'This invoice number already exists in this shop.'
    ))
    into v_registry_conflicts
    from jsonb_array_elements(v_prepared) p
    where lower(p ->> 'invoice_number') = any(v_conflicting_numbers);

    raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001', detail = v_registry_conflicts::text;
  end if;

  -- WITH ORDINALITY + ORDER BY ordinality: jsonb_agg over a bare
  -- jsonb_array_elements() is not documented to preserve array order, so
  -- the response's `rows` array is made to preserve submitted row order
  -- explicitly rather than relying on incidental iteration order.
  select jsonb_agg(jsonb_build_object(
    'row_id', p ->> 'row_id',
    'invoice_id', p ->> 'invoice_id',
    'invoice_number', p ->> 'invoice_number',
    'customer_id', p ->> 'customer_id',
    'payment_id', p ->> 'payment_id'
  ) order by ord) into v_row_results
  from jsonb_array_elements(v_prepared) with ordinality as t(p, ord);

  v_result := jsonb_build_object(
    'ok', true,
    'batch_id', v_batch_id,
    'recorded_at', to_char(v_recorded_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'rows', v_row_results
  );

  insert into public.batches (
    id, shop_id, business_date, is_backdated, backdated_reason,
    idempotency_key, fingerprint, idempotency_result, created_by, recorded_at
  ) values (
    v_batch_id, v_shop_id, v_business_date, v_is_backdated, v_backdated_reason,
    v_idempotency_key, v_fingerprint, v_result, v_actor_id, v_recorded_at
  );

  for v_idx in 0 .. jsonb_array_length(v_prepared) - 1 loop
    v_prepared_row := v_prepared -> v_idx;

    if v_prepared_row ->> 'customer_type' = 'quick_add' then
      insert into public.customers (id, shop_id, name, mobile, created_by)
      values (
        (v_prepared_row ->> 'customer_id')::uuid, v_shop_id,
        v_prepared_row ->> 'customer_name', v_prepared_row ->> 'customer_mobile', v_actor_id
      );
    end if;

    begin
      insert into public.invoices (
        id, shop_id, batch_id, customer_id, invoice_id, delivered, note,
        total_amount_dirham, business_date, created_by, recorded_at
      ) values (
        (v_prepared_row ->> 'invoice_id')::uuid, v_shop_id, v_batch_id,
        nullif(v_prepared_row ->> 'customer_id', '')::uuid,
        v_prepared_row ->> 'invoice_number', (v_prepared_row ->> 'delivered')::boolean,
        v_prepared_row ->> 'note', (v_prepared_row ->> 'total')::bigint,
        v_business_date, v_actor_id, v_recorded_at
      );

      insert into public.invoice_number_registry (shop_id, invoice_number, canonical_invoice_id)
      values (v_shop_id, v_prepared_row ->> 'invoice_number', (v_prepared_row ->> 'invoice_id')::uuid);
    exception
      when unique_violation then
        raise exception 'BATCH_VALIDATION_FAILED' using errcode = 'P0001',
          detail = jsonb_build_array(jsonb_build_object(
            'row_id', v_prepared_row ->> 'row_id', 'field', 'invoice_number',
            'code', 'INVOICE_NUMBER_ALREADY_REGISTERED', 'message', 'This invoice number already exists in this shop.'
          ))::text;
    end;

    if (v_prepared_row ->> 'payment_id') is not null then
      insert into public.payments (
        id, shop_id, batch_id, invoice_id, amount_dirham, business_date, payment_method, created_by, recorded_at
      ) values (
        (v_prepared_row ->> 'payment_id')::uuid, v_shop_id, v_batch_id,
        (v_prepared_row ->> 'invoice_id')::uuid, (v_prepared_row ->> 'received')::bigint,
        v_business_date, 'cash', v_actor_id, v_recorded_at
      );
    end if;
  end loop;

  insert into public.audit_events (shop_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_shop_id, v_actor_id, 'batch.submit', 'batch', v_batch_id::text,
    jsonb_build_object('idempotency_key', v_idempotency_key, 'row_count', jsonb_array_length(v_rows))
  );

  return v_result;
end;
$$;

revoke all on function public.submit_batch(jsonb) from public, anon;
grant execute on function public.submit_batch(jsonb) to authenticated;
