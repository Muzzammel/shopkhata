import Link from "next/link";
import { DownloadIcon, PlusIcon, WalletIcon } from "lucide-react";

import { FilterPills } from "@/components/dashboard/filter-pills";
import { ExpenseCategories } from "@/components/dashboard/lists";
import { ExpenseSummary } from "@/components/expenses/expense-summary";
import { ExpenseTable, type ExpenseRow } from "@/components/expenses/expense-table";
import { ui } from "@/components/sales/ui";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { addDays, first, parseDateRangeFilter } from "@/lib/date-range";
import { EXPENSE_CATEGORIES } from "@/lib/expense-operations";
import { categoryLabel, parseCategoryFilter, summarizeExpenses } from "@/lib/expense-view";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { readAllPages } from "@/lib/read-all-pages";
import { mapExpenseTotals } from "@/lib/reports";
import { longDate } from "@/lib/sales-view";
import { getVisibleShops } from "@/lib/shop-switching";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { AddExpenseDrawer } from "../expense-forms";

const PAGE_SIZE = 30;
const { toolbarField: field, toolbarButton: pillButton } = ui;

export default async function ExpensesPage({ searchParams }: PageProps<"/expenses">) {
  const actor = await getCurrentActor();
  const query = await searchParams;
  const supabase = await createServerSupabaseClient();
  const { data: allShops, error: shopsError } = await supabase.from("shops").select("id,name,is_active").eq("is_active", true).order("name");
  if (shopsError || !allShops) throw new Error("EXPENSE_WORKSPACE_UNAVAILABLE");
  const shops = getVisibleShops(actor, allShops);
  const shop = shops.find((item) => item.id === first(query.shop)) ?? shops[0];
  if (!shop || !can(actor, "records.view_assigned", shop.id)) return <main className="mx-auto max-w-[1280px] px-4 pt-5 sm:px-6"><h1 className="text-3xl font-semibold tracking-tight">Expenses unavailable</h1></main>;

  const today = qatarBusinessDate(new Date());
  const range = parseDateRangeFilter(query, today);
  const category = parseCategoryFilter(first(query.category));
  const offset = Math.max(0, Math.min(100_000, Number.parseInt(first(query.offset) ?? "0", 10) || 0));

  // Read-only: the same effective_expenses rows as before, narrowed to the chosen dates and category.
  let list = supabase.from("effective_expenses").select("id,business_date,recorded_at,category,description,amount_dirham,correction_request_id,backdated_reason")
    .eq("shop_id", shop.id).gte("business_date", range.from).lte("business_date", range.to);
  if (category !== "all") list = list.eq("category", category);
  const [expensesResult, totalsResult] = await Promise.all([
    list.order("business_date", { ascending: false }).order("recorded_at", { ascending: false }).order("id").range(offset, offset + PAGE_SIZE),
    supabase.rpc("report_expense_totals", { p_shop_id: shop.id, p_from: range.from, p_to: range.to }),
  ]);
  if (expensesResult.error || !expensesResult.data || totalsResult.error || !totalsResult.data) throw new Error("EXPENSE_HISTORY_UNAVAILABLE");
  const page = expensesResult.data.slice(0, PAGE_SIZE);
  const ids = page.map((expense) => expense.id!);

  const [requestsResult, attachmentsResult, anyExpense] = await Promise.all([
    ids.length ? readAllPages((o, e) => supabase.from("expense_correction_requests").select("id,expense_id").eq("shop_id", shop.id).in("expense_id", ids).order("id").range(o, e)) : Promise.resolve({ data: [], error: null }),
    ids.length ? readAllPages((o, e) => supabase.from("attachments").select("id,expense_id").eq("shop_id", shop.id).in("expense_id", ids).order("id").range(o, e)) : Promise.resolve({ data: [], error: null }),
    // Only when nothing matches: tells "no expenses at all" apart from "none for these filters".
    ids.length ? Promise.resolve({ data: [{ id: "" }], error: null }) : supabase.from("effective_expenses").select("id").eq("shop_id", shop.id).limit(1),
  ]);
  if (requestsResult.error || !requestsResult.data || attachmentsResult.error || !attachmentsResult.data || anyExpense.error || !anyExpense.data) throw new Error("EXPENSE_HISTORY_UNAVAILABLE");
  const requestIds = requestsResult.data.map((request) => request.id);
  const decisionsResult = requestIds.length ? await readAllPages((o, e) => supabase.from("expense_correction_decisions").select("request_id").eq("shop_id", shop.id).in("request_id", requestIds).order("request_id").range(o, e)) : { data: [], error: null };
  if (decisionsResult.error || !decisionsResult.data) throw new Error("EXPENSE_HISTORY_UNAVAILABLE");

  const decided = new Set(decisionsResult.data.map((decision) => decision.request_id));
  const count = (rows: readonly { expense_id: string | null }[], id: string) => rows.filter((row) => row.expense_id === id).length;
  const attachments = attachmentsResult.data;
  const pending = requestsResult.data.filter((request) => !decided.has(request.id));
  const rows: ExpenseRow[] = page.map((expense) => ({
    id: expense.id!, businessDate: expense.business_date!, category: expense.category!, description: expense.description!, amountDirham: expense.amount_dirham!,
    receiptCount: count(attachments, expense.id!), pendingCount: count(pending, expense.id!), corrected: expense.correction_request_id !== null, backdated: Boolean(expense.backdated_reason),
  }));
  const totals = mapExpenseTotals(totalsResult.data);
  const summary = summarizeExpenses(totals, category);

  // Presets are only ready-made From/To pairs for the same server filter, as on Sales.
  const presets = [
    { key: "today", label: "Today", from: today, to: today },
    { key: "7d", label: "7 days", from: addDays(today, -6), to: today },
    { key: "30d", label: "30 days", from: addDays(today, -29), to: today },
  ];
  const preset = presets.find((item) => item.from === range.from && item.to === range.to);
  const href = (changes: { from?: string; to?: string; category?: string; offset?: number }) => {
    const next = { from: range.from, to: range.to, category, offset: 0, ...changes };
    return `/expenses?shop=${shop.id}&from=${next.from}&to=${next.to}${next.category === "all" ? "" : `&category=${next.category}`}${next.offset ? `&offset=${next.offset}` : ""}`;
  };
  const filtered = category !== "all" || preset?.key !== "30d";
  const scope = `${preset ? (preset.key === "today" ? "Today" : `Last ${preset.label}`) : "Custom range"} · ${range.from === range.to ? longDate(range.from) : `${longDate(range.from)} – ${longDate(range.to)}`} · ${category === "all" ? "all categories" : categoryLabel(category)}`;
  const canCreate = can(actor, "expense.create", shop.id);
  const noneRecorded = rows.length === 0 && anyExpense.data.length === 0;

  return <main className="mx-auto grid w-full max-w-[1280px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6">
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-1">
      <div>
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">{shop.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Expenses</h1>
      </div>
      <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
        <form action="/exports/expenses" method="get" className="max-sm:flex-1">
          <input type="hidden" name="shop" value={shop.id} /><input type="hidden" name="from" value={range.from} /><input type="hidden" name="to" value={range.to} />
          <button data-slot="button" aria-label="Export expenses (.xlsx)" title={`All categories, ${longDate(range.from)} – ${longDate(range.to)}`} className={cn(pillButton, "w-full border border-input bg-card text-foreground hover:bg-muted max-sm:h-11")}><DownloadIcon aria-hidden className="size-4" />Export</button>
        </form>
        {canCreate && <AddExpenseDrawer shopId={shop.id} shopName={shop.name} businessDate={today} canBackdate={actor.role === "owner"} className="h-10 min-h-10 px-4 max-sm:h-11 max-sm:min-h-11 max-sm:flex-1" />}
      </div>
    </header>

    <section aria-label="Filter expenses" className="grid gap-3 rounded-3xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <FilterPills label="Date range" value={preset?.key ?? "custom"} items={presets.map((item) => ({ key: item.key, label: item.label, href: href({ from: item.from, to: item.to }) }))} />
          {filtered && <Link href={`/expenses?shop=${shop.id}`} className="text-[13px] font-semibold text-foreground">Reset filters</Link>}
        </div>
        <details className="group/range" open={!preset || undefined}>
          <summary data-slot="summary" className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-full text-[13px] font-semibold text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            Custom range <span className="tabular-nums">· {longDate(range.from)} – {longDate(range.to)}</span>
          </summary>
          <form action="/expenses" className="mt-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="shop" value={shop.id} />{category !== "all" && <input type="hidden" name="category" value={category} />}
            <label data-slot="label" className="grid gap-1 text-xs font-medium text-muted-foreground">From<input data-slot="date" type="date" name="from" defaultValue={range.from} max={today} required className={cn(field, "w-44 rounded-xl")} /></label>
            <label data-slot="label" className="grid gap-1 text-xs font-medium text-muted-foreground">To<input data-slot="date" type="date" name="to" defaultValue={range.to} max={today} required className={cn(field, "w-44 rounded-xl")} /></label>
            <button data-slot="button" className={cn(pillButton, "border border-input bg-card text-foreground hover:bg-muted")}>Show range</button>
          </form>
        </details>
      </div>
      {/* On phones the category pills wrap as separate chips: every category and the selected one stay in view without a clipped scroll strip. */}
      <FilterPills label="Filter by category" value={category} className="justify-self-start max-sm:flex-wrap max-sm:gap-1.5 max-sm:overflow-visible max-sm:rounded-none max-sm:bg-transparent max-sm:p-0 max-sm:[&>a:not([aria-current])]:bg-muted" items={[{ key: "all", label: "All categories", href: href({ category: "all" }) }, ...EXPENSE_CATEGORIES.map((item) => ({ key: item, label: categoryLabel(item), href: href({ category: item }) }))]} />
    </section>
    {range.error && <p role="alert" className="rounded-2xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive">{range.error} Showing the last 30 days instead.</p>}

    <div className={cn("grid gap-4 sm:gap-5", category === "all" && totals.byCategory.length > 0 && "lg:grid-cols-[minmax(0,1fr)_22rem]")}>
      <ExpenseSummary summary={summary} scope={scope} beside={category === "all" && totals.byCategory.length > 0} />
      {category === "all" && totals.byCategory.length > 0 && <ExpenseCategories title="By category" rows={totals.byCategory} totalDirham={totals.totalDirham} className="lg:col-span-1" />}
    </div>

    {rows.length === 0 ? <section className="grid justify-items-center gap-3 rounded-3xl border border-dashed border-input bg-card px-6 py-14 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-muted"><WalletIcon aria-hidden className="size-5 text-muted-foreground" /></span>
      <h2 data-slot="heading" className="text-lg font-semibold">{noneRecorded ? "No expenses recorded" : "No expenses match these filters"}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{noneRecorded ? `Record rent, utilities, supplies and other running costs for ${shop.name}.` : "Try another date range or category."}</p>
      {noneRecorded ? (canCreate && <a data-slot="button" href="#add-expense" className={cn(ui.primary, "mt-1")}><PlusIcon aria-hidden />Add expense</a>) : <Link href={`/expenses?shop=${shop.id}`} className={cn(pillButton, "mt-1 border border-input bg-card text-foreground hover:bg-muted")}>Reset filters</Link>}
    </section> : <ExpenseTable rows={rows} shopId={shop.id} />}

    {(offset > 0 || expensesResult.data.length > PAGE_SIZE) && <nav aria-label="Pages" className="flex items-center justify-between gap-3">
      {offset > 0 ? <Link href={href({ category, offset: Math.max(0, offset - PAGE_SIZE) })} className={cn(pillButton, "border border-input bg-card text-foreground hover:bg-muted")}>Newer</Link> : <span />}
      <span className="text-xs text-muted-foreground tabular-nums">Showing {offset + 1}–{offset + rows.length} of {summary.count}</span>
      {expensesResult.data.length > PAGE_SIZE ? <Link href={href({ category, offset: offset + PAGE_SIZE })} className={cn(pillButton, "border border-input bg-card text-foreground hover:bg-muted")}>Older</Link> : <span />}
    </nav>}
  </main>;
}
