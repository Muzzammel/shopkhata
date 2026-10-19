"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CircleAlertIcon, FileTextIcon, PaperclipIcon, PencilLineIcon, PlusIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Drawer } from "@/components/shell/drawer";
import { createBrowserClient } from "@/lib/supabase/browser";
import { ui } from "@/components/sales/ui";
import { categorySlot, qar } from "@/lib/dashboard-view";
import { formatQar, parseQar } from "@/lib/domain/money";
import { EXPENSE_CATEGORIES, prepareExpenseInput } from "@/lib/expense-operations";
import { categoryLabel, fileSize, RECEIPT_TYPE_LABEL } from "@/lib/expense-view";
import { longDate, personLabel, qatarDateTime, signedQar } from "@/lib/sales-view";
import { cn } from "@/lib/utils";
import { createExpense, decideExpenseCorrection, registerExpenseAttachment, requestExpenseCorrection } from "../customer-actions";
import { Comparison } from "../invoice-operations";

type Category = (typeof EXPENSE_CATEGORIES)[number];
type ReceiptAttempt={path:string;key:string;file:File};
const RECEIPT_TYPES=["image/jpeg","image/png","image/webp","application/pdf"];
const AMOUNT_ERROR="Enter a positive QAR amount with up to two decimal places.";

function amountError(amount:string):string|undefined{
  try{const value=parseQar(amount.trim());return value>0&&Number.isSafeInteger(value)?undefined:AMOUNT_ERROR;}catch{return AMOUNT_ERROR;}
}

