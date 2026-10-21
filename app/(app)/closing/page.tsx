import Link from "next/link";
import { CircleAlertIcon, LockIcon, LockOpenIcon } from "lucide-react";
import { z } from "zod";

import { ui } from "@/components/sales/ui";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { canReopenDate, dayState, type CloseEvent } from "@/lib/closing";
import { closeAttention, dailyGroups, hasActivity, metricTone } from "@/lib/closing-view";
import { qar } from "@/lib/dashboard-view";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { emptyDailySummary, fetchDailySummary, type DailySummary } from "@/lib/reports";
import { qatarDateTime } from "@/lib/sales-view";
import { getVisibleShops } from "@/lib/shop-switching";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

import { DayCloseControl } from "./close-forms";

const qatarTime = qatarDateTime;
const money = qar;
const card = cn(ui.card, "grid content-start gap-4 p-5 sm:p-6");

/** The figures the close drawer shows so the person closing reviews the same numbers the summary shows. */
function CloseReview({ summary, attention }: { summary: DailySummary; attention: string[] }) {
  return <div className="grid gap-4">
    <div className={ui.warn}>Closing blocks every new invoice, payment, expense and correction dated {summary.businessDate} for this shop. Nothing is deleted, and an owner or manager can reopen the date with a reason.</div>
    <dl className="grid grid-cols-2 gap-3 text-sm">
      <div className="grid gap-0.5 rounded-2xl bg-muted p-3"><dt className="text-muted-foreground">Invoices entered</dt><dd className="text-lg font-semibold tabular-nums">{summary.invoiceCount}</dd></div>
      <div className="grid gap-0.5 rounded-2xl bg-muted p-3"><dt className="text-muted-foreground">Total received</dt><dd className="text-lg font-semibold tabular-nums">{money(summary.totalReceivedDirham)}</dd><dd className="text-xs text-muted-foreground tabular-nums">Cash {money(summary.cashReceivedDirham)} · Bank {money(summary.bankReceivedDirham)}</dd></div>
      <div className="grid gap-0.5 rounded-2xl bg-muted p-3"><dt className="text-muted-foreground">Expenses</dt><dd className="text-lg font-semibold tabular-nums">{money(summary.expensesDirham)}</dd></div>
      <div className="grid gap-0.5 rounded-2xl bg-muted p-3"><dt className="text-muted-foreground">Net due movement</dt><dd className="text-lg font-semibold tabular-nums">{money(summary.netDueMovementDirham)}</dd></div>
    </dl>
    {attention.length > 0 && <ul className="grid list-none gap-2 pl-0 text-sm text-foreground">{attention.map((note) => <li key={note} className="flex gap-2"><CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />{note}</li>)}</ul>}
  </div>;
}

