import { Suspense } from "react";
import { notFound } from "next/navigation";
import { HistoryIcon } from "lucide-react";

import { ui } from "@/components/sales/ui";
import { Skeleton } from "@/components/ui/skeleton";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { qatarDateTime } from "@/lib/sales-view";
import { describeShopEvent } from "@/lib/shop-admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

import { AdminTabs } from "../admin-tabs";
import { AddShopDrawer, ShopDirectory } from "./shop-forms";

const shell = "mx-auto grid w-full max-w-[1280px] grid-cols-1 content-start gap-4 px-4 pt-5 pb-10 sm:gap-5 sm:px-6";
const card = cn(ui.card, "grid content-start gap-3 p-5 sm:p-6");

export default async function ShopsPage() {
  const actor = await getCurrentActor();
  // A non-owner gets the same answer as for a page that does not exist, before anything streams.
  if (!can(actor, "users.manage")) notFound();
  const supabase = await createServerSupabaseClient();
  const { data: shops, error } = await supabase.from("shops").select("id,name,is_active").order("name");
  if (error || !shops) throw new Error("SHOPS_UNAVAILABLE");

  return <main className={shell}>
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-1">
      <div className="grid min-w-0 gap-1.5">
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Owner only · All shops</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Shops</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">The shops and branches ShopKhata keeps separate books for. Owners reach every shop automatically; assign managers and staff in Accounts. An inactive shop keeps all its records but accepts no new ones. Every change is recorded.</p>
      </div>
      <AddShopDrawer shops={shops.map((shop) => ({ id: shop.id, name: shop.name, isActive: shop.is_active, assignedNames: [] }))} className="h-10 min-h-10 px-4 max-sm:h-11 max-sm:min-h-11 max-sm:w-full" />
    </header>
    <AdminTabs current="/admin/shops" />
    <Suspense fallback={<ShopsSkeleton />}><ShopsWorkspace shops={shops} /></Suspense>
  </main>;
}

function ShopsSkeleton() {
  return <div aria-busy="true" aria-label="Loading shops" className="grid gap-3 lg:rounded-3xl lg:border lg:border-border lg:bg-card lg:p-4">
    {Array.from({ length: 3 }, (_, i) => <div key={i} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-2xl border border-border bg-card p-4 lg:border-0 lg:p-2"><Skeleton className="size-10 rounded-full" /><Skeleton className="h-4 w-36" /><Skeleton className="h-5 w-16 rounded-full" /></div>)}
  </div>;
}

async function ShopsWorkspace({ shops }: { shops: { id: string; name: string; is_active: boolean }[] }) {
  const supabase = await createServerSupabaseClient();
  const [profiles, assignments, audit] = await Promise.all([
    supabase.from("profiles").select("id,display_name,role,is_active").order("display_name").limit(500),
    supabase.from("user_shop_assignments").select("user_id,shop_id").limit(2000),
    supabase.from("audit_events").select("id,action,actor_id,metadata,reason,recorded_at").eq("entity_type", "shop").order("recorded_at", { ascending: false }).limit(50),
  ]);
  if (profiles.error || !profiles.data || assignments.error || !assignments.data || audit.error || !audit.data) throw new Error("SHOPS_UNAVAILABLE");

  const name = new Map(profiles.data.map((profile) => [profile.id, profile.display_name]));
  // Owners reach every shop without an assignment, so only active manager/staff assignments are listed.
  const assignable = new Map(profiles.data.filter((profile) => profile.is_active && profile.role !== "owner").map((profile) => [profile.id, profile.display_name]));
  const rows = shops.map((shop) => ({
    id: shop.id, name: shop.name, isActive: shop.is_active,
    assignedNames: assignments.data.filter((a) => a.shop_id === shop.id && assignable.has(a.user_id)).map((a) => assignable.get(a.user_id)!),
  }));

  return <>
    <ul aria-label="Shop summary" className="flex list-none flex-wrap gap-x-5 gap-y-1.5 px-1 text-sm">
      <li className="text-muted-foreground"><strong className="font-semibold text-foreground tabular-nums">{rows.length}</strong> {rows.length === 1 ? "Shop" : "Shops"}</li>
      <li className="text-muted-foreground"><strong className="font-semibold text-foreground tabular-nums">{rows.filter((row) => row.isActive).length}</strong> Active</li>
      <li className="text-muted-foreground"><strong className="font-semibold text-foreground tabular-nums">{rows.filter((row) => !row.isActive).length}</strong> Inactive</li>
    </ul>
    {rows.length === 0
      ? <section className="grid justify-items-center gap-2 rounded-3xl border border-dashed border-input bg-card px-6 py-14 text-center"><h2 className="text-lg font-semibold">No shops yet</h2><p className="max-w-sm text-sm text-muted-foreground">Add the first shop to start recording.</p></section>
      : <ShopDirectory shops={rows} />}

    <section aria-labelledby="shop-history-heading" className={card}>
      <div className="flex items-center gap-2"><HistoryIcon aria-hidden className="size-4 text-muted-foreground" /><h2 id="shop-history-heading" className="text-lg font-semibold tracking-tight">Recent shop changes</h2></div>
      {audit.data.length === 0 ? <p className="text-sm text-muted-foreground">No shop change has been recorded.</p> : <ol className="grid list-none gap-3 pl-0">{audit.data.map((event) => <li key={event.id} className="grid gap-0.5 border-l-2 border-border pl-4 text-sm">
        <strong className="font-semibold [overflow-wrap:anywhere]">{describeShopEvent(event)}</strong>
        {event.reason && <span className="whitespace-pre-line [overflow-wrap:anywhere]">Reason: {event.reason}</span>}
        <span className="text-xs text-muted-foreground">{qatarDateTime(event.recorded_at)} (Qatar time) by {name.get(event.actor_id ?? "") ?? "Unknown actor"}</span>
      </li>)}</ol>}
    </section>
  </>;
}
