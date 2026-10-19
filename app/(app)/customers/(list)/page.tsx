import Link from "next/link";
import { SearchIcon, UsersIcon } from "lucide-react";

import { CustomerDirectory } from "@/components/customers/customer-directory";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { getVisibleShops } from "@/lib/shop-switching";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { CustomerCreateForm } from "../../customer-create-form";

const PAGE_SIZE = 30;
const field = "h-10 w-full rounded-full border border-input bg-card px-4 text-sm text-foreground placeholder:text-muted-foreground";
const pillButton = "inline-flex h-10 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold no-underline sk-press";

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
  if (!shop || !can(actor, "records.view_assigned", shop.id)) return <main className="mx-auto max-w-[1280px] px-4 pt-5 sm:px-6"><h1 className="text-3xl font-semibold tracking-tight">Customers unavailable</h1></main>;
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
  const rows = page.map((customer) => {
    const balance = byCustomer.get(customer.id);
    return {
      id: customer.id, publicId: customer.public_id, name: customer.name, mobile: customer.mobile,
      dueDirham: balance?.outstanding_due_dirham ?? 0, creditDirham: balance?.available_credit_dirham ?? 0,
      invoiceCount: balance?.invoice_count ?? 0, lastActivityDate: balance?.last_activity_date ?? null,
    };
  });
  const next = offset + page.length;
  const total = count ?? page.length;
  const pageHref = (at: number) => `/customers?shop=${shop.id}${term ? `&q=${encodeURIComponent(term)}` : ""}&offset=${at}`;

  return <main className="mx-auto grid w-full max-w-[1280px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6">
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-1">
      <div>
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">{shop.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Customers</h1>
      </div>
      <CustomerCreateForm shopId={shop.id} className="h-10 min-h-10 px-4 max-sm:min-h-10" />
    </header>

    <section aria-label="Find customers" className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-border bg-card p-4 sm:p-5">
      <form action="/customers" role="search" className="flex min-w-0 flex-[1_1_22rem] items-center gap-2">
        <input type="hidden" name="shop" value={shop.id} />
        <label className="relative block min-w-0 flex-1">
          <span className="sr-only">Search name, mobile or customer ID</span>
          <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <input data-slot="search" name="q" defaultValue={term} minLength={2} maxLength={100} placeholder="Name, mobile or ID" className={cn(field, "pl-10")} />
        </label>
        <button data-slot="button" className={cn(pillButton, "border border-input bg-card text-foreground hover:bg-muted")}>Search</button>
        {term && <Link href={`/customers?shop=${shop.id}`} className={cn(pillButton, "text-muted-foreground hover:bg-muted hover:text-foreground")}>Clear</Link>}
      </form>
      <p role="status" className="text-sm text-muted-foreground tabular-nums">{term ? `${total} match${total === 1 ? "" : "es"} for “${term}”` : `${total} customer${total === 1 ? "" : "s"} in ${shop.name}`}</p>
    </section>

    {rows.length === 0 ? <section className="grid justify-items-center gap-3 rounded-3xl border border-dashed border-input bg-card px-6 py-14 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-muted"><UsersIcon aria-hidden className="size-5 text-muted-foreground" /></span>
      <h2 className="text-lg font-semibold">{term ? "No customers match this search" : "No customers yet"}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{term ? "Search matches part of a name, a mobile number or a customer ID. Check the spelling or try fewer characters." : "Add a customer to keep their invoices, payments and balance in one place."}</p>
      {term ? <Link href={`/customers?shop=${shop.id}`} className={cn(pillButton, "mt-1 border border-input bg-card text-foreground hover:bg-muted")}>Show all customers</Link> : <CustomerCreateForm shopId={shop.id} className="mt-1" />}
    </section> : <CustomerDirectory rows={rows} shopId={shop.id} />}

    {(offset > 0 || customers.length > PAGE_SIZE) && <nav aria-label="Pages" className="flex items-center justify-between gap-3">
      {offset > 0 ? <Link href={pageHref(Math.max(0, offset - PAGE_SIZE))} className={cn(pillButton, "border border-input bg-card text-foreground hover:bg-muted")}>Previous</Link> : <span />}
      <span className="text-xs text-muted-foreground tabular-nums">Showing {offset + 1}–{next} of {total}</span>
      {customers.length > PAGE_SIZE ? <Link href={pageHref(next)} className={cn(pillButton, "border border-input bg-card text-foreground hover:bg-muted")}>Next</Link> : <span />}
    </nav>}
  </main>;
}