export default async function ClosingPage({ searchParams }: PageProps<"/closing">) {
  const actor = await getCurrentActor();
  const query = await searchParams;
  const supabase = await createServerSupabaseClient();
  const { data: allShops, error: shopsError } = await supabase.from("shops").select("id,name,is_active").eq("is_active", true).order("name");
  if (shopsError || !allShops) throw new Error("CLOSING_WORKSPACE_UNAVAILABLE");
  const shops = getVisibleShops(actor, allShops);
  const requestedShop = Array.isArray(query.shop) ? query.shop[0] : query.shop;
  const shop = shops.find((item) => item.id === requestedShop) ?? shops[0];
  if (!shop || !can(actor, "records.view_assigned", shop.id)) return <main className="mx-auto max-w-[1280px] px-4 pt-5 sm:px-6"><h1 className="text-3xl font-semibold tracking-tight">Daily close unavailable</h1></main>;

  // The business date is the Qatar operating date; it is compared as text and never passed through a time zone.
  const today = qatarBusinessDate(new Date());
  const requestedDate = Array.isArray(query.date) ? query.date[0] : query.date;
  const date = z.iso.date().safeParse(requestedDate).success && requestedDate! <= today ? requestedDate! : today;

  const [summaries, eventsResult, pendingResult, batchesResult, expensesResult] = await Promise.all([
    fetchDailySummary(supabase, shop.id, date, date),
    supabase.from("daily_closes").select("event_sequence,event_type,actor_id,recorded_at,reason,note").eq("shop_id", shop.id).eq("business_date", date).order("event_sequence", { ascending: false }).limit(100),
    supabase.rpc("report_day_pending_requests", { p_shop_id: shop.id, p_date: date }),
    supabase.from("batches").select("id,backdated_reason,created_by,recorded_at").eq("shop_id", shop.id).eq("business_date", date).eq("is_backdated", true).order("recorded_at").limit(100),
    supabase.from("effective_expenses").select("id,description,amount_dirham,backdated_reason,created_by,recorded_at").eq("shop_id", shop.id).eq("business_date", date).not("backdated_reason", "is", null).order("recorded_at").limit(100),
  ]);
  if (eventsResult.error || !eventsResult.data || pendingResult.error || !pendingResult.data || batchesResult.error || !batchesResult.data || expensesResult.error || !expensesResult.data) throw new Error("CLOSING_WORKSPACE_UNAVAILABLE");

  const summary = summaries[0] ?? emptyDailySummary(date);
  const events: CloseEvent[] = eventsResult.data.map((event) => ({
    sequence: event.event_sequence, type: event.event_type as CloseEvent["type"], actorId: event.actor_id, recordedAt: event.recorded_at, reason: event.reason, note: event.note,
  }));
  const state = dayState(events);
  const lastClose = events.find((event) => event.type === "closed");
  const pending = pendingResult.data[0];
  const pendingCount = (pending?.pending_invoice_corrections ?? 0) + (pending?.pending_invoice_replacements ?? 0) + (pending?.pending_expense_corrections ?? 0);
  const backdatedCount = batchesResult.data.length + expensesResult.data.length;
  const attention = closeAttention({ pendingCount, backdatedCount });

  // Staff can read only their own profile; other actors fall back to their ID.
  const actorIds = [...new Set([...events.map((event) => event.actorId), ...batchesResult.data.map((batch) => batch.created_by), ...expensesResult.data.map((expense) => expense.created_by)].filter((id): id is string => Boolean(id)))];
  const { data: profiles } = actorIds.length ? await supabase.from("profiles").select("id,display_name").in("id", actorIds) : { data: [] };
  const names = new Map((profiles ?? []).map((profile) => [profile.id, profile.display_name]));
  const who = (id: string | null) => id ? names.get(id) ?? id : "Unknown actor";

  const mayClose = state === "open" && can(actor, "date.close", shop.id);
  const mayReopen = state === "closed" && can(actor, "date.reopen", shop.id) && canReopenDate(actor.role, date, today);
  const closed = state === "closed";

  return <main className="mx-auto grid w-full max-w-[1280px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6">
    <header className="grid min-w-0 gap-1.5 px-1">
      <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">{shop.name}</p>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Daily close</h1>
      <p className="max-w-2xl text-sm text-muted-foreground">Closing a business date blocks every new entry for that shop and date until it is reopened with a reason.</p>
    </header>
    {shops.length > 1 && <nav className="flex flex-wrap gap-2" aria-label="Choose shop">{shops.map((item) => <Link key={item.id} aria-current={item.id === shop.id ? "page" : undefined} href={`/closing?shop=${item.id}&date=${date}`} className={cn(ui.chip, item.id === shop.id ? "bg-primary text-primary-foreground" : "border border-input bg-card text-foreground hover:bg-muted")}>{item.name}</Link>)}</nav>}

    <section aria-labelledby="closing-status-heading" className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="closing-status-heading" className="text-lg font-semibold tracking-tight">Status for {date}</h2>
        <span data-day-state={state} className={cn("inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-sm font-semibold", closed ? "bg-foreground text-background" : "bg-success-soft text-success")}>
          {closed ? <LockIcon aria-hidden className="size-4" /> : <LockOpenIcon aria-hidden className="size-4" />}
          {closed ? "Closed" : "Open"}
        </span>
      </div>
      <form className="flex flex-wrap items-end gap-3" action="/closing">
        <input type="hidden" name="shop" value={shop.id} />
        <label className="grid gap-1.5 text-[13px] font-medium text-muted-foreground">Business date<input type="date" name="date" defaultValue={date} max={today} required className={cn(ui.field, "w-auto")} /></label>
        <button className={ui.secondary}>Show date</button>
      </form>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="grid gap-1 rounded-2xl bg-muted p-3"><span className="text-xs text-muted-foreground">Business date</span><strong className="text-sm font-semibold tabular-nums">{date}</strong></div>
        <div className="grid gap-1 rounded-2xl bg-muted p-3"><span className="text-xs text-muted-foreground">Closed by</span><strong className="text-sm font-semibold">{closed && lastClose ? who(lastClose.actorId) : "—"}</strong></div>
        <div className="grid gap-1 rounded-2xl bg-muted p-3"><span className="text-xs text-muted-foreground">Closed at (Qatar time)</span><strong className="text-sm font-semibold">{closed && lastClose ? qatarTime(lastClose.recordedAt) : "—"}</strong></div>
        <div className="grid gap-1 rounded-2xl bg-muted p-3"><span className="text-xs text-muted-foreground">Activity</span><strong className="text-sm font-semibold">{hasActivity(summary) ? `${summary.invoiceCount} invoices · ${summary.expenseCount} expenses` : "Nothing recorded yet"}</strong></div>
      </div>
      {closed && lastClose?.note && <p className="text-sm text-muted-foreground">Close note: {lastClose.note}</p>}
      {attention.length > 0 && <ul className="grid list-none gap-2 pl-0">{attention.map((note) => <li key={note} className={ui.warn}>{note}</li>)}</ul>}
    </section>

    <section aria-labelledby="closing-summary-heading" className={card}>
      <div className="grid gap-1">
        <h2 id="closing-summary-heading" className="text-lg font-semibold tracking-tight">Summary for {date}</h2>
        <p className="text-sm text-muted-foreground">Amounts are grouped by business date, not by the time they were typed in. ShopKhata records sales, receipts, dues and expenses; it holds no cost of goods, so none of these figures is profit.</p>
      </div>
      {dailyGroups().map((group) => <div key={group.title} className="grid gap-2.5">
        <h3 className="text-sm font-semibold text-muted-foreground">{group.title}</h3>
        <div className="grid grid-cols-2 gap-3 tabular-nums lg:grid-cols-3">{group.metrics.map((metric, index) => <div key={metric.key} title={metric.meaning} className={cn("grid content-start gap-1 rounded-2xl p-4", index === 0 ? "col-span-2 bg-muted sm:col-span-1" : "bg-card ring-1 ring-border ring-inset")}>
          <span className="text-xs text-muted-foreground">{metric.label}</span>
          <strong data-metric={metric.key} className={cn("font-semibold tracking-tight", index === 0 ? "text-xl sm:text-2xl" : "text-lg sm:text-xl", metricTone(metric.key) === "received" && "text-success", metricTone(metric.key) === "due" && "text-warning")}>{metric.kind === "money" ? money(summary[metric.key]) : summary[metric.key]}</strong>
        </div>)}</div>
      </div>)}
      <p><Link href={`/reports?shop=${shop.id}&report=daily&date=${date}`} className="font-semibold underline underline-offset-4">Open the daily report</Link></p>
    </section>

    {mayClose && <section aria-labelledby="close-action-heading" className={card}>
      <div className="grid gap-1"><h2 id="close-action-heading" className="text-lg font-semibold tracking-tight">Close {date}</h2><p className="text-sm text-muted-foreground">Entries still waiting on a device that is offline are not part of this summary. They are rejected when they arrive after the close and stay on that device.</p></div>
      <div><DayCloseControl mode="close" shopId={shop.id} shopName={shop.name} businessDate={date} review={<CloseReview summary={summary} attention={attention} />} /></div>
    </section>}
    {mayReopen && <section aria-labelledby="reopen-action-heading" className={card}>
      <div className="grid gap-1"><h2 id="reopen-action-heading" className="text-lg font-semibold tracking-tight">Reopen {date}</h2><p className="text-sm text-muted-foreground">Reopening changes this date&apos;s operational status: new entries are accepted again and the summary can change. A reason is recorded in the history.</p></div>
      <div className={ui.warn}>Only reopen when a real record was missed. The date will show as Open until someone closes it again.</div>
      <div><DayCloseControl mode="reopen" shopId={shop.id} shopName={shop.name} businessDate={date} review={<div className={ui.warn}>Reopening {date} for {shop.name} allows new entries again. Enter the reason below; it is kept in the history.</div>} /></div>
    </section>}
    {closed && !mayReopen && <section className={card}><p className="text-sm text-muted-foreground">{can(actor, "date.reopen", shop.id) ? "Only the owner can reopen an earlier business date." : "Only a manager or owner can reopen this date."}</p></section>}
    {!closed && !mayClose && <section className={card}><p className="text-sm text-muted-foreground">Only a manager or owner can close this date.</p></section>}

    <section aria-labelledby="backdated-heading" className={card}>
      <h2 id="backdated-heading" className="text-lg font-semibold tracking-tight">Backdated entries for {date}</h2>
      {backdatedCount === 0 ? <p className="text-sm text-muted-foreground">No backdated entry was recorded for this date.</p> : <div className="grid gap-3">
        {batchesResult.data.map((batch) => <article key={batch.id} className="grid gap-1 rounded-2xl bg-muted p-4 text-sm"><strong>Backdated invoice batch</strong><span>Business date {date} · recorded {qatarTime(batch.recorded_at)} by {who(batch.created_by)}</span><span>Reason: {batch.backdated_reason}</span></article>)}
        {expensesResult.data.map((expense) => <article key={expense.id} className="grid gap-1 rounded-2xl bg-muted p-4 text-sm"><strong>Backdated expense · {money(expense.amount_dirham!)} · {expense.description}</strong><span>Business date {date} · recorded {qatarTime(expense.recorded_at!)} by {who(expense.created_by)}</span><span>Reason: {expense.backdated_reason}</span></article>)}
      </div>}
    </section>

    <section aria-labelledby="history-heading" className={card}>
      <h2 id="history-heading" className="text-lg font-semibold tracking-tight">Close and reopen history</h2>
      {events.length === 0 ? <p className="text-sm text-muted-foreground">This date has never been closed.</p> : <ol className="grid list-none gap-3 pl-0">{events.map((event) => <li key={event.sequence} className="grid gap-1 border-l-2 border-border pl-4 text-sm">
        <strong>{event.type === "closed" ? "Closed" : "Reopened"} · {shop.name} · {date}</strong>
        <span className="text-muted-foreground">{qatarTime(event.recordedAt)} (Qatar time) by {who(event.actorId)}</span>
        {(event.reason || event.note) && <span>{event.type === "closed" ? "Note" : "Reason"}: {event.reason ?? event.note}</span>}
      </li>)}</ol>}
    </section>
  </main>;
}
