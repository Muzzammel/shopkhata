import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
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
/** The owner signed in straight to the API, for writes that bypass the screens. */
async function ownerClient() {
  const envText = execFileSync(process.execPath, [join(process.cwd(), "node_modules/supabase/dist/supabase.js"), "--agent", "no", "status", "-o", "env"], { encoding: "utf8" });
  const env = Object.fromEntries(envText.split(/\r?\n/).map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/)).filter((match) => match !== null).map((match) => [match[1], match[2]]));
  const client = createClient(env.API_URL, env.PUBLISHABLE_KEY ?? env.ANON_KEY);
  expect((await client.auth.signInWithPassword(OWNER)).error).toBeNull();
  return client;
}


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

  test("deactivating needs a reason and a review, keeps the shop listed, refuses a sale already open in another tab, and reactivation restores it", async ({ page }) => {
    const id = shopId();
    const sale = `SHOP-INACTIVE-${stamp}`;
    await login(page, OWNER);
    // A New Sale screen opened for the shop before it is deactivated.
    await page.goto(`/?shop=${id}`);
    await expect(page.getByRole("heading", { name: RENAMED, exact: true })).toBeVisible();
    await fillRow(page, 0, sale, "12.00", "12.00");

    const admin = await page.context().newPage();
    await admin.goto("/admin/shops");
    const row = directory(admin).getByRole("row", { name: new RegExp(RENAMED) });
    await row.getByRole("button", { name: `Manage ${RENAMED}` }).click();
    const drawer = admin.getByRole("dialog", { name: `Manage ${RENAMED}` });
    const status = drawer.getByRole("region", { name: "Shop status" });
    await status.getByRole("button", { name: "Deactivate shop" }).click();
    await status.getByRole("button", { name: "Review deactivation" }).click();
    await expect(status.getByText("Enter the reason for deactivating this shop.")).toBeVisible();
    await expect(status.getByLabel("Reason")).toBeFocused();
    await status.getByLabel("Reason").fill("Branch closed for refit");
    await status.getByRole("button", { name: "Review deactivation" }).click();
    await expect(status.getByRole("table", { name: "Requested shop status change" }).getByRole("row", { name: /Status/ })).toContainText(/Active\s*Inactive/);
    const effects = status.getByRole("list", { name: "What deactivation does" });
    await expect(effects).toContainText("owners can still open its history, marked INACTIVE — READ ONLY");
    await expect(effects).toContainText("Nothing is deleted");
    expect(scalar(`select is_active from public.shops where id = '${id}'`)).toBe("true");
    await status.getByRole("button", { name: "Confirm: deactivate shop" }).click();
    await expect(drawer).toHaveCount(0);

    // Still listed, clearly marked, with the change and its reason in the history.
    await expect(row.locator("[data-status=inactive]")).toHaveText("Inactive");
    expect(scalar(`select is_active from public.shops where id = '${id}'`)).toBe("false");
    const history = admin.getByRole("region", { name: "Recent shop changes" });
    await expect(history).toContainText(`Shop deactivated: ${RENAMED}`);
    await expect(history).toContainText("Reason: Branch closed for refit");
    expect(scalar(`select count(*) from public.invoices where shop_id = '${id}'`)).not.toBe("0");

    // The sale that was already on screen is refused by the database and kept on the device.
    await page.getByRole("button", { name: "Review sale" }).click();
    await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
    await expect(page.getByText(/This shop is inactive\. Nothing was saved/).first()).toBeVisible();
    expect(scalar(`select count(*) from public.invoices where invoice_id = '${sale}'`)).toBe("0");

    // The owner's switcher marks it read-only history.
    await page.goto(`/dashboard?shop=${SHOP_1}`);
    await page.getByRole("button", { name: /^Shop: .*Change shop$/ }).click();
    await expect(page.getByRole("menuitemradio", { name: RENAMED })).toHaveText(`${RENAMED}(inactive, read only)`);
    await page.keyboard.press("Escape");

    // Reactivation is the same governed flow.
    await row.getByRole("button", { name: `Manage ${RENAMED}` }).click();
    await expect(drawer.getByRole("button", { name: "Deactivate shop" })).toHaveCount(0);
    await drawer.getByRole("button", { name: "Reactivate shop" }).click();
    await drawer.getByLabel("Reason").fill("Refit finished");
    await drawer.getByRole("button", { name: "Review reactivation" }).click();
    await drawer.getByRole("button", { name: "Confirm: reactivate shop" }).click();
    await expect(drawer).toHaveCount(0);
    await expect(row.locator("[data-status=active]")).toHaveText("Active");
    await expect(history).toContainText(`Shop reactivated: ${RENAMED}`);
    expect(scalar(`select string_agg(action || ':' || reason, ',' order by recorded_at) from public.audit_events where entity_id = '${id}' and action like 'shop.%activate'`))
      .toBe("shop.deactivate:Branch closed for refit,shop.reactivate:Refit finished");
    await page.goto(`/dashboard?shop=${SHOP_1}`);
    await page.getByRole("button", { name: /^Shop: .*Change shop$/ }).click();
    await expect(page.getByRole("menuitemradio", { name: RENAMED })).toHaveText(RENAMED);
    await admin.close();
  });

  test("an owner reads an inactive shop's history read-only; staff gain nothing; writes stay refused until reactivation", async ({ browser, page }) => {
    const id = shopId();
    const sale = `SHOP-NEW-${stamp}`;
    const invoiceId = scalar(`select id from public.invoices where invoice_id = '${sale}'`);
    const owner = await ownerClient();
    const deactivate = await owner.rpc("admin_set_shop_status", { command: { shop_id: id, is_active: false, reason: "History check" } });
    expect(deactivate.error).toBeNull();
    const banner = page.locator("[data-slot=read-only-banner]");
    const before = scalar(`select count(*) from public.customers where shop_id = '${id}'`) + scalar(`select count(*) from public.invoices where shop_id = '${id}'`);

    // Opened from Shop Management, never by default.
    await login(page, OWNER);
    await expect(banner).toHaveCount(0);
    await page.goto("/admin/shops");
    await directory(page).getByRole("row", { name: new RegExp(RENAMED) }).getByRole("link", { name: `View ${RENAMED} history (read only)` }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard\\?shop=${id}`));
    await expect(banner).toContainText("INACTIVE — READ ONLY");
    await expect(page.getByRole("button", { name: `Shop: ${RENAMED}. Change shop` })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Quick actions" }).getByRole("link")).toHaveCount(0);
    // The audit history is part of what stays visible.
    await expect(page.locator("main:not([aria-busy=true])")).toContainText("Shop deactivated");

    // Every history screen shows the records; none offers a new one.
    await page.goto(`/invoices?shop=${id}`);
    await expect(page.getByText(sale).first()).toBeVisible();
    await expect(banner).toBeVisible();
    await expect(page.getByRole("link", { name: "New sale" })).toHaveCount(0);
    await page.goto(`/shops/${id}/invoices/${invoiceId}`);
    await expect(page.getByRole("heading", { name: sale })).toBeVisible();
    const actions = page.getByRole("navigation", { name: "Invoice actions" });
    await expect(actions.getByRole("button", { name: /Record payment|Request correction|Request delivery change/ })).toHaveCount(0);
    await actions.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Request replacement" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Print" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto(`/payments?shop=${id}`);
    await expect(page.getByRole("link", { name: sale }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Find invoice" })).toHaveCount(0);
    await page.goto(`/customers?shop=${id}`);
    await expect(page.locator("main:not([aria-busy=true])")).toContainText(RENAMED);
    await expect(page.getByRole("button", { name: "Add customer" })).toHaveCount(0);
    await page.goto(`/expenses?shop=${id}`);
    await expect(page.locator("main:not([aria-busy=true])")).toContainText(RENAMED);
    await expect(page.getByRole("button", { name: "Add expense" })).toHaveCount(0);
    await page.goto(`/closing?shop=${id}`);
    await expect(page.locator("main:not([aria-busy=true])")).toContainText("20.00");
    await expect(page.getByRole("button", { name: /Review (close|reopen)/ })).toHaveCount(0);
    await page.goto(`/reports?shop=${id}&report=sales`);
    await expect(page.getByRole("link", { name: sale })).toBeVisible();
    await expect(page.getByRole("link", { name: "Export this report (.xlsx)" })).toBeVisible();
    await page.goto(`/?shop=${id}`);
    await expect(page.getByText(`${RENAMED} is inactive, so no new sale can be recorded.`)).toBeVisible();
    await expect(page.getByLabel("Invoice ID")).toHaveCount(0);

    // A direct write as the owner still fails in the database.
    const refused = await owner.rpc("create_customer", { command: { shop_id: id, name: `Refused ${stamp}` } });
    expect(refused.error?.message).toBe("SHOP_INACTIVE");
    expect(scalar(`select count(*) from public.customers where shop_id = '${id}'`) + scalar(`select count(*) from public.invoices where shop_id = '${id}'`)).toBe(before);

    // Staff assigned to the inactive shop gain no view of it.
    const staff = createAccount("staff");
    localDbQuery(`insert into public.user_shop_assignments(user_id, shop_id) select id, '${id}' from public.profiles where email = '${staff.email}'`);
    const staffPage = await browser.newPage();
    await login(staffPage, staff);
    // Assigned to Shop 1 and the inactive shop: only Shop 1 is offered, and asking for the other falls back to it.
    await expect(staffPage.getByRole("button", { name: /Change shop$/ })).toHaveCount(0);
    await staffPage.goto(`/invoices?shop=${id}`);
    await expect(staffPage.locator("main:not([aria-busy=true])")).toContainText("Shop 1");
    await expect(staffPage.locator("main:not([aria-busy=true])")).not.toContainText(sale);
    await expect(staffPage.locator("[data-slot=read-only-banner]")).toHaveCount(0);
    await staffPage.goto(`/?shop=${id}`);
    await expect(staffPage.getByRole("heading", { name: "Shop 1", exact: true })).toBeVisible();
    expect((await staffPage.goto(`/shops/${id}/invoices/${invoiceId}`))?.status()).toBe(404);
    await staffPage.close();

    // Reactivation restores normal operation.
    expect((await owner.rpc("admin_set_shop_status", { command: { shop_id: id, is_active: true, reason: "History check done" } })).error).toBeNull();
    await page.goto(`/invoices?shop=${id}`);
    await expect(page.getByRole("link", { name: "New sale" }).first()).toBeVisible();
    await expect(banner).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Quick actions" }).getByRole("link", { name: "New sale" })).toHaveCount(1);
    const allowed = await owner.rpc("create_customer", { command: { shop_id: id, name: `Allowed ${stamp}` } });
    expect(allowed.error).toBeNull();
  });

  test("the inactive state is readable at phone width", async ({ page }) => {
    localDbQuery(`update public.shops set is_active = false where name = '${RENAMED}'`);
    await login(page, OWNER);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/admin/shops");
    await expect(directory(page).getByRole("row", { name: new RegExp(RENAMED) }).locator("[data-status=inactive]")).toHaveText("Inactive");
    expect(await noOverflow(page)).toBe(true);
    await directory(page).getByRole("button", { name: `Manage ${RENAMED}` }).click();
    const drawer = page.getByRole("dialog", { name: `Manage ${RENAMED}` });
    await drawer.getByRole("button", { name: "Reactivate shop" }).click();
    await expect(drawer.getByLabel("Reason")).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
  });

  test.afterAll(() => {
    localDbQuery(`update public.shops set is_active = false where name in ('${NAME}', '${RENAMED}')`);
  });
});
