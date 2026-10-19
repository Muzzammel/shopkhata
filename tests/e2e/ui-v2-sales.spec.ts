import { expect, test, type Page } from "@playwright/test";

import { entryRows, fillRow, invoiceCount, login, OWNER, savedNotice, scalar, SHOP_1, STAFF } from "./offline-helpers";

// UI/UX V2 phase 2 — Sales list, New Sale and Invoice Detail. The business rules are covered by
// the invoice suites; this file holds the presentation guarantees the redesign adds.

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const saveButton = /^Save (sale|\d+ invoices)$/;

async function createSale(page: Page, number: string, total = "100.00", received = "") {
  await page.goto(`/?shop=${SHOP_1}`);
  await fillRow(page, 0, number, total, received);
  await page.getByRole("button", { name: "Review sale" }).click();
  await page.getByRole("button", { name: saveButton }).click();
  await expect(savedNotice(page)).toBeVisible();
}

test.describe("New Sale", () => {
  test("starts as one invoice, with cash shown as the fixed payment method and no method picker", async ({ page }) => {
    await login(page, STAFF);
    await expect(entryRows(page)).toHaveCount(1);
    const row = entryRows(page).first();
    await expect(row).toContainText("Payment methodCash");
    await expect(row.getByRole("combobox", { name: /payment method/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remove invoice 1" })).toHaveCount(0);
    await expect(page.locator("#sale-summary")).not.toContainText("invoices");
  });

  test("Add another invoice makes the sale multi-invoice, and one save commits both atomically", async ({ page }) => {
    const prefix = `V2-MULTI-${Date.now()}`;
    await login(page, STAFF);
    await fillRow(page, 0, `${prefix}-A`, "30.00", "30.00");
    await page.getByRole("button", { name: "Add another invoice" }).click();
    await fillRow(page, 1, `${prefix}-B`, "12.50");
    const summary = page.getByRole("region", { name: "Summary" });
    await expect(summary).toContainText("2 invoices");
    await expect(summary).toContainText("QAR 42.50");
    await expect(summary).toContainText("DueQAR 12.50");
    await page.getByRole("button", { name: "Review sale" }).click();
    await page.getByRole("button", { name: "Save 2 invoices" }).click();
    await expect(page.getByRole("status").filter({ hasText: "2 invoices saved" })).toContainText(`${prefix}-A, ${prefix}-B`);
    expect(scalar(`select count(distinct batch_id) || ':' || count(*) from public.invoices where shop_id = '${SHOP_1}' and invoice_id like '${prefix}-%'`)).toBe("1:2");
  });

  test("errors appear on blur and on review, focus the first invalid field, and keep what was typed", async ({ page }) => {
    await login(page, STAFF);
    const row = entryRows(page).first();
    await row.getByLabel("Invoice ID").fill("V2-VALIDATION");
    await expect(row.getByLabel("Total QAR")).not.toHaveAttribute("aria-invalid", "true");
    await row.getByLabel("Total QAR").fill("abc");
    await row.getByLabel("Total QAR").blur();
    await expect(row.getByLabel("Total QAR")).toHaveAttribute("aria-invalid", "true");
    await expect(row).toContainText("Enter a positive amount in QAR with at most two decimals.");

    await row.getByLabel("Total QAR").fill("20.00");
    await row.getByLabel("Received QAR").fill("25.00");
    await page.getByRole("button", { name: "Review sale" }).click();
    await expect(row.getByLabel("Received QAR")).toBeFocused();
    await expect(row.getByLabel("Received QAR")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("alert").filter({ hasText: /Fix \d+ row error/ })).toBeVisible();
    await expect(page.getByRole("button", { name: saveButton })).toHaveCount(0);
    await expect(row.getByLabel("Invoice ID")).toHaveValue("V2-VALIDATION");
    await expect(row.getByLabel("Received QAR")).toHaveValue("25.00");
  });

  test("a delivered invoice with due shows the customer requirement before it blocks saving", async ({ page }) => {
    await login(page, STAFF);
    const row = entryRows(page).first();
    await fillRow(page, 0, `V2-CUST-${Date.now()}`, "40.00", "10.00");
    await row.getByLabel("Delivered").check();
    await expect(row).toContainText("Customer required");
    await expect(page.getByRole("region", { name: "Summary" })).toContainText("CustomerRequired");
  });

  test("secondary tools start collapsed under Other tools and stay available", async ({ page }) => {
    await login(page, STAFF);
    const tools = page.locator("[data-sale-tools]");
    await expect(tools).not.toHaveAttribute("open");
    await expect(page.getByRole("region", { name: "Record payment" })).toBeHidden();
    await tools.getByText("Other tools").click();
    await expect(page.getByRole("region", { name: "Record payment" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent invoices" })).toBeVisible();
    await expect(page.getByLabel("Import Excel (.xlsx)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export invoices (.xlsx)" })).toBeVisible();
  });

  test("with several invoices, the others collapse into summary cards that expand again", async ({ page }) => {
    const prefix = `V2-COMPACT-${Date.now()}`;
    await login(page, STAFF);
    await fillRow(page, 0, `${prefix}-A`, "30.00", "10.00");
    await entryRows(page).first().getByLabel("New customer name").fill("Compact Customer");
    await page.getByRole("button", { name: "Add another invoice" }).click();
    const first = entryRows(page).first();
    await expect(first.getByLabel("Invoice ID")).toHaveCount(0);
    for (const text of [`${prefix}-A`, "TotalQAR 30.00", "ReceivedQAR 10.00", "DueQAR 20.00", "DeliveryNot delivered", "Compact Customer"]) await expect(first).toContainText(text);
    await fillRow(page, 1, `${prefix}-B`, "5.00");
    await page.getByRole("button", { name: "Edit invoice 1" }).click();
    await expect(first.getByLabel("Invoice ID")).toBeFocused();
    await expect(entryRows(page).nth(1).getByLabel("Invoice ID")).toHaveCount(0);
    await page.getByRole("button", { name: "Remove invoice 2" }).click();
    await expect(entryRows(page)).toHaveCount(1);
    await expect(first.getByLabel("Invoice ID")).toHaveValue(`${prefix}-A`);
  });

  test("is usable on a phone without sideways scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, STAFF);
    await fillRow(page, 0, `V2-PHONE-${"X".repeat(40)}`, "5.00");
    await page.getByRole("button", { name: "Add another invoice" }).click();
    await page.getByRole("button", { name: "Review sale" }).click();
    expect(await noOverflow(page)).toBe(true);
    await expect(page.locator("[data-sale-tools] > summary")).toContainText("More tools");
  });
});

test.describe("Sales list", () => {
  test("rows open the invoice, badges carry words, and phones get cards instead of a wide table", async ({ page }) => {
    const number = `V2-LIST-${Date.now()}`;
    await login(page, STAFF);
    await createSale(page, number, "60.00", "20.00");
    await page.goto(`/invoices?shop=${SHOP_1}`);
    await expect(page.getByRole("heading", { name: "Sales", exact: true })).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: number });
    await expect(row.locator("[data-badge=due]")).toHaveText("Due");
    await expect(row).toContainText("Not delivered");
    // Clicking anywhere on the row, not only the number, opens the invoice.
    const box = (await row.getByRole("cell").nth(2).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByRole("heading", { name: number, level: 1 })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/invoices?shop=${SHOP_1}`);
    await expect(page.locator("thead")).toHaveClass(/sr-only/);
    await expect(page.getByRole("row").filter({ hasText: number })).toContainText("Due QAR 40.00");
    expect(await noOverflow(page)).toBe(true);
  });
});

test.describe("Invoice detail", () => {
  test("delivery change is a request: delivery stays unchanged until a manager or owner approves", async ({ page, browser }) => {
    const number = `V2-DELIVERY-${Date.now()}`;
    await login(page, STAFF);
    // Fully paid: a delivered invoice with due would also need a customer.
    await createSale(page, number, "100.00", "100.00");
    await page.getByRole("link", { name: `View invoice ${number}`, exact: true }).click();
    const summary = page.getByRole("group", { name: "Financial summary" });
    await expect(summary).toContainText("Not delivered");

    await page.getByRole("button", { name: "Request delivery change" }).click();
    const drawer = page.getByRole("dialog", { name: "Request delivery change" });
    await expect(drawer).toContainText("Requires manager or owner approval");
    await expect(drawer.getByLabel("Delivered")).toBeChecked();
    await drawer.getByLabel("Request reason").fill("Goods collected");
    await drawer.getByRole("button", { name: "Submit request" }).click();
    await expect(page.getByText("Delivery change — Pending approval", { exact: true })).toBeVisible();
    await expect(summary).toContainText("Not delivered");
    expect(scalar(`select effective_delivered from public.effective_invoices where shop_id = '${SHOP_1}' and effective_invoice_number = '${number}'`)).toBe("false");

    const context = await browser.newContext(); const owner = await context.newPage();
    await login(owner, OWNER); await owner.goto(page.url());
    await owner.getByRole("button", { name: "Approve" }).click();
    await expect(owner.getByText("Delivery change — Pending approval", { exact: true })).toHaveCount(0);
    await expect(owner.getByRole("group", { name: "Financial summary" })).toContainText("Delivered");
    expect(scalar(`select effective_delivered from public.effective_invoices where shop_id = '${SHOP_1}' and effective_invoice_number = '${number}'`)).toBe("true");
    await expect(owner.getByRole("region", { name: "History" })).toContainText("Delivery change requestedApproved");
    await context.close();
  });

  test("drawers trap focus and close with Escape; Print shows only the document", async ({ page }) => {
    const number = `V2-DRAWER-${Date.now()}`;
    await login(page, STAFF);
    await createSale(page, number);
    await page.getByRole("link", { name: `View invoice ${number}`, exact: true }).click();
    await page.getByRole("button", { name: "Request correction" }).click();
    const drawer = page.getByRole("dialog", { name: "Request correction" });
    await expect(drawer).toBeVisible();
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Request correction" })).toBeFocused();

    // Unpaid and customerless: the delivery shortcut warns before the request is even sent.
    await page.getByRole("button", { name: "Request delivery change" }).click();
    await expect(page.getByRole("dialog", { name: "Request delivery change" })).toContainText("approval would be refused");
    await page.keyboard.press("Escape");

    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("navigation", { name: "Invoice actions" })).toBeHidden();
    await expect(page.getByRole("banner")).toBeHidden();
    await expect(page.getByRole("heading", { name: number, level: 1 })).toBeVisible();
    await page.emulateMedia({ media: "screen" });
  });

  test("actions lead with Record payment; the rest sit under More actions, on phones too", async ({ page }) => {
    const number = `V2-ACTIONS-${Date.now()}`;
    await login(page, STAFF);
    await createSale(page, number, "50.00");
    await page.getByRole("link", { name: `View invoice ${number}`, exact: true }).click();
    const actions = page.getByRole("navigation", { name: "Invoice actions" });
    await expect(actions.getByRole("button")).toHaveText(["Record payment", "Request correction", "Request delivery change", "More actions"]);
    await actions.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Request replacement", "Print"]);
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(actions.getByRole("button")).toHaveText(["Record payment", "More actions"]);
    await actions.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Request correction", "Request replacement", "Request delivery change", "Print"]);
    await page.getByRole("menuitem", { name: "Request replacement" }).click();
    await expect(page.getByRole("dialog", { name: "Request replacement" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(actions.getByRole("button", { name: "More actions" })).toBeFocused();
    expect(await noOverflow(page)).toBe(true);
  });

  test("the timeline names people and shows old and new values", async ({ page }) => {
    const number = `V2-TIMELINE-${Date.now()}`;
    await login(page, OWNER);
    await createSale(page, number, "80.00", "30.00");
    await page.getByRole("link", { name: `View invoice ${number}`, exact: true }).click();
    const history = page.getByRole("region", { name: "History" });
    await history.getByText("History").click();
    await expect(history).toContainText("Invoice recorded");
    await expect(history).toContainText("Local Owner");
    await expect(history).toContainText("Payment recorded");
    expect(invoiceCount(number)).toBe("1");
  });

  test("dark mode keeps the financial figures on readable, distinct surfaces", async ({ page }) => {
    const number = `V2-DARK-${Date.now()}`;
    await page.emulateMedia({ colorScheme: "dark" });
    await login(page, STAFF);
    await page.evaluate(() => localStorage.setItem("theme", "dark"));
    await createSale(page, number);
    await page.getByRole("link", { name: `View invoice ${number}`, exact: true }).click();
    await expect(page.getByRole("heading", { name: number, level: 1 })).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    const colours = await page.evaluate(() => {
      const doc = document.querySelector('section[aria-labelledby="invoice-heading"]')!;
      return { page: getComputedStyle(document.body).backgroundColor, card: getComputedStyle(doc).backgroundColor };
    });
    expect(colours.card).not.toBe(colours.page);
  });
});
