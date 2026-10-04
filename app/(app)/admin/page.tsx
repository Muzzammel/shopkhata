import Link from "next/link";
import { notFound } from "next/navigation";

import { effectiveAccess } from "@/lib/account-admin";
import { can, getCurrentActor } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import { AccountForm, RegisterAccountForm } from "./account-forms";
import styles from "../customers/operations.module.css";

const qatarTime = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Qatar" });
const ACTIONS: Record<string, string> = {
  "account.register": "Registered account", "account.update": "Changed role or status",
  "assignment.add": "Added shop access", "assignment.remove": "Removed shop access",
};

export default async function AdminPage() {
  const actor = await getCurrentActor();
  // A non-owner gets the same answer as for a page that does not exist.
  if (!can(actor, "users.manage")) notFound();

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
  const accounts = profiles.data.map((profile) => {
    const shopIds = assignments.data.filter((assignment) => assignment.user_id === profile.id).map((assignment) => assignment.shop_id);
    return { id: profile.id, email: profile.email, displayName: profile.display_name, role: profile.role, isActive: profile.is_active, shopIds, shopNames: shopIds.map((id) => shopName.get(id) ?? id).sort() };
  });

  return <main className={styles.workspace}>
    <header className={styles.header}><div><p className={styles.eyebrow}>Owner only</p><h1>Accounts and shop access</h1><p>Changes apply to an account&apos;s next action. Every change is recorded below.</p></div><Link href="/">Back to overview</Link></header>

    <section className={styles.panel}>
      <h2>Accounts</h2>
      <div className={styles.tableWrap}><table>
        <caption className={styles.muted}>What each account can reach right now</caption>
        <thead><tr><th scope="col">Account</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Effective access</th></tr></thead>
        <tbody>{accounts.map((account) => <tr key={account.id} data-account={account.email}>
          <th scope="row">{account.displayName}<small>{account.email}</small></th>
          <td>{account.role}</td><td>{account.isActive ? "Active" : "Deactivated"}</td><td>{effectiveAccess(account)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>

    {accounts.map((account) => <section key={account.id} className={styles.panel} data-manage={account.email}>
      <h2>{account.displayName}</h2>
      <p className={styles.muted}>{account.email}</p>
      {account.id === actor.id
        ? <p>This is your own account. Another owner must change your role or status, so the shops are never left without an owner.</p>
        : <AccountForm account={account} shops={shops.data} />}
    </section>)}

    <section className={styles.panel}>
      <h2>Register an account</h2>
      <p className={styles.muted}>First create the sign-in (email and password) in the Supabase dashboard under Authentication. Then register it here to give it a role. A new account has no shop access until you assign one above.</p>
      <RegisterAccountForm />
    </section>

    <section className={styles.panel}>
      <h2>Recent account changes</h2>
      {audit.data.length === 0 ? <p>No account change has been recorded.</p> : <div className={styles.detailList}>{audit.data.map((event) => <article key={event.id}>
        <strong>{ACTIONS[event.action] ?? event.action} · {name.get(event.entity_id ?? "") ?? event.entity_id}{event.shop_id ? ` · ${shopName.get(event.shop_id) ?? event.shop_id}` : ""}</strong>
        <span>{qatarTime(event.recorded_at)} (Qatar time) by {name.get(event.actor_id ?? "") ?? event.actor_id ?? "Unknown actor"}</span>
        {event.action === "account.update" && <span>{JSON.stringify((event.metadata as { before?: unknown }).before)} → {JSON.stringify((event.metadata as { after?: unknown }).after)}</span>}
      </article>)}</div>}
    </section>
  </main>;
}
