import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { qatarBusinessDate } from "@/lib/invoice-entry";

const SHOP1="10000000-0000-4000-8000-000000000001";const SHOP2="10000000-0000-4000-8000-000000000002";
const PNPM=process.platform==="win32"?"pnpm.cmd":"pnpm";const SUITE_TIMEOUT=120_000;
type Failure=Error&{stdout?:string;stderr?:string};
function run(args:string[],timeout=90_000){const win=process.platform==="win32";try{return execFileSync(win?(process.env.ComSpec??"cmd.exe"):PNPM,win?["/d","/s","/c","call",PNPM,...args]:args,{encoding:"utf8",timeout,stdio:["ignore","pipe","pipe"],env:{...process.env,PATH:`${join(process.cwd(),"node_modules",".bin")}${delimiter}${process.env.PATH??""}`}});}catch(error){const failure=error as Failure;throw new Error(`Command failed: ${PNPM} ${args.join(" ")}\n${failure.stdout??""}\n${failure.stderr??failure.message}`);}}
function supabase(args:string[],timeout=90_000){return run(["exec","supabase","--agent","no",...args],timeout);}
function parseEnv(output:string){return Object.fromEntries(output.split(/\r?\n/).flatMap((line)=>{const m=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);return m?[[m[1],m[2].replace(/^"|"$/g,"")]]:[]}));}
function key(){return crypto.randomUUID();}

