import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { formatQar } from "@/lib/domain/money";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { readAllPages } from "@/lib/read-all-pages";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { mapCustomerLedger, type CustomerLedgerSource } from "@/lib/customer-operations";
import { CustomerPaymentPanel } from "../../customer-payment-panel";
import styles from "../operations.module.css";

export default async function CustomerDetailPage({ params, searchParams }: PageProps<"/customers/[customerId]">) {
  const [{ customerId }, query] = await Promise.all([params, searchParams]);
  const actor = await getCurrentActor();
  const shopId = (Array.isArray(query.shop) ? query.shop[0] : query.shop) ?? actor.shopIds[0];
  if (!shopId || !can(actor, "records.view_assigned", shopId)) notFound();
  const supabase = await createServerSupabaseClient();
  const [{ data: customer, error: customerError }, { data: balance, error: balanceError }, { data: shop }] = await Promise.all([
    supabase.from("customers").select("id,shop_id,public_id,name,mobile,created_at,created_by").eq("shop_id", shopId).eq("id", customerId).maybeSingle(),
    supabase.from("customer_financial_balances").select("outstanding_due_dirham,available_credit_dirham,invoice_count,last_activity_date").eq("shop_id", shopId).eq("customer_id", customerId).maybeSingle(),
    supabase.from("shops").select("name").eq("id", shopId).maybeSingle(),
  ]);
  if (customerError || balanceError || !customer || !balance || customer.shop_id !== shopId) notFound();
  const [invoiceResult, ledgerResult, creditResult, auditsResult] = await Promise.all([
    readAllPages((offset,end) => supabase.from("effective_invoices").select("canonical_invoice_id,effective_invoice_number,business_date,recorded_at,effective_total_dirham,effective_paid_dirham,effective_credit_applied_dirham,effective_due_dirham,effective_delivered").eq("shop_id",shopId).eq("effective_customer_id",customerId).order("business_date",{ascending:false}).order("canonical_invoice_id").range(offset,end)),
    readAllPages((offset,end) => supabase.from("customer_ledger").select("business_date,recorded_at,sequence_id,invoice_id,entry_type,reference,invoice_number,actor_id,debit_dirham,credit_dirham").eq("shop_id",shopId).eq("customer_id",customerId).order("business_date").order("recorded_at").order("sequence_id").range(offset,end)),
    readAllPages((offset,end) => supabase.from("customer_credits").select("id,invoice_id,amount_dirham,business_date,recorded_at,reason,approved_by").eq("shop_id",shopId).eq("customer_id",customerId).not("approved_by","is",null).order("recorded_at",{ascending:false}).range(offset,end)),
    readAllPages((offset,end) => supabase.from("audit_events").select("id,action,entity_type,entity_id,reason,metadata,recorded_at,actor_id").eq("shop_id",shopId).eq("entity_type","customer").eq("entity_id",customerId).order("recorded_at",{ascending:false}).range(offset,end)),
  ]);
  if (invoiceResult.error || !invoiceResult.data || ledgerResult.error || !ledgerResult.data || creditResult.error || !creditResult.data || auditsResult.error || !auditsResult.data) throw new Error("CUSTOMER_HISTORY_UNAVAILABLE");
  const invoices = invoiceResult.data.map((i) => ({ invoiceId:i.canonical_invoice_id!,invoiceNumber:i.effective_invoice_number!,businessDate:i.business_date!,dueDirham:i.effective_due_dirham! }));
  const ledgerSources: CustomerLedgerSource[] = ledgerResult.data.map((entry) => ({ businessDate:entry.business_date!,recordedAt:entry.recorded_at!,sequenceId:entry.sequence_id!,invoiceId:entry.invoice_id!,type:entry.entry_type as CustomerLedgerSource["type"],reference:entry.reference!,invoiceNumber:entry.invoice_number,actorName:entry.actor_id===actor.id?"You":entry.actor_id, debitDirham:entry.debit_dirham!,creditDirham:entry.credit_dirham! }));
  const ledger = mapCustomerLedger(ledgerSources);
  const creditIds=creditResult.data.map((row)=>row.id);
  const {data:applications,error:applicationsError}=creditIds.length?await readAllPages((offset,end)=>supabase.from("credit_applications").select("credit_id,amount_dirham").eq("shop_id",shopId).in("credit_id",creditIds).range(offset,end)):{data:[],error:null};
  if(applicationsError||!applications)throw new Error("CUSTOMER_CREDIT_HISTORY_UNAVAILABLE");
  const appliedByCredit=new Map<string,number>();
  for(const item of applications)appliedByCredit.set(item.credit_id,(appliedByCredit.get(item.credit_id)??0)+item.amount_dirham);
  const recentPayments=ledger.filter((entry)=>entry.type==="payment"||entry.type==="payment_correction").slice(-20).reverse();
  const outstandingDue = balance.outstanding_due_dirham ?? 0;
  const credit = balance.available_credit_dirham ?? 0;
  return <main className={styles.workspace}>
    <header className={styles.header}><div><p className={styles.eyebrow}>{shop?.name ?? "Shop"} · {customer.public_id}</p><h1>{customer.name || "Unnamed customer"}</h1><p>{customer.mobile || "No mobile number"}</p></div><Link href={`/customers?shop=${shopId}`}>Back to customers</Link></header>
    <section className={styles.panel}><div className={styles.metrics}><div><span>Outstanding due</span><strong>{outstandingDue ? `QAR ${formatQar(outstandingDue)}` : "Settled"}</strong></div><div><span>Available credit</span><strong>QAR {formatQar(credit)}</strong></div><div><span>Invoices</span><strong>{balance.invoice_count}</strong></div><div><span>Last activity</span><strong>{balance.last_activity_date ?? "—"}</strong></div></div></section>
    {can(actor,"payment.record",shopId) && <CustomerPaymentPanel shopId={shopId} customerId={customerId} invoices={invoices.filter((i)=>i.dueDirham>0)} availableCreditDirham={credit} businessDate={qatarBusinessDate(new Date())}/>}
    <section className={styles.panel}><h2>Outstanding and historical invoices</h2><div className={styles.tableWrap}><table><thead><tr><th scope="col">Invoice</th><th scope="col">Date</th><th scope="col">Total</th><th scope="col">Cash paid</th><th scope="col">Credit applied</th><th scope="col">Due</th><th scope="col">Status</th></tr></thead><tbody>{invoiceResult.data.map((invoice)=><tr key={invoice.canonical_invoice_id}><td><Link href={`/shops/${shopId}/invoices/${invoice.canonical_invoice_id}`}><strong>{invoice.effective_invoice_number}</strong></Link></td><td>{invoice.business_date}</td><td>QAR {formatQar(invoice.effective_total_dirham!)}</td><td>QAR {formatQar(invoice.effective_paid_dirham!)}</td><td>QAR {formatQar(invoice.effective_credit_applied_dirham??0)}</td><td>QAR {formatQar(invoice.effective_due_dirham!)}</td><td>{invoice.effective_due_dirham===0?"Paid":"Due"}</td></tr>)}</tbody></table></div></section>
    <section className={styles.panel}><h2>Customer ledger</h2><p><a href={`/exports/customer-ledger?shop=${shopId}&customer=${customerId}`}>Export ledger (.xlsx)</a></p><p>Debits increase invoice due; credits reduce it. Running balance is calculated from the same event rows for all entries.</p><div className={styles.tableWrap}><table><thead><tr><th scope="col">Business date</th><th scope="col">Recorded</th><th scope="col">Type / reference</th><th scope="col">Actor</th><th scope="col">Debit</th><th scope="col">Credit</th><th scope="col">Balance</th></tr></thead><tbody>{ledger.map((entry)=><tr key={entry.sequenceId}><td>{entry.businessDate}</td><td>{new Date(entry.recordedAt).toLocaleString("en-GB",{timeZone:"Asia/Qatar"})}</td><td><Link href={`/shops/${shopId}/invoices/${entry.invoiceId}`}>{entry.type.replaceAll("_"," ")} · {entry.reference}</Link></td><td>{entry.actorName??"Unknown"}</td><td>{entry.debitDirham?`QAR ${formatQar(entry.debitDirham)}`:"—"}</td><td>{entry.creditDirham?`QAR ${formatQar(entry.creditDirham)}`:"—"}</td><td>QAR {formatQar(entry.balanceDirham)}</td></tr>)}{ledger.length===0&&<tr><td colSpan={7}>No financial activity recorded.</td></tr>}</tbody></table></div></section>
    <section className={styles.panel}><h2>Available and used credit</h2>{creditResult.data.length===0?<p>No approved credit has been issued to this customer.</p>:<div className={styles.detailList}>{creditResult.data.map((row)=><article key={row.id}><strong>Issued QAR {formatQar(row.amount_dirham)} · {row.business_date}</strong><span>{row.reason || "Approved overpayment"} · Used QAR {formatQar(appliedByCredit.get(row.id)??0)} · Source invoice {row.invoice_id ?? "—"}</span></article>)}</div>}</section>
    <section className={styles.panel}><h2>Recent payments</h2>{recentPayments.length===0?<p>No customer payments recorded.</p>:<div className={styles.detailList}>{recentPayments.map((row)=><article key={row.sequenceId}><strong>{row.type.replaceAll("_"," ")} · QAR {formatQar(row.creditDirham-row.debitDirham)}</strong><span>Invoice {row.invoiceNumber} · business date {row.businessDate} · recorded {new Date(row.recordedAt).toLocaleString("en-GB",{timeZone:"Asia/Qatar"})} · Ref {row.sequenceId}</span></article>)}</div>}</section>
    <section className={styles.panel}><h2>Customer audit history</h2>{auditsResult.data.length===0?<p>No customer changes recorded.</p>:<div className={styles.detailList}>{auditsResult.data.map((event)=><article key={event.id}><strong>{event.action.replaceAll("_"," ")}</strong><span>{event.reason || "No reason supplied"} · {new Date(event.recorded_at).toLocaleString("en-GB",{timeZone:"Asia/Qatar"})}</span></article>)}</div>}</section>
  </main>;
}
