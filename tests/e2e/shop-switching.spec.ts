import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { openSaleTools } from "./offline-helpers";

const OWNER_EMAIL = "owner@shopkhata.local";
const STAFF_PASSWORD = "ShopKhata-Local-E2E-Only-2026!";
const OWNER_PASSWORD = "ShopKhata-Local-Owner-E2E-Only-2026!";

function localDbQuery(sql: string) {
  return execFileSync(process.execPath, [
    join(process.cwd(), "node_modules", "supabase", "dist", "supabase.js"),
    "--agent", "no", "db", "query", "--local", sql,
  ], { encoding: "utf8", timeout: 30_000 });
}

async function login(page: Page, email = OWNER_EMAIL) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(email === OWNER_EMAIL ? OWNER_PASSWORD : STAFF_PASSWORD);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page.getByRole("heading", { name: "Shop 1", exact: true })).toBeVisible();
}

async function createInvoice(page: Page, invoiceNumber: string, total: string, received: string, customerName = "") {
  const row = page.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(invoiceNumber);
  await row.getByLabel("Total QAR").fill(total);
  await row.getByLabel("Received QAR").fill(received);
  if (customerName) {
    await row.getByLabel("Delivered").check();
    await row.getByLabel("New customer name").fill(customerName);
  }
  await page.getByRole("button", { name: "Review sale" }).click();
  await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await expect(page.getByRole("status").filter({ hasText: /Sale saved|\d+ invoices saved/ })).toBeVisible();
}

async function lookupPayment(page: Page, invoiceNumber: string) {
  await openSaleTools(page);
  const payment = page.getByRole("region", { name: "Record payment" });
  await payment.getByLabel("Invoice number").fill(invoiceNumber);
  await payment.getByRole("button", { name: "Find invoice" }).click();
  await expect(payment.getByRole("heading", { name: invoiceNumber })).toBeVisible();
  return payment;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function installHeldAction(page: Page, loseResponse: boolean) {
  const reachedServer = deferred<void>();
  const releaseResponse = deferred<void>();
  let commandActionId = "";
  let originalPayload: Buffer | null = null;
  let retryPayload: Buffer | null = null;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const actionId = request.headers()["next-action"];
    if (request.method() !== "POST" || !actionId) return route.continue();
    // Only a sale or payment command carries an idempotency key; the invoice-number lookup does not.
    if (!commandActionId && /idempotency(Key|_key)/.test(request.postData() ?? "")) {
      commandActionId = actionId;
      originalPayload = request.postDataBuffer();
      const response = await route.fetch();
      reachedServer.resolve();
      await releaseResponse.promise;
      if (loseResponse) return route.abort("failed");
      return route.fulfill({ response });
    }
    if (actionId === commandActionId) retryPayload = request.postDataBuffer();
    return route.continue();
  });
  return {
    reachedServer: reachedServer.promise,
    release: () => releaseResponse.resolve(),
    payloads: () => ({ originalPayload, retryPayload }),
  };
}

