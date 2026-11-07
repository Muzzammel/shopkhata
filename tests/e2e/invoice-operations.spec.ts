import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";
import readXlsxFile from "read-excel-file/universal";
import { openSaleTools } from "./offline-helpers";

const SHOP1 = "10000000-0000-4000-8000-000000000001";
const SHOP2 = "10000000-0000-4000-8000-000000000002";
function sql(query: string) {
  return execFileSync(process.execPath, [join(process.cwd(), "node_modules/supabase/dist/supabase.js"), "--agent", "no", "db", "query", "--local", query], { encoding: "utf8", timeout: 30000 });
}
async function login(page: Page, role = "staff1") {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(`${role}@shopkhata.local`);
  await page.getByLabel(/password/i).fill(role === "owner" ? "ShopKhata-Local-Owner-E2E-Only-2026!" : role === "manager" ? "ShopKhata-Local-Manager-E2E-Only-2026!" : "ShopKhata-Local-E2E-Only-2026!");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: "Shop 1", exact: true })).toBeVisible();
}
async function create(page: Page, number: string) {
  const row = page.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(number);
  await row.getByLabel("Total QAR").fill("100.00");
  await page.getByRole("button", { name: "Review sale" }).click();
  await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await expect(page.getByRole("status").filter({ hasText: /Sale saved|\d+ invoices saved/ })).toBeVisible();
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
  await page.getByRole("button", { name: "Record payment" }).click();
  const payment = page.getByRole("dialog", { name: "Record payment" });
  await payment.getByLabel("Payment amount (QAR)").fill("20.00");
  await payment.getByRole("button", { name: "Review payment", exact: true }).click();
  await payment.getByRole("button", { name: "Confirm payment" }).click();
  await expect(totals(page).getByText("QAR 80.00", { exact: true })).toBeVisible();
  await expect(payment.getByRole("status")).toContainText("Payment recorded");
  await page.keyboard.press("Escape");
  await expect(payment).toHaveCount(0);
  await page.getByRole("button", { name: "Request correction", exact: true }).click();
  const financial = page.getByRole("form", { name: "Correction request" });
  // The corrected total is entered, not the amount to take off: 100.00 becomes 90.00.
  await financial.getByLabel("Corrected invoice total (QAR)").fill("90.00");
  await financial.getByLabel("Request reason").fill("Total entered ten QAR too high");
  await financial.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText("Correction — Pending approval", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);

  const context = await browser.newContext(); const owner = await context.newPage();
  await login(owner, "owner"); await owner.goto(canonicalUrl);
  await owner.getByRole("button", { name: "Approve" }).click();
  await expect(totals(owner).getByText("QAR 90.00", { exact: true })).toBeVisible();
  await expect(totals(owner).getByText("QAR 70.00", { exact: true })).toBeVisible();
  await owner.reload();
  await expect(totals(owner).getByText("QAR 90.00", { exact: true })).toBeVisible();
  await expect(totals(owner).getByText("QAR 70.00", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Request replacement" }).click();
  const replacement = page.getByRole("form", { name: "Replacement request" });
  await replacement.getByLabel("Replacement invoice number").fill(newNumber);
  await replacement.getByLabel("Customer search", { exact: true }).fill(customerName);
  await page.getByRole("option", { name: new RegExp(customerName) }).click();
  await replacement.getByLabel("Replacement delivered").check();
  await replacement.getByLabel("Request reason").fill("Correct number, customer and delivery");
  await replacement.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText("Replacement — Pending approval", { exact: true })).toBeVisible();
  await owner.reload(); await owner.getByRole("button", { name: "Approve" }).click();
  await expect(totals(owner).getByRole("heading", { name: newNumber, exact: true })).toBeVisible();
  await expect(totals(owner)).toContainText(customerName);
  await expect(totals(owner)).toContainText(oldNumber);
  await expect(totals(owner)).toContainText("Delivered");
  await expect(owner.getByRole("region", { name: "History" })).toContainText("Version 1");
  await owner.getByRole("button", { name: "Record payment" }).click();
  await expect(owner.getByRole("dialog", { name: "Record payment" })).toContainText(newNumber);
  await owner.keyboard.press("Escape");

  await page.goto("/");
  for (const number of [oldNumber, newNumber]) {
    const row = page.locator("[data-entry-row]").first();
    await row.getByLabel("Invoice ID").fill(number);
    await row.getByLabel("Total QAR").fill("100.00");
    await expect(row).toContainText("Outstanding due QAR 70.00");
    if (number === oldNumber) await expect(row).toContainText(`Current effective invoice number: ${newNumber}`);
    await expect(row.getByRole("link", { name: "Record payment", exact: true })).toHaveAttribute("href", `/shops/${SHOP1}/invoices/${invoiceId}#record-payment`);
    await page.getByRole("button", { name: "Review sale" }).click();
    await expect(page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ })).toHaveCount(0);

  }
  await page.locator("[data-entry-row]").first().getByRole("link", { name: "Record payment", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(invoiceId));
  // #record-payment opens the payment drawer straight away.
  await expect(page.getByRole("dialog", { name: "Record payment" })).toContainText(newNumber);
  await page.keyboard.press("Escape");
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

test("a financial correction replaces the invoice total: 1000 becomes 1500, not 2500", async ({ page, browser }) => {
  test.setTimeout(120000);
  const number = `TARGET-${crypto.randomUUID()}`;
  await login(page);
  const row = page.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(number);
  await row.getByLabel("Total QAR").fill("1000.00");
  await row.getByLabel("Received QAR").fill("400.00");
  await page.getByRole("button", { name: "Review sale" }).click();
  await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await expect(page.getByRole("status").filter({ hasText: /Sale saved|\d+ invoices saved/ })).toBeVisible();
  await page.getByRole("link", { name: `View invoice ${number}`, exact: true }).click();
  await expect(totals(page)).toContainText("Invoice totalQAR 1,000.00");
  const canonicalUrl = page.url();

  await page.getByRole("button", { name: "Request correction", exact: true }).click();
  const form = page.getByRole("form", { name: "Correction request" });
  const field = form.getByLabel("Corrected invoice total (QAR)");
  const summary = form.getByLabel("Correction summary");

  // A total below what is already paid is refused on the field, before anything is sent.
  await field.fill("399.99");
  await form.getByLabel("Request reason").fill("Total was entered wrong");
  await form.getByRole("button", { name: "Submit request" }).click();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(form.locator("#correction-total-error")).toContainText("cannot be less than the QAR 400.00 already paid");
  await expect(page.getByText("Correction — Pending approval", { exact: true })).toHaveCount(0);

  await field.fill("1500.00");
  await expect(field).not.toHaveAttribute("aria-invalid", "true");
  await expect(summary).toContainText("Current invoice totalQAR 1,000.00");
  await expect(summary).toContainText("Corrected invoice totalQAR 1,500.00");
  await expect(summary).toContainText("Calculated difference+QAR 500.00");
  await expect(summary).toContainText("Current paymentsQAR 400.00");
  await expect(summary).toContainText("Resulting due after correctionQAR 1,100.00");
  await form.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText("Operation confirmed and saved.")).toBeVisible();   // toast
  await expect(page.getByText("Correction — Pending approval", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Awaiting approval" })).toContainText("Invoice total: QAR 1,000.00 → QAR 1,500.00 (+QAR 500.00)");

  const context = await browser.newContext(); const owner = await context.newPage();
  await login(owner, "owner"); await owner.goto(canonicalUrl);
  await owner.getByRole("button", { name: "Approve" }).click();
  await expect(totals(owner).getByText("QAR 1,500.00", { exact: true })).toBeVisible();
  await expect(totals(owner).getByText("QAR 1,100.00", { exact: true })).toBeVisible();
  await owner.reload();
  await expect(totals(owner).getByText("QAR 1,500.00", { exact: true })).toBeVisible();
  await expect(totals(owner)).not.toContainText("2500.00");
  await expect(totals(owner)).not.toContainText("2,500.00");
  // The original stays on record beside the effective total.
  await expect(totals(owner)).toContainText("Original totalQAR 1,000.00");
  expect(sql(`select total_amount_dirham from public.invoices where invoice_id = '${number}'`)).toContain("100000");
  await context.close();
});

test("uncertain detail payment retains exact command and allows retry without duplicate money", async ({ page }) => {
  test.setTimeout(90000);
  const number = `UNCERTAIN-DETAIL-${crypto.randomUUID()}`;
  await login(page); await create(page, number);
  await page.getByRole("link", { name: `View invoice ${number}` }).click();
  await page.getByRole("button", { name: "Record payment" }).click();
  const payment = page.getByRole("dialog", { name: "Record payment" });
  await payment.getByLabel("Payment amount (QAR)").fill("20.00");
  await payment.getByRole("button", { name: "Review payment", exact: true }).click();
  let dropped = false;
  await page.route("**/*", async (route) => {
    if (!dropped && route.request().method() === "POST" && route.request().headers()["next-action"]) {
      dropped = true; await route.fetch(); await route.abort("failed");
    } else await route.continue();
  });
  await payment.getByRole("button", { name: "Confirm payment" }).click();
  await expect(payment.getByRole("button", { name: "Retry payment" })).toBeEnabled();
  // The outcome is unknown, so the drawer refuses to close and lose the exact command.
  await page.keyboard.press("Escape");
  await expect(payment).toBeVisible();
  await payment.getByRole("button", { name: "Retry payment" }).click();
  await expect(totals(page).getByText("QAR 80.00", { exact: true })).toBeVisible();
  await expect(payment.getByRole("status")).toContainText("Payment recorded");
  await page.keyboard.press("Escape");
  await expect(payment).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Payments received" }).getByText("QAR 20.00", { exact: true })).toHaveCount(1);
});

test("fully paid duplicates offer canonical View invoice and block new creation", async ({ page }) => {
  const number = `FULLY-PAID-${crypto.randomUUID()}`;
  await login(page);
  const row = page.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(number);
  await row.getByLabel("Total QAR").fill("10.00");
  await row.getByLabel("Received QAR").fill("10.00");
  await page.getByRole("button", { name: "Review sale" }).click();
  await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await expect(page.getByRole("status").filter({ hasText: /Sale saved|\d+ invoices saved/ })).toBeVisible();
  await row.getByLabel("Invoice ID").fill(number);
  await row.getByLabel("Total QAR").fill("10.00");
  await expect(row).toContainText("Invoice already exists / fully paid.");
  await page.getByRole("button", { name: "Review sale" }).click();
  await expect(page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ })).toHaveCount(0);
  await row.getByRole("link", { name: "View invoice", exact: true }).click();
  await expect(totals(page).getByRole("heading", { name: number, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record payment" })).toHaveCount(0);
});

test("OPS-01B: a manager voids an unpaid invoice; staff cannot; the original stays visible as VOID at 0 in detail, list and export", async ({ page, browser }) => {
  test.setTimeout(180000);
  const number = `VOID-E2E-${crypto.randomUUID()}`;
  await login(page);
  await create(page, number);
  await page.getByRole("link", { name: `View invoice ${number}`, exact: true }).click();
  await expect(page).toHaveURL(/\/shops\/[^/]+\/invoices\/[0-9a-f-]+$/);
  const canonicalUrl = page.url();
  // Staff: no void action.
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Print" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Void invoice" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  const context = await browser.newContext(); const manager = await context.newPage();
  await login(manager, "manager"); await manager.goto(canonicalUrl);
  await manager.getByRole("button", { name: "More actions" }).click();
  await manager.getByRole("menuitem", { name: "Void invoice" }).click();
  const dialog = manager.getByRole("dialog", { name: `Void invoice ${number}` });
  const facts = dialog.getByLabel("Invoice to void");
  await expect(facts).toContainText(number);
  await expect(facts).toContainText("Original total");
  await expect(facts).toContainText("QAR 100.00");
  await expect(facts).toContainText("Effective total after void");
  await expect(dialog).toContainText("The original invoice is preserved unchanged");
  await dialog.getByRole("button", { name: "Confirm Void" }).click();
  await expect(dialog.getByText("Enter the reason for voiding this invoice.")).toBeVisible();
  await dialog.getByLabel(/Reason for voiding/).fill("too short");
  await dialog.getByRole("button", { name: "Confirm Void" }).click();
  await expect(dialog.getByText(/at least 10 characters/).last()).toBeVisible();
  await dialog.getByLabel(/Reason for voiding/).fill("Customer cancelled before delivery");
  await dialog.getByRole("button", { name: "Confirm Void" }).click();
  await expect(dialog).toHaveCount(0);

  // Detail: same invoice, VOID badge and banner, effective total 0, original kept.
  const doc = totals(manager);
  await expect(doc.getByRole("heading", { name: number, exact: true })).toBeVisible();
  await expect(doc.locator("[data-badge=void]")).toHaveText("Void");
  await expect(doc.locator("[data-slot=void-banner]")).toContainText("Customer cancelled before delivery");
  await expect(doc.getByRole("group", { name: "Financial summary" })).toContainText("Recorded as QAR 100.00");
  await expect(doc.getByRole("group", { name: "Financial summary" }).locator("strong").first()).toHaveText("QAR 0.00");
  await manager.reload();
  await manager.getByRole("button", { name: "More actions" }).click();
  await expect(manager.getByRole("menuitem", { name: "Print" })).toBeVisible();
  await expect(manager.getByRole("menuitem", { name: "Void invoice" })).toHaveCount(0);
  await manager.keyboard.press("Escape");

  // Staff sees it too, still visible in the Sales list with the VOID badge.
  await page.goto(`/invoices?shop=${SHOP1}`);
  const listed = page.locator("tr", { has: page.getByRole("link", { name: `View invoice ${number}`, exact: true }) });
  await expect(listed.locator("[data-badge=void]")).toHaveText("Void");
  await expect(listed).toContainText("QAR 0.00");

  // Export keeps the row: Current Total 0, Status VOID, and the Original Total still 100.00 (never silently 0).
  const response = await manager.request.get(`/exports/invoices?shop=${SHOP1}`);
  expect(response.status()).toBe(200);
  const [sheet] = await readXlsxFile(new Blob([new Uint8Array(await response.body())]));
  expect(sheet.data[0].slice(-2)).toEqual(["Status", "Original Total QAR"]);
  expect(sheet.data[0][2]).toBe("Current Total QAR");
  const exported = sheet.data.find((cells) => cells[0] === number);
  expect(exported?.slice(-2)).toEqual(["VOID", 100]);
  expect(exported?.[2]).toBe(0);

  // m1: New Sale's recent-invoice preview shows VOID, never Paid, for the voided invoice (due 0).
  await page.goto("/");
  await openSaleTools(page);
  const preview = page.locator("#recent-invoices li").filter({ has: page.getByRole("link", { name: `View invoice ${number}`, exact: true }) });
  await expect(preview.locator("[data-badge=void]")).toHaveText("Void");
  await expect(preview.locator("[data-badge=paid]")).toHaveCount(0);
  await context.close();
});
