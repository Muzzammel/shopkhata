import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { can, getCurrentActor, type Actor } from "@/lib/auth/permissions";
import { getVisibleShops } from "@/lib/shop-switching";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import styles from "@/app/ui.module.css";

import { AppShell } from "@/components/shell/app-shell";

import { SignOut } from "./sign-out";

export default async function AppLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  let actor: Actor;
  try {
    actor = await getCurrentActor();
  } catch {
    redirect("/login");
  }

  // The database already refuses a deactivated account every read and write;
  // this tells the person why instead of showing empty screens.
  if (!actor.isActive) {
    return <main className={styles.notice}>
      <h1>Account deactivated</h1>
      <p role="alert">This account has been deactivated by an owner and can no longer view or record anything. Ask an owner if this is a mistake.</p>
      <SignOut userId={actor.id} />
    </main>;
  }

  // The same shop list every page reads; the shell only needs names for the switcher.
  // A failed read leaves the switcher empty rather than breaking every screen.
  const supabase = await createServerSupabaseClient();
  const [{ data: shopRows }, { data: profile }] = await Promise.all([
    supabase.from("shops").select("id,name,is_active").eq("is_active", true).order("name"),
    supabase.from("profiles").select("display_name").eq("id", actor.id).maybeSingle(),
  ]);
  const shops = getVisibleShops(actor, shopRows ?? []).map(({ id, name }) => ({ id, name }));
  const permissions = Object.fromEntries(shops.map((shop) => [shop.id, { payment: can(actor, "payment.record", shop.id), expense: can(actor, "expense.create", shop.id) }]));

  return <AppShell shops={shops} user={{ id: actor.id, name: profile?.display_name || "Account", role: actor.role }} isOwner={can(actor, "users.manage")} permissions={permissions}>
    {children}
  </AppShell>;
}
