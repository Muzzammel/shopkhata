import { APP_NAME } from "@/lib/domain/constants";
import { getCurrentActor } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { getVisibleShops } from "@/lib/shop-switching";
import { readShopWorkspace } from "@/lib/shop-workspace";

import { InvoiceEntry } from "./invoice-entry";

export default async function Home({ searchParams }: PageProps<"/">) {
  const actor = await getCurrentActor();
  const supabase = await createServerSupabaseClient();
  const { data: shops, error: shopError } = await supabase.from("shops").select("id, name, is_active").eq("is_active", true).order("name");
  if (shopError || !shops) throw new Error("SHOP_VISIBILITY_UNAVAILABLE");
  const availableShops = getVisibleShops(actor, shops);
  const query = await searchParams;
  const shop = availableShops.find((s) => s.id === query.shop) ?? availableShops[0];
  // A newly registered account, or one whose last shop was removed.
  if (!shop) return <main style={{ maxWidth: 560, margin: "80px auto", padding: "0 16px", display: "grid", gap: 12 }}>
    <h1>No shop assigned</h1>
    <p role="alert">This account is not assigned to a shop yet, so there is nothing to show. Ask an owner to assign one under Accounts.</p>
  </main>;
  const [{ data: profile, error: profileError }, workspace] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", actor.id).single(),
    readShopWorkspace(actor, shop.id),
  ]);
  if (profileError) throw new Error("INVOICE_WORKSPACE_UNAVAILABLE");
  return <InvoiceEntry
    appName={APP_NAME} shop={workspace.shop} shops={availableShops.map(({ id, name }) => ({ id, name }))}
    actorId={actor.id} actorName={profile.display_name} actorRole={actor.role}
    invoices={workspace.invoices} duplicateInvoiceNumbers={workspace.duplicateInvoiceNumbers}
    businessDate={qatarBusinessDate(new Date())}
  />;
}
