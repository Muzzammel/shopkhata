import { APP_NAME } from "@/lib/domain/constants";
import { getCurrentActor } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { getReadableShops, pickShop } from "@/lib/shop-switching";
import { readShopWorkspace } from "@/lib/shop-workspace";

import { Notice } from "@/components/shell/notice";

import { InvoiceEntry } from "./invoice-entry";

export default async function Home({ searchParams }: PageProps<"/">) {
  const actor = await getCurrentActor();
  const supabase = await createServerSupabaseClient();
  const { data: shops, error: shopError } = await supabase.from("shops").select("id, name, is_active").order("name");
  if (shopError || !shops) throw new Error("SHOP_VISIBILITY_UNAVAILABLE");
  const readable = getReadableShops(actor, shops);
  const availableShops = readable.filter((s) => s.is_active);
  const query = await searchParams;
  const shop = pickShop(readable, query.shop);
  if (shop && !shop.is_active) return <Notice title="New sale unavailable">
    <p role="alert">{shop.name} is inactive, so no new sale can be recorded. Its history stays visible under Sales.</p>
  </Notice>;
  // A newly registered account, or one whose last shop was removed.
  if (!shop) return <Notice title="No shop assigned">
    <p role="alert">This account is not assigned to a shop yet, so there is nothing to show. Ask an owner to assign one under Accounts.</p>
  </Notice>;
  const [{ data: profile, error: profileError }, workspace] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", actor.id).single(),
    readShopWorkspace(actor, shop.id),
  ]);
  if (profileError) throw new Error("INVOICE_WORKSPACE_UNAVAILABLE");
  return <InvoiceEntry
    appName={APP_NAME} shop={workspace.shop} shops={availableShops.map(({ id, name }) => ({ id, name }))}
    actorId={actor.id} actorName={profile.display_name} actorRole={actor.role}
    invoices={workspace.invoices}
    businessDate={qatarBusinessDate(new Date())}
  />;
}
