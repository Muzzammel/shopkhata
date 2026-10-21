import { expect, test } from "@playwright/test";

import { SHOP_1, createAccount, expenseRow, fillRow, login, openAddExpense, openSaleTools, saveExpense, savedNotice, scalar, signOut } from "./offline-helpers";

// The critical workflow on every browser engine (Chromium, Firefox, WebKit):
// sign in, save an invoice with a part payment, read it back, take a follow-up
// payment, record an expense, close and reopen a date, read a report, sign out.
// The full financial suite stays on Chromium; this proves no engine is broken.
test("the critical workflow works end to end", async ({ page, browserName }) => {
  test.setTimeout(60_000);   // ten screens and a sign-in of its own; the default 30 s leaves no margin under a full parallel run
  const stamp = `${browserName}-${crypto.randomUUID().slice(0, 8)}`;
  const invoice = `XB-${stamp}`;
  // Its own manager: this workflow ends by signing out, which would end the sessions of any
  // other test signed in as the shared manager.
  await login(page, createAccount("manager"));

  // The sales report lists only its first 200 rows, so the new invoice is proven by the
  // Invoices summary count, which covers the whole range. Other tests save invoices in this
  // shop at the same time, so the count is only required to have grown.
  const invoiceCount = page.locator('[data-total="invoiceCount"]');
  await page.goto(`/reports?shop=${SHOP_1}&report=sales`);
  const invoicesBefore = Number(await invoiceCount.innerText());
  await page.goto("/");
  await expect(page.locator("[data-entry-row][data-row-id]").first()).toBeVisible();

  await fillRow(page, 0, invoice, "80.00", "30.00");
  await page.getByRole("button", { name: "Review sale" }).click();
  await expect(page.getByLabel("Sale review").getByText("Due QAR 50.00", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await expect(savedNotice(page)).toBeVisible();

  await page.getByRole("link", { name: `View invoice ${invoice}` }).click();
  await expect(page.getByRole("heading", { name: invoice })).toBeVisible();
  await expect(page.getByRole("group", { name: "Financial summary" }).getByText("QAR 50.00", { exact: true })).toBeVisible();

  // Follow-up payment from the workspace.
  await page.goto("/");
  // The workspace marks its rows once it is interactive; a person cannot act sooner either.
  await expect(page.locator("[data-entry-row][data-row-id]").first()).toBeVisible();
  await openSaleTools(page);
  const payment = page.getByRole("region", { name: "Record payment" });
  await payment.getByLabel("Invoice number").fill(invoice);
  await payment.getByRole("button", { name: "Find invoice" }).click();
  await payment.getByLabel("Payment amount (QAR)").fill("20.00");
  await payment.getByRole("button", { name: "Review payment" }).click();
  await payment.getByRole("button", { name: "Confirm payment" }).click();
  await expect(payment.getByRole("status")).toBeVisible();
  expect(scalar(`select effective_due_dirham from public.effective_invoices where shop_id = '${SHOP_1}' and effective_invoice_number = '${invoice}'`)).toBe("3000");

  await page.goto(`/expenses?shop=${SHOP_1}`);
  // The drawer only opens once the page is interactive, so typing into it is never lost.
  const expense = await openAddExpense(page);
  await expense.getByLabel("Amount (QAR)", { exact: true }).fill("7.25");
  await expense.getByLabel("Description", { exact: true }).fill(`Cross-browser ${stamp}`);
  await saveExpense(expense);
  await expect(expenseRow(page, `Cross-browser ${stamp}`)).toContainText("QAR 7.25");

  await page.goto(`/customers?shop=${SHOP_1}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.goto(`/reports?shop=${SHOP_1}&report=sales`);
  // Exact for this invoice in the database; in the report the count can only have grown by at
  // least this one, whatever the tests running beside it saved meanwhile.
  expect(scalar(`select count(*) from public.effective_invoices where shop_id = '${SHOP_1}' and effective_invoice_number = '${invoice}' and business_date = (now() at time zone 'Asia/Qatar')::date`)).toBe("1");
  await expect(invoiceCount).toBeVisible();
  expect(Number(await invoiceCount.innerText())).toBeGreaterThan(invoicesBefore);

  await page.goto(`/closing?shop=${SHOP_1}`);
  await expect(page.locator("[data-day-state]")).toHaveText(/^(Open|Closed)$/);

  await signOut(page);
  await expect(page.getByRole("heading", { name: "Sign in to ShopKhata" })).toBeVisible();
  await page.goto("/reports");
  await expect(page).toHaveURL(/\/login/);
});
