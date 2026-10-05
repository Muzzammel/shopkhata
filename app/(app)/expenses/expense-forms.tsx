"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { createBrowserClient } from "@/lib/supabase/browser";
import { formatQar, parseQar } from "@/lib/domain/money";
import { prepareExpenseInput } from "@/lib/expense-operations";
import { createExpense, decideExpenseCorrection, registerExpenseAttachment, requestExpenseCorrection } from "../customer-actions";
import styles from "@/app/ui.module.css";

const CATEGORIES=["rent","utilities","supplies","transport","maintenance","other"] as const;
type ReceiptAttempt={path:string;key:string;file:File};

export function ExpenseCreateForm({shopId,businessDate,canBackdate}:{shopId:string;businessDate:string;canBackdate:boolean}){
  const [amount,setAmount]=useState(""); const [category,setCategory]=useState<(typeof CATEGORIES)[number]>("other"); const [description,setDescription]=useState(""); const [file,setFile]=useState<File|null>(null); const [date,setDate]=useState(businessDate); const [backdatedReason,setBackdatedReason]=useState("");
  const [expenseKey,setExpenseKey]=useState(()=>crypto.randomUUID()); const [receipt,setReceipt]=useState<ReceiptAttempt|null>(null); const [message,setMessage]=useState(""); const [busy,setBusy]=useState(false); const [locked,setLocked]=useState(false); const [existingExpenseId,setExistingExpenseId]=useState<string|null>(null);
  function edit<T>(setter:(value:T)=>void,value:T){if(locked)return;setter(value);setExpenseKey(crypto.randomUUID());setMessage("");}
  function selectFile(event:ChangeEvent<HTMLInputElement>){if(locked)return;const value=event.target.files?.[0]??null;setFile(value);setReceipt(null);setMessage("");}
  async function save(event:FormEvent<HTMLFormElement>){event.preventDefault();if(busy)return;const prepared=prepareExpenseInput({amount,category,description});if(!prepared.command){setMessage(prepared.error??"Check the expense details.");return;}const {amountDirham,category:validCategory,description:validDescription}=prepared.command;
    if(file&&(!["image/jpeg","image/png","image/webp","application/pdf"].includes(file.type)||file.size>10_485_760)){setMessage("Receipt must be a JPG, PNG, WebP or PDF file no larger than 10 MB.");return;}
    setBusy(true);setMessage("");try{
      let expenseId=existingExpenseId;
      if(!expenseId){const created=await createExpense({shop_id:shopId,amount_dirham:amountDirham,business_date:date,category:validCategory,description:validDescription,...(date<businessDate?{backdated_reason:backdatedReason}:{}),idempotency_key:expenseKey});
        if(!created.ok){setMessage(created.message);setLocked(created.uncertain);return;}const returnedExpenseId=created.receipt.expense_id;if(typeof returnedExpenseId!=="string"){setMessage("Expense status is uncertain. Retry the same request.");setLocked(true);return;}expenseId=returnedExpenseId;setExistingExpenseId(returnedExpenseId);}
      if(file){let attempt=receipt;if(!attempt){const ext=file.type==="image/jpeg"?"jpg":file.type==="image/png"?"png":file.type==="image/webp"?"webp":"pdf";attempt={path:`${shopId}/${expenseId}/${crypto.randomUUID()}.${ext}`,key:crypto.randomUUID(),file};setReceipt(attempt);}
        const storage=createBrowserClient().storage.from("expense-receipts");const upload=await storage.upload(attempt.path,attempt.file,{contentType:attempt.file.type,upsert:false});
        if(upload.error&&!/already exists|duplicate/i.test(upload.error.message)){setLocked(true);setMessage("Expense recorded. Receipt upload failed; retry the same expense to attach it.");return;}
        const attached=await registerExpenseAttachment({shop_id:shopId,expense_id:expenseId,file_path:attempt.path,file_name:attempt.file.name,content_type:attempt.file.type,byte_size:attempt.file.size,idempotency_key:attempt.key});
        if(!attached.ok){setLocked(true);setMessage(`Expense recorded. Receipt could not be linked: ${attached.message}`);return;}
      }
      setMessage(file?"Expense and receipt saved.":"Expense saved.");setAmount("");setDescription("");setCategory("other");setFile(null);setReceipt(null);setExpenseKey(crypto.randomUUID());setExistingExpenseId(null);setLocked(false);window.location.reload();
    }catch{setLocked(true);setMessage("Expense status or receipt upload is uncertain. Retry this exact request.");}finally{setBusy(false);}}
  return <section className={styles.panel}><h2>Record expense</h2><form className={styles.formGrid} onSubmit={save}>
    <label>Date<input type="date" value={date} max={businessDate} readOnly={!canBackdate||locked} onChange={(e)=>edit(setDate,e.target.value)}/></label>{canBackdate&&date<businessDate&&<label className={styles.wide}>Reason for backdating<textarea value={backdatedReason} disabled={locked} maxLength={2000} onChange={(e)=>edit(setBackdatedReason,e.target.value)}/></label>}<label>Amount (QAR)<input inputMode="decimal" value={amount} disabled={locked} onChange={(e)=>edit(setAmount,e.target.value)}/></label>
    <label>Category<select value={category} disabled={locked} onChange={(e)=>edit(setCategory,e.target.value as typeof category)}>{CATEGORIES.map((value)=><option key={value} value={value}>{value[0].toUpperCase()+value.slice(1)}</option>)}</select></label>
    <label>Receipt (optional)<input type="file" disabled={locked} accept="image/jpeg,image/png,image/webp,application/pdf" onChange={selectFile}/><small>Private upload, max 10 MB.</small></label>
    <label className={styles.wide}>Description<textarea value={description} disabled={locked} maxLength={1000} onChange={(e)=>edit(setDescription,e.target.value)}/></label>
    <button disabled={busy||!amount||!description.trim()||(date<businessDate&&!backdatedReason.trim())}>{busy?"Saving…":existingExpenseId?"Retry receipt/save":"Save expense"}</button>
  </form>{file&&<p className={styles.muted}>Selected receipt: {file.name} ({file.size} bytes)</p>}{message&&<p role={message.startsWith("Expense and")||message==="Expense saved."?"status":"alert"}>{message}</p>}</section>;
}

