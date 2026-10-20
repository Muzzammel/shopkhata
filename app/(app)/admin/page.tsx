import { Suspense } from "react";
import { notFound } from "next/navigation";
import { HistoryIcon, KeyRoundIcon } from "lucide-react";

import { ui } from "@/components/sales/ui";
import { Skeleton } from "@/components/ui/skeleton";
import { describeAccountEvent, ROLE_LABEL, ROLE_SUMMARY } from "@/lib/account-view";
import { can, getCurrentActor, type Actor } from "@/lib/auth/permissions";
import { qatarDateTime } from "@/lib/sales-view";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

import { AccountDirectory, RegisterAccountDrawer } from "./account-forms";
import { AdminTabs } from "./admin-tabs";

const shell = "mx-auto grid w-full max-w-[1280px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6";
const card = cn(ui.card, "grid content-start gap-3 p-5 sm:p-6");

export default async function AdminPage() {
  const actor = await getCurrentActor();
  // A non-owner gets the same answer as for a page that does not exist. Checked before anything
  // streams, so the 404 status is kept; only the reads below wait behind the skeleton.
  if (!can(actor, "users.manage")) notFound();

  return <main className={shell}>
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-1">
      <div className="grid min-w-0 gap-1.5">
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Owner only · All shops</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Accounts</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">Who can sign in to ShopKhata, in which role, and which shops they can use. Changes apply to an account&apos;s next action, and every change is recorded.</p>
      </div>
      <RegisterAccountDrawer className="h-10 min-h-10 px-4 max-sm:h-11 max-sm:min-h-11 max-sm:w-full" />
    </header>
    <AdminTabs current="/admin" />
    <Suspense fallback={<AccountsSkeleton />}><AccountsWorkspace actor={actor} /></Suspense>
  </main>;
}

function AccountsSkeleton() {
  return <div aria-busy="true" aria-label="Loading accounts" className="grid gap-4 sm:gap-5">
    <Skeleton className="h-8 w-80 max-w-full rounded-full" />
    <div className="grid gap-3 sm:max-lg:grid-cols-2 lg:rounded-3xl lg:border lg:border-border lg:bg-card lg:p-4">{Array.from({ length: 5 }, (_, i) => <div key={i} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-2xl border border-border bg-card p-4 lg:border-0 lg:p-2"><Skeleton className="size-10 rounded-full" /><div className="grid gap-1.5"><Skeleton className="h-4 w-36" /><Skeleton className="h-3 w-48 max-w-full" /></div><Skeleton className="h-5 w-16 rounded-full" /></div>)}</div>
  </div>;
}

async function AccountsWorkspace({ actor }: { actor: Actor }) {
  const supabase = await createServerSupabaseClient();
  const [profiles, assignments, shops, audit] = await Promise.all([
    supabase.from("profiles").select("id,email,display_name,role,is_active").order("display_name").limit(500),
    supabase.from("user_shop_assignments").select("user_id,shop_id").limit(2000),
    supabase.from("shops").select("id,name").order("name"),
    supabase.from("audit_events").select("id,action,actor_id,entity_id,metadata,recorded_at,shop_id").eq("entity_type", "profile").order("recorded_at", { ascending: false }).limit(50),
  ]);
  if (profiles.error || !profiles.data || assignments.error || !assignments.data || shops.error || !shops.data || audit.error || !audit.data) throw new Error("ADMIN_WORKSPACE_UNAVAILABLE");

  const shopName = new Map(shops.data.map((shop) => [shop.id, shop.name]));
  const name = new Map(profiles.data.map((profile) => [profile.id, profile.display_name]));
  const accounts = profiles.data.map((profile) => ({
    id: profile.id, email: profile.email, displayName: profile.display_name, role: profile.role, isActive: profile.is_active,
    shopIds: assignments.data.filter((assignment) => assignment.user_id === profile.id).map((assignment) => assignment.shop_id),
  }));
  const active = accounts.filter((account) => account.isActive);
  const counts = [
    { label: "Accounts", value: accounts.length },
    { label: "Active", value: active.length },
    ...([["owner", "Owners"], ["manager", "Managers"], ["staff", "Staff"]] as const).map(([role, label]) => ({ label, value: active.filter((account) => account.role === role).length })),
    { label: "Deactivated", value: accounts.length - active.length },
    { label: "No shop access", value: active.filter((account) => account.role !== "owner" && account.shopIds.length === 0).length, warn: true },
  ];

  return <>
    <ul aria-label="Account summary" className="flex list-none flex-wrap gap-x-5 gap-y-1.5 px-1 text-sm">
      {counts.map((count) => <li key={count.label} className={cn("text-muted-foreground", count.warn && count.value > 0 && "font-medium text-warning")}><strong className={cn("font-semibold text-foreground tabular-nums", count.warn && count.value > 0 && "text-warning")}>{count.value}</strong> {count.label}</li>)}
    </ul>

    {accounts.length === 0
      ? <section className="grid justify-items-center gap-2 rounded-3xl border border-dashed border-input bg-card px-6 py-14 text-center"><h2 className="text-lg font-semibold">No accounts registered</h2><p className="max-w-sm text-sm text-muted-foreground">Register a sign-in to give it a role.</p></section>
      : <AccountDirectory accounts={accounts} shops={shops.data} actorId={actor.id} />}

    <div className="grid gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <section aria-labelledby="account-history-heading" className={card}>
        <div className="flex items-center gap-2"><HistoryIcon aria-hidden className="size-4 text-muted-foreground" /><h2 id="account-history-heading" className="text-lg font-semibold tracking-tight">Recent account changes</h2></div>
        {audit.data.length === 0 ? <p className="text-sm text-muted-foreground">No account change has been recorded.</p> : <ol className="grid list-none gap-3 pl-0">{audit.data.map((event) => {
          const line = describeAccountEvent(event, name, shopName);
          return <li key={event.id} className="grid gap-0.5 border-l-2 border-border pl-4 text-sm">
            <strong className="font-semibold [overflow-wrap:anywhere]">{line.title}</strong>
            {line.detail && <span>{line.detail}</span>}
            <span className="text-xs text-muted-foreground">{qatarDateTime(event.recorded_at)} (Qatar time) by {name.get(event.actor_id ?? "") ?? event.actor_id ?? "Unknown actor"}</span>
          </li>;
        })}</ol>}
      </section>

      <aside aria-labelledby="access-rules-heading" className={cn(card, "content-start")}>
        <div className="flex items-center gap-2"><KeyRoundIcon aria-hidden className="size-4 text-muted-foreground" /><h2 id="access-rules-heading" className="text-lg font-semibold tracking-tight">How access works</h2></div>
        <dl className="grid gap-3 text-sm">{(["owner", "manager", "staff"] as const).map((role) => <div key={role} className="grid gap-0.5"><dt className="font-semibold">{ROLE_LABEL[role]}</dt><dd className="text-muted-foreground">{ROLE_SUMMARY[role]}</dd></div>)}</dl>
        <p className="border-t border-border pt-3 text-[13px] text-muted-foreground">Sign-in emails and passwords are managed in the Supabase dashboard (Authentication), not here. ShopKhata never shows or stores a password. You cannot change your own role or status, so the shops always keep an owner.</p>
      </aside>
    </div>
  </>;
}
