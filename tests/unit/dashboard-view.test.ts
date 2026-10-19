import { describe, expect, it } from "vitest";

import { hrefForShop, NAV_ITEMS, navHref } from "@/components/shell/nav-items";
import { quickActions } from "@/components/shell/quick-actions";
import { activityKind, activityWhen, bucketTrend, categorySlot, compactQar, deriveAttention, initials, monotonePath, niceMax, shortDate } from "@/lib/dashboard-view";

const day = (businessDate: string, salesDirham: number, paymentsDirham = 0, expensesDirham = 0) => ({ businessDate, salesDirham, paymentsDirham, expensesDirham });

describe("bucketTrend", () => {
  it("fills the days without activity with zeros, so a sparse week still has seven points", () => {
    const { unit, buckets } = bucketTrend([day("2026-10-02", 500)], "2026-09-28", "2026-10-04", 31);
    expect(unit).toBe("day");
    expect(buckets.map((b) => b.salesDirham)).toEqual([0, 0, 0, 0, 500, 0, 0]);
    expect(buckets[0].label).toBe("28 Sep");
  });
  it("sums into weeks and then months without changing any total", () => {
    const days = [day("2026-09-05", 100, 40, 10), day("2026-09-20", 250, 60, 5), day("2026-10-04", 75, 0, 30)];
    const weeks = bucketTrend(days, "2026-09-05", "2026-10-04", 10);
    expect(weeks.unit).toBe("week");
    expect(weeks.buckets).toHaveLength(5);
    const months = bucketTrend(days, "2025-10-05", "2026-10-04", 31);
    expect(months.unit).toBe("month");
    expect(months.buckets.at(-1)!.label).toBe("Oct");
    for (const result of [weeks, months]) {
      expect(result.buckets.reduce((sum, b) => sum + b.salesDirham, 0)).toBe(425);
      expect(result.buckets.reduce((sum, b) => sum + b.paymentsDirham, 0)).toBe(100);
      expect(result.buckets.reduce((sum, b) => sum + b.expensesDirham, 0)).toBe(45);
    }
  });
  it("returns a single bucket for a single day", () => {
    expect(bucketTrend([], "2026-10-04", "2026-10-04", 31).buckets).toEqual([{ key: "2026-10-04", label: "4 Oct", salesDirham: 0, paymentsDirham: 0, expensesDirham: 0 }]);
  });
});

describe("labels and scales", () => {
  it("formats axis amounts compactly from dirham", () => {
    expect(compactQar(0)).toBe("0");
    expect(compactQar(99_900)).toBe("999");
    expect(compactQar(125_000)).toBe("1.3k");
    expect(compactQar(250_000_000)).toBe("2.5M");
    expect(compactQar(-150_000)).toBe("-1.5k");
  });
  it("rounds an axis maximum up to a 1/2/5 step", () => {
    expect(niceMax(0)).toBe(100);
    expect(niceMax(730)).toBe(1000);
    expect(niceMax(1_800)).toBe(2000);
    expect(niceMax(4_200)).toBe(5000);
  });
  it("derives initials and stable category colours", () => {
    expect(initials("Ahmed Al Thani")).toBe("AT");
    expect(initials("noor")).toBe("NO");
    expect(initials("  ")).toBe("?");
    expect(categorySlot("Rent")).toBe(1);
    expect(categorySlot("other")).toBe(6);
    expect(categorySlot("unknown")).toBe(6);
    expect(shortDate("2026-01-09")).toBe("9 Jan");
  });
  it("shows activity times in Qatar time relative to the Qatar business date", () => {
    expect(activityWhen("2026-10-04T08:30:00Z", "2026-10-04")).toBe("Today 11:30");
    expect(activityWhen("2026-10-03T22:10:00Z", "2026-10-04")).toBe("Today 01:10");
    expect(activityWhen("2026-10-03T08:00:00Z", "2026-10-04")).toBe("Yesterday 11:00");
    expect(activityWhen("2026-09-30T08:00:00Z", "2026-10-04")).toBe("30 Sep 11:00");
  });
  it("classifies audit actions for their icon", () => {
    expect(activityKind("batch.submit")).toBe("invoice");
    expect(activityKind("record_customer_payment")).toBe("payment");
    expect(activityKind("approve_overpayment")).toBe("payment");
    expect(activityKind("correction.decide")).toBe("correction");
    expect(activityKind("create_expense")).toBe("expense");
    expect(activityKind("date.close")).toBe("close");
    expect(activityKind("admin_update_account")).toBe("admin");
  });
  it("draws a monotone path that passes through every point", () => {
    expect(monotonePath([], [])).toBe("");
    expect(monotonePath([0], [50])).toBe("M0,50");
    const path = monotonePath([0, 50, 100], [100, 20, 20]);
    expect(path.startsWith("M0,100")).toBe(true);
    expect(path).toContain(" 50,20");
    expect(path.endsWith(" 100,20")).toBe(true);
    // A flat segment stays flat: both control points keep y = 20.
    expect(path.split(" C").at(-1)).toMatch(/^[\d.]+,20 [\d.]+,20 100,20$/);
  });
});