async function forceShopChange(page: Page) {
  const selector = page.getByLabel("Current shop");
  await selector.evaluate((element: HTMLSelectElement) => {
    element.value = Array.from(element.options).find((option) => option.textContent === "Shop 2")!.value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

test("owners switch isolated workspaces and can use the same invoice number in both shops", async ({ page }) => {
  const sharedNumber = `SHARED-${Date.now()}`;
  page.on("dialog", (dialog) => dialog.accept());
  await login(page);
  await expect(page.getByText("Local Owner")).toBeVisible();
  const selector = page.getByLabel("Current shop");
  await expect(selector.locator("option")).toHaveText(["Shop 1", "Shop 2"]);

  await createInvoice(page, sharedNumber, "15.00", "5.00", "Shop One Customer");
  await expect(page.getByLabel("Recent invoices")).toContainText(sharedNumber);

  await selector.selectOption({ label: "Shop 2" });
  await expect(page.getByRole("heading", { name: "Shop 2", exact: true })).toBeVisible();
  await expect(page.getByLabel("Recent invoices")).not.toContainText(sharedNumber);
  await page.getByLabel("Customer search").fill("Shop One Customer");
  await expect(page.locator('[id^="customer-search-status-"]').filter({ hasText: "No customers found." })).toBeVisible();
  await createInvoice(page, sharedNumber, "25.00", "10.00");
  await expect(page.getByLabel("Recent invoices")).toContainText(sharedNumber);
  const shop2Payment = await lookupPayment(page, sharedNumber);
  await expect(shop2Payment).toContainText("Invoice totalQAR 25.00");
  await expect(shop2Payment).toContainText("Outstanding nowQAR 15.00");

  await selector.selectOption({ label: "Shop 1" });
  await expect(page.getByRole("heading", { name: "Shop 1", exact: true })).toBeVisible();
  await expect(page.getByLabel("Recent invoices")).toContainText(sharedNumber);
  const shop1Payment = await lookupPayment(page, sharedNumber);
  await expect(shop1Payment).toContainText("Invoice totalQAR 15.00");
  await expect(shop1Payment).toContainText("Outstanding nowQAR 10.00");
});

test("owner shop switching clears a selected customer from the old shop", async ({ page }) => {
  const suffix = Date.now();
  const customerId = crypto.randomUUID();
  localDbQuery(`insert into public.customers (id, shop_id, public_id, name, mobile)
    values ('${customerId}', '10000000-0000-4000-8000-000000000001', 'CUS-SWITCH-${suffix}', 'Switch-only ${suffix}', '755${suffix}')`);
  page.once("dialog", (dialog) => dialog.accept());
  await login(page);
  const row = page.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(`SHOP-SWITCH-${suffix}`);
  await row.getByLabel("Total QAR").fill("9.00");
  await row.getByLabel("Customer search", { exact: true }).fill(`CUS-SWITCH-${suffix}`);
  await page.getByRole("option", { name: new RegExp(`CUS-SWITCH-${suffix}`) }).click();
  await expect(row.getByText(new RegExp(`Switch-only ${suffix}`))).toBeVisible();

  await page.getByLabel("Current shop").selectOption({ label: "Shop 2" });
  await expect(page.getByRole("heading", { name: "Shop 2", exact: true })).toBeVisible();
  const shop2Row = page.locator("[data-entry-row]").first();
  await expect(shop2Row.getByLabel("Customer search", { exact: true })).toHaveValue("");
  await expect(shop2Row.getByText(new RegExp(`Switch-only ${suffix}`))).toHaveCount(0);
  await shop2Row.getByLabel("Invoice ID").fill(`SHOP-SWITCH-SAVED-${suffix}`);
  await shop2Row.getByLabel("Total QAR").fill("9.00");
  await page.getByRole("button", { name: "Review sale" }).click();
  await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await expect(page.getByRole("status").filter({ hasText: /Sale saved|\d+ invoices saved/ })).toBeVisible();
  const crossShopLink = localDbQuery(`select count(*) = 0 as isolated from public.invoices
    where invoice_id = 'SHOP-SWITCH-SAVED-${suffix}' and customer_id = '${customerId}'`);
  expect(crossShopLink).toContain("true");
});

test("staff with one assigned shop has no selector, and owners confirm before discarding a draft", async ({ page }) => {
  await login(page, "staff1@shopkhata.local");
  await expect(page.getByLabel("Current shop")).toHaveCount(0);
  await page.goto("/?shopId=10000000-0000-4000-8000-000000000002");
  await expect(page.getByRole("heading", { name: "Shop 1", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Shop 2", exact: true })).toHaveCount(0);

  await login(page);
  const invoiceNumber = `DRAFT-${Date.now()}`;
  await page.getByLabel("Invoice ID").fill(invoiceNumber);
  await page.getByLabel("Total QAR").fill("9.00");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByLabel("Current shop").selectOption({ label: "Shop 2" });
  await expect(page.getByRole("heading", { name: "Shop 1", exact: true })).toBeVisible();
  await expect(page.getByLabel("Invoice ID")).toHaveValue(invoiceNumber);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel("Current shop").selectOption({ label: "Shop 2" });
  await expect(page.getByRole("heading", { name: "Shop 2", exact: true })).toBeVisible();
  await expect(page.getByLabel("Invoice ID")).toHaveValue("");
  await expect(page.getByLabel("Recent invoices")).not.toContainText(invoiceNumber);
});

test("an uncertain batch blocks switching and retries the identical command before releasing the shop", async ({ page }) => {
  await login(page);
  const invoiceNumber = `BATCH-RETRY-${Date.now()}`;
  await page.getByLabel("Invoice ID").fill(invoiceNumber);
  await page.getByLabel("Total QAR").fill("12.00");
  await page.getByRole("button", { name: "Review sale" }).click();

  let dropped = false;
  let actionId = "";
  let originalPayload: Buffer | null = null;
  let retryPayload: Buffer | null = null;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.headers()["next-action"]) {
      // Only the batch submission carries an idempotency key; the invoice-number lookup does not.
      if (!dropped && request.postData()?.includes("idempotencyKey")) {
        dropped = true;
        actionId = request.headers()["next-action"];
        originalPayload = request.postDataBuffer();
        await route.fetch();
        await route.abort("failed");
      } else if (request.headers()["next-action"] === actionId) {
        retryPayload = request.postDataBuffer();
        await route.continue();
      } else {
        await route.continue();
      }
    } else {
      await route.continue();
    }
  });

  await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await expect(page.getByLabel("Current shop")).toBeDisabled();
  await expect(page.getByText("Sale was not saved. Try again with the same draft.")).toBeVisible();
  expect(dropped).toBe(true);
  await page.getByRole("button", { name: "Retry same sale" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Sale saved|\d+ invoices saved/ })).toBeVisible();
  expect(retryPayload).toEqual(originalPayload);
  await expect(page.getByLabel("Current shop")).toBeEnabled();
});

test("an uncertain payment blocks switching until its original idempotent command is retried", async ({ page }) => {
  await login(page);
  const invoiceNumber = `PAYMENT-RETRY-${Date.now()}`;
  await createInvoice(page, invoiceNumber, "30.00", "0.00");
  const payment = await lookupPayment(page, invoiceNumber);
  await payment.getByLabel("Payment amount (QAR)").fill("8.00");
  await payment.getByRole("button", { name: "Review payment" }).click();

  let dropped = false;
  let actionId = "";
  let originalPayload: Buffer | null = null;
  let retryPayload: Buffer | null = null;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.headers()["next-action"]) {
      if (!dropped) {
        dropped = true;
        actionId = request.headers()["next-action"];
        originalPayload = request.postDataBuffer();
        await route.abort("failed");
      } else if (request.headers()["next-action"] === actionId) {
        retryPayload = request.postDataBuffer();
        await route.continue();
      } else {
        await route.continue();
      }
    } else {
      await route.continue();
    }
  });

  await payment.getByRole("button", { name: "Confirm payment" }).click();
  await expect(page.getByLabel("Current shop")).toBeDisabled();
  await expect(payment.getByRole("button", { name: "Retry payment" })).toBeVisible();
  await payment.getByRole("button", { name: "Retry payment" }).click();
  await expect(payment.getByRole("status")).toContainText("Payment recorded");
  expect(retryPayload).toEqual(originalPayload);
  await expect(page.getByLabel("Current shop")).toBeEnabled();
});

