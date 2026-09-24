import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { qatarBusinessDate } from "@/lib/invoice-entry";

// These tests write to the same seeded shop; the 30-invoice batch can displace
// another test's invoice from the recent preview when they run concurrently.
test.describe.configure({ mode: "default" });

function localDbQuery(sql: string) {
  return execFileSync(process.execPath, [
    join(process.cwd(), "node_modules", "supabase", "dist", "supabase.js"),
    "--agent", "no", "db", "query", "--local", sql,
  ], { encoding: "utf8", timeout: 30_000 });
}

test("Shop 1 staff saves a mixed batch and sees it after refresh", async ({ page }) => {
  const prefix = `UI-${Date.now()}`;
  await page.goto("/login");
  await page.getByLabel(/email/i).fill("staff1@shopkhata.local");
  await page.getByLabel(/password/i).fill("ShopKhata-Local-E2E-Only-2026!");
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page.getByRole("heading", { name: "Shop 1" })).toBeVisible();
  await expect(page.getByText("Local Shop 1 Staff")).toBeVisible();

  const rows = page.locator("[data-entry-row]");
  await rows.nth(0).getByLabel("Invoice ID").fill(`${prefix}-PAID`);
  await rows.nth(0).getByLabel("Total QAR").fill("100.00");
  await rows.nth(0).getByLabel("Received QAR").fill("100.00");
  await rows.nth(0).getByLabel("Delivered").check();

  await page.getByRole("button", { name: "Add row" }).click();
  await rows.nth(1).getByLabel("Invoice ID").fill(`${prefix}-DUE`);
  await rows.nth(1).getByLabel("Total QAR").fill("80.50");
  await rows.nth(1).getByLabel("Received QAR").fill("20.00");
  await rows.nth(1).getByLabel("Delivered").check();
  await rows.nth(1).getByLabel("New customer name").fill("E2E Mary");

  await page.getByRole("button", { name: "Add row" }).click();
  await rows.nth(2).getByLabel("Invoice ID").fill(`${prefix}-ADV`);
  await rows.nth(2).getByLabel("Total QAR").fill("60.00");
  await rows.nth(2).getByLabel("Received QAR").fill("10.00");

  await page.getByRole("button", { name: "Review batch" }).click();
  await expect(page.getByText("QAR 240.50")).toBeVisible();
  await expect(page.getByText(`${prefix}-DUE`, { exact: true })).toHaveCount(1);
  await expect(page.getByLabel("New invoice batch").getByText("Due QAR 60.50", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save batch" }).click();
  await expect(page.getByRole("status")).toContainText("Batch saved");
  await page.reload();
  await expect(page.getByText(`${prefix}-PAID`)).toBeVisible();
  await expect(page.getByText(`${prefix}-DUE`)).toBeVisible();
  await expect(page.getByText(`${prefix}-ADV`)).toBeVisible();
});

test("a duplicate older than the recent preview gets a row error", async ({ page }) => {
  test.setTimeout(120_000);
  const prefix = `UI-OLD-${Date.now()}`;
  await page.goto("/login");
  await page.getByLabel(/email/i).fill("staff1@shopkhata.local");
  await page.getByLabel(/password/i).fill("ShopKhata-Local-E2E-Only-2026!");
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  const rows = page.locator("[data-entry-row]");

  await rows.nth(0).getByLabel("Invoice ID").fill(`${prefix}-FIRST`);
  await rows.nth(0).getByLabel("Total QAR").fill("10.00");
  await page.getByRole("button", { name: "Review batch" }).click();
  await page.getByRole("button", { name: "Save batch" }).click();
  await expect(page.getByRole("status")).toContainText("Batch saved");

  for (let i = 0; i < 30; i++) {
    if (i > 0) await page.getByRole("button", { name: "Add row" }).click();
    await rows.nth(i).getByLabel("Invoice ID").fill(`${prefix}-LATER-${i}`);
    await rows.nth(i).getByLabel("Total QAR").fill("1.00");
  }
  await page.getByRole("button", { name: "Review batch" }).click();
  await page.getByRole("button", { name: "Save batch" }).click();
  await expect(page.getByRole("status")).toContainText("Batch saved");
  await page.reload();
  await expect(page.getByLabel("Recent invoices").getByText(`${prefix}-FIRST`)).toHaveCount(0);

  await rows.nth(0).getByLabel("Invoice ID").fill(`${prefix}-FIRST`);
  await rows.nth(0).getByLabel("Total QAR").fill("10.00");
  await page.getByRole("button", { name: "Review batch" }).click();
  await page.getByRole("button", { name: "Save batch" }).click();
  await expect(rows.nth(0)).toContainText("Invoice ID already exists in this shop.");
  await expect(page.getByRole("alert").filter({ hasText: "Fix the marked rows before saving." })).toBeVisible();
});

test("recent invoices show approved invoice and payment corrections", async ({ page }) => {
  const invoiceNumber = `UI-CORRECTED-${Date.now()}`;
  await page.goto("/login");
  await page.getByLabel(/email/i).fill("staff1@shopkhata.local");
  await page.getByLabel(/password/i).fill("ShopKhata-Local-E2E-Only-2026!");
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  const row = page.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(invoiceNumber);
  await row.getByLabel("Total QAR").fill("100.00");
  await row.getByLabel("Received QAR").fill("20.00");
  await row.getByLabel("Delivered").check();
  await row.getByLabel("New customer name").fill("Corrected customer");
  await page.getByRole("button", { name: "Review batch" }).click();
  await page.getByRole("button", { name: "Save batch" }).click();
  await expect(page.getByRole("status")).toContainText("Batch saved");

  const shopId = "10000000-0000-4000-8000-000000000001";
  const ownerId = "10000000-0000-4000-8000-000000000101";
  localDbQuery(`
    insert into public.corrections (shop_id, invoice_id, amount_delta_dirham, reason, business_date, approved_by)
    select '${shopId}', i.id, -5000, 'Approved invoice adjustment', i.business_date, '${ownerId}'
    from public.invoices i where i.shop_id = '${shopId}' and i.invoice_id = '${invoiceNumber}'
  `);
  localDbQuery(`
    insert into public.corrections (shop_id, payment_id, amount_delta_dirham, reason, business_date, approved_by)
    select '${shopId}', p.id, 3000, 'Approved payment adjustment', i.business_date, '${ownerId}'
    from public.invoices i join public.payments p on p.invoice_id = i.id
    where i.shop_id = '${shopId}' and i.invoice_id = '${invoiceNumber}'
  `);

  await page.reload();
  const saved = page.getByLabel("Recent invoices").locator("div", { hasText: invoiceNumber }).filter({ hasText: invoiceNumber }).last();
  await expect(saved).toContainText("QAR 50.00");
  await expect(saved).toContainText("Due QAR 0.00");
  await expect(saved).toContainText("Delivered · paid");
});

test.describe("Qatar operating date in a different browser timezone", () => {
test.use({ timezoneId: "Pacific/Honolulu" });
test("an open Shop 1 workspace advances its displayed Qatar date at midnight", async ({ page }) => {
  const today = qatarBusinessDate(new Date());
  await page.clock.install({ time: new Date(Date.parse(`${today}T00:00:00.000Z`) - 3 * 60 * 60 * 1000 - 60_000) });
  await page.goto("/login");
  await page.getByLabel(/email/i).fill("staff1@shopkhata.local");
  await page.getByLabel(/password/i).fill("ShopKhata-Local-E2E-Only-2026!");
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page.getByRole("heading", { name: "Shop 1" })).toBeVisible();
  await page.clock.fastForward(120_000);
  await expect(page.locator("header")).toContainText(today);
  const invoiceNumber = `DATE-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel("Invoice ID").fill(invoiceNumber);
  await page.getByLabel("Total QAR").fill("12.00");
  await page.getByRole("button", { name: "Review batch" }).click();
  await page.getByRole("button", { name: "Save batch" }).click();
  await expect(page.getByRole("status")).toContainText("Batch saved");
  await expect(page.getByLabel("Recent invoices")).toContainText(invoiceNumber);
  await expect(page.getByLabel("Recent invoices")).toContainText(today);
});

test("a lost save response keeps the original date and retry key across midnight", async ({ page }) => {
  const today = qatarBusinessDate(new Date());
  const firstTime = new Date(Date.parse(`${today}T00:00:00.000Z`) + 21 * 60 * 60 * 1000 - 60_000);
  await page.clock.install({ time: firstTime });
  await page.goto("/login");
  await page.getByLabel(/email/i).fill("staff1@shopkhata.local");
  await page.getByLabel(/password/i).fill("ShopKhata-Local-E2E-Only-2026!");
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page.getByRole("heading", { name: "Shop 1" })).toBeVisible();

  const invoiceNumber = `RETRY-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel("Invoice ID").fill(invoiceNumber);
  await page.getByLabel("Total QAR").fill("12.00");
  await page.getByRole("button", { name: "Review batch" }).click();
  let dropped = false;
  await page.route("**/*", async (route) => {
    if (!dropped && route.request().method() === "POST" && route.request().headers()["next-action"]) {
      dropped = true;
      await route.fetch();
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await page.getByRole("button", { name: "Save batch" }).click();
  await expect(page.getByText("Batch was not saved. Try again with the same draft.")).toBeVisible();
  expect(dropped).toBe(true);

  await page.clock.fastForward(120_000);
  await expect(page.locator("header")).toContainText(today);
  await page.getByRole("button", { name: "Save batch" }).click();
  await expect(page.getByRole("status")).toContainText("Batch saved");
  await expect(page.getByLabel("Recent invoices")).toContainText(invoiceNumber);
});
});
