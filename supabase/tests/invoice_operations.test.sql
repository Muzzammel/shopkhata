begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select has_table('public', 'replacement_requests', 'immutable replacement requests exist');
select has_table('public', 'replacement_decisions', 'immutable replacement decisions exist');
select has_table('public', 'correction_requests', 'financial requests exist');
select has_table('public', 'correction_decisions', 'financial decisions exist');
select has_view('public', 'effective_invoices', 'one authoritative effective invoice projection exists');

insert into public.invoices(id, shop_id, invoice_id, total_amount_dirham, business_date) values
('a9000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','OPS-OLD',10000,(now() at time zone 'Asia/Qatar')::date),
('a9000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','OPS-COLLISION',10000,(now() at time zone 'Asia/Qatar')::date),
('a9000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','OPS-NEW',10000,(now() at time zone 'Asia/Qatar')::date);
insert into public.invoice_number_registry(shop_id, invoice_number, canonical_invoice_id)
select shop_id, invoice_id, id from public.invoices where invoice_id like 'OPS-%';
insert into public.customers(id,shop_id,public_id,name) values
('c9000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','CUS-OPS','Operations customer');

create function pg_temp.req(kind text, key text, extra jsonb default '{}'::jsonb) returns jsonb language plpgsql as $$
declare cmd jsonb := jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001', 'invoice_id','a9000000-0000-4000-8000-000000000001','reason','Fix mistake','idempotency_key',key) || extra;
begin
if kind = 'replacement' then return public.request_invoice_replacement(jsonb_build_object('expected_revision',0,'invoice_number','OPS-NEW','customer_id','c9000000-0000-4000-8000-000000000001','delivered',true) || cmd);
else return public.request_invoice_correction(jsonb_build_object('amount_delta_dirham',-1000,'payment_id',null) || cmd); end if;
end $$;
create function pg_temp.decide(kind text, key text, request_key text, extra jsonb default '{}'::jsonb) returns jsonb language plpgsql as $$
declare rid uuid; cmd jsonb;
begin
if kind = 'replacement' then select id into rid from public.replacement_requests where idempotency_key=request_key;
else select id into rid from public.correction_requests where idempotency_key=request_key; end if;
cmd := jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001','request_id',rid,'expected_revision',0,'decision','approved','reason',null,'idempotency_key',key) || extra;
if kind = 'replacement' then return public.decide_invoice_replacement(cmd); else return public.decide_invoice_correction(cmd); end if;
end $$;

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
select lives_ok($$select pg_temp.req('replacement','r1')$$,'staff requests replacement');
select lives_ok($$select pg_temp.req('replacement','r1')$$,'exact request replay');
select is((select requested_by::text from public.replacement_requests where idempotency_key='r1'),'10000000-0000-4000-8000-000000000102','requester comes from authenticated identity');
select is((select count(*)::int from public.replacement_requests),1,'request once');
select throws_ok($$select pg_temp.req('replacement','r1','{"reason":"other"}')$$,'P0001','IDEMPOTENCY_CONFLICT','changed request conflicts');
select throws_ok($$select pg_temp.decide('replacement','d-staff','r1')$$,'42501','INSUFFICIENT_ROLE','staff cannot decide');
select lives_ok($$select pg_temp.req('financial','f1')$$,'staff requests financial correction');
select throws_ok($$select pg_temp.decide('financial','f-staff','f1')$$,'42501','INSUFFICIENT_ROLE','staff cannot approve financial correction');
select throws_ok($$select pg_temp.req('financial','blank','{"reason":" "}')$$,'P0001','INVALID_REQUEST','reason mandatory');
select throws_ok($$select pg_temp.req('replacement','money','{"total_amount_dirham":1}')$$,'P0001','INVALID_REQUEST','replacement rejects money input');
select throws_ok($$select pg_temp.req('replacement','cross','{"shop_id":"10000000-0000-4000-8000-000000000002"}')$$,'42501','UNAUTHORIZED_SHOP','request cannot cross shop');
select throws_ok($$select pg_temp.req('replacement','spoof','{"requested_by":"10000000-0000-4000-8000-000000000101"}')$$,'P0001','INVALID_REQUEST','cannot supply requester identity');
select throws_ok($$select pg_temp.req('replacement','customer-cross','{"customer_id":"c9000000-0000-4000-8000-000000000002"}')$$,'P0001','CUSTOMER_NOT_FOUND','customer must resolve in the same shop');
select throws_ok($$select pg_temp.req('financial','float','{"amount_delta_dirham":1.5}')$$,'P0001','INVALID_REQUEST','integer dirham only');
select is((select count(*)::int from public.effective_invoices where shop_id='10000000-0000-4000-8000-000000000002'),0,'effective projection respects RLS');
select throws_ok($$insert into public.replacement_requests default values$$,'42501',null,'direct request writes denied');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000101"}';
select lives_ok($$select pg_temp.decide('financial','fd1','f1')$$,'owner approves correction');
select lives_ok($$select pg_temp.decide('financial','fd1','f1')$$,'financial decision replay');
select is((select effective_total_dirham from public.effective_invoices where canonical_invoice_id='a9000000-0000-4000-8000-000000000001'),9000::bigint,'financial delta once');
select is((select count(*)::int from public.corrections where invoice_id='a9000000-0000-4000-8000-000000000001'),1,'one ledger correction');
select throws_ok($$select pg_temp.decide('financial','fd1','f1','{"decision":"rejected"}')$$,'P0001','IDEMPOTENCY_CONFLICT','decision fingerprint includes outcome');
select throws_ok($$select pg_temp.decide('financial','fd2','f1')$$,'P0001','ALREADY_DECIDED','different key cannot approve twice');
select lives_ok($$select pg_temp.req('replacement','collision','{"invoice_number":" ops-collision "}')$$,'collision request auditable');
select throws_ok($$select pg_temp.decide('replacement','collision-d','collision')$$,'P0001','NUMBER_ALREADY_REGISTERED','approval cannot steal another canonical number');
select is((select count(*)::int from public.replacement_decisions),0,'collision rolls back decision');
select lives_ok($$select pg_temp.decide('replacement','d1','r1')$$,'approve replacement in same shop despite same number elsewhere');
select lives_ok($$select pg_temp.decide('replacement','d1','r1')$$,'decision replay before stale revision checks');
select is((select revision from public.effective_invoices where canonical_invoice_id='a9000000-0000-4000-8000-000000000001'),1,'one linear revision');
select is((select effective_invoice_number from public.effective_invoices where canonical_invoice_id='a9000000-0000-4000-8000-000000000001'),'OPS-NEW','effective number');
select is((select original_invoice_number from public.effective_invoices where canonical_invoice_id='a9000000-0000-4000-8000-000000000001'),'OPS-OLD','original preserved');
select is((select count(*)::int from public.invoice_number_registry where canonical_invoice_id='a9000000-0000-4000-8000-000000000001'),2,'old and current numbers resolve to canonical invoice');
select throws_ok($$select pg_temp.decide('replacement','stale','collision')$$,'P0001','STALE_REVISION','competing request cannot branch version');
select lives_ok($$select pg_temp.decide('replacement','reject','collision','{"decision":"rejected","expected_revision":1}')$$,'stale request can be explicitly rejected');
select lives_ok($$select pg_temp.req('replacement','r2','{"expected_revision":1,"invoice_number":"OPS-NEW","delivered":false}')$$,'same canonical number reusable');
select lives_ok($$select pg_temp.decide('replacement','d2','r2','{"expected_revision":1}')$$,'customer/delivery-only approval');
select is((select count(*)::int from public.invoice_number_registry where canonical_invoice_id='a9000000-0000-4000-8000-000000000001'),2,'no duplicate reservation');
select is((select effective_total_dirham from public.effective_invoices where canonical_invoice_id='a9000000-0000-4000-8000-000000000001'),9000::bigint,'multiple versions do not multiply financial amounts');