test("a delayed successful batch cannot switch shops or move Shop 1 data into Shop 2", async ({ page }) => {
  await login(page);
  const invoiceNumber = `BATCH-DELAY-${Date.now()}`;
  const customerName = `Only Shop One ${Date.now()}`;
  const row = page.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(invoiceNumber);
  await row.getByLabel("Total QAR").fill("14.00");
  await row.getByLabel("Received QAR").fill("4.00");
  await row.getByLabel("Delivered").check();
  await row.getByLabel("New customer name").fill(customerName);
  await page.getByRole("button", { name: "Review sale" }).click();
  const held = await installHeldAction(page, false);
  await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await held.reachedServer;

  const selector = page.getByLabel("Current shop");
  await expect(selector).toBeDisabled();
  await forceShopChange(page);
  await expect(page.getByRole("heading", { name: "Shop 1", exact: true })).toBeVisible();
  held.release();
  await expect(page.getByRole("status").filter({ hasText: /Sale saved|\d+ invoices saved/ })).toBeVisible();
  await expect(page.getByLabel("Recent invoices")).toContainText(invoiceNumber);

  await selector.selectOption({ label: "Shop 2" });
  await expect(page.getByRole("heading", { name: "Shop 2", exact: true })).toBeVisible();
  await expect(page.getByLabel("Recent invoices")).not.toContainText(invoiceNumber);
  await page.getByLabel("Customer search").fill(customerName);
  await expect(page.locator('[id^="customer-search-status-"]').filter({ hasText: "No customers found." })).toBeVisible();
});

