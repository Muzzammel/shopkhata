import type { SupabaseClient } from "@supabase/supabase-js";

import { addDays, first, last30Days, parseDateRangeFilter } from "@/lib/date-range";
import { dayState, type CloseEvent } from "@/lib/closing";
import {
  DAILY_METRICS, fetchCustomerDueRows, fetchDailySummary, mapExpenseTotals, mapPaymentTotals,
  type CustomerDueRow, type DailySummary,
} from "@/lib/reports";
import type { Database } from "@/lib/supabase/database.types";

type Client = SupabaseClient<Database>;

// The operational Dashboard: every number below is read from the same
// report_* RPCs, effective projections and event tables that Reports,
// Closing and the invoice/customer pages already treat as authoritative.
// Nothing is aggregated by re-reading full invoice/payment history into
// React — each query is either a database aggregate or a bounded, limited
// select.

export const DASHBOARD_PERIODS = ["today", "7d", "30d", "year", "custom"] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];
export type DashboardRange = { period: DashboardPeriod; from: string; to: string; error: string | null };

export function parseDashboardPeriod(query: Record<string, string | string[] | undefined>, today: string): DashboardRange {
  const period = DASHBOARD_PERIODS.find((item) => item === first(query.period));
  if (period === "7d") return { period, from: addDays(today, -6), to: today, error: null };
  if (period === "30d") return { period, ...last30Days(today), error: null };
  if (period === "year") return { period, from: addDays(today, -364), to: today, error: null };
  if (period === "custom") {
    const range = parseDateRangeFilter(query, today);
    return { period, from: range.from, to: range.to, error: range.error };
  }
  return { period: "today", from: today, to: today, error: null };
}

export type ShopTotals = { shopId: string; shopName: string; salesDirham: number; invoiceCount: number; paymentsReceivedDirham: number; expensesDirham: number; outstandingDueDirham: number };

type Rpc<Name extends keyof Database["public"]["Functions"]> = Database["public"]["Functions"][Name]["Returns"];

function shopTotals(shop: { id: string; name: string }, sales: Rpc<"report_sales_totals">[number], payments: Rpc<"report_payment_totals">, expenses: Rpc<"report_expense_totals">, due: Rpc<"report_customer_due_totals">[number]): ShopTotals {
  const expenseTotal = expenses.find((row) => row.category === null)?.amount_dirham ?? 0;
  return {
    shopId: shop.id, shopName: shop.name, salesDirham: sales.effective_total_dirham, invoiceCount: sales.invoice_count,
    paymentsReceivedDirham: mapPaymentTotals(payments).receivedDirham, expensesDirham: expenseTotal, outstandingDueDirham: due.outstanding_due_dirham,
  };
}

async function fetchShopTotals(supabase: Client, shop: { id: string; name: string }, from: string, to: string): Promise<ShopTotals> {
  const [sales, payments, expenses, due] = await Promise.all([
    supabase.rpc("report_sales_totals", { p_shop_id: shop.id, p_from: from, p_to: to }),
    supabase.rpc("report_payment_totals", { p_shop_id: shop.id, p_from: from, p_to: to }),
    supabase.rpc("report_expense_totals", { p_shop_id: shop.id, p_from: from, p_to: to }),
    supabase.rpc("report_customer_due_totals", { p_shop_id: shop.id }),
  ]);
  if (sales.error || !sales.data?.[0] || payments.error || !payments.data || expenses.error || !expenses.data || due.error || !due.data?.[0]) {
    throw new Error("DASHBOARD_UNAVAILABLE");
  }
  return shopTotals(shop, sales.data[0], payments.data, expenses.data, due.data[0]);
}

async function customerNames(supabase: Client, shopId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return names;
  const { data, error } = await supabase.from("customers").select("id,name,public_id").eq("shop_id", shopId).in("id", uniqueIds);
  if (error || !data) throw new Error("DASHBOARD_UNAVAILABLE");
  for (const customer of data) names.set(customer.id, customer.name || customer.public_id);
  return names;
}

