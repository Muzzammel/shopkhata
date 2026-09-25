import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { qatarBusinessDate } from "@/lib/invoice-entry";

// These tests write to the same seeded shop; the 30-invoice batch can displace
// another test's invoice from the recent preview when they run concurrently.
test.describe.configure({ mode: "default" });

function seedCustomers(shopId: string, customers: { id: string; publicId: string; name: string; mobile: string }[]) {
  const values = customers.map(({ id, publicId, name, mobile }) =>
    `('${id}', '${shopId}', '${publicId}', '${name.replaceAll("'", "''")}', '${mobile}')`).join(",\n");
  localDbQuery(`insert into public.customers (id, shop_id, public_id, name, mobile) values ${values}`);
}

function localDbQuery(sql: string) {
  return execFileSync(process.execPath, [
    join(process.cwd(), "node_modules", "supabase", "dist", "supabase.js"),
    "--agent", "no", "db", "query", "--local", sql,
  ], { encoding: "utf8", timeout: 30_000 });
}

async function loginStaff(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill("staff1@shopkhata.local");
  await page.getByLabel(/password/i).fill("ShopKhata-Local-E2E-Only-2026!");
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page.getByRole("heading", { name: "Shop 1" })).toBeVisible();
}

async function createDueInvoice(page: Page, invoiceNumber: string, total: string, received = "0.00") {
  const row = page.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(invoiceNumber);
  await row.getByLabel("Total QAR").fill(total);
  if (received !== "0.00") await row.getByLabel("Received QAR").fill(received);
  await page.getByRole("button", { name: "Review batch" }).click();
  await page.getByRole("button", { name: "Save batch" }).click();
  await expect(page.locator('p[role="status"]').filter({ hasText: "Batch saved" })).toBeVisible();
}

async function findInvoiceForPayment(page: Page, invoiceNumber: string) {
  const payment = page.getByRole("region", { name: "Record Payment" });
  await payment.getByLabel("Invoice number").fill(invoiceNumber);
  await payment.getByRole("button", { name: "Find invoice" }).click();
  await expect(payment.getByRole("heading", { name: invoiceNumber })).toBeVisible();
  return payment;
}

