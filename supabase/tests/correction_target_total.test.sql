begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- An invoice-total correction states the corrected total; the database derives the delta.
insert into public.invoices(id, shop_id, invoice_id, total_amount_dirham, business_date) values
('ac000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','TGT-1',100000,(now() at time zone 'Asia/Qatar')::date);
insert into public.invoice_number_registry(shop_id, invoice_number, canonical_invoice_id)
values ('10000000-0000-4000-8000-000000000001','TGT-1','ac000000-0000-4000-8000-000000000001');

create function pg_temp.total() returns bigint language sql as $$
  select effective_total_dirham from public.effective_invoices where canonical_invoice_id='ac000000-0000-4000-8000-000000000001' $$;
create function pg_temp.req(key text, expected bigint, corrected bigint, extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select public.request_invoice_correction(jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001','invoice_id','ac000000-0000-4000-8000-000000000001',
    'payment_id',null,'expected_total_dirham',expected,'corrected_total_dirham',corrected,'reason','Fix total','idempotency_key',key) || extra) $$;
create function pg_temp.decide(key text, request_key text, outcome text default 'approved') returns jsonb language sql as $$
  select public.decide_invoice_correction(jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001',
    'request_id',(select id from public.correction_requests where idempotency_key=request_key),'expected_revision',0,'decision',outcome,'reason',null,'idempotency_key',key)) $$;
create function pg_temp.act(who text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',
    case who when 'owner' then '10000000-0000-4000-8000-000000000101' else '10000000-0000-4000-8000-000000000102' end)::text, true) $$;

set local role authenticated;
select pg_temp.act('staff');

-- 1. 1000 -> 1500 is 1500, never 2500.
select lives_ok($$select pg_temp.req('up',100000,150000)$$,'staff requests a corrected total of 1500 on a 1000 invoice');
select is((select amount_delta_dirham from public.correction_requests where idempotency_key='up'),50000::bigint,'the database derives a delta of +500, not +1500');
select is((select pg_temp.req('up',100000,150000)->>'request_id'),(select id::text from public.correction_requests where idempotency_key='up'),'an exact retry returns the same request');
select is((select count(*)::int from public.correction_requests where invoice_id='ac000000-0000-4000-8000-000000000001'),1,'a retry stores nothing more');
select throws_ok($$select pg_temp.req('up',100000,160000)$$,'P0001','IDEMPOTENCY_CONFLICT','the same key with another total is a conflict');
select is(pg_temp.total(),100000::bigint,'nothing takes effect before approval');
select pg_temp.act('owner');
select lives_ok($$select pg_temp.decide('up-d','up')$$,'owner approves');
select lives_ok($$select pg_temp.decide('up-d','up')$$,'an exact decision retry is accepted');
select is(pg_temp.total(),150000::bigint,'the effective total is exactly 1500');
select is((select count(*)::int from public.corrections where invoice_id='ac000000-0000-4000-8000-000000000001'),1,'one ledger row, not one per retry');
select is((select total_amount_dirham from public.invoices where id='ac000000-0000-4000-8000-000000000001'),100000::bigint,'the original invoice row is unchanged');

-- 2. Invalid requests are refused by the database, whatever the client calculated.
select pg_temp.act('staff');
select lives_ok($$select public.record_payment(jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001','invoice_id','ac000000-0000-4000-8000-000000000001','amount_dirham',40000,'payment_method','cash','business_date',(now() at time zone 'Asia/Qatar')::date,'idempotency_key','tgt-pay'))$$,'a payment of 400 is recorded');
select throws_ok($$select pg_temp.req('below',150000,39999)$$,'P0001','INVALID_FINANCIAL_RESULT','a total below what is already paid is refused');
select throws_ok($$select pg_temp.req('same',150000,150000)$$,'P0001','CORRECTION_NO_CHANGE','an unchanged total is refused');
select throws_ok($$select pg_temp.req('stale',100000,120000)$$,'P0001','STALE_TOTAL','a request made against an outdated total is refused');
select throws_ok($$select pg_temp.req('both',150000,120000,'{"amount_delta_dirham":-30000}')$$,'P0001','INVALID_REQUEST','a corrected total and a delta cannot be combined');
select throws_ok($$select pg_temp.req('float',150000,120000,'{"corrected_total_dirham":1200.5}')$$,'P0001','INVALID_REQUEST','whole dirham only');
select throws_ok($$select pg_temp.req('negative',150000,-1)$$,'P0001','INVALID_REQUEST','a corrected total cannot be negative');

-- 3. 1500 -> 1000 is 1000, and a second request against the old total cannot stack on top.
select lives_ok($$select pg_temp.req('down',150000,100000)$$,'staff requests a corrected total of 1000 on the 1500 invoice');
select lives_ok($$select pg_temp.req('other',150000,120000)$$,'a competing request against the same total is recorded');
select pg_temp.act('owner');
select lives_ok($$select pg_temp.decide('down-d','down')$$,'owner approves the decrease');
select is((select effective_due_dirham from public.effective_invoices where canonical_invoice_id='ac000000-0000-4000-8000-000000000001'),60000::bigint,'total 1000, paid 400, due 600');
select throws_ok($$select pg_temp.decide('other-d','other')$$,'P0001','STALE_TOTAL','the competing request is stale and cannot be approved');

reset role;
select throws_ok($$insert into public.correction_requests(shop_id,invoice_id,amount_delta_dirham,expected_total_dirham,corrected_total_dirham,reason,requested_by,idempotency_key,fingerprint)
values('10000000-0000-4000-8000-000000000001','ac000000-0000-4000-8000-000000000001',150000,100000,150000,'r','10000000-0000-4000-8000-000000000102','forged','fp')$$,'23514',null,'a stored delta must equal corrected minus expected');

select * from finish();
rollback;
