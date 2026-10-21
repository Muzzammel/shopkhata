-- BANK PAYMENT METHOD: money received is either cash or bank.
--
-- Until now every receipt was forced to 'cash' by the RPCs and nothing in the
-- database constrained payments.payment_method. This migration:
--   1. constrains payments.payment_method to ('cash','bank') and leaves every
--      existing row and default as it is (all history is cash),
--   2. records the tender of an approved overpayment on its customer_credits row,
--      so the part held as credit is attributed to the same method as the payment,
--   3. lets submit_batch, record_payment, approve_overpayment and
--      record_customer_payment accept 'bank',
--   4. makes the reports attribute payment corrections and overpayment credit to
--      the original tender, and splits the daily summary into cash, bank and total.
-- No amount, date, allocation order or idempotency result of an existing record changes.
-- Applying credit (credit_applications) is not a receipt and stays out of both methods.

-- 1. Database-side validation -------------------------------------------------------
-- NOT VALID then VALIDATE: the migration fails (and rolls back) if any row holds
-- another value, instead of silently accepting it.
alter table public.payments
  add constraint payments_payment_method_check check (payment_method in ('cash', 'bank')) not valid;
alter table public.payments validate constraint payments_payment_method_check;

-- 2. Tender of the credit created by an overpayment ---------------------------------
-- Existing credits were all created from cash, which is the default.
alter table public.customer_credits
  add column payment_method text not null default 'cash' check (payment_method in ('cash', 'bank'));

-- 3. RPCs ---------------------------------------------------------------------------
-- Each function is re-created from its stored definition with exact-once text
-- substitutions, so every other line stays exactly as deployed. The migration
-- stops if an anchor is not found exactly once.
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
      raise exception 'bank_payment_method: % edit % did not match exactly once', p_signature, i;
    end if;
    def := replace(def, anchor, p_edits[2 * i]);
  end loop;
  execute def;
end
$redefine$;

-- submit_batch: validate against both methods and store the row's own method.
-- The canonical batch command (the idempotency fingerprint) already hashes each
-- paid row's payment_method, so Cash and Bank can never share a retry key.
select pg_temp.redefine('public.submit_batch(jsonb)', array[
  $a$v_received > 0 and v_payment_method is distinct from 'cash' then$a$,
  $b$v_received > 0 and (v_payment_method is null or v_payment_method not in ('cash', 'bank')) then$b$,
  $a$'Only the cash payment method is supported.'$a$,
  $b$'payment_method must be cash or bank.'$b$,
  $a$'payment_id', v_prepared_payment_id$a$,
  $b$'payment_id', v_prepared_payment_id,
      'payment_method', v_payment_method$b$,
  $a$v_business_date, 'cash', v_actor_id, v_recorded_at$a$,
  $b$v_business_date, v_prepared_row ->> 'payment_method', v_actor_id, v_recorded_at$b$
]);

-- record_payment: payment_method stays a required string; 'bank' is now valid.
-- canonical_payment_command already hashes the method.
select pg_temp.redefine('public.record_payment(jsonb)', array[
  $a$if v_payment_method is distinct from 'cash' then$a$,
  $b$if v_payment_method is null or v_payment_method not in ('cash', 'bank') then$b$,
  $a$'payment_method must be cash.'$a$,
  $b$'payment_method must be cash or bank.'$b$
]);

-- approve_overpayment: same validation; the credit row carries the payment's tender.
select pg_temp.redefine('public.approve_overpayment(jsonb)', array[
  $a$if v_payment_method is distinct from 'cash' then$a$,
  $b$if v_payment_method is null or v_payment_method not in ('cash', 'bank') then$b$,
  $a$'payment_method must be cash.'$a$,
  $b$'payment_method must be cash or bank.'$b$,
  $a$reason, recorded_at, created_by, approved_by, approved_at$a$,
  $b$reason, recorded_at, created_by, approved_by, approved_at, payment_method$b$,
  $a$v_reason, v_recorded_at, v_actor_id, v_actor_id, v_recorded_at$a$,
  $b$v_reason, v_recorded_at, v_actor_id, v_actor_id, v_recorded_at, v_payment_method$b$
]);

-- record_customer_payment: optional payment_method, default cash, so a command
-- without it behaves exactly as before. The fingerprint only gains the method
-- when it is not cash, which keeps every stored cash fingerprint valid for replay
-- and makes a Bank retry of a Cash key an IDEMPOTENCY_CONFLICT (and vice versa).
-- FIFO allocation is untouched: the method is only written onto the payment rows.
select pg_temp.redefine('public.record_customer_payment(jsonb)', array[
  $a$declare sid uuid;$a$,
  $b$declare mth text:='cash'; sid uuid;$b$,
  $a$array['shop_id','customer_id','amount_dirham','business_date','idempotency_key'])$a$,
  $b$array['shop_id','customer_id','amount_dirham','business_date','idempotency_key','payment_method'])$b$,
  $a$ dt:=(command->>'business_date')::date;$a$,
  $b$ dt:=(command->>'business_date')::date;
 if command ? 'payment_method' then
  if jsonb_typeof(command->'payment_method') is distinct from 'string' or command->>'payment_method' not in ('cash','bank') then raise exception 'INVALID_PAYMENT_METHOD' using errcode='P0001'; end if;
  mth:=command->>'payment_method';
 end if;$b$,
  $a$fp:=encode(extensions.digest(jsonb_build_object('shop_id',sid,'customer_id',cid,'amount_dirham',amt,'business_date',dt)::text::bytea,'sha256'),'hex');$a$,
  $b$fp:=encode(extensions.digest((jsonb_build_object('shop_id',sid,'customer_id',cid,'amount_dirham',amt,'business_date',dt)||case when mth='cash' then '{}'::jsonb else jsonb_build_object('payment_method',mth) end)::text::bytea,'sha256'),'hex');$b$,
  $a$values(sid,inv.canonical_invoice_id,take,dt,'cash',auth.uid(),batch)$a$,
  $b$values(sid,inv.canonical_invoice_id,take,dt,mth,auth.uid(),batch)$b$,
  $a$jsonb_build_object('customer_id',cid,'amount_dirham',amt,'allocations',allocations))$a$,
  $b$jsonb_build_object('customer_id',cid,'amount_dirham',amt,'payment_method',mth,'allocations',allocations))$b$
]);