describe("customer ledger, allocated payments, governed credit and expenses",()=>{
 let available=false;let credentials={url:"",key:""};let staff:SupabaseClient;let staff2:SupabaseClient;let manager:SupabaseClient;
 beforeAll(async()=>{
  try{supabase(["migration","list","--local"],30_000);}catch{throw new Error("Prerequisite: local Supabase and Docker must be running.");}
  available=true;supabase(["db","reset","--local"]);const env=parseEnv(supabase(["status","-o","env"],30_000));credentials={url:env.API_URL,key:env.PUBLISHABLE_KEY??env.ANON_KEY};
  async function login(email:string,password:string){const client=createClient(credentials.url,credentials.key);const {error}=await client.auth.signInWithPassword({email,password});if(error)throw error;return client;}
  [staff,staff2,manager]=await Promise.all([login("staff1@shopkhata.local","ShopKhata-Local-E2E-Only-2026!"),login("staff2@shopkhata.local","ShopKhata-Local-Shop2-E2E-Only-2026!"),login("manager@shopkhata.local","ShopKhata-Local-Manager-E2E-Only-2026!")]);
 },SUITE_TIMEOUT);
 afterAll(()=>{if(available)supabase(["db","reset","--local"]);},SUITE_TIMEOUT);
 async function newCustomer(client:SupabaseClient,label:string,shopId=SHOP1){const {data,error}=await client.rpc("create_customer",{command:{shop_id:shopId,name:`Integration ${label} ${key()}`,mobile:null}});if(error)throw error;return data.customer_id as string;}
 async function invoice(client:SupabaseClient,customerId:string,label:string,total:number,shopId=SHOP1){const number=`IT-CUST-${label}-${key().slice(0,8)}`;const {data,error}=await client.rpc("submit_batch",{command:{shop_id:shopId,business_date:qatarBusinessDate(new Date()),idempotency_key:key(),rows:[{row_id:"row-1",invoice_number:number,total_dirham:total,received_dirham:0,payment_method:"cash",delivered:true,customer:{type:"existing",customer_id:customerId}}]}});if(error)throw error;return data.rows[0].invoice_id as string;}

 it("serializes overlapping customer payments and reconciles ledger with effective invoice due",async()=>{
  const customer=await newCustomer(staff,"payment-race");await invoice(staff,customer,"race-a",300);await invoice(staff,customer,"race-b",200);
  const businessDate=qatarBusinessDate(new Date());const attempts=await Promise.all(["race-1","race-2"].map((label)=>staff.rpc("record_customer_payment",{command:{shop_id:SHOP1,customer_id:customer,amount_dirham:400,business_date:businessDate,idempotency_key:`${label}-${key()}`}})));
  expect(attempts.filter((r)=>!r.error)).toHaveLength(1);expect(attempts.filter((r)=>r.error?.message==="AMOUNT_EXCEEDS_DUE")).toHaveLength(1);
  const {data:balance,error}=await staff.from("customer_financial_balances").select("outstanding_due_dirham").eq("shop_id",SHOP1).eq("customer_id",customer).single();expect(error).toBeNull();expect(balance?.outstanding_due_dirham).toBe(100);
  const {data:invoices,error:invoiceError}=await staff.from("effective_invoices").select("effective_due_dirham").eq("shop_id",SHOP1).eq("effective_customer_id",customer);expect(invoiceError).toBeNull();expect(invoices?.reduce((sum,row)=>sum+(row.effective_due_dirham??0),0)).toBe(balance?.outstanding_due_dirham);
  const {data:ledger,error:ledgerError}=await staff.from("customer_ledger").select("debit_dirham,credit_dirham").eq("shop_id",SHOP1).eq("customer_id",customer);expect(ledgerError).toBeNull();expect(ledger?.reduce((sum,row)=>sum+(row.debit_dirham??0)-(row.credit_dirham??0),0)).toBe(balance?.outstanding_due_dirham);
 });

 it("locks approved customer credit so two concurrent applications cannot consume it twice",async()=>{
  const customer=await newCustomer(staff,"credit-race");const source=await invoice(staff,customer,"credit-source",100);await invoice(staff,customer,"credit-due",200);
  const {error:issueError}=await manager.rpc("approve_overpayment",{command:{shop_id:SHOP1,invoice_id:source,amount_dirham:200,payment_method:"cash",business_date:qatarBusinessDate(new Date()),idempotency_key:key(),reason:"approved excess tender"}});expect(issueError).toBeNull();
  const results=await Promise.all([1,2].map(()=>staff.rpc("apply_customer_credit",{command:{shop_id:SHOP1,customer_id:customer,amount_dirham:80,business_date:qatarBusinessDate(new Date()),idempotency_key:key()}})));
  expect(results.filter((result)=>!result.error)).toHaveLength(1);expect(results.filter((result)=>result.error?.message==="CREDIT_OR_DUE_INSUFFICIENT")).toHaveLength(1);
  const {data:balance}=await staff.from("customer_financial_balances").select("available_credit_dirham,outstanding_due_dirham").eq("shop_id",SHOP1).eq("customer_id",customer).single();expect(balance?.available_credit_dirham).toBe(20);expect(balance?.outstanding_due_dirham).toBe(120);
 });

 it("keeps expense retries idempotent, corrections governed, and attachments private by shop",async()=>{
  const businessDate=qatarBusinessDate(new Date());const expenseKey=key();const command={shop_id:SHOP1,amount_dirham:250,business_date:businessDate,category:"supplies",description:"Receipt expense",idempotency_key:expenseKey};
  const [first,retry]=await Promise.all([staff.rpc("create_expense",{command}),staff.rpc("create_expense",{command})]);expect(first.error).toBeNull();expect(retry.error).toBeNull();expect(retry.data.expense_id).toBe(first.data.expense_id);
  const expenseId=first.data.expense_id as string;const request=await staff.rpc("request_expense_correction",{command:{shop_id:SHOP1,expense_id:expenseId,amount_dirham:300,category:"utilities",description:"Corrected utility receipt",reason:"Entered amount incorrectly",idempotency_key:key()}});expect(request.error).toBeNull();
  const denied=await staff.rpc("decide_expense_correction",{command:{shop_id:SHOP1,request_id:request.data.request_id,decision:"approved",idempotency_key:key()}});expect(denied.error?.message).toBe("INSUFFICIENT_ROLE");
  const approved=await manager.rpc("decide_expense_correction",{command:{shop_id:SHOP1,request_id:request.data.request_id,decision:"approved",idempotency_key:key()}});expect(approved.error).toBeNull();
  const {data:effective}=await staff.from("effective_expenses").select("amount_dirham,category").eq("shop_id",SHOP1).eq("id",expenseId).single();expect(effective?.amount_dirham).toBe(300);expect(effective?.category).toBe("utilities");
  const path=`${SHOP1}/${expenseId}/${key()}.png`;expect(path).toMatch(new RegExp(`^${SHOP1}/${expenseId}/[0-9a-f-]{36}\\.png$`));const upload=await staff.storage.from("expense-receipts").upload(path,new Uint8Array([137,80,78,71]),{contentType:"image/png"});expect(upload.error).toBeNull();
  const invalidType=await staff.storage.from("expense-receipts").upload(`${SHOP1}/${expenseId}/${key()}.txt`,new Uint8Array([1]),{contentType:"text/plain"});expect(invalidType.error).not.toBeNull();
  const oversized=await staff.storage.from("expense-receipts").upload(`${SHOP1}/${expenseId}/${key()}.pdf`,new Uint8Array(10*1024*1024+1),{contentType:"application/pdf"});expect(oversized.error).not.toBeNull();
  const crossShopUpload=await staff2.storage.from("expense-receipts").upload(`${SHOP1}/${expenseId}/${key()}.png`,new Uint8Array([1]),{contentType:"image/png"});expect(crossShopUpload.error).not.toBeNull();
  const receiptKey=key();const metadata={shop_id:SHOP1,expense_id:expenseId,file_path:path,file_name:"receipt.png",content_type:"image/png",byte_size:4,idempotency_key:receiptKey};
  const [registered,duplicate]=await Promise.all([staff.rpc("register_expense_attachment",{command:metadata}),staff.rpc("register_expense_attachment",{command:metadata})]);expect(registered.error).toBeNull();expect(duplicate.error).toBeNull();expect(duplicate.data.attachment_id).toBe(registered.data.attachment_id);
  const signed=await staff.storage.from("expense-receipts").createSignedUrl(path,60);expect(signed.error).toBeNull();const read=await staff.storage.from("expense-receipts").download(path);expect(read.error).toBeNull();expect(read.data?.size).toBe(4);
  const crossShop=await staff2.storage.from("expense-receipts").createSignedUrl(path,60);expect(crossShop.error).not.toBeNull();
  const foreignExpense=await staff2.from("expenses").select("id").eq("shop_id",SHOP1).eq("id",expenseId);expect(foreignExpense.data).toEqual([]);
  const {count}=await staff.from("attachments").select("id",{count:"exact",head:true}).eq("shop_id",SHOP1).eq("file_path",path);expect(count).toBe(1);
 });

 it("prevents cross-shop customer discovery through RLS and rejects shop injection",async()=>{
  const foreignCustomer=await newCustomer(staff2,"foreign",SHOP2);
  const {data}=await staff.from("customers").select("id").eq("shop_id",SHOP2).eq("id",foreignCustomer);expect(data).toEqual([]);
  const result=await staff.rpc("record_customer_payment",{command:{shop_id:SHOP2,customer_id:foreignCustomer,amount_dirham:1,business_date:qatarBusinessDate(new Date()),idempotency_key:key()}});expect(result.error?.message).toBe("UNAUTHORIZED_SHOP");
 });
});
