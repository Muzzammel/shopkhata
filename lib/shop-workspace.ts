import { can, type Actor } from "@/lib/auth/permissions";
import { last30Days } from "@/lib/date-range";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getVisibleShops } from "@/lib/shop-switching";

// Overview is a compact recent-activity preview, not the invoice history
// browser — that is the dedicated /invoices page. This is why the window is
// fixed at the last 30 Qatar business days and the list stays short.
const RECENT_INVOICE_PREVIEW_SIZE = 20;

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

  const { from, to } = last30Days(qatarBusinessDate(new Date()));
  const { data: invoices, error: invoiceError } = await supabase.from("effective_invoices")
    .select("*").eq("shop_id", shop.id).gte("business_date", from).lte("business_date", to)
    .order("business_date", { ascending: false }).order("recorded_at", { ascending: false }).order("canonical_invoice_id", { ascending: false })
    .limit(RECENT_INVOICE_PREVIEW_SIZE);
  if (invoiceError || !invoices) throw new Error("INVOICE_WORKSPACE_UNAVAILABLE");
  const registry: { invoice_number: string }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from("invoice_number_registry").select("invoice_number")
      .eq("shop_id", shop.id).order("invoice_number").range(offset, offset + 999);
    if (error || !data) throw new Error("INVOICE_NUMBER_CHECK_UNAVAILABLE");
    registry.push(...data);
    if (data.length < 1000) break;
  }
  const recentInvoices = invoices.map((invoice) => ({
    id: invoice.canonical_invoice_id!, invoice_id: invoice.effective_invoice_number!, business_date: invoice.business_date!,
    effective_total_dirham: invoice.effective_total_dirham!, effective_due_dirham: invoice.effective_due_dirham!,
    delivered: invoice.effective_delivered!, customer_id: invoice.effective_customer_id,
  }));
  return {
    shop: { id: shop.id, name: shop.name },
    invoices: recentInvoices,
    duplicateInvoiceNumbers: registry.map((row) => row.invoice_number),
  };
}