function Field({label,error,id,hint,children,className}:{label:string;error?:string;id:string;hint?:ReactNode;children:ReactNode;className?:string}){
  return <div className={cn("grid content-start gap-1.5",className)}>
    <label data-slot="label" htmlFor={id} className={ui.label}>{label}</label>
    {children}
    {hint&&!error&&<p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
    {error&&<p id={`${id}-error`} data-slot="field-error" className={ui.fieldError}>{error}</p>}
  </div>;
}
const describedBy=(id:string,error?:string,hint?:boolean)=>error?`${id}-error`:hint?`${id}-hint`:undefined;

/** The six fixed categories as a radio picker, each with its Dashboard colour. */
function CategoryPicker({value,onChange,disabled,name}:{value:string;onChange:(value:Category)=>void;disabled?:boolean;name:string}){
  return <fieldset disabled={disabled} className="grid gap-2">
    <legend data-slot="legend" className={cn(ui.label,"mb-1.5")}>Category</legend>
    <div className="flex flex-wrap gap-2">{EXPENSE_CATEGORIES.map((category)=><label key={category} data-slot="label" className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full border border-input bg-card px-3.5 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-muted has-[:checked]:border-foreground has-[:checked]:bg-primary has-[:checked]:text-primary-foreground has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/40 max-sm:min-h-11">
      <input data-slot="radio" type="radio" name={name} value={category} checked={value===category} onChange={()=>onChange(category)} className="sr-only"/>
      <span aria-hidden className="size-2.5 shrink-0 rounded-sm ring-1 ring-white/30" style={{background:`var(--category-${categorySlot(category)})`}}/>
      {categoryLabel(category)}
    </label>)}</div>
  </fieldset>;
}

function Failure({title,message}:{title:string;message:string}){
  return <Alert variant="destructive" className="border-destructive/40 bg-danger-soft"><CircleAlertIcon/><AlertTitle>{title}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>;
}

/**
 * "Add expense": the unchanged create_expense → private receipt upload → register_expense_attachment
 * sequence, in a drawer with a review step. Its state outlives the drawer, so a half-finished save
 * (expense recorded, receipt not yet linked) can be reopened and retried with the same keys.
 */
export function AddExpenseDrawer({shopId,shopName,businessDate,canBackdate,className}:{shopId:string;shopName:string;businessDate:string;canBackdate:boolean;className?:string}){
  const router=useRouter();
  const [open,setOpen]=useState(false); const [review,setReview]=useState(false); const [checked,setChecked]=useState(false); const [touched,setTouched]=useState<Record<string,boolean>>({});
  const [amount,setAmount]=useState(""); const [category,setCategory]=useState<Category>("other"); const [description,setDescription]=useState(""); const [file,setFile]=useState<File|null>(null); const [date,setDate]=useState(businessDate); const [backdatedReason,setBackdatedReason]=useState("");
  const [expenseKey,setExpenseKey]=useState(()=>crypto.randomUUID()); const [receipt,setReceipt]=useState<ReceiptAttempt|null>(null); const [message,setMessage]=useState(""); const [busy,setBusy]=useState<false|"expense"|"receipt">(false); const [locked,setLocked]=useState(false); const [existingExpenseId,setExistingExpenseId]=useState<string|null>(null);
  const fileInput=useRef<HTMLInputElement>(null);
  const backdated=date<businessDate;

  // Quick actions elsewhere in the app land here with #add-expense.
  useEffect(()=>{
    const sync=()=>{if(window.location.hash==="#add-expense")setOpen(true);};
    const frame=requestAnimationFrame(sync); window.addEventListener("hashchange",sync);
    return ()=>{cancelAnimationFrame(frame);window.removeEventListener("hashchange",sync);};
  },[]);

  const errors={
    date:!date||date>businessDate?"Choose today or an earlier business date.":undefined,
    amount:amountError(amount),
    description:!description.trim()?"Enter what this expense was for.":undefined,
    backdatedReason:backdated&&!backdatedReason.trim()?"Enter the reason for backdating.":undefined,
    receipt:file&&(!RECEIPT_TYPES.includes(file.type)||file.size>10_485_760)?"Receipt must be a JPG, PNG, WebP or PDF file no larger than 10 MB.":undefined,
  };
  const shown=(field:keyof typeof errors)=>checked||touched[field]?errors[field]:undefined;
  const touch=(field:string)=>()=>setTouched((current)=>({...current,[field]:true}));

  function edit<T>(setter:(value:T)=>void,value:T){if(locked)return;setter(value);setExpenseKey(crypto.randomUUID());setMessage("");}
  function selectFile(event:ChangeEvent<HTMLInputElement>){if(locked)return;const value=event.target.files?.[0]??null;setFile(value);setReceipt(null);setMessage("");setTouched((current)=>({...current,receipt:true}));}
  function removeFile(){if(locked)return;setFile(null);setReceipt(null);if(fileInput.current)fileInput.current.value="";}

  function toReview(event:FormEvent<HTMLFormElement>){
    event.preventDefault(); setChecked(true);
    const first=(Object.keys(errors) as (keyof typeof errors)[]).find((key)=>errors[key]);
    if(first){document.getElementById(`expense-${first}`)?.focus();return;}
    setReview(true);
  }

  async function save(){if(busy)return;const prepared=prepareExpenseInput({amount,category,description});if(!prepared.command){setMessage(prepared.error??"Check the expense details.");setReview(false);return;}const {amountDirham,category:validCategory,description:validDescription}=prepared.command;
    if(file&&(!RECEIPT_TYPES.includes(file.type)||file.size>10_485_760)){setMessage("Receipt must be a JPG, PNG, WebP or PDF file no larger than 10 MB.");return;}
    setBusy("expense");setMessage("");try{
      let expenseId=existingExpenseId;
      if(!expenseId){const created=await createExpense({shop_id:shopId,amount_dirham:amountDirham,business_date:date,category:validCategory,description:validDescription,...(date<businessDate?{backdated_reason:backdatedReason}:{}),idempotency_key:expenseKey});
        if(!created.ok){setMessage(created.message);setLocked(created.uncertain);return;}const returnedExpenseId=created.receipt.expense_id;if(typeof returnedExpenseId!=="string"){setMessage("Expense status is uncertain. Retry the same request.");setLocked(true);return;}expenseId=returnedExpenseId;setExistingExpenseId(returnedExpenseId);}
      if(file){setBusy("receipt");let attempt=receipt;if(!attempt){const ext=file.type==="image/jpeg"?"jpg":file.type==="image/png"?"png":file.type==="image/webp"?"webp":"pdf";attempt={path:`${shopId}/${expenseId}/${crypto.randomUUID()}.${ext}`,key:crypto.randomUUID(),file};setReceipt(attempt);}
        const storage=createBrowserClient().storage.from("expense-receipts");const upload=await storage.upload(attempt.path,attempt.file,{contentType:attempt.file.type,upsert:false});
        if(upload.error&&!/already exists|duplicate/i.test(upload.error.message)){setLocked(true);setMessage("Expense recorded. Receipt upload failed; retry the same expense to attach it.");return;}
        const attached=await registerExpenseAttachment({shop_id:shopId,expense_id:expenseId,file_path:attempt.path,file_name:attempt.file.name,content_type:attempt.file.type,byte_size:attempt.file.size,idempotency_key:attempt.key});
        if(!attached.ok){setLocked(true);setMessage(`Expense recorded. Receipt could not be linked: ${attached.message}`);return;}
      }
      toast.success(file?"Expense and receipt saved.":"Expense saved.");
      setAmount("");setDescription("");setCategory("other");setFile(null);setReceipt(null);setDate(businessDate);setBackdatedReason("");setExpenseKey(crypto.randomUUID());setExistingExpenseId(null);setLocked(false);setReview(false);setChecked(false);setTouched({});
      close(false); router.refresh();
    }catch{setLocked(true);setMessage("Expense status or receipt upload is uncertain. Retry this exact request.");}finally{setBusy(false);}}

  function close(next:boolean){
    if(next){setOpen(true);return;}
    if(busy)return;
    setOpen(false); if(!locked)setReview(false);
    if(window.location.hash==="#add-expense")history.replaceState(history.state,"",window.location.pathname+window.location.search);
  }

  const success=message.startsWith("Expense and")||message==="Expense saved.";
  return <>
    <button data-slot="button" type="button" className={cn(ui.primary,className)} onClick={()=>setOpen(true)}><PlusIcon aria-hidden/>Add expense{locked&&<span className="sr-only"> (unfinished save)</span>}</button>
    <Drawer open={open} onOpenChange={close} title="Add expense" description={<>An operating cost for {shopName}, kept separate from sales and customer due. Saved only after ShopKhata confirms it.</>}>
      {!review?<form noValidate aria-label="Expense details" className="grid gap-5" onSubmit={toReview}>
        <fieldset disabled={locked} className="grid gap-5">
          <legend className="sr-only">Expense details</legend>
          <div className="grid grid-cols-2 gap-3 max-[380px]:grid-cols-1">
            <Field id="expense-date" label="Business date" error={shown("date")} hint={canBackdate?"Owners can backdate, with a reason.":undefined}>
              <input data-slot="input" id="expense-date" type="date" value={date} max={businessDate} readOnly={!canBackdate} aria-invalid={Boolean(shown("date"))||undefined} aria-describedby={describedBy("expense-date",shown("date"),canBackdate)} onBlur={touch("date")} onChange={(e)=>edit(setDate,e.target.value)} className={cn(ui.field,!canBackdate&&"bg-muted text-muted-foreground")}/>
            </Field>
            <Field id="expense-amount" label="Amount (QAR)" error={shown("amount")}>
              <input data-slot="input" id="expense-amount" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} aria-invalid={Boolean(shown("amount"))||undefined} aria-describedby={describedBy("expense-amount",shown("amount"))} onBlur={touch("amount")} onChange={(e)=>edit(setAmount,e.target.value)} className={cn(ui.field,"text-right text-lg font-semibold tabular-nums")}/>
            </Field>
          </div>
          {canBackdate&&backdated&&<Field id="expense-backdatedReason" label="Reason for backdating" error={shown("backdatedReason")}>
            <textarea data-slot="textarea" id="expense-backdatedReason" value={backdatedReason} maxLength={2000} rows={2} aria-invalid={Boolean(shown("backdatedReason"))||undefined} aria-describedby={describedBy("expense-backdatedReason",shown("backdatedReason"))} onBlur={touch("backdatedReason")} onChange={(e)=>edit(setBackdatedReason,e.target.value)} className={cn(ui.field,"h-auto min-h-16 py-2.5")}/>
          </Field>}
          <CategoryPicker name="expense-category" value={category} onChange={(value)=>edit(setCategory,value)}/>
          <Field id="expense-description" label="Description" error={shown("description")}>
            <textarea data-slot="textarea" id="expense-description" value={description} maxLength={1000} rows={3} placeholder="What was this for?" aria-invalid={Boolean(shown("description"))||undefined} aria-describedby={describedBy("expense-description",shown("description"))} onBlur={touch("description")} onChange={(e)=>edit(setDescription,e.target.value)} className={cn(ui.field,"h-auto min-h-20 py-2.5")}/>
          </Field>
          <div className="grid gap-2">
            <span className={ui.label}>Receipt (optional)</span>
            {file&&<div className="flex items-center gap-3 rounded-2xl border border-border bg-muted/50 p-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-card ring-1 ring-border"><FileTextIcon aria-hidden className="size-4"/></span>
              <span className="grid min-w-0 flex-1"><span className="truncate text-sm font-medium">{file.name}</span><span className="text-xs text-muted-foreground">{RECEIPT_TYPE_LABEL[file.type]??(file.type||"Unknown type")} · {fileSize(file.size)}</span></span>
              <button data-slot="button" type="button" aria-label={`Remove receipt ${file.name}`} onClick={removeFile} className={cn(ui.quiet,"min-h-10 max-sm:min-h-11")}><XIcon aria-hidden/>Remove</button>
            </div>}
            <label data-slot="label" className={cn(ui.secondary,"min-h-10 cursor-pointer justify-self-start px-4 has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/40 max-sm:min-h-11")}>
              <PaperclipIcon aria-hidden/>{file?"Replace receipt":"Attach receipt"}
              <input ref={fileInput} data-slot="file" id="expense-receipt" type="file" aria-label="Receipt (optional)" accept="image/jpeg,image/png,image/webp,application/pdf" aria-invalid={Boolean(shown("receipt"))||undefined} aria-describedby={shown("receipt")?"expense-receipt-error":"expense-receipt-hint"} onChange={selectFile} className="sr-only"/>
            </label>
            {shown("receipt")?<p id="expense-receipt-error" data-slot="field-error" className={ui.fieldError}>{shown("receipt")}</p>:<p id="expense-receipt-hint" className="text-xs text-muted-foreground">Private to this shop. JPG, PNG, WebP or PDF, max 10 MB. A saved receipt cannot be removed.</p>}
          </div>
        </fieldset>
        {message&&!success&&<Failure title="The expense was not saved" message={message}/>}
        <button data-slot="button" className={ui.primary} disabled={locked}>Review expense</button>
      </form>:<div className="grid gap-5">
        <section aria-labelledby="expense-review-heading" className="grid gap-4 rounded-2xl border border-border p-4">
          <h3 id="expense-review-heading" data-slot="heading" className="text-sm font-semibold">Review before saving</h3>
          <p className="text-3xl font-semibold tracking-tight tabular-nums">{amountError(amount)?"—":qar(parseQar(amount.trim()))}</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Business date</dt><dd>{longDate(date)}{backdated&&" · backdated"}</dd>
            {backdated&&<><dt className="text-muted-foreground">Backdate reason</dt><dd className="[overflow-wrap:anywhere]">{backdatedReason}</dd></>}
            <dt className="text-muted-foreground">Category</dt><dd>{categoryLabel(category)}</dd>
            <dt className="text-muted-foreground">Description</dt><dd className="whitespace-pre-line [overflow-wrap:anywhere]">{description.trim()}</dd>
            <dt className="text-muted-foreground">Receipt</dt><dd className="[overflow-wrap:anywhere]">{file?`${file.name} · ${fileSize(file.size)}`:"No receipt attached"}</dd>
          </dl>
        </section>
        <p className="text-[13px] text-muted-foreground">After saving, a change needs a correction request approved by a manager or owner.</p>
        {busy&&<p role="status" className="text-sm font-medium">{busy==="expense"?"Saving expense…":"Uploading receipt…"}</p>}
        {message&&!success&&<Failure title={locked?"Saving could not be completed":"The expense was not saved"} message={message}/>}
        <div className="flex flex-wrap gap-2">
          <button data-slot="button" type="button" className={cn(ui.primary,"flex-1")} disabled={Boolean(busy)} onClick={()=>void save()}>{busy?"Saving…":existingExpenseId?"Retry receipt/save":locked?"Retry exact save":"Save expense"}</button>
          <button data-slot="button" type="button" className={ui.secondary} disabled={Boolean(busy)||locked} onClick={()=>setReview(false)}><PencilLineIcon aria-hidden/>Edit</button>
        </div>
      </div>}
    </Drawer>
  </>;
}

