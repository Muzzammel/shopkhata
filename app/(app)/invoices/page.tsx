import Link from "next/link";
import { PlusIcon, ReceiptTextIcon, SearchIcon } from "lucide-react";

import { FilterPills } from "@/components/dashboard/filter-pills";
import { SalesTable } from "@/components/sales/sales-table";
import { ui } from "@/components/sales/ui";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { qar } from "@/lib/dashboard-view";
import { addDays } from "@/lib/date-range";
import { fetchInvoiceList, findInvoiceByNumber, INVOICE_PAGE_SIZE, INVOICE_STATUSES, INVOICE_STATUS_LABELS, parseInvoiceListFilter } from "@/lib/invoice-list";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { longDate } from "@/lib/sales-view";
import { getReadableShops, pickShop } from "@/lib/shop-switching";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const { toolbarField: field, toolbarButton: pillButton } = ui;

export default async function InvoicesPage({ searchParams }: PageProps<"/invoices">) {
  const actor = await getCurrentActor();
  const query = await searchParams;
  const supabase = await createServerSupabaseClient();
  const { data: allShops, error: shopsError } = await supabase.from("shops").select("id,name,is_active").order("name");
  if (shopsError || !allShops) throw new Error("INVOICE_LIST_UNAVAILABLE");
  const shops = getReadableShops(actor, allShops);
  const requestedShop = first(query.shop);
  const shop = pickShop(shops, requestedShop);
  if (!shop || !can(actor, "records.view_assigned", shop.id)) return <main className="mx-auto max-w-[1280px] px-4 pt-5 sm:px-6"><h1 className="text-3xl font-semibold tracking-tight">Sales unavailable</h1></main>;

  const today = qatarBusinessDate(new Date());
  const filter = parseInvoiceListFilter(query, today);
  const searchTerm = (first(query.q) ?? "").trim().slice(0, 120);
  const baseQS = `shop=${shop.id}&from=${filter.from}&to=${filter.to}&status=${filter.status}`;

  const [{ rows, hasMore }, searchResult] = await Promise.all([
    fetchInvoiceList(supabase, shop.id, filter),
    searchTerm ? findInvoiceByNumber(supabase, shop.id, searchTerm) : Promise.resolve(undefined),
  ]);

  // Presets are only ready-made From/To pairs for the same server filter.
  const presets = [
    { key: "today", label: "Today", from: today, to: today },
    { key: "7d", label: "7 days", from: addDays(today, -6), to: today },
    { key: "30d", label: "30 days", from: addDays(today, -29), to: today },
  ];
  const preset = presets.find((item) => item.from === filter.from && item.to === filter.to)?.key ?? "custom";
  const invoiceHref = (id: string) => `/shops/${shop.id}/invoices/${id}`;

  return <main className="mx-auto grid w-full max-w-[1280px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6">
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-1">
      <div>
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">{shop.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Sales</h1>
      </div>
      {shop.is_active && <Link href={`/?shop=${shop.id}`} data-slot="new-sale" className={cn(pillButton, "bg-primary text-primary-foreground hover:bg-primary/90")}><PlusIcon aria-hidden className="size-4" />New sale</Link>}
    </header>

    <section aria-label="Find and filter" className="grid gap-4 rounded-3xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <form action="/invoices" role="search" className="flex min-w-0 flex-[1_1_22rem] items-center gap-2">
          <input type="hidden" name="shop" value={shop.id} />
          <label className="relative block min-w-0 flex-1">
            <span className="sr-only">Invoice number</span>
            <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <input data-slot="search" name="q" defaultValue={searchTerm} maxLength={120} placeholder="Exact invoice number" className={cn(field, "pl-10")} />
          </label>
          <button data-slot="button" className={cn(pillButton, "border border-input bg-card text-foreground hover:bg-muted")}>Search</button>
          {searchTerm && <Link href={`/invoices?shop=${shop.id}`} className={cn(pillButton, "text-muted-foreground hover:bg-muted hover:text-foreground")}>Clear</Link>}
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <FilterPills label="Date range" value={preset} items={presets.map((item) => ({ key: item.key, label: item.label, href: `/invoices?shop=${shop.id}&from=${item.from}&to=${item.to}&status=${filter.status}` }))} />
          {preset !== "30d" && <Link href={`/invoices?shop=${shop.id}`} className="text-[13px] font-semibold text-foreground">Reset to last 30 days</Link>}
        </div>
      </div>
      <details className="group/range" open={preset === "custom" || undefined}>
        <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-full text-[13px] font-semibold text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          Custom range <span className="tabular-nums">· {longDate(filter.from)} – {longDate(filter.to)}</span>
        </summary>
        <form action="/invoices" className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="shop" value={shop.id} /><input type="hidden" name="status" value={filter.status} />
          <label data-slot="label" className="grid gap-1 text-xs font-medium text-muted-foreground">From<input data-slot="date" type="date" name="from" defaultValue={filter.from} max={today} required className={cn(field, "w-44 rounded-xl")} /></label>
          <label data-slot="label" className="grid gap-1 text-xs font-medium text-muted-foreground">To<input data-slot="date" type="date" name="to" defaultValue={filter.to} max={today} required className={cn(field, "w-44 rounded-xl")} /></label>
          <button data-slot="button" className={cn(pillButton, "border border-input bg-card text-foreground hover:bg-muted")}>Show range</button>
        </form>
      </details>
      {searchTerm && (searchResult ? <div className="grid gap-3 rounded-2xl bg-muted p-4">
        <p role="status" className="text-sm">Found invoice <strong>{searchResult.invoiceNumber}</strong>, business date {searchResult.businessDate}{(searchResult.businessDate < filter.from || searchResult.businessDate > filter.to) && " (outside the current date filter below)"}.</p>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2 tabular-nums">
          <span className="grid text-xs text-muted-foreground">Total<strong className="text-base text-foreground">{qar(searchResult.totalDirham)}</strong></span>
          <span className="grid text-xs text-muted-foreground">Received<strong className="text-base text-foreground">{qar(searchResult.paidDirham)}</strong></span>
          <span className="grid text-xs text-muted-foreground">Due<strong className={cn("text-base", searchResult.dueDirham > 0 ? "text-warning" : "text-foreground")}>{qar(searchResult.dueDirham)}</strong></span>
          <Link href={invoiceHref(searchResult.invoiceId)} className="ml-auto text-sm font-semibold text-foreground">View invoice {searchResult.invoiceNumber}</Link>
        </div>
      </div> : <p role="alert" className="rounded-2xl bg-warning-soft px-4 py-3 text-sm font-medium text-warning">No invoice numbered &quot;{searchTerm}&quot; was found in {shop.name}. Search matches the exact number, at any date.</p>)}
    </section>

    <div className="flex flex-wrap items-center justify-between gap-3 px-1">
      <FilterPills label="Filter by status" value={filter.status} items={INVOICE_STATUSES.map((item) => ({ key: item, label: INVOICE_STATUS_LABELS[item], href: `/invoices?shop=${shop.id}&from=${filter.from}&to=${filter.to}&status=${item}` }))} />
      <p className="text-xs text-muted-foreground tabular-nums">{longDate(filter.from)} – {longDate(filter.to)}{filter.offset > 0 && ` · from #${filter.offset + 1}`}</p>
    </div>
    {filter.error && <p role="alert" className="rounded-2xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive">{filter.error} Showing the last 30 days instead.</p>}

    {rows.length === 0 ? <section className="grid justify-items-center gap-3 rounded-3xl border border-dashed border-input bg-card px-6 py-14 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-muted"><ReceiptTextIcon aria-hidden className="size-5 text-muted-foreground" /></span>
      <h2 className="text-lg font-semibold">No invoices in this range</h2>
      <p className="max-w-sm text-sm text-muted-foreground">Try another status or date range, or search an exact invoice number to find older sales.</p>
      {shop.is_active && <Link href={`/?shop=${shop.id}`} className={cn(pillButton, "mt-1 bg-primary text-primary-foreground")}><PlusIcon aria-hidden className="size-4" />New sale</Link>}
    </section> : <SalesTable rows={rows} shopId={shop.id} />}

    {(filter.offset > 0 || hasMore) && <nav aria-label="Pages" className="flex items-center justify-between gap-3">
      {filter.offset > 0 ? <Link href={`/invoices?${baseQS}&offset=${Math.max(0, filter.offset - INVOICE_PAGE_SIZE)}`} className={cn(pillButton, "border border-input bg-card text-foreground hover:bg-muted")}>Previous</Link> : <span />}
      <span className="text-xs text-muted-foreground tabular-nums">Showing {filter.offset + 1}–{filter.offset + rows.length}</span>
      {hasMore ? <Link href={`/invoices?${baseQS}&offset=${filter.offset + INVOICE_PAGE_SIZE}`} className={cn(pillButton, "border border-input bg-card text-foreground hover:bg-muted")}>Next</Link> : <span />}
    </nav>}
  </main>;
}
