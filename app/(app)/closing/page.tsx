import Link from "next/link";
import { z } from "zod";

import { can, getCurrentActor } from "@/lib/auth/permissions";
import { canReopenDate, dayState, type CloseEvent } from "@/lib/closing";
import { formatQar } from "@/lib/domain/money";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { DAILY_METRICS, emptyDailySummary, fetchDailySummary } from "@/lib/reports";
import { getVisibleShops } from "@/lib/shop-switching";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import { DayCloseForm } from "./close-forms";
import styles from "@/app/ui.module.css";

const qatarTime = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Qatar" });

export default async function ClosingPage({ searchParams }: PageProps<"/closing">) {
  const actor = await getCurrentActor();
  const query = await searchParams;
  const supabase = await createServerSupabaseClient();
  const { data: allShops, error: shopsError } = await supabase.from("shops").select("id,name,is_active").eq("is_active", true).order("name");
  if (shopsError || !allShops) throw new Error("CLOSING_WORKSPACE_UNAVAILABLE");
  const shops = getVisibleShops(actor, allShops);
  const requestedShop = Array.isArray(query.shop) ? query.shop[0] : query.shop;
  const shop = shops.find((item) => item.id === requestedShop) ?? shops[0];
  if (!shop || !can(actor, "records.view_assigned", shop.id)) return <main className={styles.workspace}><h1>Daily close unavailable</h1></main>;

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

  // Staff can read only their own profile; other actors fall back to their ID.
  const actorIds = [...new Set([...events.map((event) => event.actorId), ...batchesResult.data.map((batch) => batch.created_by), ...expensesResult.data.map((expense) => expense.created_by)].filter((id): id is string => Boolean(id)))];
  const { data: profiles } = actorIds.length ? await supabase.from("profiles").select("id,display_name").in("id", actorIds) : { data: [] };
  const names = new Map((profiles ?? []).map((profile) => [profile.id, profile.display_name]));
  const who = (id: string | null) => id ? names.get(id) ?? id : "Unknown actor";

  const mayClose = state === "open" && can(actor, "date.close", shop.id);
  const mayReopen = state === "closed" && can(actor, "date.reopen", shop.id) && canReopenDate(actor.role, date, today);

  return <main className={styles.workspace}>
    <header className={styles.header}><div><p className={styles.eyebrow}>{shop.name}</p><h1>Daily close</h1><p>Closing a business date blocks every new entry for that shop and date until it is reopened with a reason.</p></div><Link href="/">Back to overview</Link></header>
    {shops.length > 1 && <nav className={styles.shops} aria-label="Choose shop">{shops.map((item) => <Link key={item.id} aria-current={item.id === shop.id ? "page" : undefined} href={`/closing?shop=${item.id}&date=${date}`}>{item.name}</Link>)}</nav>}

    <section className={styles.panel}>
      <form className={styles.search} action="/closing"><input type="hidden" name="shop" value={shop.id} /><label>Business date<input type="date" name="date" defaultValue={date} max={today} required /></label><button className={styles.secondary}>Show date</button></form>
      <div className={styles.metrics}>
        <div><span>Business date</span><strong>{date}</strong></div>
        <div><span>State</span><strong data-day-state={state} className={styles.badge} data-tone={state === "closed" ? "solid" : "success"}>{state === "closed" ? "Closed" : "Open"}</strong></div>
        <div><span>Closed by</span><strong>{state === "closed" && lastClose ? who(lastClose.actorId) : "—"}</strong></div>
        <div><span>Closed at (Qatar time)</span><strong>{state === "closed" && lastClose ? qatarTime(lastClose.recordedAt) : "—"}</strong></div>
      </div>
      {state === "closed" && lastClose?.note && <p>Close note: {lastClose.note}</p>}
    </section>

    <section className={styles.panel}>
      <h2>Summary for {date}</h2>
      <p className={styles.muted}>Amounts are grouped by business date, not by the time they were typed in. ShopKhata records sales, receipts, dues and expenses; it holds no cost of goods, so none of these figures is profit.</p>
      <div className={styles.metrics}>{DAILY_METRICS.map((metric) => <div key={metric.key} title={metric.meaning}><span>{metric.label}</span><strong data-metric={metric.key}>{metric.kind === "money" ? `QAR ${formatQar(summary[metric.key])}` : summary[metric.key]}</strong></div>)}</div>
      <p><Link href={`/reports?shop=${shop.id}&report=daily&date=${date}`}>Open the daily report</Link></p>
      {pendingCount > 0 && <p className={styles.callout}>Waiting for a decision on records dated {date}: {pending.pending_invoice_corrections} invoice corrections, {pending.pending_invoice_replacements} invoice replacements, {pending.pending_expense_corrections} expense corrections. They do not stop a close. An expense correction cannot be approved while its date is closed.</p>}
    </section>

    {mayClose && <section className={`${styles.panel} ${styles.governance}`}><h2>Close {date}</h2><p className={styles.muted}>Entries still waiting on a device that is offline are not part of this summary. They are rejected when they arrive after the close and stay on that device.</p><DayCloseForm mode="close" shopId={shop.id} shopName={shop.name} businessDate={date} /></section>}
    {mayReopen && <section className={`${styles.panel} ${styles.governance}`}><h2>Reopen {date}</h2><DayCloseForm mode="reopen" shopId={shop.id} shopName={shop.name} businessDate={date} /></section>}
    {state === "closed" && !mayReopen && <section className={styles.panel}><p>{can(actor, "date.reopen", shop.id) ? "Only the owner can reopen an earlier business date." : "Only a manager or owner can reopen this date."}</p></section>}
    {state === "open" && !mayClose && <section className={styles.panel}><p>Only a manager or owner can close this date.</p></section>}

    <section className={styles.panel}>
      <h2>Backdated entries for {date}</h2>
      {batchesResult.data.length + expensesResult.data.length === 0 ? <p className={styles.empty}>No backdated entry was recorded for this date.</p> : <div className={styles.detailList}>
        {batchesResult.data.map((batch) => <article key={batch.id}><strong>Backdated invoice batch</strong><span>Business date {date} · recorded {qatarTime(batch.recorded_at)} by {who(batch.created_by)}</span><span>Reason: {batch.backdated_reason}</span></article>)}
        {expensesResult.data.map((expense) => <article key={expense.id}><strong>Backdated expense · QAR {formatQar(expense.amount_dirham!)} · {expense.description}</strong><span>Business date {date} · recorded {qatarTime(expense.recorded_at!)} by {who(expense.created_by)}</span><span>Reason: {expense.backdated_reason}</span></article>)}
      </div>}
    </section>

    <section className={styles.panel}>
      <h2>Close and reopen history</h2>
      {events.length === 0 ? <p className={styles.empty}>This date has never been closed.</p> : <div className={styles.detailList}>{events.map((event) => <article key={event.sequence}>
        <strong>{event.type === "closed" ? "Closed" : "Reopened"} · {shop.name} · {date}</strong>
        <span>{qatarTime(event.recordedAt)} (Qatar time) by {who(event.actorId)}</span>
        {(event.reason || event.note) && <span>{event.type === "closed" ? "Note" : "Reason"}: {event.reason ?? event.note}</span>}
      </article>)}</div>}
    </section>
  </main>;
}