describe("deriveAttention", () => {
  const base = { shopId: "s1", dayOpenWithActivity: false, customersWithDue: 0, outstandingDueDirham: 0, backup: null };
  it("is empty when nothing needs a person", () => {
    expect(deriveAttention(base)).toEqual([]);
    expect(deriveAttention({ ...base, backup: { freshness: "current", ageHours: 3 } })).toEqual([]);
  });
  it("lists an open day with activity, an overdue backup and customer due", () => {
    const items = deriveAttention({ ...base, dayOpenWithActivity: true, customersWithDue: 2, outstandingDueDirham: 12_345, backup: { freshness: "overdue", ageHours: 40.2 } });
    expect(items.map((item) => item.id)).toEqual(["close", "backup", "due"]);
    expect(items[0].href).toBe("/closing?shop=s1");
    expect(items[1]).toMatchObject({ title: "Backup overdue", detail: "The last backup is 40 hours old.", href: "/admin/backup" });
    expect(items[2].detail).toBe("2 customers owe QAR 123.45.");
  });
});

describe("shell navigation", () => {
  it("keeps the current shop on shop-scoped links only", () => {
    const sales = NAV_ITEMS.find((item) => item.key === "sales")!;
    const accounts = NAV_ITEMS.find((item) => item.key === "accounts")!;
    expect(navHref(sales, "s2")).toBe("/invoices?shop=s2");
    expect(navHref(sales, null)).toBe("/invoices");
    expect(navHref(accounts, "s2")).toBe("/admin");
  });
  it("marks exactly one item current for each screen", () => {
    const current = (path: string) => NAV_ITEMS.filter((item) => item.current(path)).map((item) => item.key);
    expect(current("/")).toEqual(["sales"]);
    expect(current("/shops/a/invoices/b")).toEqual(["sales"]);
    expect(current("/dashboard")).toEqual(["dashboard"]);
    expect(current("/admin")).toEqual(["accounts"]);
    expect(current("/admin/backup")).toEqual(["backup"]);
  });
  it("switches shop on the same page, and sends a detail page back to its list", () => {
    expect(hrefForShop("/dashboard", "shop=s1&period=7d", "s2")).toBe("/dashboard?shop=s2&period=7d");
    expect(hrefForShop("/customers", "shop=s1&offset=50&q=ali", "s2")).toBe("/customers?shop=s2&q=ali");
    expect(hrefForShop("/customers/c9", "shop=s1", "s2")).toBe("/customers?shop=s2");
    expect(hrefForShop("/shops/s1/invoices/i1", "", "s2")).toBe("/invoices?shop=s2");
  });
  it("offers Record Payment and Add Expense only where they are permitted", () => {
    expect(quickActions("s1", { s1: { payment: true, expense: false } }).map((a) => a.key)).toEqual(["sale", "payment"]);
    expect(quickActions("s1", {}).map((a) => a.href)).toEqual(["/?shop=s1"]);
    expect(quickActions(null, {}).map((a) => a.href)).toEqual(["/"]);
  });
});