export type CorrectionView={id:string;amountDirham:number;category:string;description:string;reason:string;requestedBy:string|null;requestedAt:string;stale:boolean};
type CurrentExpense={id:string;amountDirham:number;category:string;description:string};

/** "Request correction": a request only. The expense keeps its current values until a manager or owner approves. */
export function ExpenseCorrectionPanel({shopId,expense,pendingCount}:{shopId:string;expense:CurrentExpense;pendingCount:number}){
  const router=useRouter();
  const [open,setOpen]=useState(false);const [checked,setChecked]=useState(false);
  const [amount,setAmount]=useState(formatQar(expense.amountDirham));const [category,setCategory]=useState(expense.category);const [description,setDescription]=useState(expense.description);const [reason,setReason]=useState("");const [message,setMessage]=useState("");const [busy,setBusy]=useState(false);const [requestKey,setRequestKey]=useState(()=>crypto.randomUUID());const [uncertain,setUncertain]=useState(false);
  function change<T>(setter:(value:T)=>void,value:T){setter(value);setUncertain(false);setRequestKey(crypto.randomUUID());setMessage("");}
  let requested:number|null=null;try{if(!amountError(amount))requested=parseQar(amount.trim());}catch{requested=null;}
  const errors={amount:amountError(amount),description:!description.trim()?"Enter the corrected description.":undefined,reason:!reason.trim()?"Enter the reason for this correction.":undefined};
  const shown=(field:keyof typeof errors)=>checked?errors[field]:undefined;
  const unchanged=requested===expense.amountDirham&&category===expense.category&&description.trim()===expense.description;

  async function request(event:FormEvent<HTMLFormElement>){event.preventDefault();setChecked(true);
    const first=(Object.keys(errors) as (keyof typeof errors)[]).find((key)=>errors[key]);
    if(!uncertain&&first){document.getElementById(`correction-${first}`)?.focus();return;}
    let parsed:number;try{parsed=parseQar(amount);}catch{setMessage("Enter a valid corrected amount.");return;}
    setBusy(true);try{const result=await requestExpenseCorrection({shop_id:shopId,expense_id:expense.id,amount_dirham:parsed,category,description,reason,idempotency_key:requestKey});
      if(result.ok){toast.success("Correction request submitted for manager or owner approval.");setRequestKey(crypto.randomUUID());setReason("");setUncertain(false);setMessage("");setChecked(false);setOpen(false);router.refresh();}
      else{setMessage(result.message);setUncertain(result.uncertain);}
    }catch{setUncertain(true);setMessage("Correction request status is uncertain. Retry the exact request.");}finally{setBusy(false);}}

  function openDrawer(){if(!uncertain){setAmount(formatQar(expense.amountDirham));setCategory(expense.category);setDescription(expense.description);setReason("");setMessage("");setChecked(false);setRequestKey(crypto.randomUUID());}setOpen(true);}

  return <>
    <button data-slot="button" type="button" className={cn(ui.secondary,"min-h-10 px-4 max-sm:min-h-11 max-sm:flex-1")} onClick={openDrawer}><PencilLineIcon aria-hidden/>Request correction</button>
    <Drawer open={open} onOpenChange={(next)=>{if(next||!busy)setOpen(next);}} title="Request correction" description={<>This is a request. Nothing changes until a manager or owner approves it.</>}>
      <form noValidate aria-label="Correction request" className="grid gap-5" onSubmit={request}>
        {pendingCount>0&&<p className={ui.warn}>{pendingCount===1?"A correction request is":`${pendingCount} correction requests are`} already awaiting approval for this expense.</p>}
        <fieldset disabled={uncertain||busy} className="grid gap-5">
          <legend className="sr-only">Corrected values</legend>
          <Field id="correction-amount" label="Corrected amount (QAR)" error={shown("amount")}>
            <input data-slot="input" id="correction-amount" inputMode="decimal" autoComplete="off" value={amount} aria-invalid={Boolean(shown("amount"))||undefined} aria-describedby={describedBy("correction-amount",shown("amount"))} onChange={(e)=>change(setAmount,e.target.value)} className={cn(ui.field,"text-right text-lg font-semibold tabular-nums")}/>
          </Field>
          <CategoryPicker name="correction-category" value={category} onChange={(value)=>change(setCategory,value)}/>
          <Field id="correction-description" label="Description" error={shown("description")}>
            <textarea data-slot="textarea" id="correction-description" value={description} maxLength={1000} rows={2} aria-invalid={Boolean(shown("description"))||undefined} aria-describedby={describedBy("correction-description",shown("description"))} onChange={(e)=>change(setDescription,e.target.value)} className={cn(ui.field,"h-auto min-h-16 py-2.5")}/>
          </Field>
        </fieldset>
        <div className="grid gap-2">
          <Comparison label="Requested correction" rows={[
            {label:"Amount",current:qar(expense.amountDirham),requested:requested===null?"—":qar(requested)},
            {label:"Category",current:categoryLabel(expense.category),requested:categoryLabel(category)},
            {label:"Description",current:expense.description,requested:description.trim()||"—"},
          ]}/>
          {requested!==null&&requested!==expense.amountDirham&&<p className="text-sm tabular-nums">Difference: <strong>{signedQar(requested-expense.amountDirham)}</strong></p>}
          {unchanged&&<p className="text-[13px] text-muted-foreground">Nothing differs from the current values yet.</p>}
        </div>
        <fieldset disabled={uncertain||busy} className="grid">
          <legend className="sr-only">Reason</legend>
          <Field id="correction-reason" label="Reason" error={shown("reason")}>
            <textarea data-slot="textarea" id="correction-reason" value={reason} maxLength={2000} rows={2} aria-invalid={Boolean(shown("reason"))||undefined} aria-describedby={describedBy("correction-reason",shown("reason"))} onChange={(e)=>change(setReason,e.target.value)} className={cn(ui.field,"h-auto min-h-16 py-2.5")}/>
          </Field>
        </fieldset>
        <p className={ui.warn}>Requires manager or owner approval. The expense keeps its current amount, category and description until then.</p>
        {message&&<Failure title={uncertain?"Saving could not be confirmed":"The request was not saved"} message={message}/>}
        <button data-slot="button" className={ui.primary} disabled={busy}>{busy?"Submitting…":uncertain?"Retry exact correction request":"Submit correction request"}</button>
      </form>
    </Drawer>
  </>;
}