-- 4. Reports ------------------------------------------------------------------------
-- A payment correction belongs to the tender of the payment it corrects; an
-- overpayment credit to the tender recorded on the credit. Same columns and rows.
create or replace view public.report_payments with (security_invoker = true) as
select p.shop_id, p.id entry_id, p.business_date, p.recorded_at,
  case when p.batch_id is not null then 'invoice_entry' when p.customer_payment_batch_id is not null then 'customer_payment' else 'follow_up' end source,
  p.payment_method method, p.amount_dirham, p.invoice_id, p.created_by,
  coalesce(p.customer_payment_batch_id, p.id)::text reference
from public.payments p
union all
select c.shop_id, c.id, c.business_date, c.recorded_at, 'payment_correction',
  (select p.payment_method from public.payments p where p.shop_id = c.shop_id and p.id = c.payment_id), c.amount_delta_dirham,
  (select p.invoice_id from public.payments p where p.shop_id = c.shop_id and p.id = c.payment_id), c.approved_by, c.payment_id::text
from public.corrections c where c.payment_id is not null and c.approved_by is not null
union all
select cc.shop_id, cc.id, cc.business_date, cc.recorded_at, 'overpayment_credit', cc.payment_method, cc.amount_dirham, cc.invoice_id, cc.created_by, cc.id::text
from public.customer_credits cc where cc.approved_by is not null
union all
select a.shop_id, a.id, a.business_date, a.recorded_at, 'credit_application', 'credit', a.amount_dirham, a.invoice_id, a.created_by, a.credit_id::text
from public.credit_applications a;

-- The daily summary gains bank_received and total_received. cash_received now means
-- cash only; total_received is the former cash_received (every receipt, either method)
-- and is also what net_cash_movement subtracts expenses from, so no existing figure changes
-- until a bank receipt exists. Expenses carry no method.
drop function public.report_daily_summary(uuid, date, date);
create function public.report_daily_summary(p_shop_id uuid, p_from date, p_to date)
returns table(
  business_date date, invoice_count bigint, gross_invoice_dirham bigint, initial_received_dirham bigint,
  due_created_dirham bigint, followup_payments_dirham bigint, customer_payments_dirham bigint,
  payment_corrections_dirham bigint, invoice_corrections_dirham bigint, credit_created_dirham bigint,
  credit_applied_dirham bigint, expense_count bigint, expenses_dirham bigint, cash_received_dirham bigint,
  bank_received_dirham bigint, total_received_dirham bigint,
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
  ), bank_flows as (
    select p.business_date d, sum(p.amount_dirham) amount
    from public.payments p where p.shop_id = p_shop_id and p.business_date between p_from and p_to and p.payment_method = 'bank' group by 1
    union all
    select c.business_date, sum(c.amount_delta_dirham)
    from public.corrections c join public.payments p on p.shop_id = c.shop_id and p.id = c.payment_id
    where c.shop_id = p_shop_id and c.business_date between p_from and p_to and c.approved_by is not null and p.payment_method = 'bank' group by 1
    union all
    select cc.business_date, sum(cc.amount_dirham)
    from public.customer_credits cc
    where cc.shop_id = p_shop_id and cc.business_date between p_from and p_to and cc.approved_by is not null and cc.payment_method = 'bank' group by 1
  ), bank_days as (
    select d, sum(amount)::bigint amount from bank_flows group by d
  ), totals as (
    select days.*, initial_received + followup + customer_paid + payment_corrections + credit_created received from days
  )
  select t.d, t.invoice_count, t.gross, t.initial_received, t.gross - t.initial_received, t.followup, t.customer_paid, t.payment_corrections,
    t.invoice_corrections, t.credit_created, t.credit_applied, t.expense_count, t.expenses,
    t.received - coalesce(b.amount, 0), coalesce(b.amount, 0), t.received,
    t.received - t.expenses,
    t.gross + t.invoice_corrections - t.initial_received - t.followup - t.customer_paid - t.payment_corrections - t.credit_applied
  from totals t left join bank_days b on b.d = t.d order by t.d
$$;
revoke all on function public.report_daily_summary(uuid, date, date) from public, anon;
grant execute on function public.report_daily_summary(uuid, date, date) to authenticated;