test("searches beyond 200 customers and keeps a selected customer on a delivered invoice with due", async ({ page }) => {
  const suffix = Date.now();
  const shopId = "10000000-0000-4000-8000-000000000001";
  const target = { name: `ZZZ Beyond 200 ${suffix}`, mobile: `799${String(suffix).slice(-6)}` };
  const publicId = `CUS-BEYOND-${suffix}`;
  const expectedFirstTwoPages = Array.from({ length: 204 }, (_, index) => index + 1)
    .map((number) => ({ name: `List customer ${suffix} ${number}`, publicId: `CUS-LIST-${suffix}-${number}` }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : left.publicId < right.publicId ? -1 : 1)
    .slice(0, 40);
  localDbQuery(`insert into public.customers (shop_id, public_id, name, mobile)
    select '${shopId}', case when i = 205 then '${publicId}' else 'CUS-LIST-${suffix}-' || i end,
      case when i = 205 then '${target.name}' else 'List customer ${suffix} ' || i end,
      case when i = 205 then '${target.mobile}' else '700${String(suffix).slice(-5)}' || lpad(i::text, 3, '0') end
    from generate_series(1, 205) i`);

  await loginStaff(page);
  const row = page.locator("[data-entry-row]").first();
  const search = row.getByLabel("Customer search", { exact: true });
  await search.fill(`List customer ${suffix}`);
  const customerOptions = page.getByRole("option");
  await expect(customerOptions).toHaveCount(20);
  await page.getByRole("button", { name: "Show more results" }).click();
  await expect(customerOptions).toHaveCount(40);
  const customerOptionTexts = await customerOptions.allInnerTexts();
  const returnedPublicIds = customerOptionTexts.map((text) => text.match(new RegExp(`CUS-LIST-${suffix}-\\d+`))?.[0]);
  expect(returnedPublicIds).toEqual(expectedFirstTwoPages.map((customer) => customer.publicId));
  expect(new Set(returnedPublicIds).size).toBe(40);
  await expect(customerOptions.nth(20)).toContainText(expectedFirstTwoPages[20].publicId);

  await search.fill(target.name);
  const option = page.getByRole("option", { name: new RegExp(target.name) });
  await expect(option).toBeVisible();
  await expect(option).toContainText(target.mobile);
  await option.click();
  await row.getByLabel("Invoice ID").fill(`CUSTOMER-DUE-${suffix}`);
  await row.getByLabel("Total QAR").fill("42.00");
  await row.getByLabel("Received QAR").fill("12.00");
  await row.getByLabel("Delivered").check();
  await expect(row.getByText(new RegExp(target.name))).toBeVisible();
  await page.getByRole("button", { name: "Review batch" }).click();
  await expect(page.getByLabel("New invoice batch").getByText("Due QAR 30.00", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Save batch" }).click();
  await expect(page.locator('p[role="status"]').filter({ hasText: "Batch saved" })).toBeVisible();
  const persisted = localDbQuery(`select (i.customer_id = c.id and b.effective_due_dirham = 3000) as linked_due
    from public.invoices i join public.customers c on c.id = i.customer_id
    join public.invoice_effective_balances b on b.canonical_invoice_id = i.id
    where i.invoice_id = 'CUSTOMER-DUE-${suffix}' and c.public_id = '${publicId}'`);
  expect(persisted).toContain("true");
});

test("distinguishes duplicate customer names by mobile and public ID", async ({ page }) => {
  const suffix = Date.now();
  seedCustomers("10000000-0000-4000-8000-000000000001", [
    { id: crypto.randomUUID(), publicId: `CUS-DUP-A-${suffix}`, name: `Same customer ${suffix}`, mobile: `711${suffix}` },
    { id: crypto.randomUUID(), publicId: `CUS-DUP-B-${suffix}`, name: `Same customer ${suffix}`, mobile: `722${suffix}` },
  ]);
  await loginStaff(page);
  const search = page.getByLabel("Customer search", { exact: true });
  await search.fill(`Same customer ${suffix}`);
  const options = page.getByRole("option").filter({ hasText: `Same customer ${suffix}` });
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText(`CUS-DUP-A-${suffix}`);
  await expect(options.nth(1)).toContainText(`CUS-DUP-B-${suffix}`);
  await search.fill(`CUS-DUP-B-${suffix}`);
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option")).toContainText(`722${suffix}`);
  await search.fill(`722${suffix}`);
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option")).toContainText(`CUS-DUP-B-${suffix}`);
  await search.fill(`No such customer ${suffix}`);
  await expect(page.locator('[id^="customer-search-status-"]').filter({ hasText: "No customers found." })).toBeVisible();
});

test("rapid customer searches ignore an older response that arrives last", async ({ page }) => {
  const suffix = Date.now();
  seedCustomers("10000000-0000-4000-8000-000000000001", [
    { id: crypto.randomUUID(), publicId: `CUS-SLOW-${suffix}`, name: `Slow customer ${suffix}`, mobile: `733${suffix}` },
    { id: crypto.randomUUID(), publicId: `CUS-FAST-${suffix}`, name: `Fast customer ${suffix}`, mobile: `744${suffix}` },
  ]);
  await loginStaff(page);
  let release!: () => void;
  let reached!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const firstReached = new Promise<void>((resolve) => { reached = resolve; });
  let held = false;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (!held && request.method() === "POST" && request.headers()["next-action"]) {
      held = true;
      const response = await route.fetch();
      reached();
      await delayed;
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  const search = page.getByLabel("Customer search");
  await search.fill(`Slow customer ${suffix}`);
  await firstReached;
  await search.fill(`Fast customer ${suffix}`);
  await expect(search).toHaveValue(`Fast customer ${suffix}`);
  await expect(page.locator('[id^="customer-search-status-"]').first()).toContainText("Searching customers...");
  release();
  await expect(page.getByRole("option")).toContainText(`Fast customer ${suffix}`);
  await expect(page.getByRole("option")).not.toContainText(`Slow customer ${suffix}`);
});

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
  await expect(page.locator('p[role="status"]').filter({ hasText: "Batch saved" })).toBeVisible();
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
  await expect(page.locator('p[role="status"]').filter({ hasText: "Batch saved" })).toBeVisible();

  for (let i = 0; i < 30; i++) {
    if (i > 0) await page.getByRole("button", { name: "Add row" }).click();
    await rows.nth(i).getByLabel("Invoice ID").fill(`${prefix}-LATER-${i}`);
    await rows.nth(i).getByLabel("Total QAR").fill("1.00");
  }
  await page.getByRole("button", { name: "Review batch" }).click();
  await page.getByRole("button", { name: "Save batch" }).click();
  await expect(page.locator('p[role="status"]').filter({ hasText: "Batch saved" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Recent invoices").getByText(`${prefix}-FIRST`)).toHaveCount(0);

  await rows.nth(0).getByLabel("Invoice ID").fill(`${prefix}-FIRST`);
  await rows.nth(0).getByLabel("Total QAR").fill("10.00");
  await page.getByRole("button", { name: "Review batch" }).click();
  await expect(rows.nth(0)).toContainText("Invoice ID already exists in this shop.");
  await expect(page.getByRole("alert").filter({ hasText: /Fix \d+ row error/ })).toBeVisible();
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
  await expect(page.locator('p[role="status"]').filter({ hasText: "Batch saved" })).toBeVisible();

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

test("records partial and full cash payments and rejects overpayment in review", async ({ page }) => {
  const invoiceNumber = `UI-PAY-${Date.now()}`;
  await loginStaff(page);
  await createDueInvoice(page, invoiceNumber, "50.00");
  const payment = await findInvoiceForPayment(page, invoiceNumber);
  await expect(payment).toContainText("Effective totalQAR 50.00");
  await expect(payment).toContainText("PaidQAR 0.00");
  await expect(payment).toContainText("DueQAR 50.00");

  await payment.getByLabel("Cash amount (QAR)").fill("50.01");
  await payment.getByRole("button", { name: "Review payment" }).click();
  await expect(payment.getByRole("alert")).toContainText("cannot exceed");
  await expect(payment.getByRole("button", { name: "Confirm payment" })).toHaveCount(0);

  await payment.getByLabel("Cash amount (QAR)").fill("20.00");
  await payment.getByRole("button", { name: "Review payment" }).click();
  await expect(payment.getByText("Cash payment of QAR 20.00")).toBeVisible();
  await payment.getByRole("button", { name: "Confirm payment" }).click();
  await expect(payment.getByRole("status")).toContainText("Payment recorded");
  await expect(payment).toContainText("PaidQAR 20.00");
  await expect(payment).toContainText("DueQAR 30.00");

  await payment.getByLabel("Cash amount (QAR)").fill("30.00");
  await payment.getByRole("button", { name: "Review payment" }).click();
  await payment.getByRole("button", { name: "Confirm payment" }).click();
  await expect(payment.getByRole("alert")).toContainText("Already paid — no amount due");
  await expect(payment.getByLabel("Cash amount (QAR)")).toHaveCount(0);
});

test("shows approved corrections in the payment lookup and blocks zero due", async ({ page }) => {
  const invoiceNumber = `UI-PAY-CORRECTED-${Date.now()}`;
  await loginStaff(page);
  await createDueInvoice(page, invoiceNumber, "100.00", "10.00");
  const shopId = "10000000-0000-4000-8000-000000000001";
  const ownerId = "10000000-0000-4000-8000-000000000101";
  localDbQuery(`
    insert into public.corrections (shop_id, invoice_id, amount_delta_dirham, reason, business_date, approved_by)
    select '${shopId}', i.id, -2500, 'Approved payment lookup invoice correction', i.business_date, '${ownerId}'
    from public.invoices i where i.shop_id = '${shopId}' and i.invoice_id = '${invoiceNumber}'
  `);
  localDbQuery(`
    insert into public.corrections (shop_id, payment_id, amount_delta_dirham, reason, business_date, approved_by)
    select '${shopId}', p.id, 500, 'Approved payment lookup payment correction', i.business_date, '${ownerId}'
    from public.invoices i join public.payments p on p.invoice_id = i.id
    where i.shop_id = '${shopId}' and i.invoice_id = '${invoiceNumber}'
  `);

  const payment = await findInvoiceForPayment(page, invoiceNumber);
  await expect(payment).toContainText("Effective totalQAR 75.00");
  await expect(payment).toContainText("PaidQAR 15.00");
  await expect(payment).toContainText("DueQAR 60.00");
  await payment.getByLabel("Cash amount (QAR)").fill("60.00");
  await payment.getByRole("button", { name: "Review payment" }).click();
  await payment.getByRole("button", { name: "Confirm payment" }).click();
  await expect(payment.getByRole("alert")).toContainText("Already paid — no amount due");
});

test("looks up normalized invoice numbers without exposing other shops", async ({ page }) => {
  const invoiceNumber = `INV-42-${Date.now()}`;
  await loginStaff(page);
  await createDueInvoice(page, invoiceNumber, "30.00");
  const payment = page.getByRole("region", { name: "Record Payment" });
  await payment.getByLabel("Invoice number").fill(` ${invoiceNumber.toLowerCase()} `);
  await payment.getByRole("button", { name: "Find invoice" }).click();
  await expect(payment.getByRole("heading", { name: invoiceNumber })).toBeVisible();
  await expect(payment).toContainText("DueQAR 30.00");

  const historicalNumber = `OLD-${invoiceNumber}`;
  localDbQuery(`
    insert into public.invoice_number_registry (shop_id, invoice_number, canonical_invoice_id)
    select shop_id, '${historicalNumber}', id from public.invoices
    where shop_id = '10000000-0000-4000-8000-000000000001' and invoice_id = '${invoiceNumber}';
  `);
  await payment.getByLabel("Invoice number").fill(historicalNumber.toLowerCase());
  await payment.getByRole("button", { name: "Find invoice" }).click();
  await expect(payment.getByRole("heading", { name: invoiceNumber })).toBeVisible();
});

test("hides another shop's invoice and retries the same payment command after a lost response", async ({ page }) => {
  const otherInvoice = `UI-SHOP2-${Date.now()}`;
  const batchId = crypto.randomUUID();
  const invoiceId = crypto.randomUUID();
  const shop2 = "10000000-0000-4000-8000-000000000002";
  const ownerId = "10000000-0000-4000-8000-000000000101";
  localDbQuery(`
    insert into public.batches (id, shop_id, business_date, created_by)
    values ('${batchId}', '${shop2}', (now() at time zone 'Asia/Qatar')::date, '${ownerId}');
  `);
  localDbQuery(`
    insert into public.invoices (id, shop_id, batch_id, invoice_id, invoice_type, quantity, total_amount_dirham, business_date, created_by)
    values ('${invoiceId}', '${shop2}', '${batchId}', '${otherInvoice}', 'advance', 1, 1200,
      (now() at time zone 'Asia/Qatar')::date, '${ownerId}');
  `);
  localDbQuery(`
    insert into public.invoice_number_registry (shop_id, invoice_number, canonical_invoice_id)
    values ('${shop2}', '${otherInvoice}', '${invoiceId}');
  `);
  await loginStaff(page);
  const payment = page.getByRole("region", { name: "Record Payment" });
  await payment.getByLabel("Invoice number").fill(otherInvoice);
  await payment.getByRole("button", { name: "Find invoice" }).click();
  await expect(payment.getByRole("alert")).toContainText("No matching invoice");

  const ownInvoice = `UI-PAY-LOST-${Date.now()}`;
  await createDueInvoice(page, ownInvoice, "30.00");
  await findInvoiceForPayment(page, ownInvoice);
  await payment.getByLabel("Cash amount (QAR)").fill("12.00");
  await payment.getByRole("button", { name: "Review payment" }).click();

  const today = qatarBusinessDate(new Date());
  await page.clock.install({ time: new Date(Date.parse(`${today}T00:00:00.000Z`) + 21 * 60 * 60 * 1000 - 60_000) });
  await expect(payment.getByText(`Business date: ${today} (Qatar)`)).toBeVisible();
  let dropped = false;
  let firstPaymentAction = "";
  let originalCommandPayload: Buffer | null = null;
  let retriedCommandPayload: Buffer | null = null;
  await page.route("**/*", async (route) => {
    if (!dropped && route.request().method() === "POST" && route.request().headers()["next-action"]) {
      dropped = true;
      firstPaymentAction = route.request().headers()["next-action"];
      originalCommandPayload = route.request().postDataBuffer();
      await route.fetch();
      await route.abort("failed");
    } else if (dropped && route.request().method() === "POST"
      && route.request().headers()["next-action"] === firstPaymentAction) {
      retriedCommandPayload = route.request().postDataBuffer();
      await route.continue();
    } else {
      await route.continue();
    }
  });
  await payment.getByRole("button", { name: "Confirm payment" }).click();
  await expect(payment.getByText("Retry the same payment command.")).toBeVisible();
  expect(dropped).toBe(true);

  await payment.getByLabel("Invoice number").fill(ownInvoice);
  await payment.getByRole("button", { name: "Find invoice" }).click();
  await expect(payment.getByText("A payment is still pending. Retry that exact payment before starting another.")).toBeVisible();
  await expect(payment.getByRole("button", { name: "Retry payment" })).toBeVisible();

  await page.clock.fastForward(120_000);
  await payment.getByRole("button", { name: "Retry payment" }).click();
  await expect(payment.getByRole("status")).toContainText("Payment recorded");
  expect(retriedCommandPayload).toEqual(originalCommandPayload);
  const exactlyOnePaymentAndAudit = localDbQuery(`
    select (select count(*) = 1 from public.payments p
      join public.invoices i on i.id = p.invoice_id where i.invoice_id = '${ownInvoice}')
      and (select count(*) = 1 from public.audit_events a
        join public.payments p on a.entity_id = p.id::text
        join public.invoices i on i.id = p.invoice_id
        where i.invoice_id = '${ownInvoice}' and a.entity_type = 'payment' and a.action = 'record_payment')
      as exactly_one_payment_and_audit
  `);
  expect(exactlyOnePaymentAndAudit).toContain("true");
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
  await expect(page.locator('p[role="status"]').filter({ hasText: "Batch saved" })).toBeVisible();
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
  await page.getByRole("button", { name: "Retry same batch" }).click();
  await expect(page.locator('p[role="status"]').filter({ hasText: "Batch saved" })).toBeVisible();
  await expect(page.getByLabel("Recent invoices")).toContainText(invoiceNumber);
});
});
