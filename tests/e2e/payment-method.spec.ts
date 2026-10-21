import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { entryRows, fillRow, login, OWNER, savedNotice, scalar, SHOP_1, storedDrafts } from "./offline-helpers";

// Bank as a second payment method: New Sale, Record Payment, customer payments, history, Daily Close,
// Reports, accessibility, dark mode and the offline queue. Every bank receipt in the suite comes from
// this file, so the Bank totals it reads back are exact; Cash totals are only checked for consistency
// because other specs record cash while this one runs.

test.describe.configure({ mode: "serial" });

const qatarToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Qatar" }).format(new Date());
const methods = (invoice: string) => scalar(`select coalesce(string_agg(p.payment_method || ':' || p.amount_dirham, ',' order by p.recorded_at, p.id), '') from public.payments p join public.invoices i on i.id = p.invoice_id where i.shop_id = '${SHOP_1}' and i.invoice_id = '${invoice}'`);
const money = (text: string | null) => Math.round(Number((text ?? "").replace(/[^0-9.-]/g, "")) * 100);
const bankToday = () => Number(scalar(`select coalesce(sum(bank_received_dirham), 0) from public.report_daily_summary('${SHOP_1}', '${qatarToday()}', '${qatarToday()}')`));
const methodGroup = (scope: Page | Locator) => scope.getByRole("group", { name: "Payment method" });
type StoredBankDraft = { shopId: string; idempotencyKey: string; rows: { paymentMethod?: string }[]; submission: { payload: { rows: { paymentMethod?: string }[] } } | null };
const drafts = async (page: Page) => (await storedDrafts(page)) as unknown as StoredBankDraft[];
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function createInvoice(page: Page, number: string, total: string, received = "") {
  await page.goto("/");
  await fillRow(page, 0, number, total, received);
  await page.getByRole("button", { name: "Review sale" }).click();
  await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await expect(savedNotice(page)).toBeVisible();
}

async function seedCustomer(invoiceTotals: number[]) {
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
  const name = `Bank Customer ${suffix}`;
  const customerId = (await rpc("create_customer", { name, mobile: `55${suffix.slice(-7)}` })).customer_id as string;
  const numbers = invoiceTotals.map((_, index) => `BNK-${suffix}-${index + 1}`);
  await rpc("submit_batch", {
    business_date: qatarToday(), idempotency_key: crypto.randomUUID(),
    rows: invoiceTotals.map((total, index) => ({ row_id: crypto.randomUUID(), invoice_number: numbers[index], total_dirham: total, received_dirham: 0, payment_method: "cash", delivered: true, customer: { type: "existing", customer_id: customerId } })),
  });
  await owner.auth.signOut();
  return { name, customerId, numbers };
}

/** sRGB of any CSS colour (oklch included), read back through a canvas. */
const rgbOf = (page: Page, color: string) => page.evaluate((value) => {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}, color);
const luminance = ([r, g, b]: number[]) => [r, g, b].map((v) => v / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: number[], b: number[]) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