export type TopCustomer = { customerId: string; name: string; amountDirham: number };

// Aggregated in the database (report_top_customers_by_sales/_by_payments) so
// the ranking is complete for the period, not capped at a row count read
// into React.
async function topCustomersBySales(supabase: Client, shopId: string, from: string, to: string): Promise<TopCustomer[]> {
  const { data, error } = await supabase.rpc("report_top_customers_by_sales", { p_shop_id: shopId, p_from: from, p_to: to, p_limit: 5 });
  if (error || !data) throw new Error("DASHBOARD_UNAVAILABLE");
  return data.map((row) => ({ customerId: row.customer_id, name: row.name, amountDirham: row.amount_dirham }));
}

async function topCustomersByPayments(supabase: Client, shopId: string, from: string, to: string): Promise<TopCustomer[]> {
  const { data, error } = await supabase.rpc("report_top_customers_by_payments", { p_shop_id: shopId, p_from: from, p_to: to, p_limit: 5 });
  if (error || !data) throw new Error("DASHBOARD_UNAVAILABLE");
  return data.map((row) => ({ customerId: row.customer_id, name: row.name, amountDirham: row.amount_dirham }));
}

/** paymentsDirham is cash only; receivedDirham is cash plus bank. */
export type TrendPoint = { businessDate: string; salesDirham: number; paymentsDirham: number; receivedDirham: number; expensesDirham: number };
export type ExpenseLine = { id: string; businessDate: string; recordedAt: string | null; category: string; description: string; amountDirham: number };
export type ActivityEvent = { id: string; action: string; label: string; actorName: string; businessReference: string; recordedAt: string; href: string | null };
export type CreditCustomer = { customerId: string; name: string; availableCreditDirham: number };
export type RecentCustomer = { customerId: string; name: string; lastActivity: string };

export type DashboardData = {
  range: DashboardRange;
  kpi: {
    /** paymentsReceivedDirham is cash only. */
    invoiceCount: number; salesDirham: number; averageInvoiceDirham: number; paymentsReceivedDirham: number; bankReceivedDirham: number; totalReceivedDirham: number; expensesDirham: number;
    netCashMovementDirham: number; outstandingDueDirham: number; availableCreditDirham: number; customersWithDue: number;
    /** Unpaid balance of every invoice dated in the period, customerless ones included (report_sales_totals.effective_due_dirham). */
    unpaidInvoicesDirham: number;
  };
  invoiceHealth: { total: number; delivered: number; advance: number; fullyPaid: number; withDue: number };
  collection: { outstandingDueDirham: number; availableCreditDirham: number; customersWithDue: number; paymentsReceivedDirham: number; bankReceivedDirham: number; largestDues: CustomerDueRow[]; creditCustomers: CreditCustomer[] };
  trend: { days: TrendPoint[]; today: DailySummary };
  expenses: { totalDirham: number; byCategory: { category: string; amountDirham: number; count: number }[]; recent: ExpenseLine[]; largest: ExpenseLine[] };
  closing: { state: "open" | "closed"; lastClose: CloseEvent | null; recentEvents: (CloseEvent & { actorName: string })[]; recentlyReopened: string[] };
  customers: { topBySales: TopCustomer[]; topByPayments: TopCustomer[]; recentlyActive: RecentCustomer[]; creditCustomers: CreditCustomer[]; anonymousInvoiceCount: number };
  activity: { visible: boolean; events: ActivityEvent[] };
  shopComparison: ShopTotals[] | null;
};

