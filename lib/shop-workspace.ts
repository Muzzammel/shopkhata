import { can, type Actor } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getVisibleShops } from "@/lib/shop-switching";

export type WorkspaceCustomer = { id: string; name: string | null; mobile: string | null; public_id: string };
export type WorkspaceInvoice = {
  id: string;
  invoice_id: string;
  business_date: string;
  effective_total_dirham: number;
  effective_due_dirham: number;
  delivered: boolean;
  customer_id: string | null;
};
export type ShopWorkspace = {
  shop: { id: string; name: string };
  customers: WorkspaceCustomer[];
  invoices: WorkspaceInvoice[];
  duplicateInvoiceNumbers: string[];
};

export async function readShopWorkspace(actor: Actor, shopId: string): Promise<ShopWorkspace> {
  if (!can(actor, "records.view_assigned", shopId)) throw new Error("UNAUTHORIZED_SHOP");
  const supabase = await createServerSupabaseClient();
  const { data: allShops, error: shopError } = await supabase.from("shops").select("id, name, is_active").eq("is_active", true).order("name");
  if (shopError || !allShops) throw new Error("SHOP_VISIBILITY_UNAVAILABLE");
  const shops = getVisibleShops(actor, allShops);
  const shop = shops.find((item) => item.id === shopId);
  if (!shop) throw new Error("UNAUTHORIZED_SHOP");

  const [{ data: customers, error: customerError }, { data: invoices, error: invoiceError }] = await Promise.all([
    supabase.from("customers").select("id, name, mobile, public_id").eq("shop_id", shop.id).order("name").limit(200),
    supabase.from("invoices").select("id, invoice_id, business_date, total_amount_dirham, delivered, customer_id, created_at").eq("shop_id", shop.id).order("created_at", { ascending: false }).limit(30),
  ]);
  if (customerError || invoiceError || !customers || !invoices) throw new Error("INVOICE_WORKSPACE_UNAVAILABLE");
  const registry: { invoice_number: string }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from("invoice_number_registry").select("invoice_number")
      .eq("shop_id", shop.id).order("invoice_number").range(offset, offset + 999);
    if (error || !data) throw new Error("INVOICE_NUMBER_CHECK_UNAVAILABLE");
    registry.push(...data);
    if (data.length < 1000) break;
  }
  const invoiceIds = invoices.map((invoice) => invoice.id);
  const { data: balances, error: balanceError } = invoiceIds.length
    ? await supabase.from("invoice_effective_balances")
      .select("canonical_invoice_id, effective_total_dirham, effective_paid_dirham, effective_due_dirham")
      .eq("shop_id", shop.id).in("canonical_invoice_id", invoiceIds)
    : { data: [], error: null };
  if (balanceError || !balances) throw new Error("INVOICE_BALANCES_UNAVAILABLE");
  const balanceByInvoice = new Map(balances.map((balance) => [balance.canonical_invoice_id, balance]));
  const recentInvoices = invoices.map((invoice) => {
    const balance = balanceByInvoice.get(invoice.id);
    if (!balance) throw new Error("INVOICE_BALANCE_MISSING");
    return {
      id: invoice.id,
      invoice_id: invoice.invoice_id,
      business_date: invoice.business_date,
      effective_total_dirham: balance.effective_total_dirham,
      effective_due_dirham: balance.effective_due_dirham,
      delivered: invoice.delivered,
      customer_id: invoice.customer_id,
    };
  });
  return {
    shop: { id: shop.id, name: shop.name },
    customers,
    invoices: recentInvoices,
    duplicateInvoiceNumbers: registry.map((row) => row.invoice_number),
  };
}
