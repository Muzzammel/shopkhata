begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

insert into public.customers(id,shop_id,name,mobile,created_by) values
 ('c1000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Ledger Customer','55510001','10000000-0000-4000-8000-000000000102'),
 ('c2000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Other Shop Customer','55520002','10000000-0000-4000-8000-000000000103');
insert into public.invoices(id,shop_id,customer_id,invoice_id,total_amount_dirham,business_date,delivered,created_by) values
 ('a1000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','INV-101',300,current_date-2,true,'10000000-0000-4000-8000-000000000102'),
 ('a1000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','INV-105',200,current_date-1,true,'10000000-0000-4000-8000-000000000102'),
 ('a1000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','INV-CREDIT-SOURCE',50,current_date,true,'10000000-0000-4000-8000-000000000102');
create temporary table test_payment_result(result jsonb);
create temporary table test_credit_result(result jsonb);
create temporary table test_expense_result(result jsonb);
create temporary table test_correction_result(result jsonb);

set local role authenticated;
set local request.jwt.claims='{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';

select is((select count(*)::int from public.customers where shop_id='10000000-0000-4000-8000-000000000002'),0,'Shop 1 staff cannot read Shop 2 customers');
select throws_ok($$select public.record_customer_payment(jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000002','customer_id','c2000000-0000-4000-8000-000000000002','amount_dirham',1,'business_date',current_date::text,'idempotency_key','cross-shop'))$$,'42501',null,'customer payment RPC rejects a different shop');
select ok((public.create_customer(jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001','name','New Customer','mobile','55510003'))->>'ok')::boolean,'staff can create an identified shop customer');
select throws_ok($$select public.create_customer(jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001','name','Ledger Customer','mobile','55510001'))$$,'P0001','DUPLICATE_CUSTOMER','duplicate shop customer is explicitly rejected');

insert into test_payment_result select public.record_customer_payment(jsonb_build_object(
 'shop_id','10000000-0000-4000-8000-000000000001','customer_id','c1000000-0000-4000-8000-000000000001',
 'amount_dirham',400,'business_date',current_date::text,'idempotency_key','customer-payment-1'));
select ok((select result->>'ok'='true' from test_payment_result),'one customer payment is committed');
select is((select result->'allocations'->0->>'invoice_number' from test_payment_result),'INV-101','oldest business-date invoice is allocated first');
select is((select (result->'allocations'->0->>'amount_dirham')::int from test_payment_result),300,'first invoice is paid only up to its due');
select is((select result->'allocations'->1->>'invoice_number' from test_payment_result),'INV-105','next invoice receives the remaining amount');
select is((select (result->'allocations'->1->>'amount_dirham')::int from test_payment_result),100,'second invoice receives only the balance');
select is((select effective_due_dirham from public.effective_invoices where canonical_invoice_id='a1000000-0000-4000-8000-000000000002'),100::bigint,'second invoice retains its unpaid due');
select is((select outstanding_due_dirham from public.customer_financial_balances where shop_id='10000000-0000-4000-8000-000000000001' and customer_id='c1000000-0000-4000-8000-000000000001'),150::bigint,'customer due equals all remaining invoice obligations');
select is((select sum(debit_dirham-credit_dirham)::bigint from public.customer_ledger where shop_id='10000000-0000-4000-8000-000000000001' and customer_id='c1000000-0000-4000-8000-000000000001'),150::bigint,'ledger net balance reconciles to the customer balance');
select is((select count(*)::int from public.payments where customer_payment_batch_id=(select result->>'batch_id' from test_payment_result)),2,'one immutable payment allocation exists per affected invoice');
select is((public.record_customer_payment(jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001','customer_id','c1000000-0000-4000-8000-000000000001','amount_dirham',400,'business_date',current_date::text,'idempotency_key','customer-payment-1'))->>'batch_id'),(select result->>'batch_id' from test_payment_result),'an exact customer-payment retry returns its original batch');
select throws_ok($$select public.record_customer_payment(jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001','customer_id','c1000000-0000-4000-8000-000000000001','amount_dirham',151,'business_date',current_date::text,'idempotency_key','customer-payment-too-large'))$$,'P0001','AMOUNT_EXCEEDS_DUE','customer payment cannot exceed authoritative due');

reset role;
set local role authenticated;
set local request.jwt.claims='{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000104"}';
insert into test_credit_result select public.approve_overpayment(jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001','invoice_id','a1000000-0000-4000-8000-000000000003','amount_dirham',80,'payment_method','cash','business_date',current_date::text,'idempotency_key','credit-issue-1','reason','approved customer overpayment'));
select is((select (result->>'credit_amount')::int from test_credit_result),30,'approved excess payment is the only source of customer credit');
select is((select available_credit_dirham from public.customer_financial_balances where shop_id='10000000-0000-4000-8000-000000000001' and customer_id='c1000000-0000-4000-8000-000000000001'),30::bigint,'available credit derives from approved overpayments');
select ok((public.apply_customer_credit(jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001','customer_id','c1000000-0000-4000-8000-000000000001','amount_dirham',30,'business_date',current_date::text,'idempotency_key','credit-apply-1'))->>'ok')::boolean,'credit applies atomically to due');
select is((select effective_credit_applied_dirham from public.effective_invoices where canonical_invoice_id='a1000000-0000-4000-8000-000000000002'),30::bigint,'effective invoice projection exposes applied credit separately from cash paid');
select is((select effective_due_dirham from public.effective_invoices where canonical_invoice_id='a1000000-0000-4000-8000-000000000002'),70::bigint,'effective invoice due subtracts applied credit');
select is((select available_credit_dirham from public.customer_financial_balances where shop_id='10000000-0000-4000-8000-000000000001' and customer_id='c1000000-0000-4000-8000-000000000001'),0::bigint,'applied credit is no longer available');
select is((select outstanding_due_dirham from public.customer_financial_balances where shop_id='10000000-0000-4000-8000-000000000001' and customer_id='c1000000-0000-4000-8000-000000000001'),70::bigint,'customer balance reconciles after credit application');
select is((select sum(debit_dirham-credit_dirham)::bigint from public.customer_ledger where shop_id='10000000-0000-4000-8000-000000000001' and customer_id='c1000000-0000-4000-8000-000000000001'),70::bigint,'ledger includes applied customer credit');
reset role;

set local role authenticated;
set local request.jwt.claims='{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000102"}';
insert into test_expense_result select public.create_expense(jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001','amount_dirham',100,'business_date',current_date::text,'category','supplies','description','Receipt paper','idempotency_key','expense-create-1'));
select ok((select result->>'ok'='true' from test_expense_result),'staff can create a shop expense');
select is((public.create_expense(jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001','amount_dirham',100,'business_date',current_date::text,'category','supplies','description','Receipt paper','idempotency_key','expense-create-1'))->>'expense_id'),(select result->>'expense_id' from test_expense_result),'expense retry returns the original record');
select is((select count(*)::int from public.expenses where idempotency_key='expense-create-1'),1,'expense retry does not duplicate history');
select ok(not has_table_privilege('authenticated','public.expenses','INSERT'),'staff cannot bypass the expense RPC');
insert into test_correction_result select public.request_expense_correction(jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001','expense_id',(select result->>'expense_id' from test_expense_result),'amount_dirham',150,'category','utilities','description','Corrected receipt paper expense','reason','entered amount and category were incorrect','idempotency_key','expense-correction-request-1'));
select ok((select result->>'ok'='true' from test_correction_result),'staff can request an expense correction with a reason');
select is((select amount_dirham from public.effective_expenses where id=(select result->>'expense_id' from test_expense_result)::uuid),100::bigint,'pending correction does not change the effective expense');
select throws_ok($$select public.decide_expense_correction(jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001','request_id',(select result->>'request_id' from test_correction_result),'decision','approved','idempotency_key','expense-correction-decision-staff'))$$,'42501',null,'staff cannot approve an expense correction');
reset role;
set local role authenticated;
set local request.jwt.claims='{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000104"}';
select ok((public.decide_expense_correction(jsonb_build_object('shop_id','10000000-0000-4000-8000-000000000001','request_id',(select result->>'request_id' from test_correction_result),'decision','approved','reason','verified receipt','idempotency_key','expense-correction-decision-manager'))->>'ok')::boolean,'manager can approve a correction');
select is((select amount_dirham from public.effective_expenses where id=(select result->>'expense_id' from test_expense_result)::uuid),150::bigint,'approved expense correction changes the effective amount without rewriting the source');
select is((select category from public.effective_expenses where id=(select result->>'expense_id' from test_expense_result)::uuid),'utilities','approved category correction is effective');

select * from finish();
rollback;
