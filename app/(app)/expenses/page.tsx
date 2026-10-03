import Link from "next/link";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { getVisibleShops } from "@/lib/shop-switching";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { readAllPages } from "@/lib/read-all-pages";
import { formatQar } from "@/lib/domain/money";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { ExpenseCreateForm, ExpenseCorrectionForm } from "./expense-forms";
import styles from "../customers/operations.module.css";

export default async function ExpensesPage({ searchParams }: PageProps<"/expenses">) {
  const actor=await getCurrentActor(); const query=await searchParams; const supabase=await createServerSupabaseClient();
  const requestedPage=typeof query.page==="string"&&/^\d+$/.test(query.page)?Number(query.page):0; const pageNumber=Number.isSafeInteger(requestedPage)&&requestedPage<=1_000_000?requestedPage:0; const pageSize=30; const start=pageNumber*pageSize;
  const {data:allShops,error:shopsError}=await supabase.from("shops").select("id,name,is_active").eq("is_active",true).order("name");
  if(shopsError||!allShops)throw new Error("EXPENSE_WORKSPACE_UNAVAILABLE");
  const shops=getVisibleShops(actor,allShops); const selectedShop=Array.isArray(query.shop)?query.shop[0]:query.shop; const shop=shops.find((item)=>item.id===selectedShop)??shops[0];
  if(!shop||!can(actor,"records.view_assigned",shop.id))return <main className={styles.workspace}><h1>Expenses unavailable</h1></main>;
  const [expensesResult]=await Promise.all([
    supabase.from("effective_expenses").select("id,shop_id,description,amount_dirham,category,business_date,recorded_at,created_by,correction_request_id,backdated_reason").eq("shop_id",shop.id).order("business_date",{ascending:false}).order("recorded_at",{ascending:false}).range(start,start+pageSize-1),
  ]);
  if(expensesResult.error||!expensesResult.data)throw new Error("EXPENSE_HISTORY_UNAVAILABLE");
  const expenseIds=expensesResult.data.map((expense)=>expense.id!).filter(Boolean);
  const requestsResult=expenseIds.length?await readAllPages((o,e)=>supabase.from("expense_correction_requests").select("id,expense_id,amount_dirham,category,description,reason,requested_by,requested_at").eq("shop_id",shop.id).in("expense_id",expenseIds).order("requested_at",{ascending:false}).range(o,e)):{data:[],error:null};
  if(requestsResult.error||!requestsResult.data)throw new Error("EXPENSE_HISTORY_UNAVAILABLE");
  const requestIds=requestsResult.data.map((request)=>request.id);
  const decisionsResult=requestIds.length?await readAllPages((o,e)=>supabase.from("expense_correction_decisions").select("request_id,decision,reason,decided_by,decided_at").eq("shop_id",shop.id).in("request_id",requestIds).range(o,e)):{data:[],error:null};
  if(decisionsResult.error||!decisionsResult.data)throw new Error("EXPENSE_HISTORY_UNAVAILABLE");
  const expenseRequests=requestsResult.data??[];const expenseDecisions=decisionsResult.data??[];
  const decisionByRequest=new Map(expenseDecisions.map((d)=>[d.request_id,d]));const decided=new Set(decisionByRequest.keys());const pending=expenseRequests.filter((request)=>!decided.has(request.id));
  const ids=expensesResult.data.map((expense)=>expense.id);
  const {data:attachments,error:attachmentError}=ids.length?await readAllPages((o,e)=>supabase.from("attachments").select("id,expense_id,file_path,file_name,content_type,byte_size,created_at").eq("shop_id",shop.id).in("expense_id",ids).order("created_at",{ascending:false}).range(o,e)):{data:[],error:null};
  if(attachmentError||!attachments)throw new Error("EXPENSE_ATTACHMENTS_UNAVAILABLE");
  const receiptResult=attachments.length?await supabase.storage.from("expense-receipts").createSignedUrls(attachments.map((file)=>file.file_path),300):{data:[],error:null};
  const receiptUrls=new Map(attachments.map((file,index)=>[file.id,receiptResult.data?.[index]?.signedUrl??null] as const));
  const correctionsByExpense=new Map<string,typeof pending>(); for(const r of pending){correctionsByExpense.set(r.expense_id,[...(correctionsByExpense.get(r.expense_id)??[]),r]);}
  return <main className={styles.workspace}>
    <header className={styles.header}><div><p className={styles.eyebrow}>{shop.name}</p><h1>Expenses</h1><p>Shop operating costs, recorded separately from invoice sales and customer due.</p></div><Link href="/">Back to overview</Link></header>
    {shops.length>1&&<nav className={styles.shops} aria-label="Choose shop">{shops.map((s)=><Link key={s.id} aria-current={s.id===shop.id?"page":undefined} href={`/expenses?shop=${s.id}`}>{s.name}</Link>)}</nav>}
    {can(actor,"expense.create",shop.id)&&<ExpenseCreateForm shopId={shop.id} businessDate={qatarBusinessDate(new Date())} canBackdate={actor.role==="owner"}/>}
    <section className={styles.panel}><h2>Expense history</h2><form className={styles.search} action="/exports/expenses" method="get"><input type="hidden" name="shop" value={shop.id}/><label>Export from<input type="date" name="from" defaultValue={qatarBusinessDate(new Date())} required/></label><label>Export to<input type="date" name="to" defaultValue={qatarBusinessDate(new Date())} required/></label><button>Export expenses (.xlsx)</button></form><div className={styles.detailList}>{expensesResult.data.map((expense)=><article key={expense.id}>
      <div className={styles.expenseHeading}><strong>QAR {formatQar(expense.amount_dirham!)} · {expense.category}</strong><span>{expense.business_date} · Recorded {new Date(expense.recorded_at!).toLocaleString("en-GB",{timeZone:"Asia/Qatar"})}</span></div>
      <p>{expense.description}</p><small>Created by {expense.created_by ?? "Unknown actor"} · Expense ref {expense.id}{expense.backdated_reason?` · Backdate reason: ${expense.backdated_reason}`:""}</small>
      {attachments.filter((file)=>file.expense_id===expense.id).map((file)=><p key={file.id}>{receiptUrls.get(file.id)?<a href={receiptUrls.get(file.id)!} target="_blank" rel="noreferrer">Receipt: {file.file_name}</a>:<span>Receipt currently unavailable: {file.file_name}</span>} <small>({file.content_type}, {file.byte_size} bytes)</small></p>)}
      {expenseRequests.some((request)=>request.expense_id===expense.id)&&<details><summary>Correction history</summary><div className={styles.detailList}>{expenseRequests.filter((request)=>request.expense_id===expense.id).map((request)=>{const decision=decisionByRequest.get(request.id);return <article key={request.id}><strong>{decision?.decision??"Pending"} · proposed QAR {formatQar(request.amount_dirham)} · {request.category}</strong><span>{request.description}</span><span>Reason: {request.reason} · requested {new Date(request.requested_at).toLocaleString("en-GB",{timeZone:"Asia/Qatar"})} by {request.requested_by}</span>{decision&&<span>Decision {decision.decision} at {new Date(decision.decided_at).toLocaleString("en-GB",{timeZone:"Asia/Qatar"})} by {decision.decided_by}{decision.reason?` · ${decision.reason}`:""}</span>}</article>;})}</div></details>}
      {can(actor,"expense.create",shop.id)&&<ExpenseCorrectionForm shopId={shop.id} expense={{id:expense.id!,amountDirham:expense.amount_dirham!,category:expense.category!,description:expense.description!}} requests={correctionsByExpense.get(expense.id!)??[]} canApprove={can(actor,"correction.approve",shop.id)}/>}
    </article>)}{expensesResult.data.length===0&&pageNumber===0&&<p>No expenses recorded for {shop.name}.</p>}{(pageNumber>0||expensesResult.data.length===pageSize)&&<nav className={styles.shops} aria-label="Expense pages">{pageNumber>0&&<Link href={`/expenses?shop=${shop.id}&page=${pageNumber-1}`}>Newer expenses</Link>}{expensesResult.data.length===pageSize&&<Link href={`/expenses?shop=${shop.id}&page=${pageNumber+1}`}>Older expenses</Link>}</nav>}</div></section>
  </main>;
}
