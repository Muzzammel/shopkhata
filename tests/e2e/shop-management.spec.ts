import { expect, test, type Page } from "@playwright/test";

import { createAccount, entryRows, fillRow, localDbQuery, login, MANAGER, OWNER, openAddExpense, saveExpense, savedNotice, scalar, SHOP_1, storedDrafts } from "./offline-helpers";

// Owner-only Shop / Branch Management: create, rename, the global switcher, assignment, audit history,
// and that a new shop starts empty and isolated. One serial flow because each step builds on the shop
// the previous one made. Shops cannot be deleted (their audit rows are append-only), so the shop is
// deactivated at the end, which removes it from every other screen and leaves later specs untouched.

test.describe.configure({ mode: "serial" });

const stamp = Date.now();
const NAME = `Shop 3 E2E ${stamp}`;
const RENAMED = `Shop 3 E2E Central ${stamp}`;
const SALE = `SHOP-ISO-${stamp}`;
const EXPENSE = `Shop isolation expense ${stamp}`;
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const directory = (page: Page) => page.getByRole("table", { name: "Every shop and how many accounts are assigned to it" });
const shopId = () => scalar(`select id from public.shops where name in ('${NAME}', '${RENAMED}')`);

async function addShop(page: Page, name: string) {
  await page.goto("/admin/shops");
  await page.getByRole("button", { name: "Add shop" }).click();
  const drawer = page.getByRole("dialog", { name: "Add a shop" });
  await drawer.getByLabel("Shop / Branch name").fill(name);
  await drawer.getByRole("button", { name: "Review shop" }).click();
  return drawer;
}

