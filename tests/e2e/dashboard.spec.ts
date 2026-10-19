import { expect, test, type Page } from "@playwright/test";

import { login, OWNER, savedNotice, SHOP_1, STAFF } from "./offline-helpers";

// The operational Dashboard (UI/UX V2): period controls, KPI correspondence to real data,
// current-balance labeling, shop comparison, closing health, quick actions and safe empty states.
// Reduced motion keeps every figure at its final value, so reading it never races a counter.
test.use({ contextOptions: { reducedMotion: "reduce" } });

const periods = (page: Page) => page.getByRole("navigation", { name: "Choose period" });

test("defaults to Today, and every period control is reachable", async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/dashboard?shop=${SHOP_1}`);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(periods(page).getByRole("link", { name: "Today", exact: true })).toHaveAttribute("aria-current", "page");
  for (const label of ["Week", "Month", "Year", "Custom"]) await expect(periods(page).getByRole("link", { name: label })).toBeVisible();
});

// The Sales card is the first KPI; its first "QAR ..." figure is effective sales for the period.
async function salesKpiCents(page: Page): Promise<number> {
  const text = await page.locator("[data-slot=kpi]").filter({ hasText: "Sales" }).first().innerText();
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

test("Week, Month and Year widen the window, and a custom range is validated like every other history screen", async ({ page }) => {
  await login(page, OWNER);
  for (const [period, label] of [["7d", "Week"], ["30d", "Month"], ["year", "Year"]] as const) {
    await page.goto(`/dashboard?shop=${SHOP_1}&period=${period}`);
    await expect(periods(page).getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
  }
  await expect(page.getByRole("region", { name: "Sales Overview" })).toContainText("Last 12 months");

  await page.goto(`/dashboard?shop=${SHOP_1}&period=custom&from=2026-10-03&to=2026-10-01`);
  // Scoped to the page: with a loading skeleton Next also mounts its own (empty) route announcer alert.
  await expect(page.getByRole("main").getByRole("alert")).toContainText("must not be after");
});

test("Customer Due is the current customer-ledger balance; All Unpaid Invoices is every unpaid invoice in the period", async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/dashboard?shop=${SHOP_1}&period=7d`);
  const due = page.locator("[data-slot=kpi]").filter({ hasText: "Customer Due" });
  await expect(due).toContainText("current balance, customer ledger only");
  await expect(due.getByRole("link")).toHaveAttribute("href", `/customers?shop=${SHOP_1}`);
  const unpaid = page.locator("[data-slot=kpi]").filter({ hasText: "All Unpaid Invoices" });
  await expect(unpaid).toContainText("with or without a customer");
  await expect(unpaid.getByRole("link")).toHaveAttribute("href", /\/invoices\?shop=.*&status=with_due$/);
  // The detailed breakdown keeps the old wording for the balance figures.
  await page.getByText("More detail").click();
  await expect(page.getByText("Outstanding due · current balance")).toBeVisible();
  await expect(page.getByText("Available customer credit · current balance")).toBeVisible();
});

test("an empty historical window renders zero states without NaN or undefined", async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/dashboard?shop=${SHOP_1}&period=custom&from=2019-01-01&to=2019-01-07`);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  const body = await page.locator("main").innerText();
  expect(body).not.toMatch(/NaN|undefined/);
  await expect(page.getByText("QAR 0.00").first()).toBeVisible();
  await expect(page.getByText("Nothing recorded in this period")).toBeVisible();
});

test("owner sees a shop comparison; single-shop staff sees no comparison section and only their own shop", async ({ page, browser }) => {
  await login(page, OWNER);
  await page.goto(`/dashboard?shop=${SHOP_1}`);
  await page.getByText("More detail").click();
  await expect(page.getByRole("heading", { name: "Shop comparison" })).toBeVisible();
  await expect(page.getByRole("table").filter({ hasText: "Shop 1" })).toContainText("Shop 2");

  const context = await browser.newContext(); const staff = await context.newPage();
  await login(staff, STAFF);
  await staff.goto(`/dashboard?shop=${SHOP_1}`);
  await staff.getByText("More detail").click();
  await expect(staff.getByRole("heading", { name: "Invoice health" })).toBeVisible();
  await expect(staff.getByRole("heading", { name: "Shop comparison" })).toHaveCount(0);
  await expect(staff.getByText("Shop 2")).toHaveCount(0);
  await context.close();
});

test("daily closing health renders today's state and links to Closing", async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/dashboard?shop=${SHOP_1}`);
  await page.getByText("More detail").click();
  const closing = page.getByRole("region", { name: "Daily closing health" });
  await expect(closing.locator("[data-day-state]")).toHaveText(/^(Open|Closed)$/);
  await expect(closing.getByRole("link", { name: "Open daily close" })).toHaveAttribute("href", `/closing?shop=${SHOP_1}`);
});

test("Needs Attention lists only actionable items, or says everything looks good", async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/dashboard?shop=${SHOP_1}`);
  const attention = page.getByRole("region", { name: "Needs Attention" });
  await expect(attention).toBeVisible();
  const items = attention.getByRole("link");
  if (await items.count() === 0) await expect(attention.getByRole("status")).toHaveText("Everything looks good");
  for (const href of await items.evaluateAll((links) => links.map((link) => link.getAttribute("href")))) {
    expect(href).toMatch(/^\/(closing|customers)\?shop=|^\/admin\/backup$/);
  }
});

test("quick actions deep-link to the right surfaces", async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/dashboard?shop=${SHOP_1}`);
  const actions = page.getByRole("navigation", { name: "Quick actions" });
  await expect(actions.getByRole("link", { name: "New sale" })).toHaveAttribute("href", `/?shop=${SHOP_1}`);
  await expect(actions.getByRole("link", { name: "Record payment" })).toHaveAttribute("href", `/payments?shop=${SHOP_1}`);
  await expect(actions.getByRole("link", { name: "Add expense" })).toHaveAttribute("href", `/expenses?shop=${SHOP_1}`);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("link", { name: "Sales" })).toHaveAttribute("href", `/invoices?shop=${SHOP_1}`);
  await expect(nav.getByRole("link", { name: "Customers" })).toHaveAttribute("href", `/customers?shop=${SHOP_1}`);
  await expect(nav.getByRole("link", { name: "Daily Close" })).toHaveAttribute("href", `/closing?shop=${SHOP_1}`);
  await expect(nav.getByRole("link", { name: "Reports" })).toHaveAttribute("href", `/reports?shop=${SHOP_1}`);
});