/** Pending requests with current against requested values. Only managers and owners see the decision controls. */
export function ExpenseApprovals({shopId,expense,requests,people,canApprove}:{shopId:string;expense:CurrentExpense;requests:CorrectionView[];people:Record<string,string>;canApprove:boolean}){
  const router=useRouter();
  const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");const [uncertain,setUncertain]=useState(false);
  const [reasons,setReasons]=useState<Record<string,string>>({});
  const [attempts,setAttempts]=useState<Record<string,{decision:"approved"|"rejected";reason:string;key:string}>>({});
  async function decide(requestId:string,decision:"approved"|"rejected"){
    const reason=(reasons[requestId]??"").trim();
    // The same decision with the same reason reuses its key, so a retry can never decide twice.
    const previous=attempts[requestId];const attempt=previous?.decision===decision&&previous.reason===reason?previous:{decision,reason,key:crypto.randomUUID()};
    setAttempts((current)=>({...current,[requestId]:attempt}));setBusy(true);setMessage("");
    try{const result=await decideExpenseCorrection({shop_id:shopId,request_id:requestId,decision,...(reason?{reason}:{}),idempotency_key:attempt.key});
      if(result.ok){setUncertain(false);toast.success(decision==="approved"?"Correction approved.":"Correction rejected.");router.refresh();}
      else{setMessage(result.message);setUncertain(result.uncertain);}
    }catch{setUncertain(true);setMessage("Decision status is uncertain. Retry the same decision.");}finally{setBusy(false);}}
  return <section aria-labelledby="awaiting-heading" className="grid gap-2.5 rounded-3xl border border-warning/30 bg-card p-4 sm:px-5">
    <div className="grid gap-0.5">
      <h2 id="awaiting-heading" data-slot="heading" className="text-base font-semibold">Awaiting approval</h2>
      <p className="text-[13px] text-muted-foreground">Requests change nothing until a manager or owner approves them. The expense shows the current approved values.</p>
    </div>
    <ul className="grid list-none gap-2.5 pl-0">{requests.map((request)=>{
      const retrying=uncertain&&attempts[request.id];
      return <li key={request.id} aria-label="Correction request" className="grid gap-2.5 rounded-2xl border border-border p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 data-slot="heading" className="text-sm font-semibold">Correction — Pending approval</h3>
          <span className="text-xs text-muted-foreground">Requested by <span className="font-medium text-foreground">{personLabel(people,request.requestedBy)}</span> · {qatarDateTime(request.requestedAt)}</span>
        </div>
        <Comparison label="Requested correction" rows={[
          {label:"Amount",current:qar(expense.amountDirham),requested:qar(request.amountDirham)},
          {label:"Category",current:categoryLabel(expense.category),requested:categoryLabel(request.category)},
          {label:"Description",current:expense.description,requested:request.description},
        ]}/>
        {request.amountDirham!==expense.amountDirham&&<p className="text-sm tabular-nums">Amount: {qar(expense.amountDirham)} → {qar(request.amountDirham)} ({signedQar(request.amountDirham-expense.amountDirham)})</p>}
        {request.stale&&<p className={ui.warn}>Out of date: this expense was corrected after the request was made. Approving will be refused; ask for a new request.</p>}
        <p className="text-sm [overflow-wrap:anywhere]"><span className="text-muted-foreground">Reason: </span>{request.reason}</p>
        {canApprove?<form className="border-t border-border pt-2.5" onSubmit={(e)=>e.preventDefault()}>
          <fieldset disabled={busy} className="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label data-slot="label" className="grid gap-1.5"><span className={ui.label}>Decision reason (optional)</span><input data-slot="input" maxLength={2000} value={reasons[request.id]??""} onChange={(e)=>setReasons((current)=>({...current,[request.id]:e.target.value}))} className={ui.field}/></label>
            <div className="flex flex-wrap gap-2">
              <button data-slot="button" type="button" className={cn(ui.primary,"min-h-11")} onClick={()=>void decide(request.id,"approved")}>{retrying&&attempts[request.id].decision==="approved"?"Retry approval":"Approve"}</button>
              <button data-slot="button" type="button" className={cn(ui.secondary,"min-h-11")} onClick={()=>void decide(request.id,"rejected")}>{retrying&&attempts[request.id].decision==="rejected"?"Retry rejection":"Reject"}</button>
            </div>
          </fieldset>
        </form>:<p className="text-xs text-muted-foreground">A manager or owner will review this request.</p>}
      </li>;
    })}</ul>
    {message&&<Failure title={uncertain?"Decision could not be confirmed":"The decision was not saved"} message={message}/>}
  </section>;
}