const ACTION_LABELS: Record<string, string> = {
  "batch.submit": "Invoice batch recorded", "submit_batch": "Invoice batch recorded", "account.register": "Account registered", "account.update": "Account updated", "record_payment": "Payment recorded", "approve_overpayment": "Overpayment approved as credit",
  "correction.request": "Invoice correction requested", "correction.decide": "Invoice correction decided",
  "replacement.request": "Invoice replacement requested", "replacement.decide": "Invoice replacement decided",
  "create_customer": "Customer created", "record_customer_payment": "Customer payment recorded", "apply_customer_credit": "Customer credit applied",
  "create_expense": "Expense recorded", "request_expense_correction": "Expense correction requested", "decide_expense_correction": "Expense correction decided",
  "attach_expense_receipt": "Expense receipt attached", "date.close": "Business date closed", "date.reopen": "Business date reopened",
  "admin_register_account": "Account registered", "admin_update_account": "Account updated", "admin_set_shop_assignment": "Shop assignment changed",
  "shop.create": "Shop created", "shop.update": "Shop renamed", "admin_create_shop": "Shop created", "admin_update_shop": "Shop renamed",
  "shop.deactivate": "Shop deactivated", "shop.reactivate": "Shop reactivated", "account.deactivate": "Account deactivated", "account.reactivate": "Account reactivated",
};

function activityHref(entityType: string, entityId: string, shopId: string): string | null {
  if (entityType === "invoice") return `/shops/${shopId}/invoices/${entityId}`;
  if (entityType === "customer") return `/customers/${entityId}?shop=${shopId}`;
  if (entityType === "business_date") return `/closing?shop=${shopId}&date=${entityId}`;
  return null;
}