test("a committed batch with a lost response keeps its exact retry while switching is blocked", async ({ page }) => {
  await login(page);
  const invoiceNumber = `BATCH-LOST-${Date.now()}`;
  await page.getByLabel("Invoice ID").fill(invoiceNumber);
  await page.getByLabel("Total QAR").fill("16.00");
  await page.getByRole("button", { name: "Review sale" }).click();
  const held = await installHeldAction(page, true);
  await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await held.reachedServer;

  await expect(page.getByLabel("Current shop")).toBeDisabled();
  await forceShopChange(page);
  await expect(page.getByRole("heading", { name: "Shop 1", exact: true })).toBeVisible();
  held.release();
  await expect(page.getByRole("button", { name: "Retry same sale" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same sale" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Sale saved|\d+ invoices saved/ })).toBeVisible();
  expect(held.payloads().retryPayload).toEqual(held.payloads().originalPayload);
  await expect(page.getByLabel("Recent invoices")).toContainText(invoiceNumber);

  await page.getByLabel("Current shop").selectOption({ label: "Shop 2" });
  await expect(page.getByRole("heading", { name: "Shop 2", exact: true })).toBeVisible();
  await expect(page.getByLabel("Recent invoices")).not.toContainText(invoiceNumber);
});

test("a delayed successful payment cannot switch shops or move Shop 1 balances into Shop 2", async ({ page }) => {
  await login(page);
  const invoiceNumber = `PAY-DELAY-${Date.now()}`;
  await createInvoice(page, invoiceNumber, "30.00", "0.00");
  const payment = await lookupPayment(page, invoiceNumber);
  await payment.getByLabel("Payment amount (QAR)").fill("8.00");
  await payment.getByRole("button", { name: "Review payment" }).click();
  const held = await installHeldAction(page, false);
  await payment.getByRole("button", { name: "Confirm payment" }).click();
  await held.reachedServer;

  const selector = page.getByLabel("Current shop");
  await expect(selector).toBeDisabled();
  await forceShopChange(page);
  await expect(page.getByRole("heading", { name: "Shop 1", exact: true })).toBeVisible();
  held.release();
  await expect(payment.getByRole("status")).toContainText("Payment recorded");
  await expect(page.getByLabel("Recent invoices")).toContainText("Due QAR 22.00");

  await selector.selectOption({ label: "Shop 2" });
  await expect(page.getByRole("heading", { name: "Shop 2", exact: true })).toBeVisible();
  await expect(page.getByLabel("Recent invoices")).not.toContainText(invoiceNumber);
});

test("a committed payment with a lost response keeps its exact retry while switching is blocked", async ({ page }) => {
  await login(page);
  const invoiceNumber = `PAY-LOST-${Date.now()}`;
  await createInvoice(page, invoiceNumber, "30.00", "0.00");
  const payment = await lookupPayment(page, invoiceNumber);
  await payment.getByLabel("Payment amount (QAR)").fill("7.00");
  await payment.getByRole("button", { name: "Review payment" }).click();
  const held = await installHeldAction(page, true);
  await payment.getByRole("button", { name: "Confirm payment" }).click();
  await held.reachedServer;

  await expect(page.getByLabel("Current shop")).toBeDisabled();
  await forceShopChange(page);
  await expect(page.getByRole("heading", { name: "Shop 1", exact: true })).toBeVisible();
  held.release();
  await expect(payment.getByRole("button", { name: "Retry payment" })).toBeVisible();
  await payment.getByRole("button", { name: "Retry payment" }).click();
  await expect(payment.getByRole("status")).toContainText("Payment recorded");
  expect(held.payloads().retryPayload).toEqual(held.payloads().originalPayload);
  await expect(page.getByLabel("Recent invoices")).toContainText("Due QAR 23.00");

  await page.getByLabel("Current shop").selectOption({ label: "Shop 2" });
  await expect(page.getByRole("heading", { name: "Shop 2", exact: true })).toBeVisible();
  await expect(page.getByLabel("Recent invoices")).not.toContainText(invoiceNumber);
});
