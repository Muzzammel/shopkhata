import { expect, test, type Browser, type Page } from "@playwright/test";

import { qatarBusinessDate } from "@/lib/invoice-entry";

import { OWNER, SHOP_1, SHOP_2, STAFF, invoiceCount, localDbQuery, login, openAddExpense, paymentCount, savedNotice, scalar, storedDrafts } from "./offline-helpers";

// OPS-01B slice 1: tabs that were opened and filled in BEFORE maintenance started cannot complete a write after it
// starts, without any reload. Maintenance is global, so this file runs serially and always switches it off again.
test.describe.configure({ mode: "serial" });

const setMaintenance = (enabled: boolean) => localDbQuery(enabled
  ? "update private.system_maintenance set enabled = true, enabled_at = now(), enabled_by = '10000000-0000-4000-8000-000000000101', reason = 'e2e already-open tabs', release_ref = 'e2e'"
  : "update private.system_maintenance set enabled = false, enabled_at = null, enabled_by = null, reason = null, release_ref = null, bypass_user_id = null, bypass_expires_at = null, bypass_enabled_by = null, bypass_reason = null");
const oldDate = () => new Date(Date.parse(`${qatarBusinessDate(new Date())}T12:00:00.000Z`) - (9000 + Math.floor(Math.random() * 1000)) * 86_400_000).toISOString().slice(0, 10);

async function signedIn(browser: Browser, user: typeof STAFF): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await login(page, user);
  return page;
}

test.afterAll(() => { setMaintenance(false); });

test("already-open tabs: sale, payment, expense and Daily Close are refused by the backend once maintenance starts", async ({ browser }) => {
  const stamp = Date.now();
  const sold = `MT-PAY-${stamp}`;
  const blocked = `MT-SALE-${stamp}`;
  const description = `Maintenance expense ${stamp}`;
  const date = oldDate();

  // Normal operation: an invoice to pay later.
  const owner = await signedIn(browser, OWNER);
  await owner.goto("/");
  let row = owner.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(sold);
  await row.getByLabel("Total QAR").fill("40.00");
  await owner.getByRole("button", { name: "Review sale" }).click();
  await owner.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await expect(savedNotice(owner)).toBeVisible();

  // Tab 1 (staff): a sale reviewed and ready to save.
  const sale = await signedIn(browser, STAFF);
  await sale.goto("/");
  row = sale.locator("[data-entry-row]").first();
  await row.getByLabel("Invoice ID").fill(blocked);
  await row.getByLabel("Total QAR").fill("25.00");
  await sale.getByRole("button", { name: "Review sale" }).click();
  // Tab 2 (owner): a payment reviewed and ready to confirm.
  await owner.goto(`/payments?shop=${SHOP_1}`);
  const form = owner.getByRole("region", { name: "Record payment" });
  await form.getByLabel("Invoice number").fill(sold);
  await form.getByRole("button", { name: "Find invoice" }).click();
  await expect(form.getByRole("heading", { name: sold })).toBeVisible();
  await form.getByLabel("Payment amount (QAR)").fill("15.00");
  await form.getByRole("button", { name: "Review payment" }).click();
  // Tab 3 (staff): an expense reviewed and ready to save.
  const expense = await signedIn(browser, STAFF);
  await expense.goto(`/expenses?shop=${SHOP_1}`);
  const drawer = await openAddExpense(expense);
  await drawer.getByLabel("Amount (QAR)", { exact: true }).fill("3.50");
  await drawer.getByLabel("Description", { exact: true }).fill(description);
  await drawer.getByRole("button", { name: "Review expense" }).click();
  // Tab 4 (owner, second context): Daily Close confirmed and ready to submit.
  const close = await signedIn(browser, OWNER);
  await close.goto(`/closing?shop=${SHOP_2}&date=${date}`);
  await close.getByRole("button", { name: "Review close" }).click();
  await close.getByRole("checkbox").check();

  setMaintenance(true);

  await sale.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await expect(sale.getByText(/ShopKhata is being updated/).first()).toBeVisible();
  expect(invoiceCount(blocked)).toBe("0");
  // The refusal is "try later", not a rejection: the draft and its queued submission stay on the device.
  expect((await storedDrafts(sale)).flatMap((draft) => draft.rows.map((r) => r.invoiceId))).toContain(blocked);

  await form.getByRole("button", { name: "Confirm payment" }).click();
  await expect(form.getByText(/could not be recorded/i)).toBeVisible();
  expect(paymentCount(sold)).toBe("0");

  await drawer.getByRole("button", { name: "Save expense" }).click();
  await expect(drawer.getByText(/could not|not saved|failed/i).first()).toBeVisible();
  expect(scalar(`select count(*) from public.expenses where description = '${description}'`)).toBe("0");

  await close.getByRole("button", { name: "Close business date" }).click();
  await expect(close.locator("[data-day-state]")).toHaveText("Open");
  expect(scalar(`select count(*) from public.daily_closes where shop_id = '${SHOP_2}' and business_date = '${date}'`)).toBe("0");

  // Reopen: the same tab saves the same draft (nothing was lost).
  setMaintenance(false);
  await sale.getByRole("button", { name: /^Save (sale|\d+ invoices)$|^Retry/ }).first().click();
  await expect.poll(() => invoiceCount(blocked), { timeout: 15_000 }).toBe("1");
});