test.describe("Shop management", () => {
  test("only an owner reaches Shops; managers and staff get the not-found page", async ({ page }) => {
    await login(page, MANAGER);
    const response = await page.goto("/admin/shops");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "Shops" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Shops" })).toHaveCount(0);
  });

  test("the directory lists real data only and offers no archive or delete", async ({ page }) => {
    await login(page, OWNER);
    await page.goto("/admin/shops");
    await expect(page.getByRole("heading", { level: 1, name: "Shops" })).toBeVisible();
    await expect(page.getByText("Owner only · All shops")).toBeVisible();
    for (const name of ["Shop 1", "Shop 2"]) {
      const row = directory(page).getByRole("row", { name: new RegExp(name) });
      await expect(row.locator("[data-status=active]")).toHaveText("Active");
      await expect(row.getByRole("button", { name: `Manage ${name}` })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: /archive|deactivate|delete|remove/i })).toHaveCount(0);
    expect(await noOverflow(page)).toBe(true);
    // The admin tabs link to Shops.
    await expect(page.getByRole("link", { name: "Shops" }).first()).toBeVisible();
  });

  test("adding a shop reviews first, then creates an empty shop and shows it in the switcher", async ({ page }) => {
    await login(page, OWNER);
    const drawer = await addShop(page, `  shop 1 `);
    await expect(drawer.getByText("Another shop already uses that name.")).toBeVisible();
    await drawer.getByLabel("Shop / Branch name").fill(NAME);
    await drawer.getByRole("button", { name: "Review shop" }).click();
    await expect(drawer.getByText("Every owner can use it automatically")).toBeVisible();
    await expect(drawer.getByText("will appear in the global shop switcher")).toBeVisible();
    await expect(drawer.getByText("Manager and staff access can be assigned after creation")).toBeVisible();
    expect(scalar(`select count(*) from public.shops where name = '${NAME}'`)).toBe("0");
    await drawer.getByRole("button", { name: "Create shop" }).click();
    await expect(drawer).toHaveCount(0);
    await expect(directory(page).getByRole("row", { name: new RegExp(NAME) })).toBeVisible();

    const id = shopId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(scalar(`select count(*) from public.user_shop_assignments where shop_id = '${id}'`)).toBe("0");
    expect(scalar(`select count(*) from public.invoices where shop_id = '${id}'`) + scalar(`select count(*) from public.customers where shop_id = '${id}'`)
      + scalar(`select count(*) from public.expenses where shop_id = '${id}'`) + scalar(`select count(*) from public.payments where shop_id = '${id}'`)).toBe("0000");

    // The owner can switch to it from any shop-scoped screen.
    await page.goto(`/dashboard?shop=${SHOP_1}`);
    await page.getByRole("button", { name: /^Shop: .*Change shop$/ }).click();
    await page.getByRole("menuitemradio", { name: NAME }).click();
    await expect(page).toHaveURL(new RegExp(`shop=${id}`));
    await expect(page.getByRole("button", { name: `Shop: ${NAME}. Change shop` })).toBeVisible();
  });

  test("a new shop shows none of Shop 1's sales, customers, expenses or Cash and Bank totals", async ({ page }) => {
    await login(page, OWNER);
    const id = shopId();
    // Real Shop 1 activity first: a Bank sale and an expense.
    await page.goto(`/?shop=${SHOP_1}`);
    await fillRow(page, 0, SALE, "777.77", "777.77");
    await entryRows(page).nth(0).getByRole("group", { name: "Payment method" }).getByRole("radio", { name: "Bank" }).check();
    await page.getByRole("button", { name: "Review sale" }).click();
    await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
    await expect(savedNotice(page)).toBeVisible();
    await page.goto(`/expenses?shop=${SHOP_1}`);
    const form = await openAddExpense(page);
    await form.getByLabel("Amount (QAR)", { exact: true }).fill("55.55");
    await form.getByLabel("Description", { exact: true }).fill(EXPENSE);
    await saveExpense(form);
    await expect(form).toHaveCount(0);

    for (const path of ["dashboard", "invoices", "customers", "expenses", "payments", "closing", "reports"]) {
      await page.goto(`/${path}?shop=${id}`);
      // Wait for the loaded page (not its loading skeleton) so an empty result is a real one.
      const main = page.locator("main:not([aria-busy=true])");
      await expect(main).toContainText(NAME);
      const text = await main.innerText();
      expect(text, `${path} must not show Shop 1 figures`).not.toMatch(/777\.77|55\.55/);
      expect(text, `${path} must not show Shop 1 records`).not.toContain(SALE);
      expect(text).not.toContain(EXPENSE);
      expect(await noOverflow(page)).toBe(true);
    }
    // Shop 1 itself still shows them.
    await page.goto(`/invoices?shop=${SHOP_1}`);
    await expect(page.getByText(SALE).first()).toBeVisible();
    expect(scalar(`select count(*) from public.payments p join public.invoices i on i.id = p.invoice_id where i.shop_id = '${id}'`)).toBe("0");
    expect(scalar(`select coalesce(sum(bank_received_dirham), 0) from public.report_daily_summary('${id}', current_date - 1, current_date + 1)`)).toBe("0");
  });

  test("renaming reviews the change, keeps the shop id and is written to the history in words", async ({ page }) => {
    await login(page, OWNER);
    const id = shopId();
    await page.goto("/admin/shops");
    await directory(page).getByRole("button", { name: `Manage ${NAME}` }).click();
    const drawer = page.getByRole("dialog", { name: `Manage ${NAME}` });
    await expect(drawer.getByText(id)).toBeVisible();
    await drawer.getByLabel("Shop / Branch name").fill(RENAMED);
    await drawer.getByRole("button", { name: "Review rename" }).click();
    const comparison = drawer.getByRole("table", { name: "Requested shop change" });
    await expect(comparison).toContainText(NAME);
    await expect(comparison).toContainText(RENAMED);
    await expect(drawer.getByText("Historical records stay attached to the same shop ID.")).toBeVisible();
    await drawer.getByRole("button", { name: "Save name" }).click();
    await expect(drawer).toHaveCount(0);
    await expect(directory(page).getByRole("row", { name: new RegExp(RENAMED) })).toBeVisible();
    expect(shopId()).toBe(id);

    const history = page.getByRole("region", { name: "Recent shop changes" });
    await expect(history).toContainText(`Shop renamed: ${NAME} → ${RENAMED}`);
    await expect(history).toContainText(`Shop created: ${NAME}`);
    await expect(history).not.toContainText("old_name");
    await expect(history).not.toContainText("{");
  });

  test("sales entry offers the new shop: a Shop 1 draft never follows the owner into it and a Bank sale saves only there", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept());
    await login(page, OWNER);
    const id = shopId();
    const selector = page.getByLabel("Current shop");
    await expect(selector.locator("option")).toHaveText(["Shop 1", "Shop 2", RENAMED]);
    const draft = `SHOP-DRAFT-${stamp}`;
    await fillRow(page, 0, draft, "9.00", "9.00");
    await selector.selectOption({ label: RENAMED });
    await expect(page.getByRole("heading", { name: RENAMED, exact: true })).toBeVisible();
    await expect(page.getByLabel("Invoice ID")).toHaveValue("");

    const own = `SHOP-NEW-${stamp}`;
    await fillRow(page, 0, own, "20.00", "20.00");
    await entryRows(page).nth(0).getByRole("group", { name: "Payment method" }).getByRole("radio", { name: "Bank" }).check();
    await page.getByRole("button", { name: "Review sale" }).click();
    await page.getByRole("button", { name: /^Save (sale|d+ invoices)$/ }).click();
    await expect(savedNotice(page)).toBeVisible();
    expect(scalar(`select shop_id from public.invoices where invoice_id = '${own}'`)).toBe(id);
    expect(scalar(`select p.payment_method from public.payments p join public.invoices i on i.id = p.invoice_id where i.invoice_id = '${own}'`)).toBe("bank");
    expect(scalar(`select count(*) from public.invoices where invoice_id = '${draft}'`)).toBe("0");
    expect((await storedDrafts(page)).filter((stored) => stored.rows.some((row) => row.invoiceId === draft))).toEqual([]);
  });

  test("manager and staff see the shop only while assigned, using the existing Accounts flow", async ({ browser, page }) => {
    const id = shopId();
    const staff = createAccount("staff");
    await login(page, OWNER);
    const staffPage = await browser.newPage();
    await login(staffPage, staff);
    await expect(staffPage.getByRole("button", { name: /Change shop$/ })).toHaveCount(0);

    // Assign through the Accounts drawer, not a second assignment screen.
    await page.goto("/admin");
    await page.getByRole("row", { name: new RegExp(staff.email) }).getByRole("button", { name: /^Manage / }).click();
    const drawer = page.getByRole("dialog", { name: /^Manage / });
    await drawer.getByLabel(RENAMED).check();
    await drawer.getByRole("button", { name: "Review changes" }).click();
    await drawer.getByRole("button", { name: "Save account" }).click();
    await expect(drawer).toHaveCount(0);
    expect(scalar(`select count(*) from public.user_shop_assignments a join public.profiles p on p.id = a.user_id where p.email = '${staff.email}' and a.shop_id = '${id}'`)).toBe("1");

    await staffPage.goto(`/dashboard?shop=${SHOP_1}`);
    await staffPage.getByRole("button", { name: /^Shop: .*Change shop$/ }).click();
    await staffPage.getByRole("menuitemradio", { name: RENAMED }).click();
    await expect(staffPage.getByRole("button", { name: `Shop: ${RENAMED}. Change shop` })).toBeVisible();

    // Shop 1 and the new shop are listed on the Shops page for the owner with the assigned account counted.
    await page.goto("/admin/shops");
    await expect(directory(page).getByRole("row", { name: new RegExp(RENAMED) }).locator("[data-slot=assigned-count]")).toHaveText("1 account assigned");

    localDbQuery(`delete from public.user_shop_assignments a using public.profiles p where p.id = a.user_id and p.email = '${staff.email}' and a.shop_id = '${id}'`);
    await staffPage.goto(`/dashboard?shop=${SHOP_1}`);
    await expect(staffPage.getByRole("button", { name: /Change shop$/ })).toHaveCount(0);
    await staffPage.close();
  });

  test("duplicate and invalid names are refused, and the page works at phone width", async ({ page }) => {
    await login(page, OWNER);
    await page.setViewportSize({ width: 375, height: 800 });
    const drawer = await addShop(page, RENAMED.toUpperCase());
    await expect(drawer.getByText("Another shop already uses that name.")).toBeVisible();
    await drawer.getByLabel("Shop / Branch name").fill("   ");
    await drawer.getByRole("button", { name: "Review shop" }).click();
    await expect(drawer.getByText("Enter the shop or branch name.")).toBeVisible();
    expect(scalar(`select count(*) from public.shops where lower(name) = lower('${RENAMED}')`)).toBe("1");
    expect(await noOverflow(page)).toBe(true);
  });

  test.afterAll(() => {
    localDbQuery(`update public.shops set is_active = false where name in ('${NAME}', '${RENAMED}')`);
  });
});
