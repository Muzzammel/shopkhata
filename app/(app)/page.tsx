import { APP_NAME } from "@/lib/domain/constants";
import { getCurrentActor } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { qatarBusinessDate } from "@/lib/invoice-entry";

import { InvoiceEntry } from "./invoice-entry";

export default async function Home() {
  const actor = await getCurrentActor();
  const supabase = await createServerSupabaseClient();
  const { data: shops, error: shopError } = await supabase.from("shops").select("id, name").order("name");
  if (shopError || !shops) throw new Error("SHOP_VISIBILITY_UNAVAILABLE");
  const shop = shops.find((item) => actor.shopIds.includes(item.id)) ?? shops[0];
  if (!shop) throw new Error("SHOP_REQUIRED");
  const [{ data: profile, error: profileError }, { data: customers, error: customerError }, { data: invoices, error: invoiceError }] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", actor.id).single(),
    supabase.from("customers").select("id, name, mobile, public_id").eq("shop_id", shop.id).order("name").limit(200),
    supabase.from("invoices").select("id, invoice_id, business_date, total_amount_dirham, delivered, customer_id, created_at").eq("shop_id", shop.id).order("created_at", { ascending: false }).limit(30),
  ]);
  if (profileError || customerError || invoiceError) throw new Error("INVOICE_WORKSPACE_UNAVAILABLE");
  const invoiceIds = (invoices ?? []).map((invoice) => invoice.id);
  const { data: balances, error: balanceError } = invoiceIds.length
    ? await supabase.from("invoice_effective_balances")
      .select("canonical_invoice_id, effective_total_dirham, effective_paid_dirham, effective_due_dirham")
      .eq("shop_id", shop.id).in("canonical_invoice_id", invoiceIds)
    : { data: [], error: null };
  if (balanceError) throw new Error("INVOICE_BALANCES_UNAVAILABLE");
  const balanceByInvoice = new Map((balances ?? []).map((balance) => [balance.canonical_invoice_id, balance]));
  const recentInvoices = (invoices ?? []).map((invoice) => {
    const balance = balanceByInvoice.get(invoice.id);
    if (!balance) throw new Error("INVOICE_BALANCE_MISSING");
    return { ...invoice, ...balance };
  });
  return <InvoiceEntry
    appName={APP_NAME} shop={shop} actorName={profile.display_name} actorRole={actor.role} customers={customers ?? []}
    invoices={recentInvoices}
    businessDate={qatarBusinessDate(new Date())}
  />;
}
