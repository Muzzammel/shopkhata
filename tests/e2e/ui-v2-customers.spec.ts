import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { login, OWNER, SHOP_1, SHOP_2, STAFF } from "./offline-helpers";

// UI/UX V2 phase 3 — Customer Directory and Customer Detail. Ledger, FIFO and credit rules are
// covered by the customer suites; this file holds the presentation guarantees the redesign adds.

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const qatarToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Qatar" }).format(new Date());

/**
 * One customer with three invoices (A 100.00 / 20.00 received, B 50.00, C 30.00 paid), a 5.00
 * overpayment on C kept as credit, and one 90.00 customer payment that settles across A and B.
 * Everything goes through the RPCs the app itself calls. Due left: 40.00; credit: 5.00.
 */
async function seedCustomer() {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const envText = execFileSync(process.execPath, [join(process.cwd(), "node_modules/supabase/dist/supabase.js"), "--agent", "no", "status", "-o", "env"], { encoding: "utf8" });
  const env = Object.fromEntries(envText.split(/\r?\n/).map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/)).filter((match) => match !== null).map((match) => [match[1], match[2]]));
  const owner = createClient(env.API_URL, env.PUBLISHABLE_KEY ?? env.ANON_KEY);
  expect((await owner.auth.signInWithPassword(OWNER)).error).toBeNull();
  const rpc = async (name: string, command: Record<string, unknown>) => {
    const { data, error } = await owner.rpc(name, { command: { shop_id: SHOP_1, ...command } });
    if (error) throw new Error(`${name}: ${error.message}`);
    return data;
  };
  const key = () => crypto.randomUUID();
  const today = qatarToday();
  const name = `V2 Customer ${suffix}`;
  const customerId = (await rpc("create_customer", { name, mobile: `55${suffix.slice(-7)}` })).customer_id as string;
  const row = (number: string, total: number, received: number) => ({ row_id: key(), invoice_number: number, total_dirham: total, received_dirham: received, payment_method: "cash", delivered: true, customer: { type: "existing", customer_id: customerId } });
  const numbers = [`V2C-A-${suffix}`, `V2C-B-${suffix}`, `V2C-C-${suffix}`];
  const batch = await rpc("submit_batch", { business_date: today, idempotency_key: key(), rows: [row(numbers[0], 10_000, 2_000), row(numbers[1], 5_000, 0), row(numbers[2], 3_000, 3_000)] });
  const invoiceC = batch.rows[2].invoice_id as string;
  await rpc("approve_overpayment", { invoice_id: invoiceC, amount_dirham: 500, payment_method: "cash", business_date: today, reason: "Paid extra in cash", idempotency_key: key() });
  await rpc("record_customer_payment", { customer_id: customerId, amount_dirham: 9_000, business_date: today, idempotency_key: key() });
  await owner.auth.signOut();
  return { name, customerId, numbers };
}

