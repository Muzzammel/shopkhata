import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

const SHOP1 = "10000000-0000-4000-8000-000000000001";
const SHOP2 = "10000000-0000-4000-8000-000000000002";
function sql(query: string) {
  return execFileSync(process.execPath, [join(process.cwd(), "node_modules/supabase/dist/supabase.js"), "--agent", "no", "db", "query", "--local", query], { encoding: "utf8", timeout: 30000 });
}
async function login(page: Page, role = "staff1") {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(`${role}@shopkhata.local`);
  await page.getByLabel(/password/i).fill(role === "owner" ? "ShopKhata-Local-Owner-E2E-Only-2026!" : "ShopKhata-Local-E2E-Only-2026!");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: "Shop 1", exact: true })).toBeVisible();
}
async function create(page: Page, number: string) {
  const row = page.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(number);
  await row.getByLabel("Total QAR").fill("100.00");
  await page.getByRole("button", { name: "Review batch" }).click();
  await page.getByRole("button", { name: "Save batch" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Batch saved" })).toBeVisible();
}
function totals(page: Page) { return page.locator('section[aria-labelledby="invoice-heading"]'); }

test("complete staff invoice lifecycle with separate owner approvals, canonical history and isolation", async ({ page, browser }) => {
  test.setTimeout(180000);
  const suffix = crypto.randomUUID(); const oldNumber = `LIFECYCLE-${suffix}`; const newNumber = `REPLACED-${suffix}`;
  const customerId = crypto.randomUUID(); const customerName = `Replacement customer ${suffix}`;
  sql(`insert into public.customers(id,shop_id,public_id,name) values('${customerId}','${SHOP1}','CUS-${suffix}','${customerName}')`);
  await login(page);
  await create(page, oldNumber);
  await page.getByRole("link", { name: `View invoice ${oldNumber}`, exact: true }).click();
  await expect(page).toHaveURL(/\/shops\/[^/]+\/invoices\/[0-9a-f-]+$/);
  const canonicalUrl = page.url(); const invoiceId = canonicalUrl.split("/").at(-1)!;
  await expect(totals(page)).toContainText("QAR 100.00");
  const payment = page.getByRole("region", { name: "Record Payment", exact: true });
  await payment.getByLabel("Cash amount (QAR)").fill("20.00");
  await payment.getByRole("button", { name: "Review payment", exact: true }).click();
  await payment.getByRole("button", { name: "Confirm payment" }).click();
  await expect(totals(page).getByText("QAR 80.00", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Request financial correction", exact: true }).click();
  const financial = page.getByRole("form", { name: "Financial correction request" });
  await financial.getByLabel("Adjustment amount (QAR)").fill("10.00");
  await financial.getByLabel("Request reason").fill("Total entered ten QAR too high");
  await financial.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText("Financial correction — Pending approval", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save decision" })).toHaveCount(0);

  const context = await browser.newContext(); const owner = await context.newPage();
  await login(owner, "owner"); await owner.goto(canonicalUrl);
  await owner.getByRole("button", { name: "Save decision" }).click();
  await expect(totals(owner).getByText("QAR 90.00", { exact: true })).toBeVisible();
  await expect(totals(owner).getByText("QAR 70.00", { exact: true })).toBeVisible();
  await owner.reload();
  await expect(totals(owner).getByText("QAR 90.00", { exact: true })).toBeVisible();
  await expect(totals(owner).getByText("QAR 70.00", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Request non-financial replacement" }).click();
  const replacement = page.getByRole("form", { name: "Replacement request" });
  await replacement.getByLabel("Replacement invoice number").fill(newNumber);
  await replacement.getByLabel("Customer search", { exact: true }).fill(customerName);
  await page.getByRole("option", { name: new RegExp(customerName) }).click();
  await replacement.getByLabel("Replacement delivered").check();
  await replacement.getByLabel("Request reason").fill("Correct number, customer and delivery");
  await replacement.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText("Non-financial replacement — Pending approval", { exact: true })).toBeVisible();
  await owner.reload(); await owner.getByRole("button", { name: "Save decision" }).click();
  await expect(totals(owner).getByRole("heading", { name: newNumber, exact: true })).toBeVisible();
  await expect(totals(owner)).toContainText(customerName);
  await expect(totals(owner)).toContainText(oldNumber);
  await expect(totals(owner)).toContainText("Delivered");
  await expect(owner.getByRole("region", { name: "Requests and version history" })).toContainText("version 1");
  await expect(owner.getByRole("region", { name: "Record Payment", exact: true })).toContainText(newNumber);

  await page.goto("/");
  for (const number of [oldNumber, newNumber]) {
    const row = page.locator("[data-entry-row]").first();
    await row.getByLabel("Invoice ID").fill(number);
    await row.getByLabel("Total QAR").fill("100.00");
    await expect(row).toContainText("Outstanding due QAR 70.00");
    if (number === oldNumber) await expect(row).toContainText(`Current effective invoice number: ${newNumber}`);
    await expect(row.getByRole("link", { name: "Record payment", exact: true })).toHaveAttribute("href", `/shops/${SHOP1}/invoices/${invoiceId}#record-payment`);
    await page.getByRole("button", { name: "Review batch" }).click();
    await expect(page.getByRole("button", { name: "Save batch" })).toHaveCount(0);

  }
  await page.locator("[data-entry-row]").first().getByRole("link", { name: "Record payment", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(invoiceId));
  await expect(totals(page).getByRole("heading", { name: newNumber, exact: true })).toBeVisible();

  await owner.goto(`/?shop=${SHOP2}`);
  await expect(owner.getByRole("heading", { name: "Shop 2", exact: true })).toBeVisible();
  await create(owner, newNumber);
  await owner.getByRole("link", { name: `View invoice ${newNumber}`, exact: true }).click();
  await expect(owner).toHaveURL(new RegExp(`/shops/${SHOP2}/invoices/[0-9a-f-]+$`));
  const shop2Url = owner.url(); const shop2Id = shop2Url.split("/").at(-1)!;
  await page.goto(shop2Url);
  await expect(page.getByRole("heading", { name: "Invoice not found" })).toBeVisible();

  const envText = execFileSync(process.execPath, [join(process.cwd(), "node_modules/supabase/dist/supabase.js"), "--agent", "no", "status", "-o", "env"], { encoding: "utf8" });
  const env = Object.fromEntries(envText.split(/\r?\n/).map((s) => s.match(/^([A-Z_]+)="?(.*?)"?$/)).filter((m) => m !== null).map((m) => [m[1], m[2]]));
  const staff = createClient(env.API_URL, env.PUBLISHABLE_KEY ?? env.ANON_KEY);
  expect((await staff.auth.signInWithPassword({ email: "staff1@shopkhata.local", password: "ShopKhata-Local-E2E-Only-2026!" })).error).toBeNull();
  const requests = await staff.from("replacement_requests").select("id").eq("invoice_id", invoiceId);
  expect((await staff.rpc("decide_invoice_replacement", { command: { shop_id: SHOP1, request_id: requests.data![0].id, expected_revision: 1, decision: "approved", reason: null, idempotency_key: crypto.randomUUID() } })).error?.message).toBe("INSUFFICIENT_ROLE");
  expect((await staff.rpc("request_invoice_replacement", { command: { shop_id: SHOP2, invoice_id: shop2Id, expected_revision: 0, invoice_number: "HACK", customer_id: null, delivered: false, reason: "hack", idempotency_key: crypto.randomUUID() } })).error?.message).toBe("UNAUTHORIZED_SHOP");
  expect((await staff.from("effective_invoices").select("*").eq("shop_id", SHOP2)).data).toEqual([]);
  await context.close();
});

test("uncertain detail payment retains exact command and allows retry without duplicate money", async ({ page }) => {
  test.setTimeout(90000);
  const number = `UNCERTAIN-DETAIL-${crypto.randomUUID()}`;
  await login(page); await create(page, number);
  await page.getByRole("link", { name: `View invoice ${number}` }).click();
  const payment = page.getByRole("region", { name: "Record Payment", exact: true });
  await payment.getByLabel("Cash amount (QAR)").fill("20.00");
  await payment.getByRole("button", { name: "Review payment", exact: true }).click();
  let dropped = false;
  await page.route("**/*", async (route) => {
    if (!dropped && route.request().method() === "POST" && route.request().headers()["next-action"]) {
      dropped = true; await route.fetch(); await route.abort("failed");
    } else await route.continue();
  });
  await payment.getByRole("button", { name: "Confirm payment" }).click();
  await expect(payment.getByRole("button", { name: "Retry payment" })).toBeEnabled();
  await payment.getByRole("button", { name: "Retry payment" }).click();
  await expect(totals(page).getByText("QAR 80.00", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Payment history" }).getByText(/QAR 20.00/)).toHaveCount(1);
});

test("fully paid duplicates offer canonical View invoice and block new creation", async ({ page }) => {
  const number = `FULLY-PAID-${crypto.randomUUID()}`;
  await login(page);
  const row = page.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(number);
  await row.getByLabel("Total QAR").fill("10.00");
  await row.getByLabel("Received QAR").fill("10.00");
  await page.getByRole("button", { name: "Review batch" }).click();
  await page.getByRole("button", { name: "Save batch" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Batch saved" })).toBeVisible();
  await row.getByLabel("Invoice ID").fill(number);
  await row.getByLabel("Total QAR").fill("10.00");
  await expect(row).toContainText("Invoice already exists / fully paid.");
  await page.getByRole("button", { name: "Review batch" }).click();
  await expect(page.getByRole("button", { name: "Save batch" })).toHaveCount(0);
  await row.getByRole("link", { name: "View invoice", exact: true }).click();
  await expect(totals(page).getByRole("heading", { name: number, exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Record Payment", exact: true })).toHaveCount(0);
});