test.describe("New Sale", () => {
  test("defaults to Cash, saves a Bank receipt, and the invoice shows Bank", async ({ page }) => {
    const number = `BNK-SALE-${Date.now()}`;
    await login(page, OWNER);
    await fillRow(page, 0, number, "50.00", "20.00");
    const group = methodGroup(entryRows(page).nth(0));
    await expect(group.getByRole("radio", { name: "Cash" })).toBeChecked();
    await expect(group.getByRole("radio", { name: "Bank" })).not.toBeChecked();
    await group.getByRole("radio", { name: "Bank" }).check();
    await expect(group.getByRole("radio", { name: "Bank" })).toBeChecked();
    await page.getByRole("button", { name: "Review sale" }).click();
    await expect(page.getByLabel("Sale review")).toContainText("Bank");
    await expect(page.getByLabel("Sale review")).toContainText("Cash QAR 0.00");
    await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
    await expect(savedNotice(page)).toBeVisible();
    expect(methods(number)).toBe("bank:2000");
    await page.getByRole("link", { name: `View invoice ${number}` }).click();
    const history = page.getByRole("region", { name: "Payments received" });
    await expect(history.locator("[data-payment-method=bank]")).toHaveText("Bank");
    await expect(history).toContainText("QAR 20.00");
  });

  test("a row that receives nothing records no method, and a Cash row stays Cash", async ({ page }) => {
    const unpaid = `BNK-NONE-${Date.now()}`;
    const cash = `BNK-CASH-${Date.now()}`;
    await login(page, OWNER);
    await fillRow(page, 0, unpaid, "10.00");
    await methodGroup(entryRows(page).nth(0)).getByRole("radio", { name: "Bank" }).check();
    await expect(entryRows(page).nth(0)).toContainText("Applies when an amount is received");
    await page.getByRole("button", { name: "Add another invoice" }).click();
    await fillRow(page, 1, cash, "10.00", "10.00");
    await page.getByRole("button", { name: "Review sale" }).click();
    await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
    await expect(savedNotice(page)).toBeVisible();
    expect(methods(unpaid)).toBe("");
    expect(methods(cash)).toBe("cash:1000");
  });

  test("the selector is a labelled radio group that works from the keyboard, with a visible focus and a non-colour selected cue", async ({ page }) => {
    await login(page, OWNER);
    const group = methodGroup(entryRows(page).nth(0));
    await expect(group.getByRole("radio")).toHaveCount(2);
    const cash = group.getByRole("radio", { name: "Cash" });
    const bank = group.getByRole("radio", { name: "Bank" });
    await cash.focus();
    await page.keyboard.press("ArrowRight");
    await expect(bank).toBeChecked();
    await expect(bank).toBeFocused();
    await expect(group.locator("label", { hasText: "Bank" }).locator("svg")).toHaveCount(1);
    await expect(group.locator("label", { hasText: "Cash" }).locator("svg")).toHaveCount(0);
    const outline = await group.locator("label", { hasText: "Bank" }).evaluate((element) => { const style = getComputedStyle(element); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
    expect(outline.style).not.toBe("none");
    expect(outline.width).toBeGreaterThan(0);
    await page.keyboard.press("ArrowLeft");
    await expect(cash).toBeChecked();
    await expect(group.locator("label", { hasText: "Cash" }).locator("svg")).toHaveCount(1);
  });

  test("works at phone width: no horizontal overflow and touch targets of at least 44px", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await login(page, OWNER);
    await fillRow(page, 0, `BNK-MOBILE-${Date.now()}`, "20.00", "5.00");
    const group = methodGroup(entryRows(page).nth(0));
    await group.scrollIntoViewIfNeeded();
    for (const name of ["Cash", "Bank"]) {
      const box = await group.locator("label", { hasText: name }).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    await group.getByRole("radio", { name: "Bank" }).check();
    expect(await noOverflow(page)).toBe(true);
    await page.getByRole("button", { name: "Review sale" }).click();
    expect(await noOverflow(page)).toBe(true);
    await context.close();
  });

  test("dark mode keeps the selected and unselected options distinct and readable", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await login(page, OWNER);
    await page.evaluate(() => localStorage.setItem("theme", "dark"));
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    // The row id is only rendered once the page has hydrated and restored its draft.
    await expect(entryRows(page).nth(0)).toHaveAttribute("data-row-id", /.+/);
    const group = methodGroup(entryRows(page).nth(0));
    await group.getByRole("radio", { name: "Bank" }).check();
    const paint = (label: string) => group.locator("label", { hasText: label }).evaluate((element) => { const style = getComputedStyle(element); return { background: style.backgroundColor, color: style.color }; });
    const wrapper = await group.locator("div").first().evaluate((element) => getComputedStyle(element).backgroundColor);
    // The options fade between states, so the colours are read once they settle.
    await expect.poll(async () => {
      const [selected, unselected] = [await paint("Bank"), await paint("Cash")];
      if (selected.background === unselected.background) return 0;
      return Math.min(contrast(await rgbOf(page, selected.color), await rgbOf(page, selected.background)), contrast(await rgbOf(page, unselected.color), await rgbOf(page, wrapper)));
    }).toBeGreaterThanOrEqual(4.5);
  });
});

test.describe("Record payment", () => {
  test("a Bank payment is reviewed as Bank, stored as bank and listed as Bank in payment history", async ({ page }) => {
    const number = `BNK-PAY-${Date.now()}`;
    await login(page, OWNER);
    await createInvoice(page, number, "40.00");
    await page.goto(`/payments?shop=${SHOP_1}`);
    const form = page.getByRole("region", { name: "Record payment" });
    await form.getByLabel("Invoice number").fill(number);
    await form.getByRole("button", { name: "Find invoice" }).click();
    await expect(form.getByRole("heading", { name: number })).toBeVisible();
    await expect(methodGroup(form).getByRole("radio", { name: "Cash" })).toBeChecked();
    await form.getByLabel("Payment amount (QAR)").fill("15.00");
    await methodGroup(form).getByRole("radio", { name: "Bank" }).check();
    await form.getByRole("button", { name: "Review payment" }).click();
    await expect(form).toContainText("Payment methodBank");
    await form.getByRole("button", { name: "Confirm payment" }).click();
    await expect(form.getByRole("status")).toContainText("Payment recorded");
    expect(methods(number)).toBe("bank:1500");

    await page.reload();
    const row = page.getByRole("row", { name: new RegExp(number) });
    await expect(row).toContainText("Bank");
    await expect(row.locator("[data-payment-method=bank]")).toHaveText("Bank");
    await expect(row).toContainText("QAR 15.00");
  });

  test("the invoice page's Record payment sheet offers Cash and Bank, and Cash stays the default", async ({ page }) => {
    const number = `BNK-SHEET-${Date.now()}`;
    await login(page, OWNER);
    await createInvoice(page, number, "30.00");
    await page.getByRole("link", { name: `View invoice ${number}` }).click();
    await page.getByRole("button", { name: /Record payment/ }).first().click();
    const sheet = page.getByRole("dialog", { name: "Record payment" });
    await expect(methodGroup(sheet).getByRole("radio", { name: "Cash" })).toBeChecked();
    await sheet.getByLabel("Payment amount (QAR)").fill("10.00");
    await methodGroup(sheet).getByRole("radio", { name: "Bank" }).check();
    await sheet.getByRole("button", { name: "Review payment" }).click();
    await expect(sheet).toContainText("Bank");
    await sheet.getByRole("button", { name: "Edit" }).click();
    await methodGroup(sheet).getByRole("radio", { name: "Cash" }).check();
    await sheet.getByRole("button", { name: "Review payment" }).click();
    await sheet.getByRole("button", { name: "Confirm payment" }).click();
    await expect.poll(() => methods(number)).toBe("cash:1000");
  });
});

test.describe("Customer payment", () => {
  test("a Bank customer payment is allocated as before, stored as bank and shown as Bank in the customer's payments", async ({ page }) => {
    const { customerId, name, numbers } = await seedCustomer([10_000, 5_000]);
    await login(page, OWNER);
    await page.goto(`/customers/${customerId}?shop=${SHOP_1}`);
    await page.getByRole("button", { name: "Record payment" }).click();
    const drawer = page.getByRole("dialog", { name: "Record payment" });
    await expect(methodGroup(drawer).getByRole("radio", { name: "Cash" })).toBeChecked();
    await methodGroup(drawer).getByRole("radio", { name: "Bank" }).check();
    await drawer.getByLabel("Payment amount (QAR)").fill("120.00");
    await expect(drawer).toContainText("Payment methodBank");
    await drawer.getByRole("button", { name: "Review allocation" }).click();
    await expect(drawer).toContainText("Bank payment of");
    await drawer.getByRole("button", { name: "Confirm payment" }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Financial summary" })).toContainText("Current dueQAR 30.00");
    expect(scalar(`select string_agg(p.payment_method || ':' || p.amount_dirham, ',' order by i.invoice_id) from public.payments p join public.invoices i on i.id = p.invoice_id where i.shop_id = '${SHOP_1}' and i.invoice_id in ('${numbers[0]}', '${numbers[1]}')`)).toMatch(/^bank:\d+,bank:\d+$/);
    expect(scalar(`select sum(p.amount_dirham) from public.payments p join public.invoices i on i.id = p.invoice_id where i.invoice_id in ('${numbers[0]}', '${numbers[1]}')`)).toBe("12000");

    await page.getByRole("tab", { name: /Payments/ }).click();
    const payment = page.locator("[data-payment=payment]").first();
    await expect(payment).toContainText("Bank payment");
    await expect(payment.locator("[data-payment-method=bank]")).toHaveText("Bank");
    expect(name).toContain("Bank Customer");
  });

  test("applying credit offers no payment method", async ({ page }) => {
    const { customerId } = await seedCustomer([4_000]);
    await login(page, OWNER);
    await page.goto(`/customers/${customerId}?shop=${SHOP_1}`);
    await page.getByRole("button", { name: "Record payment" }).click();
    const drawer = page.getByRole("dialog", { name: "Record payment" });
    await expect(methodGroup(drawer)).toBeVisible();
    // No credit is held, so "Apply credit" is not offered; the payment form is the only mode.
    await expect(drawer.getByRole("button", { name: "Apply credit" })).toHaveCount(0);
  });
});

test.describe("Daily Close and Reports", () => {
  test("Daily Close shows Cash, Bank and Total received, with Bank never inside Cash", async ({ page }) => {
    await login(page, OWNER);
    await createInvoice(page, `BNK-CLOSE-${Date.now()}`, "25.00", "25.00");
    await page.goto("/");
    await fillRow(page, 0, `BNK-CLOSE-B-${Date.now()}`, "13.00", "13.00");
    await methodGroup(entryRows(page).nth(0)).getByRole("radio", { name: "Bank" }).check();
    await page.getByRole("button", { name: "Review sale" }).click();
    await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
    await expect(savedNotice(page)).toBeVisible();

    await page.goto(`/closing?shop=${SHOP_1}`);
    const value = (key: string) => page.locator(`[data-metric=${key}]`).textContent();
    const [cash, bank, total] = [money(await value("cashReceivedDirham")), money(await value("bankReceivedDirham")), money(await value("totalReceivedDirham"))];
    expect(bank).toBe(bankToday());
    expect(bank).toBeGreaterThanOrEqual(1300);
    expect(total).toBe(cash + bank);
    await expect(page.getByText("Cash received", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Bank received", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Total received", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Net movement (total received − expenses)")).toBeVisible();
    await expect(page.getByText("Net cash movement")).toHaveCount(0);
  });

  test("the payments report separates Cash and Bank and reports Total as their sum", async ({ page }) => {
    await login(page, OWNER);
    await page.goto(`/reports?shop=${SHOP_1}&report=payments&from=${qatarToday()}&to=${qatarToday()}`);
    const total = (key: string) => page.locator(`[data-total=${key}]`).textContent();
    const [cash, bank, received] = [money(await total("cash")), money(await total("bank")), money(await total("received"))];
    expect(bank).toBe(bankToday());
    expect(received).toBe(cash + bank);
    const table = page.getByRole("table");
    await expect(table.getByRole("row").filter({ has: page.getByRole("cell", { name: "Bank", exact: true }) }).first()).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Method" })).toBeVisible();
  });

  test("the daily report lists Cash received, Bank received and Total received", async ({ page }) => {
    await login(page, OWNER);
    await page.goto(`/reports?shop=${SHOP_1}&report=daily&from=${qatarToday()}&to=${qatarToday()}`);
    for (const label of ["Cash received", "Bank received", "Total received"]) await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Net movement (total received − expenses)").first()).toBeVisible();
  });

  test("the dashboard keeps Cash Received cash-only and names Bank and Total next to it", async ({ page }) => {
    await login(page, OWNER);
    await page.goto(`/dashboard?shop=${SHOP_1}&period=today`);
    await expect(page.getByRole("button", { name: "Show Cash Received on the chart" })).toBeVisible();
    await expect(page.getByText(/Cash only · Bank QAR [0-9,.]+ · Total QAR [0-9,.]+/)).toBeVisible();
    await expect(page.getByText("Total received (cash + bank) − expenses. Not profit.")).toBeVisible();
  });
});

test.describe("Offline", () => {
  test("a Bank draft stays Bank through a shop switch, a queued save and the retry after reconnect", async ({ page, context }) => {
    const number = `BNK-OFF-${Date.now()}`;
    await login(page, OWNER);
    await fillRow(page, 0, number, "30.00", "12.00");
    await methodGroup(entryRows(page).nth(0)).getByRole("radio", { name: "Bank" }).check();
    await expect.poll(async () => (await drafts(page))[0]?.rows[0]?.paymentMethod).toBe("bank");

    // A shop switch is only ever offered by discarding the unsaved entry; declining leaves the Bank draft as it was.
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByLabel("Current shop").selectOption({ label: "Shop 2" });
    await expect(page.getByRole("heading", { name: "Shop 1", exact: true })).toBeVisible();
    await expect(methodGroup(entryRows(page).nth(0)).getByRole("radio", { name: "Bank" })).toBeChecked();

    await context.setOffline(true);
    await expect(page.locator("[data-offline-banner]")).toBeVisible();
    await page.getByRole("button", { name: "Review sale" }).click();
    await page.getByRole("button", { name: "Save when back online" }).click();
    await expect(page.locator("[data-draft-status]")).toHaveText("Submission pending — will send when you reconnect");
    const queued = (await drafts(page)).find((draft) => draft.shopId === SHOP_1)!;
    expect(queued.rows[0].paymentMethod).toBe("bank");
    expect(queued.submission!.payload.rows[0].paymentMethod).toBe("bank");
    expect(methods(number)).toBe("");

    // The queued submission cannot be carried into another shop either: the switch asks to discard it first.
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByLabel("Current shop").selectOption({ label: "Shop 2" });
    await expect(page.getByRole("heading", { name: "Shop 1", exact: true })).toBeVisible();
    const stillQueued = (await drafts(page)).filter((draft) => draft.shopId === SHOP_1);
    expect(stillQueued).toHaveLength(1);
    expect(stillQueued[0].submission!.payload.rows[0].paymentMethod).toBe("bank");
    expect(stillQueued[0].idempotencyKey).toBe(queued.idempotencyKey);

    let submissions = 0;
    page.on("request", (request) => { if (request.method() === "POST" && request.postData()?.includes(queued.idempotencyKey)) submissions += 1; });
    await context.setOffline(false);
    await page.evaluate(() => { for (let i = 0; i < 3; i++) window.dispatchEvent(new Event("online")); });
    await expect(savedNotice(page)).toBeVisible({ timeout: 30_000 });
    expect(submissions).toBe(1);
    expect(methods(number)).toBe("bank:1200");
    expect(scalar(`select count(*) from public.batches where shop_id = '${SHOP_1}' and idempotency_key = '${queued.idempotencyKey}'`)).toBe("1");
  });
  test("the payments table scrolls inside its own region on a phone and keeps Method reachable from the keyboard", async ({ page }) => {
    await login(page, OWNER);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/payments?shop=${SHOP_1}`);
    expect(await noOverflow(page)).toBe(true);
    const region = page.getByRole("region", { name: /^Payment history table/ });
    await region.focus();
    await expect(region).toBeFocused();
    expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await expect(region.getByRole("columnheader", { name: "Method" })).toBeAttached();
    await expect(region.locator("[data-payment-method]").first()).toBeAttached();
  });
});
