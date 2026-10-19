import { expect, test, type Page } from "@playwright/test";

import { login, OWNER, savedNotice, SHOP_1, SHOP_2, STAFF } from "./offline-helpers";

// Big Slice 6: the dedicated Payments page — Record Payment reusing the one
// authoritative payment path, historical search/filtering, allocation and
// correction visibility, and shop isolation.

async function createInvoice(page: Page, number: string, total: string, received = "0.00") {
  await page.goto("/");
  const row = page.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(number);
  await row.getByLabel("Total QAR").fill(total);
  if (received !== "0.00") await row.getByLabel("Received QAR").fill(received);
  await page.getByRole("button", { name: "Review sale" }).click();
  await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await expect(savedNotice(page)).toBeVisible();
}

test("the Payments page loads with Record Payment and a history list", async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/payments?shop=${SHOP_1}`);
  await expect(page.getByRole("heading", { name: "Payments" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Record payment" })).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
});

test("recording a payment on the Payments page uses the authoritative workflow and appears in its own history", async ({ page }) => {
  await login(page, OWNER);
  const number = `PAY-${Date.now()}`;
  await createInvoice(page, number, "40.00");

  await page.goto(`/payments?shop=${SHOP_1}`);
  const form = page.getByRole("region", { name: "Record payment" });
  await form.getByLabel("Invoice number").fill(number);
  await form.getByRole("button", { name: "Find invoice" }).click();
  await expect(form.getByRole("heading", { name: number })).toBeVisible();
  await form.getByLabel("Cash amount (QAR)").fill("15.00");
  await form.getByRole("button", { name: "Review payment" }).click();
  await form.getByRole("button", { name: "Confirm payment" }).click();
  await expect(form.getByRole("status")).toContainText("Payment recorded");

  await page.reload();
  const row = page.getByRole("row", { name: new RegExp(number) });
  await expect(row).toContainText("QAR 15.00");
  await expect(row).toContainText("Follow-up invoice payment");
});

test("invoice-number search finds a payment outside the default 30-day window", async ({ page }) => {
  await login(page, OWNER);
  const number = `PAY-OLD-${Date.now()}`;
  await page.goto("/");
  await page.getByLabel("Business date").fill("2020-02-10");
  await page.getByLabel("Backdate reason").fill("Historical payment search coverage");
  const row = page.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(number);
  await row.getByLabel("Total QAR").fill("22.00");
  await row.getByLabel("Received QAR").fill("22.00");
  await page.getByRole("button", { name: "Review sale" }).click();
  await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await expect(savedNotice(page)).toBeVisible();

  await page.goto(`/payments?shop=${SHOP_1}`);
  await expect(page.getByText(number)).toHaveCount(0);
  await page.locator('input[name="invoice"]').fill(number);
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("table")).toContainText(number);
  await expect(page.getByRole("table")).toContainText("2020-02-10");
});

test("a custom date range narrows payment history, and reset restores the last 30 days", async ({ page }) => {
  await login(page, OWNER);
  const number = `PAY-RANGE-${Date.now()}`;
  await createInvoice(page, number, "18.00", "18.00");

  await page.goto(`/payments?shop=${SHOP_1}&from=2020-01-01&to=2020-01-02`);
  await expect(page.getByText(number)).toHaveCount(0);
  await page.getByRole("link", { name: "Reset to last 30 days" }).click();
  await expect(page.getByText(number)).toBeVisible();
});

test("payment rows link safely to their invoice and customer", async ({ page }) => {
  await login(page, OWNER);
  const customerName = `Payment Link Customer ${Date.now()}`;
  const number = `PAY-LINK-${Date.now()}`;
  await page.goto("/");
  const row = page.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(number);
  await row.getByLabel("Total QAR").fill("50.00");
  await row.getByLabel("Received QAR").fill("20.00");
  await row.getByLabel("Delivered").check();
  await row.getByLabel("New customer name").fill(customerName);
  await page.getByRole("button", { name: "Review sale" }).click();
  await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await expect(savedNotice(page)).toBeVisible();

  await page.goto(`/payments?shop=${SHOP_1}&invoice=${number}`);
  const tableRow = page.getByRole("row", { name: new RegExp(number) });
  await expect(tableRow.getByRole("link", { name: number })).toHaveAttribute("href", new RegExp(`^/shops/${SHOP_1}/invoices/[0-9a-f-]+$`));
  await expect(tableRow.getByRole("link", { name: customerName })).toHaveAttribute("href", new RegExp(`^/customers/[0-9a-f-]+\\?shop=${SHOP_1}$`));
});

test("staff cannot reach another shop's payment history by editing the shop query parameter", async ({ page }) => {
  await login(page, STAFF);
  await page.goto(`/payments?shop=${SHOP_2}`);
  await expect(page.getByRole("heading", { name: "Payments" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Choose shop" })).toHaveCount(0); // a single-shop user gets no shop switcher at all
  await expect(page.getByText("Shop 2")).toHaveCount(0);
});

test("an approved payment correction is shown as its own effective row, not a mutation of the original", async ({ page, browser }) => {
  await login(page, OWNER);
  const number = `PAY-CORR-${Date.now()}`;
  await createInvoice(page, number, "100.00");
  await page.getByRole("link", { name: `View invoice ${number}`, exact: true }).click();
  await expect(page).toHaveURL(/\/shops\/[^/]+\/invoices\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Record payment" }).click();
  const payment = page.getByRole("dialog", { name: "Record payment" });
  await payment.getByLabel("Cash amount (QAR)").fill("30.00");
  await payment.getByRole("button", { name: "Review payment", exact: true }).click();
  await payment.getByRole("button", { name: "Confirm payment" }).click();
  await expect(payment.getByRole("status")).toContainText("Payment recorded");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Request correction", exact: true }).click();
  const financial = page.getByRole("form", { name: "Correction request" });
  await financial.getByLabel("Correct record").selectOption({ index: 1 }); // "Invoice total" is index 0; the one payment just recorded is index 1
  await financial.getByLabel("Adjustment amount (QAR)").fill("5.00");
  await financial.getByLabel("Request reason").fill("Payment overstated by five QAR");
  await financial.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText("Payment correction — Pending approval", { exact: true })).toBeVisible();

  const context = await browser.newContext(); const owner = await context.newPage();
  await login(owner, OWNER);
  await owner.goto(page.url());
  await owner.getByRole("button", { name: "Approve" }).click();
  await expect(owner.getByRole("region", { name: "History" })).toContainText("Payment correction requestedApproved");
  await context.close();

  await page.goto(`/payments?shop=${SHOP_1}&invoice=${number}`);
  const table = page.getByRole("table");
  await expect(table).toContainText("Follow-up invoice payment");
  await expect(table).toContainText("Payment correction");
  await expect(table).toContainText("QAR 30.00");
  await expect(table).toContainText("QAR -5.00"); // the correction's own signed row (default direction: decrease)
});
