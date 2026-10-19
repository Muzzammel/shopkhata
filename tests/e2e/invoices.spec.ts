import { expect, test, type Page } from "@playwright/test";

import { fillRow, importFile, login, OWNER, savedNotice, SHOP_1, SHOP_2, STAFF, workbook } from "./offline-helpers";

// Big Slice 6: the dedicated Invoices history browser — the 30-day default,
// historical invoice-number search, custom ranges, pagination and shop
// isolation.

async function saveBatch(page: Page) {
  await page.getByRole("button", { name: "Review sale" }).click();
  await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await expect(savedNotice(page)).toBeVisible();
}

test("opens with the last-30-day default and a visible status filter", async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/invoices?shop=${SHOP_1}`);
  await expect(page.getByRole("heading", { name: "Sales", exact: true })).toBeVisible();
  const from = await page.locator('input[name="from"]').inputValue();
  const to = await page.locator('input[name="to"]').inputValue();
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  expect(days).toBe(29);
  for (const label of ["All", "Delivered", "Not delivered", "Due", "Paid"]) {
    await expect(page.getByRole("navigation", { name: "Filter by status" }).getByRole("link", { name: label, exact: true })).toBeVisible();
  }
});

test("a custom range shows only invoices in that range, and reset returns to the 30-day default", async ({ page }) => {
  await login(page, OWNER);
  const number = `INV-RANGE-${Date.now()}`;
  await page.goto("/");
  await fillRow(page, 0, number, "25.00");
  await saveBatch(page);

  await page.goto(`/invoices?shop=${SHOP_1}&from=2020-01-01&to=2020-01-02&status=all`);
  await expect(page.getByText(number)).toHaveCount(0);
  await page.getByRole("link", { name: "Reset to last 30 days" }).click();
  await expect(page.getByText(number)).toBeVisible();
});

test("invoice-number search finds an invoice outside the default 30-day window, and stays shop-scoped", async ({ page, browser }) => {
  await login(page, OWNER);
  const number = `INV-OLD-${Date.now()}`;
  const old = "2020-01-05";
  await page.goto("/");
  await page.getByLabel("Business date").fill(old);
  await page.getByLabel("Backdate reason").fill("Recording a historical invoice for search coverage");
  const row = page.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(number);
  await row.getByLabel("Total QAR").fill("30.00");
  await saveBatch(page);

  await page.goto(`/invoices?shop=${SHOP_1}`);
  await expect(page.getByText(number)).toHaveCount(0); // not in the default window
  await page.locator('input[name="q"]').fill(number);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("status")).toContainText(number);
  await expect(page.getByRole("status")).toContainText(old);
  await expect(page.getByRole("link", { name: `View invoice ${number}` })).toBeVisible();

  // Unauthorized cross-shop search: the number exists only in Shop 1 and must not be exposed through Shop 2.
  const context = await browser.newContext(); const staff2 = await context.newPage();
  await staff2.goto("/login");
  await staff2.getByLabel(/email/i).fill("staff2@shopkhata.local");
  await staff2.getByLabel(/password/i).fill("ShopKhata-Local-Shop2-E2E-Only-2026!");
  await staff2.getByRole("button", { name: /sign in/i }).click();
  await expect(staff2.getByRole("heading", { name: "Shop 2", exact: true })).toBeVisible();
  await staff2.goto(`/invoices?shop=${SHOP_2}`);
  await staff2.locator('input[name="q"]').fill(number);
  await staff2.getByRole("button", { name: "Search" }).click();
  await expect(staff2.getByRole("main").getByRole("alert")).toContainText("No invoice");
  await context.close();
});

test("staff cannot reach another shop's invoices by editing the shop query parameter", async ({ page }) => {
  await login(page, STAFF); // staff1 is assigned only to Shop 1
  await page.goto(`/invoices?shop=${SHOP_2}`);
  await expect(page.getByRole("heading", { name: "Sales", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Choose shop" })).toHaveCount(0); // a single-shop user gets no shop switcher at all
  await expect(page.getByText("Shop 2")).toHaveCount(0);
});

test("pagination moves through invoice history deterministically", async ({ page }) => {
  await login(page, OWNER);
  const prefix = `INV-PAGE-${Date.now()}`;
  // A business date of its own, so invoices other tests record today cannot shift the pages mid-test.
  const day = `2021-02-${10 + (Date.now() % 18)}`;
  await page.goto("/");
  await page.getByLabel("Business date").fill(day);
  await page.getByLabel("Backdate reason").fill("Pagination fixture on its own date");
  const rows = Array.from({ length: 31 }, (_, i) => [`${prefix}-${String(i + 1).padStart(2, "0")}`, 5, 0, "No", null, null, null]);
  await importFile(page, await workbook([["Invoice Number", "Total QAR", "Received QAR", "Delivered", "Customer Name", "Customer Mobile", "Note"], ...rows]));
  await page.getByRole("button", { name: "Add rows to draft" }).click();
  await saveBatch(page);

  await page.goto(`/invoices?shop=${SHOP_1}&from=${day}&to=${day}&status=all`);
  await expect(page.getByRole("link", { name: "Next" })).toBeVisible();
  const table = page.getByRole("region", { name: "Invoices" }).locator("tbody");
  const firstPageText = await table.innerText();
  await page.getByRole("link", { name: "Next" }).click();
  await expect(page.getByRole("link", { name: "Previous" })).toBeVisible(); // only renders once the new (offset > 0) page has loaded
  const secondPageText = await table.innerText();
  expect(secondPageText).not.toBe(firstPageText);
  await page.getByRole("link", { name: "Previous" }).click();
  await expect(page.getByRole("link", { name: "Previous" })).toHaveCount(0); // back at offset 0
  expect(await table.innerText()).toBe(firstPageText);
});