export async function loadDashboard(supabase: Client, shops: readonly { id: string; name: string }[], shop: { id: string; name: string }, range: DashboardRange, canViewAudit: boolean): Promise<DashboardData> {
  const { from, to } = range;
  // Two waves: every read that needs only the shop and range goes out at once;
  // the second wave resolves names for ids the first one returned.
  const [
    sales, payments, expenses, due, days, fullyPaidCount, withDueCount, anonymousCount, dueRows, creditRows, recentlyActiveRows, closeHistory, recentExpenses, largestExpenses,
    topBySales, topByPayments, audit, otherShopTotals,
  ] = await Promise.all([
    supabase.rpc("report_sales_totals", { p_shop_id: shop.id, p_from: from, p_to: to }),
    supabase.rpc("report_payment_totals", { p_shop_id: shop.id, p_from: from, p_to: to }),
    supabase.rpc("report_expense_totals", { p_shop_id: shop.id, p_from: from, p_to: to }),
    supabase.rpc("report_customer_due_totals", { p_shop_id: shop.id }),
    fetchDailySummary(supabase, shop.id, from, to),
    supabase.from("effective_invoices").select("*", { count: "exact", head: true }).eq("shop_id", shop.id).gte("business_date", from).lte("business_date", to).lte("effective_due_dirham", 0).eq("is_void", false),
    supabase.from("effective_invoices").select("*", { count: "exact", head: true }).eq("shop_id", shop.id).gte("business_date", from).lte("business_date", to).gt("effective_due_dirham", 0),
    supabase.from("effective_invoices").select("*", { count: "exact", head: true }).eq("shop_id", shop.id).gte("business_date", from).lte("business_date", to).is("effective_customer_id", null),
    fetchCustomerDueRows(supabase, shop.id, 5),
    supabase.from("customer_financial_balances").select("customer_id,available_credit_dirham").eq("shop_id", shop.id).gt("available_credit_dirham", 0).order("available_credit_dirham", { ascending: false }).limit(5),
    supabase.from("customer_financial_balances").select("customer_id,last_activity_date").eq("shop_id", shop.id).not("last_activity_date", "is", null).order("last_activity_date", { ascending: false }).limit(5),
    supabase.from("daily_closes").select("event_sequence,event_type,actor_id,recorded_at,reason,note,business_date").eq("shop_id", shop.id).order("recorded_at", { ascending: false }).limit(10),
    supabase.from("effective_expenses").select("id,business_date,recorded_at,category,description,amount_dirham").eq("shop_id", shop.id).order("recorded_at", { ascending: false }).limit(8),
    supabase.from("effective_expenses").select("id,business_date,recorded_at,category,description,amount_dirham").eq("shop_id", shop.id).gte("business_date", from).lte("business_date", to).order("amount_dirham", { ascending: false }).limit(5),
    topCustomersBySales(supabase, shop.id, from, to),
    topCustomersByPayments(supabase, shop.id, from, to),
    canViewAudit ? supabase.from("audit_events").select("id,action,entity_type,entity_id,actor_id,metadata,recorded_at").eq("shop_id", shop.id).order("recorded_at", { ascending: false }).limit(20) : null,
    // The selected shop's comparison row reuses this wave's totals (same RPCs, same arguments).
    shops.length > 1 ? Promise.all(shops.filter((item) => item.id !== shop.id).map((item) => fetchShopTotals(supabase, item, from, to))) : null,
  ]);
  if (sales.error || !sales.data?.[0] || payments.error || !payments.data || expenses.error || !expenses.data || due.error || !due.data?.[0]
    || fullyPaidCount.error || withDueCount.error || anonymousCount.error || closeHistory.error || !closeHistory.data || recentExpenses.error || !recentExpenses.data
    || largestExpenses.error || !largestExpenses.data || creditRows.error || !creditRows.data || recentlyActiveRows.error || !recentlyActiveRows.data
    || (audit && (audit.error || !audit.data))) {
    throw new Error("DASHBOARD_UNAVAILABLE");
  }

  const paymentTotals = mapPaymentTotals(payments.data);
  const expenseTotals = mapExpenseTotals(expenses.data);
  const netCashMovementDirham = days.reduce((sum, day) => sum + day.netCashMovementDirham, 0);
  const salesRow = sales.data[0];
  const dueRow = due.data[0];
  const todaySummary = days.find((day) => day.businessDate === to) ?? { businessDate: to, ...Object.fromEntries(DAILY_METRICS.map((metric) => [metric.key, 0])) } as DailySummary;

  // business_date comes back as a date string already (YYYY-MM-DD) via the client.
  const todayEvents = closeHistory.data.filter((event) => String(event.business_date) === range.to);

  const creditCustomerIds = creditRows.data.map((row) => row.customer_id!);
  const activeCustomerIds = recentlyActiveRows.data.map((row) => row.customer_id!);
  const actorIds = [...new Set(closeHistory.data.flatMap((event) => event.actor_id ? [event.actor_id] : []))];
  const auditActorIds = [...new Set((audit?.data ?? []).flatMap((event) => event.actor_id ? [event.actor_id] : []))];
  const [creditNames, activeNames, actorNames, { data: auditActors }] = await Promise.all([
    customerNames(supabase, shop.id, creditCustomerIds),
    customerNames(supabase, shop.id, activeCustomerIds),
    supabase.from("profiles").select("id,display_name").in("id", actorIds.length ? actorIds : ["00000000-0000-0000-0000-000000000000"]),
    auditActorIds.length ? supabase.from("profiles").select("id,display_name").in("id", auditActorIds) : { data: [] },
  ]);
  const actorNameMap = new Map((actorNames.data ?? []).map((profile) => [profile.id, profile.display_name]));
  const who = (id: string | null) => id ? actorNameMap.get(id) ?? id : "Unknown actor";

  const creditCustomers: CreditCustomer[] = creditRows.data.map((row) => ({ customerId: row.customer_id!, name: creditNames.get(row.customer_id!) ?? "", availableCreditDirham: row.available_credit_dirham! }));
  const recentlyActive: RecentCustomer[] = recentlyActiveRows.data.map((row) => ({ customerId: row.customer_id!, name: activeNames.get(row.customer_id!) ?? "", lastActivity: row.last_activity_date! }));
  const closeEvents: CloseEvent[] = closeHistory.data.map((event) => ({ sequence: event.event_sequence, type: event.event_type as CloseEvent["type"], actorId: event.actor_id, recordedAt: event.recorded_at, reason: event.reason, note: event.note }));
  const todayCloseEvents: CloseEvent[] = todayEvents.map((event) => ({ sequence: event.event_sequence, type: event.event_type as CloseEvent["type"], actorId: event.actor_id, recordedAt: event.recorded_at, reason: event.reason, note: event.note }));

  const auditNames = new Map((auditActors ?? []).map((profile) => [profile.id, profile.display_name]));
  const activity: ActivityEvent[] = (audit?.data ?? []).map((event) => ({
    id: event.id!, action: event.action!, label: ACTION_LABELS[event.action!] ?? event.action!.replace(/[._]/g, " "),
    actorName: event.actor_id ? auditNames.get(event.actor_id) ?? event.actor_id : "System", businessReference: event.entity_id ?? "",
    recordedAt: event.recorded_at!, href: event.entity_id ? activityHref(event.entity_type!, event.entity_id, shop.id) : null,
  }));

  const currentShopTotals = shopTotals(shop, salesRow, payments.data, expenses.data, dueRow);
  const shopComparison = otherShopTotals
    ? shops.map((item) => item.id === shop.id ? currentShopTotals : otherShopTotals.find((row) => row.shopId === item.id)!)
    : null;

  return {
    range,
    kpi: {
      invoiceCount: salesRow.invoice_count, salesDirham: salesRow.effective_total_dirham,
      averageInvoiceDirham: salesRow.invoice_count > 0 ? Math.round(salesRow.effective_total_dirham / salesRow.invoice_count) : 0,
      paymentsReceivedDirham: paymentTotals.cashDirham, bankReceivedDirham: paymentTotals.bankDirham, totalReceivedDirham: paymentTotals.receivedDirham,
      expensesDirham: expenseTotals.totalDirham, netCashMovementDirham,
      outstandingDueDirham: dueRow.outstanding_due_dirham, availableCreditDirham: dueRow.available_credit_dirham, customersWithDue: dueRow.customers_with_due,
      unpaidInvoicesDirham: salesRow.effective_due_dirham,
    },
    invoiceHealth: {
      total: salesRow.invoice_count, delivered: salesRow.delivered_count, advance: salesRow.undelivered_count,
      fullyPaid: fullyPaidCount.count ?? 0, withDue: withDueCount.count ?? 0,
    },
    collection: {
      outstandingDueDirham: dueRow.outstanding_due_dirham, availableCreditDirham: dueRow.available_credit_dirham, customersWithDue: dueRow.customers_with_due,
      paymentsReceivedDirham: paymentTotals.cashDirham, bankReceivedDirham: paymentTotals.bankDirham, largestDues: dueRows, creditCustomers,
    },
    trend: {
      days: days.map((day) => ({ businessDate: day.businessDate, salesDirham: day.grossInvoiceDirham, paymentsDirham: day.cashReceivedDirham, receivedDirham: day.totalReceivedDirham, expensesDirham: day.expensesDirham })),
      today: todaySummary,
    },
    expenses: {
      totalDirham: expenseTotals.totalDirham, byCategory: expenseTotals.byCategory,
      recent: recentExpenses.data.map((row) => ({ id: row.id!, businessDate: row.business_date!, recordedAt: row.recorded_at, category: row.category!, description: row.description!, amountDirham: row.amount_dirham! })),
      largest: largestExpenses.data.map((row) => ({ id: row.id!, businessDate: row.business_date!, recordedAt: row.recorded_at, category: row.category!, description: row.description!, amountDirham: row.amount_dirham! })),
    },
    closing: {
      state: dayState(todayCloseEvents), lastClose: closeEvents.find((event) => event.type === "closed") ?? null,
      recentEvents: closeEvents.map((event) => ({ ...event, actorName: who(event.actorId) })),
      recentlyReopened: [...new Set(closeHistory.data.filter((event) => event.event_type === "reopened").map((event) => String(event.business_date)))].slice(0, 5),
    },
    customers: { topBySales, topByPayments, recentlyActive, creditCustomers, anonymousInvoiceCount: anonymousCount.count ?? 0 },
    activity: { visible: canViewAudit, events: activity },
    shopComparison,
  };
}
