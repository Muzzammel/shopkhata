import { expect, test } from "@playwright/test";

import { login, OWNER, savedNotice, SHOP_1, STAFF } from "./offline-helpers";

// Big Slice 6: the operational Dashboard — period controls, KPI correspondence
// to real data, current-balance labeling, shop comparison, closing health,
// quick actions and safe empty states.

test("defaults to Today, and every period control is reachable", async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/dashboard?shop=${SHOP_1}`);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  const periods = page.getByRole("navigation", { name: "Choose period" });
  await expect(periods.getByRole("link", { name: "Today", exact: true })).toHaveAttribute("aria-current", "page");
  for (const label of ["Last 7 days", "Last 30 days", "Custom"]) await expect(periods.getByRole("link", { name: label })).toBeVisible();
});

// The KPI section lists "Invoices" (a count, no QAR) then "Sales (effective)"
// immediately after, so the first "QAR ..." figure in the section's text is
// always the Sales KPI, regardless of how many other KPIs follow it.
async function salesKpiCents(page: import("@playwright/test").Page): Promise<number> {
  const section = page.locator("section").filter({ hasText: "Sales (effective)" }).first();
  const text = await section.innerText();
  const match = text.match(/QAR\s*([\d,]+\.\d{2})/);
  return Math.round(Number.parseFloat(match![1].replace(/,/g, "")) * 100);
}

test("a new invoice raises today's Sales KPI by exactly its effective total", async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/dashboard?shop=${SHOP_1}`);
  const before = await salesKpiCents(page);

  const number = `DASH-${Date.now()}`;
  await page.goto("/");
  const row = page.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(number);
  await row.getByLabel("Total QAR").fill("77.00");
  await row.getByLabel("Received QAR").fill("77.00");
  await page.getByRole("button", { name: "Review batch" }).click();
  await page.getByRole("button", { name: "Save batch" }).click();
  await expect(savedNotice(page)).toBeVisible();

  await page.goto(`/dashboard?shop=${SHOP_1}`);
  const after = await salesKpiCents(page);
  expect(after - before).toBe(7700);
});

test("7-day and 30-day periods widen the window, and a custom range is validated like every other history screen", async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/dashboard?shop=${SHOP_1}&period=7d`);
  await expect(page.getByRole("link", { name: "Last 7 days" })).toHaveAttribute("aria-current", "page");
  await page.goto(`/dashboard?shop=${SHOP_1}&period=30d`);
  await expect(page.getByRole("link", { name: "Last 30 days" })).toHaveAttribute("aria-current", "page");

  await page.goto(`/dashboard?shop=${SHOP_1}&period=custom&from=2026-10-03&to=2026-10-01`);
  await expect(page.getByRole("alert")).toContainText("must not be after");
});

test("outstanding due and available credit are labeled as the current balance, not the selected period", async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/dashboard?shop=${SHOP_1}&period=7d`);
  await expect(page.locator("span").filter({ hasText: "current balance" }).filter({ hasText: "Outstanding due" }).first()).toBeVisible();
  await expect(page.locator("span").filter({ hasText: "current balance" }).filter({ hasText: "Available customer credit" }).first()).toBeVisible();
});

test("an empty historical window renders zero states without NaN or undefined", async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/dashboard?shop=${SHOP_1}&period=custom&from=2019-01-01&to=2019-01-07`);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  const body = await page.locator("main").innerText();
  expect(body).not.toMatch(/NaN|undefined/);
  await expect(page.getByText("QAR 0.00").first()).toBeVisible();
});

test("owner sees a shop comparison; single-shop staff sees no comparison section and only their own shop", async ({ page, browser }) => {
  await login(page, OWNER);
  await page.goto(`/dashboard?shop=${SHOP_1}`);
  await expect(page.getByRole("heading", { name: "Shop comparison" })).toBeVisible();
  await expect(page.getByRole("table").filter({ hasText: "Shop 1" })).toContainText("Shop 2");

  const context = await browser.newContext(); const staff = await context.newPage();
  await login(staff, STAFF);
  await staff.goto(`/dashboard?shop=${SHOP_1}`);
  await expect(staff.getByRole("heading", { name: "Shop comparison" })).toHaveCount(0);
  await expect(staff.getByText("Shop 2")).toHaveCount(0);
  await context.close();
});

test("daily closing health renders today's state and links to Closing", async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/dashboard?shop=${SHOP_1}`);
  const closing = page.locator("section").filter({ hasText: "Daily closing health" }).first();
  await expect(closing.locator("[data-day-state]")).toHaveText(/^(Open|Closed)$/);
  await expect(closing.getByRole("link", { name: "Open daily close" })).toHaveAttribute("href", `/closing?shop=${SHOP_1}`);
});

test("quick actions deep-link to the right surfaces", async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/dashboard?shop=${SHOP_1}`);
  const actions = page.locator("section").filter({ hasText: "Quick actions" }).first();
  await expect(actions.getByRole("link", { name: "New invoice" })).toHaveAttribute("href", "/");
  await expect(actions.getByRole("link", { name: "Record payment" })).toHaveAttribute("href", `/payments?shop=${SHOP_1}`);
  await expect(actions.getByRole("link", { name: "Add expense" })).toHaveAttribute("href", `/expenses?shop=${SHOP_1}`);
  await expect(actions.getByRole("link", { name: "Find invoice" })).toHaveAttribute("href", `/invoices?shop=${SHOP_1}`);
  await expect(actions.getByRole("link", { name: "Find customer" })).toHaveAttribute("href", `/customers?shop=${SHOP_1}`);
  await expect(actions.getByRole("link", { name: "Daily close" })).toHaveAttribute("href", `/closing?shop=${SHOP_1}`);
  await expect(actions.getByRole("link", { name: "Reports" })).toHaveAttribute("href", `/reports?shop=${SHOP_1}`);
});