type CorrectionRequest={id:string;amount_dirham:number;category:string;description:string;reason:string};
export function ExpenseCorrectionForm({shopId,expense,requests,canApprove}:{shopId:string;expense:{id:string;amountDirham:number;category:string;description:string};requests:CorrectionRequest[];canApprove:boolean}){
  const [amount,setAmount]=useState("");const [category,setCategory]=useState(expense.category);const [description,setDescription]=useState(expense.description);const [reason,setReason]=useState("");const [message,setMessage]=useState("");const [busy,setBusy]=useState(false);const [requestKey,setRequestKey]=useState(()=>crypto.randomUUID());const [uncertain,setUncertain]=useState(false);const [decisionAttempts,setDecisionAttempts]=useState<Record<string,{decision:"approved"|"rejected";key:string}>>({});
  async function request(event:FormEvent<HTMLFormElement>){event.preventDefault();let parsed:number;try{parsed=parseQar(amount);}catch{setMessage("Enter a valid corrected amount.");return;}setBusy(true);try{const result=await requestExpenseCorrection({shop_id:shopId,expense_id:expense.id,amount_dirham:parsed,category,description,reason,idempotency_key:requestKey});setMessage(result.ok?"Correction request submitted for manager or owner decision.":result.message);setUncertain(!result.ok&&result.uncertain);if(result.ok){setRequestKey(crypto.randomUUID());setReason("");}}catch{setUncertain(true);setMessage("Correction request status is uncertain. Retry the exact request.");}finally{setBusy(false);}}
  async function decide(requestId:string,decision:"approved"|"rejected"){const previous=decisionAttempts[requestId];const attempt=previous?.decision===decision?previous:{decision,key:crypto.randomUUID()};setDecisionAttempts((current)=>({...current,[requestId]:attempt}));setBusy(true);try{const result=await decideExpenseCorrection({shop_id:shopId,request_id:requestId,decision,idempotency_key:attempt.key});setMessage(result.ok?`Correction ${decision}.`:result.message);setUncertain(!result.ok&&result.uncertain);if(result.ok)window.location.reload();}catch{setUncertain(true);setMessage("Decision status is uncertain. Retry the same decision.");}finally{setBusy(false);}}
  return <div className={styles.correction}><details><summary>Request expense correction</summary><form className={styles.formGrid} onSubmit={request}>
    <label>Corrected amount (QAR)<input inputMode="decimal" value={amount} disabled={uncertain||busy} onChange={(e)=>{setAmount(e.target.value);setUncertain(false);setRequestKey(crypto.randomUUID());}}/></label><label>Category<select value={category} disabled={uncertain||busy} onChange={(e)=>{setCategory(e.target.value);setUncertain(false);setRequestKey(crypto.randomUUID());}}>{CATEGORIES.map((item)=><option key={item}>{item}</option>)}</select></label>
    <label>Description<input value={description} disabled={uncertain||busy} maxLength={1000} onChange={(e)=>{setDescription(e.target.value);setUncertain(false);setRequestKey(crypto.randomUUID());}}/></label><label className={styles.wide}>Reason<textarea value={reason} disabled={uncertain||busy} maxLength={2000} onChange={(e)=>{setReason(e.target.value);setUncertain(false);setRequestKey(crypto.randomUUID());}}/></label><button disabled={busy||(!uncertain&&!reason.trim())}>{uncertain?"Retry exact correction request":"Submit correction request"}</button>
  </form></details>
  {requests.map((request)=><div key={request.id} className={styles.callout}><p>Pending: QAR {formatQar(request.amount_dirham)} · {request.category} · {request.description} · {request.reason}</p>{canApprove&&<div className={styles.actions}><button disabled={busy} onClick={()=>void decide(request.id,"approved")}>{decisionAttempts[request.id]?.decision==="approved"&&uncertain?"Retry approval":"Approve"}</button><button className={styles.secondary} disabled={busy} onClick={()=>void decide(request.id,"rejected")}>{decisionAttempts[request.id]?.decision==="rejected"&&uncertain?"Retry rejection":"Reject"}</button></div>}</div>)}{message&&<p role={uncertain?"alert":"status"}>{message}</p>}</div>;
}
