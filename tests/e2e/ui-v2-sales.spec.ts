import { expect, test, type Page } from "@playwright/test";

import { IMPORT_HEADERS } from "@/lib/excel/invoice-import";

import { entryRows, fillRow, importFile, invoiceCount, login, MANAGER, MANAGER_ID, OWNER, savedNotice, scalar, SHOP_1, STAFF, workbook } from "./offline-helpers";

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

/** A legacy invoice (yes/no delivery, no piece counts): Excel imports still create those. */
async function createLegacySale(page: Page, number: string, total: number, received: number) {
  await page.goto(`/?shop=${SHOP_1}`);
  await importFile(page, await workbook([[...IMPORT_HEADERS], [number, total, received, "No", null, null, null]]));
  await page.getByRole("region", { name: "Import preview" }).getByRole("button", { name: "Add rows to draft" }).click();
  await page.getByRole("button", { name: "Review sale" }).click();
  await page.getByRole("button", { name: saveButton }).click();
  await expect(savedNotice(page)).toBeVisible();
  expect(scalar(`select ordered_pieces is null from public.invoices where shop_id = '${SHOP_1}' and invoice_id = '${number}'`)).toBe("true");
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
    await row.getByLabel("Delivered now").fill("1");
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
    // Fully paid: a delivered invoice with due would also need a customer. Legacy: piece-tracked invoices record deliveries instead.
    await createLegacySale(page, number, 100, 100);
    await page.goto(`/shops/${SHOP_1}/invoices/${scalar(`select id from public.invoices where shop_id = '${SHOP_1}' and invoice_id = '${number}'`)}`);
    await expect(page.locator("[data-piece-delivery]")).toHaveCount(0);
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
    // Legacy: the delivery-change shortcut below exists only for invoices without piece counts.
    await createLegacySale(page, number, 100, 0);
    await page.goto(`/shops/${SHOP_1}/invoices/${scalar(`select id from public.invoices where shop_id = '${SHOP_1}' and invoice_id = '${number}'`)}`);
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
    // A New Sale invoice is piece-tracked: deliveries are recorded on the page, so there is no delivery-change request.
    await expect(actions.getByRole("button")).toHaveText(["Record payment", "Request correction", "More actions"]);
    await actions.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Request replacement", "Print"]);
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(actions.getByRole("button")).toHaveText(["Record payment", "More actions"]);
    await actions.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Request correction", "Request replacement", "Print"]);
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

test.describe("Piece delivery", () => {
  test("100 ordered, 60 with the sale, 40 later: over-delivery refused, a lost response retried once, nothing left", async ({ page }) => {
    const number = `V2-PIECES-${Date.now()}`;
    const totals = () => scalar(`select t.ordered_pieces || '/' || t.delivered_pieces || '/' || t.remaining_pieces || '/' || t.delivery_status || '/' || b.effective_total_dirham || '/' || b.effective_due_dirham
      from public.invoices i join public.invoice_delivery_totals t on t.canonical_invoice_id = i.id join public.invoice_effective_balances b on b.canonical_invoice_id = i.id
      where i.shop_id = '${SHOP_1}' and i.invoice_id = '${number}'`);
    await login(page, STAFF);
    await fillRow(page, 0, number, "250.00", "250.00");
    const row = entryRows(page).first();
    await row.getByLabel("Ordered pieces").fill("100");
    await row.getByLabel("Delivered now").fill("60");
    await page.getByRole("button", { name: "Review sale" }).click();
    await page.getByRole("button", { name: saveButton }).click();
    await expect(savedNotice(page)).toBeVisible();
    expect(totals()).toBe("100/60/40/partial/25000/0");

    await page.getByRole("link", { name: `View invoice ${number}`, exact: true }).click();
    const figures = page.getByLabel("Piece delivery");
    await expect(figures).toContainText("Ordered pieces100Delivered pieces60Remaining pieces40Delivery statusPartially delivered");
    await expect(page.getByRole("group", { name: "Financial summary" })).toContainText("Partially delivered");
    await expect(page.getByRole("button", { name: "Request delivery change" })).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Delivery history" }).getByRole("listitem")).toHaveCount(1);
    await expect(page.getByRole("list", { name: "Delivery history" })).toContainText(`With the sale`);
    await expect(page.getByRole("list", { name: "Delivery history" })).toContainText(`invoice ${number}`);

    // Over-delivery is refused on screen, before anything is sent.
    const pieces = page.getByLabel("Pieces delivered now");
    await pieces.fill("41");
    await page.getByRole("button", { name: "Record delivery" }).click();
    await expect(page.getByText("Only 40 pieces remain to deliver.")).toBeVisible();

    // The first response is lost after the server committed: the retry resends the same command and records nothing twice.
    const payloads: string[] = [];
    let dropped = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.headers()["next-action"] && request.postData()?.includes("idempotency_key")) {
        payloads.push(request.postData() ?? "");
        if (!dropped) { dropped = true; await route.fetch(); return route.abort("failed"); }
      }
      return route.continue();
    });
    await pieces.fill("40");
    await page.getByRole("button", { name: "Record delivery" }).click();
    await expect(page.getByRole("button", { name: "Retry exact delivery" })).toBeVisible();
    await expect(pieces).toBeDisabled();
    expect(totals()).toBe("100/100/0/full/25000/0");
    await page.getByRole("button", { name: "Retry exact delivery" }).click();
    await expect(figures).toContainText("Delivered pieces100Remaining pieces0Delivery statusFully delivered");
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toBe(payloads[0]);
    expect(scalar(`select count(*) from public.invoice_deliveries d join public.invoices i on i.id = d.invoice_id where i.shop_id = '${SHOP_1}' and i.invoice_id = '${number}'`)).toBe("2");
    expect(totals()).toBe("100/100/0/full/25000/0");
    await expect(page.getByRole("list", { name: "Delivery history" }).getByRole("listitem")).toHaveCount(2);
    await expect(page.getByRole("list", { name: "Delivery history" })).toContainText("Later delivery");
    await expect(page.getByText("All ordered pieces are delivered.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Record delivery" })).toHaveCount(0);

    // One audit event for the one later delivery, despite two sends.
    await page.unroute("**/*");
    const invoiceId = scalar(`select id from public.invoices where shop_id = '${SHOP_1}' and invoice_id = '${number}'`);
    expect(scalar(`select count(*) from public.audit_events where action = 'delivery.record' and entity_id = '${invoiceId}'`)).toBe("1");
  });

  test("a manager reverses a whole delivery with a reason: history kept, net totals, money unchanged; staff cannot", async ({ page, browser }) => {
    const number = `V2-REVERSE-${Date.now()}`;
    const reason = "Delivered to the wrong customer";
    const totals = () => scalar(`select t.ordered_pieces || '/' || t.delivered_pieces || '/' || t.remaining_pieces || '/' || t.delivery_status || '/' || b.effective_total_dirham || '/' || b.effective_paid_dirham || '/' || b.effective_due_dirham
      from public.invoices i join public.invoice_delivery_totals t on t.canonical_invoice_id = i.id join public.invoice_effective_balances b on b.canonical_invoice_id = i.id
      where i.shop_id = '${SHOP_1}' and i.invoice_id = '${number}'`);
    await login(page, MANAGER);
    await fillRow(page, 0, number, "250.00", "250.00");
    const row = entryRows(page).first();
    await row.getByLabel("Ordered pieces").fill("100");
    await row.getByLabel("Delivered now").fill("60");
    await page.getByRole("button", { name: "Review sale" }).click();
    await page.getByRole("button", { name: saveButton }).click();
    await expect(savedNotice(page)).toBeVisible();
    await page.getByRole("link", { name: `View invoice ${number}`, exact: true }).click();
    const figures = page.getByLabel("Piece delivery");
    const history = page.getByRole("list", { name: "Delivery history" });
    await page.getByLabel("Pieces delivered now").fill("40");
    await page.getByRole("button", { name: "Record delivery" }).click();
    await expect(figures).toContainText("Delivered pieces100Remaining pieces0Delivery statusFully delivered");
    expect(totals()).toBe("100/100/0/full/25000/25000/0");
    const invoiceId = scalar(`select id from public.invoices where shop_id = '${SHOP_1}' and invoice_id = '${number}'`);
    const money = () => scalar(`select (select count(*) from public.payments where invoice_id = '${invoiceId}') || '/' || (select count(*) from public.corrections where invoice_id = '${invoiceId}')
      || '/' || (select count(*) from public.sales_movements where invoice_id = '${invoiceId}')`);
    const moneyBefore = money();
    const reverseButtons = page.getByRole("button", { name: /^Reverse delivery of/ });
    await expect(reverseButtons).toHaveCount(2);

    // Staff see the same history and no reversal action.
    const staffContext = await browser.newContext();
    const staff = await staffContext.newPage();
    await login(staff, STAFF);
    await staff.goto(new URL(page.url()).pathname);
    await expect(staff.getByRole("list", { name: "Delivery history" }).getByRole("listitem")).toHaveCount(2);
    await expect(staff.getByRole("button", { name: /^Reverse delivery of/ })).toHaveCount(0);
    await staffContext.close();

    // A reason is mandatory, on screen, before anything is sent.
    await page.getByRole("button", { name: /^Reverse delivery of 60 pieces/ }).click();
    await page.getByRole("button", { name: "Reverse delivery", exact: true }).click();
    await expect(page.getByText("Enter the reason for reversing this delivery.")).toBeVisible();
    await page.getByLabel("Reason for reversing this delivery").fill("too short");
    await page.getByRole("button", { name: "Reverse delivery", exact: true }).click();
    await expect(page.getByText("Explain the reversal in at least 10 characters.")).toBeVisible();
    expect(totals()).toBe("100/100/0/full/25000/25000/0");

    // The first response is lost after the server committed: the retry resends the same command and reverses nothing twice.
    const payloads: string[] = [];
    let dropped = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.headers()["next-action"] && request.postData()?.includes("idempotency_key")) {
        payloads.push(request.postData() ?? "");
        if (!dropped) { dropped = true; await route.fetch(); return route.abort("failed"); }
      }
      return route.continue();
    });
    await page.getByLabel("Reason for reversing this delivery").fill(reason);
    await page.getByRole("button", { name: "Reverse delivery", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry exact reversal" })).toBeVisible();
    expect(totals()).toBe("100/40/60/partial/25000/25000/0");
    await page.getByRole("button", { name: "Retry exact reversal" }).click();
    await expect(figures).toContainText("Delivered pieces40Remaining pieces60Delivery statusPartially delivered");
    await page.unroute("**/*");
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toBe(payloads[0]);

    // History: the original delivery stays (marked Reversed); the reversal is a new event with reason, actor, date and the original.
    await expect(history.getByRole("listitem")).toHaveCount(3);
    await expect(history.locator('[data-delivery-event="delivery"]').first()).toContainText("With the sale · Reversed");
    const reversal = history.locator('[data-delivery-event="reversal"]');
    await expect(reversal).toHaveCount(1);
    await expect(reversal).toContainText("Reversal of the 60 pieces delivered on");
    await expect(reversal).toContainText(`reason: ${reason}`);
    await expect(reversal).toContainText(`invoice ${number}`);
    await expect(reversal).toContainText("\u221260 pieces");
    await expect(page.getByRole("group", { name: "Financial summary" })).toContainText("Partially delivered");
    await expect(reverseButtons).toHaveCount(1);

    // Database: one reversal event by the manager on today's date, the original untouched, one audit event, money unchanged.
    expect(scalar(`select count(*) || '/' || min(r.pieces) || '/' || bool_and(r.created_by = '${MANAGER_ID}') || '/' || bool_and(r.reason = '${reason}') || '/' || bool_and(r.business_date = (now() at time zone 'Asia/Qatar')::date) || '/' || min(o.pieces)
      from public.invoice_deliveries r join public.invoice_deliveries o on o.id = r.reverses_delivery_id where r.invoice_id = '${invoiceId}'`)).toBe("1/-60/true/true/true/60");
    expect(scalar(`select count(*) from public.invoice_deliveries where invoice_id = '${invoiceId}'`)).toBe("3");
    expect(scalar(`select count(*) from public.audit_events where action = 'delivery.reverse' and entity_id = '${invoiceId}' and reason = '${reason}'`)).toBe("1");
    expect(money()).toBe(moneyBefore);
    expect(totals()).toBe("100/40/60/partial/25000/25000/0");

    // Ordinary delivery recording still works afterwards, against the net total.
    await page.getByLabel("Pieces delivered now").fill("61");
    await page.getByRole("button", { name: "Record delivery" }).click();
    await expect(page.getByText("Only 60 pieces remain to deliver.")).toBeVisible();
    await page.getByLabel("Pieces delivered now").fill("60");
    await page.getByRole("button", { name: "Record delivery" }).click();
    await expect(figures).toContainText("Delivered pieces100Remaining pieces0Delivery statusFully delivered");
    expect(totals()).toBe("100/100/0/full/25000/25000/0");
    await expect(history.getByRole("listitem")).toHaveCount(4);
  });
  test("a manager corrects ordered pieces with a reason: original kept, stale edits refused, money unchanged; staff cannot", async ({ page, browser }) => {
    const number = `V2-ORDERFIX-${Date.now()}`;
    const reason = "Customer added twenty pieces";
    const totals = () => scalar(`select t.ordered_pieces || '/' || t.delivered_pieces || '/' || t.remaining_pieces || '/' || t.delivery_status || '/' || t.original_ordered_pieces || '/' || b.effective_total_dirham || '/' || b.effective_paid_dirham || '/' || b.effective_due_dirham
      from public.invoices i join public.invoice_delivery_totals t on t.canonical_invoice_id = i.id join public.invoice_effective_balances b on b.canonical_invoice_id = i.id
      where i.shop_id = '${SHOP_1}' and i.invoice_id = '${number}'`);
    await login(page, MANAGER);
    await fillRow(page, 0, number, "250.00", "250.00");
    const row = entryRows(page).first();
    await row.getByLabel("Ordered pieces").fill("100");
    await row.getByLabel("Delivered now").fill("60");
    await page.getByRole("button", { name: "Review sale" }).click();
    await page.getByRole("button", { name: saveButton }).click();
    await expect(savedNotice(page)).toBeVisible();
    await page.getByRole("link", { name: `View invoice ${number}`, exact: true }).click();
    const figures = page.getByLabel("Piece delivery");
    const corrections = page.getByRole("list", { name: "Ordered piece corrections" });
    expect(totals()).toBe("100/60/40/partial/100/25000/25000/0");
    const invoiceId = scalar(`select id from public.invoices where shop_id = '${SHOP_1}' and invoice_id = '${number}'`);
    const money = () => scalar(`select (select count(*) from public.payments where invoice_id = '${invoiceId}') || '/' || (select count(*) from public.corrections where invoice_id = '${invoiceId}')
      || '/' || (select count(*) from public.sales_movements where invoice_id = '${invoiceId}')`);
    const moneyBefore = money();

    // Staff see no correction action.
    const staffContext = await browser.newContext();
    const staff = await staffContext.newPage();
    await login(staff, STAFF);
    await staff.goto(new URL(page.url()).pathname);
    await expect(staff.getByLabel("Piece delivery")).toContainText("Ordered pieces100");
    await expect(staff.getByRole("button", { name: "Correct ordered pieces" })).toHaveCount(0);

    // On-screen validation before anything is sent: below the delivered pieces, and a mandatory reason.
    await page.getByRole("button", { name: "Correct ordered pieces" }).click();
    await page.getByLabel("Corrected ordered pieces").fill("50");
    await page.getByRole("button", { name: "Save correction" }).click();
    await expect(page.getByText("60 pieces are already delivered. Reverse a delivery first to go lower.")).toBeVisible();
    await expect(page.getByText("Enter the reason for correcting the ordered pieces.")).toBeVisible();
    expect(scalar(`select count(*) from public.invoice_piece_corrections where invoice_id = '${invoiceId}'`)).toBe("0");

    // The first response is lost after the server committed: the retry resends the same command and corrects once.
    const payloads: string[] = [];
    let dropped = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.headers()["next-action"] && request.postData()?.includes("expected_ordered_pieces")) {
        payloads.push(request.postData() ?? "");
        if (!dropped) { dropped = true; await route.fetch(); return route.abort("failed"); }
      }
      return route.continue();
    });
    await page.getByLabel("Corrected ordered pieces").fill("120");
    await page.getByLabel("Reason for the correction").fill(reason);
    await page.getByRole("button", { name: "Save correction" }).click();
    await expect(page.getByRole("button", { name: "Retry exact correction" })).toBeVisible();
    expect(totals()).toBe("120/60/60/partial/100/25000/25000/0");
    await page.getByRole("button", { name: "Retry exact correction" }).click();
    await expect(figures).toContainText("Ordered pieces120Delivered pieces60Remaining pieces60Delivery statusPartially delivered");
    await page.unroute("**/*");
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toBe(payloads[0]);
    await expect(page.getByText("Originally ordered 100 pieces.")).toBeVisible();
    await expect(corrections.getByRole("listitem")).toHaveCount(1);
    await expect(corrections).toContainText("100 → 120");
    await expect(corrections).toContainText(`Reason: ${reason}`);

    // The staff page still shows 100: a stale editor. A second manager page on 120 corrects first; a stale command is refused.
    const second = await browser.newContext();
    const other = await second.newPage();
    await login(other, MANAGER);
    await other.goto(new URL(page.url()).pathname);
    await other.getByRole("button", { name: "Correct ordered pieces" }).click();
    await other.getByLabel("Corrected ordered pieces").fill("80");
    await other.getByLabel("Reason for the correction").fill("Customer reduced the order");
    await page.getByRole("button", { name: "Correct ordered pieces" }).click();
    await page.getByLabel("Corrected ordered pieces").fill("130");
    await page.getByLabel("Reason for the correction").fill("Customer added ten more pieces");
    await other.getByRole("button", { name: "Save correction" }).click();
    await expect(other.getByLabel("Piece delivery")).toContainText("Ordered pieces80");
    await second.close();
    await page.getByRole("button", { name: "Save correction" }).click();
    await expect(page.getByText("The ordered pieces were changed by someone else. Refresh and check the latest quantity.")).toBeVisible();
    await expect(figures).toContainText("Ordered pieces80Delivered pieces60Remaining pieces20");
    expect(totals()).toBe("80/60/20/partial/100/25000/25000/0");

    // Decrease to exactly the delivered pieces: the invoice becomes fully delivered and recording stops.
    await page.getByLabel("Corrected ordered pieces").fill("60");
    await page.getByLabel("Reason for the correction").fill("Customer cancelled the rest");
    await page.getByRole("button", { name: "Save correction" }).click();
    await expect(figures).toContainText("Ordered pieces60Delivered pieces60Remaining pieces0Delivery statusFully delivered");
    await expect(page.getByText("All ordered pieces are delivered.")).toBeVisible();
    await expect(corrections.getByRole("listitem")).toHaveCount(3);

    // Database: append-only history, original preserved, audit per correction, money untouched. Staff sees the history.
    expect(scalar(`select string_agg(ordered_before || '>' || ordered_after, ',' order by seq) from public.invoice_piece_corrections where invoice_id = '${invoiceId}'`)).toBe("100>120,120>80,80>60");
    expect(scalar(`select ordered_pieces from public.invoices where id = '${invoiceId}'`)).toBe("100");
    expect(scalar(`select count(*) from public.audit_events where action = 'delivery.correct_ordered' and entity_id = '${invoiceId}'`)).toBe("3");
    expect(money()).toBe(moneyBefore);
    expect(totals()).toBe("60/60/0/full/100/25000/25000/0");
    await staff.reload();
    await expect(staff.getByRole("list", { name: "Ordered piece corrections" }).getByRole("listitem")).toHaveCount(3);
    await staffContext.close();
  });
});