test.describe("Customer Directory", () => {
  test("shows factual balance states, due and credit, and opens the customer from anywhere on the row", async ({ page }) => {
    const { name } = await seedCustomer();
    await login(page, OWNER);
    await page.goto(`/customers?shop=${SHOP_1}&q=${encodeURIComponent(name)}`);
    await expect(page.getByRole("heading", { name: "Customers", level: 1 })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "1 match" })).toBeVisible();
    const row = page.locator("[data-slot=customer-table] tbody tr");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Due");
    await expect(row).toContainText("Credit available");
    await expect(row).toContainText("QAR 40.00");
    await expect(row).toContainText("QAR 5.00");
    for (const label of ["High due", "VIP", "Inactive"]) await expect(row).not.toContainText(label);
    // The stretched name link covers the row, so a click on the due cell lands on it.
    await row.getByRole("cell").nth(4).click({ force: true });
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  });

  test("says plainly when a search matches nobody", async ({ page }) => {
    await login(page, STAFF);
    await page.goto(`/customers?shop=${SHOP_1}&q=zz-no-such-customer-${Date.now()}`);
    await expect(page.getByRole("heading", { name: "No customers match this search" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Show all customers" })).toBeVisible();
  });
});

test.describe("Customer Detail", () => {
  test("summarises the customer and keeps payments, credits and activity honest", async ({ page }) => {
    const { name, customerId, numbers } = await seedCustomer();
    await login(page, OWNER);
    await page.goto(`/customers/${customerId}?shop=${SHOP_1}`);
    const summary = page.getByRole("group", { name: "Financial summary" });
    await expect(summary).toContainText("Total salesQAR 180.00");
    await expect(summary).toContainText("Current dueQAR 40.00");
    await expect(summary).toContainText("Available creditQAR 5.00");
    await expect(page.getByRole("region", { name: "Open invoices" }).getByRole("link")).toHaveCount(1); // 90.00 settled one invoice fully, the other in part

    await page.getByRole("tab", { name: /Payments/ }).click();
    await expect(page).toHaveURL(/tab=payments/);
    const payment = page.locator("[data-payment=payment]").filter({ hasText: "Allocated across 2 invoices" });
    await expect(payment).toContainText("QAR 90.00");
    for (const number of numbers.slice(0, 2)) await expect(payment.getByRole("link", { name: number })).toBeVisible();

    await page.getByRole("tab", { name: /Credits/ }).click();
    const credits = page.getByRole("region", { name: "Credits" });
    await expect(credits).toContainText("IssuedQAR 5.00");
    await expect(credits).toContainText("AvailableQAR 5.00");
    await expect(credits).toContainText("Paid extra in cash");
    await expect(credits.getByRole("link", { name: numbers[2] })).toBeVisible();

    await page.getByRole("tab", { name: /Activity/ }).click();
    await page.reload();
    await expect(page.getByRole("tab", { name: /Activity/ })).toHaveAttribute("aria-selected", "true");
    const activity = page.getByRole("region", { name: "Activity" });
    for (const title of ["Payment received", "Credit issued", "Invoice recorded", "Customer added"]) await expect(activity.getByRole("heading", { name: title }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  });

  test("keeps another person's name private from staff, using the safe fallback", async ({ page }) => {
    const { customerId } = await seedCustomer();
    await login(page, STAFF);
    await page.goto(`/customers/${customerId}?shop=${SHOP_1}&tab=activity`);
    await expect(page.getByRole("region", { name: "Activity" })).toContainText("By Team member …");
  });

  test("answers a missing or mismatched customer with a real 404 that streams none of their data", async ({ page }) => {
    const { name, customerId } = await seedCustomer();
    // The other-shop customer case lives in customer-expenses; these are the rest of the contract.
    for (const [user, path] of [
      [OWNER, `/customers/${crypto.randomUUID()}?shop=${SHOP_1}`],
      [OWNER, `/customers/${customerId}?shop=${SHOP_2}`],
      [STAFF, `/customers/${customerId}?shop=${SHOP_2}`],
    ] as const) {
      await page.context().clearCookies();
      await login(page, user);
      const raw = await page.request.get(path);
      expect(raw.status()).toBe(404);
      expect(await raw.text()).not.toContain(name);
      expect((await page.goto(path))?.status()).toBe(404);
      await expect(page.getByRole("heading", { name, level: 1 })).toHaveCount(0);
    }
  });

  test("Record payment drawer traps focus, closes on Escape, and applies credit through the existing flow", async ({ page }) => {
    const { customerId } = await seedCustomer();
    await login(page, STAFF);
    await page.goto(`/customers/${customerId}?shop=${SHOP_1}`);
    const trigger = page.getByRole("button", { name: "Record payment" });
    await trigger.click();
    const drawer = page.getByRole("dialog", { name: "Record payment" });
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("Current due");
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      expect(await drawer.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await drawer.getByRole("button", { name: "Apply credit" }).click();
    await drawer.getByLabel("Credit amount (QAR)").fill("6.00");
    await expect(drawer.getByRole("alert")).toContainText("available credit");
    await expect(drawer.getByRole("button", { name: "Review allocation" })).toBeDisabled();
    await drawer.getByLabel("Credit amount (QAR)").fill("2.00");
    await expect(drawer).toContainText("Resulting dueQAR 38.00");
    await expect(drawer).toContainText("Resulting creditQAR 3.00");
    await drawer.getByRole("button", { name: "Review allocation" }).click();
    await drawer.getByRole("button", { name: "Confirm credit" }).click();
    await expect(drawer).toHaveCount(0);
    const summary = page.getByRole("group", { name: "Financial summary" });
    await expect(summary).toContainText("Current dueQAR 38.00");
    await expect(summary).toContainText("Available creditQAR 3.00");
  });
});

test.describe("Customers on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("uses cards, not a squeezed table, and a full-screen payment sheet", async ({ page }) => {
    const { name, customerId } = await seedCustomer();
    await login(page, STAFF);
    await page.goto(`/customers?shop=${SHOP_1}&q=${encodeURIComponent(name)}`);
    await expect(page.locator("[data-slot=customer-table] thead")).toHaveClass(/sr-only/);
    await expect(page.getByRole("link", { name })).toBeVisible();
    expect(await noOverflow(page)).toBe(true);

    await page.goto(`/customers/${customerId}?shop=${SHOP_1}`);
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
    for (const tab of ["Invoices", "Payments", "Credits", "Activity"]) {
      await page.getByRole("tab", { name: new RegExp(tab) }).click();
      expect(await noOverflow(page)).toBe(true);
    }
    await page.getByRole("button", { name: "Record payment" }).click();
    const sheet = page.getByRole("dialog", { name: "Record payment" });
    await expect(sheet).toBeVisible();
    const box = await sheet.boundingBox();
    expect(Math.round(box!.width)).toBe(375);
  });
});