select lives_ok($$select public.record_payment(jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001','invoice_id','a9000000-0000-4000-8000-000000000001','amount_dirham',2000,'payment_method','cash','business_date',(now() at time zone 'Asia/Qatar')::date,'idempotency_key','ops-pay'))$$,'follow-up payment uses corrected due');
select is((select effective_due_dirham from public.effective_invoices where canonical_invoice_id='a9000000-0000-4000-8000-000000000001'),7000::bigint,'payment and corrections reflected together');
select lives_ok($$select pg_temp.req('financial','negative','{"amount_delta_dirham":-99999}')$$,'invalid outcome request is auditable');
select throws_ok($$select pg_temp.decide('financial','negative-d','negative','{"expected_revision":2}')$$,'P0001','INVALID_FINANCIAL_RESULT','cannot approve negative total/due');
reset role;
select throws_ok($$update public.replacement_requests set reason='edit'$$,'55000',null,'request append-only even for database owner');
select throws_ok($$delete from public.replacement_decisions$$,'55000',null,'decisions append-only');
select throws_ok($$update public.correction_requests set reason='edit'$$,'55000',null,'financial requests append-only');
select throws_ok($$delete from public.correction_decisions$$,'55000',null,'financial decisions append-only');
select is((select invoice_id from public.invoices where id='a9000000-0000-4000-8000-000000000001'),'OPS-OLD','canonical row never changed');
select lives_ok($$select pg_temp.req('replacement','fk-pending','{"expected_revision":2,"invoice_number":"OPS-PENDING"}')$$,'pending request for FK boundary');
select throws_ok($$insert into public.replacement_decisions(shop_id,request_id,invoice_id,decision,expected_revision,revision,decided_by,idempotency_key,fingerprint)
values('10000000-0000-4000-8000-000000000002',(select id from public.replacement_requests where idempotency_key='fk-pending'),'a9000000-0000-4000-8000-000000000003','approved',0,1,'10000000-0000-4000-8000-000000000101','bad-fk','bad')$$,'23503',null,'decision composite FK cannot cross shop');
select throws_ok($$insert into public.replacement_requests(shop_id,invoice_id,expected_revision,invoice_number,customer_id,delivered,reason,requested_by,idempotency_key,fingerprint)
values('10000000-0000-4000-8000-000000000002','a9000000-0000-4000-8000-000000000003',0,'FK-CROSS','c9000000-0000-4000-8000-000000000001',true,'reason','10000000-0000-4000-8000-000000000101','fk','fp')$$,'23503',null,'request customer composite FK cannot cross shop');
select * from finish();
rollback;
