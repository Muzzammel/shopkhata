import Link from "next/link";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { getVisibleShops } from "@/lib/shop-switching";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { formatQar } from "@/lib/domain/money";
import { CustomerCreateForm } from "../customer-create-form";
import styles from "./operations.module.css";

const PAGE_SIZE = 30;
export default async function CustomersPage({ searchParams }: PageProps<"/customers">) {
  const actor = await getCurrentActor();
  const query = await searchParams;
  const rawOffset=Array.isArray(query.offset)?query.offset[0]:query.offset;
  const rawTerm=Array.isArray(query.q)?query.q[0]:query.q;
  const rawShop=Array.isArray(query.shop)?query.shop[0]:query.shop;
  const offset = Math.max(0, Math.min(10_000, Number.parseInt(rawOffset ?? "0", 10) || 0));
  const term = (rawTerm ?? "").trim().slice(0, 100);
  const supabase = await createServerSupabaseClient();
  const { data: allShops, error: shopsError } = await supabase.from("shops").select("id,name,is_active").eq("is_active", true).order("name");
  if (shopsError || !allShops) throw new Error("CUSTOMER_WORKSPACE_UNAVAILABLE");
  const shops = getVisibleShops(actor, allShops);
  const shop = shops.find((item) => item.id === rawShop) ?? shops[0];
  if (!shop || !can(actor, "records.view_assigned", shop.id)) return <main className={styles.workspace}><h1>Customers unavailable</h1></main>;
  let request = supabase.from("customers").select("id,public_id,name,mobile,created_at", { count: "exact" }).eq("shop_id", shop.id);
  if (term) {
    const escaped = term.replace(/[\\%_*,()]/g, "\\$&");
    request = request.or(`name.ilike.*${escaped}*,mobile.ilike.*${escaped}*,public_id.ilike.*${escaped}*`);
  }
  const { data: customers, error, count } = await request.order("name", { ascending: true, nullsFirst: false }).order("public_id").range(offset, offset + PAGE_SIZE);
  if (error || !customers) throw new Error("CUSTOMER_WORKSPACE_UNAVAILABLE");
  const page = customers.slice(0, PAGE_SIZE);
  const { data: balances, error: balanceError } = page.length
    ? await supabase.from("customer_financial_balances").select("customer_id,outstanding_due_dirham,invoice_count,last_activity_date,available_credit_dirham").eq("shop_id", shop.id).in("customer_id", page.map((c) => c.id))
    : { data: [], error: null };
  if (balanceError || !balances) throw new Error("CUSTOMER_BALANCE_UNAVAILABLE");
  const byCustomer = new Map(balances.map((b) => [b.customer_id, b]));
  const next = offset + page.length;
  return <main className={styles.workspace}>
    <header className={styles.header}><div><p className={styles.eyebrow}>{shop.name}</p><h1>Customers</h1></div><Link href="/">Back to overview</Link></header>
    {shops.length > 1 && <nav className={styles.shops} aria-label="Choose shop">{shops.map((s) => <Link key={s.id} aria-current={s.id === shop.id ? "page" : undefined} href={`/customers?shop=${s.id}`}>{s.name}</Link>)}</nav>}
    <section className={styles.panel}>
      <form className={styles.search} action="/customers"><input type="hidden" name="shop" value={shop.id}/><label>Search name, mobile or customer ID<input name="q" defaultValue={term} minLength={2} maxLength={100}/></label><button>Search</button>{term && <Link href={`/customers?shop=${shop.id}`}>Clear</Link>}</form>
      <p className={styles.muted}>{count ?? page.length} customers in {shop.name}</p>
      <div className={styles.tableWrap}><table><thead><tr><th scope="col">Customer</th><th scope="col">Mobile</th><th scope="col">Outstanding due</th><th scope="col">Invoices</th><th scope="col">Last activity</th></tr></thead><tbody>
        {page.map((customer) => { const balance = byCustomer.get(customer.id); const due = balance?.outstanding_due_dirham ?? 0; return <tr key={customer.id}>
          <td><Link href={`/customers/${customer.id}?shop=${shop.id}`}><strong>{customer.name || "Unnamed customer"}</strong><small>{customer.public_id}</small></Link></td><td>{customer.mobile || "—"}</td>
          <td><strong>{due ? `QAR ${formatQar(due)}` : "Settled"}</strong>{(balance?.available_credit_dirham ?? 0) > 0 && <small>Credit QAR {formatQar(balance!.available_credit_dirham!)}</small>}</td>
          <td>{balance?.invoice_count ?? 0}</td><td>{balance?.last_activity_date ?? "—"}</td>
        </tr>; })}
        {page.length === 0 && <tr><td colSpan={5}>No customers match this search.</td></tr>}
      </tbody></table></div>
      <div className={styles.pager}>{offset > 0 && <Link href={`/customers?shop=${shop.id}&q=${encodeURIComponent(term)}&offset=${Math.max(0, offset-PAGE_SIZE)}`}>Previous</Link>}{customers.length > PAGE_SIZE && <Link href={`/customers?shop=${shop.id}&q=${encodeURIComponent(term)}&offset=${next}`}>Next</Link>}</div>
    </section>
    <CustomerCreateForm shopId={shop.id}/>
  </main>;
}
