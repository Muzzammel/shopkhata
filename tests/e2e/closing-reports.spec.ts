import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { qatarBusinessDate } from "@/lib/invoice-entry";
import { DAILY_SUMMARY_HEADERS, PAYMENT_REPORT_HEADERS } from "@/lib/reports";

import {
  MANAGER, OWNER, OWNER_ID, SHOP_1, SHOP_2, STAFF, draftStatus, entryRows, expectStoredRows, invoiceCount, localDbQuery, login, openAddExpense, queueOffline, saveExpense,
  readDownload, savedNotice, scalar,
} from "./offline-helpers";

// Every test closes a business date nobody else uses (a different band of old
// dates per test), so closing it cannot disturb any other test or shop.
const today = () => qatarBusinessDate(new Date());
function oldDate(band: number) {
  return new Date(Date.parse(`${today()}T12:00:00.000Z`) - (band * 1000 + Math.floor(Math.random() * 1000)) * 86_400_000).toISOString().slice(0, 10);
}
const dayState = (page: Page) => page.locator("[data-day-state]");
const metric = (page: Page, key: string) => page.locator(`[data-metric="${key}"]`);
const total = (page: Page, key: string) => page.locator(`[data-total="${key}"]`);
const closeState = (shop: string, date: string) => scalar(`coalesce((select event_type from public.daily_closes where shop_id = '${shop}' and business_date = '${date}' order by event_sequence desc limit 1), 'open')`);

const invalid = (page: Page, label: string | RegExp) => page.getByLabel(label).evaluate((field: HTMLInputElement) => !field.validity.valid);
async function closeDate(page: Page, note = "") {
  // The close is reviewed in a drawer first; the drawer's own button submits it.
  await page.getByRole("button", { name: "Review close" }).click();
  const button = page.getByRole("button", { name: "Close business date" });
  // Without the explicit confirmation the browser refuses to submit.
  await button.click();
  expect(await invalid(page, /I understand that closing blocks/)).toBe(true);
  await expect(dayState(page)).toHaveText("Open");
  if (note) await page.getByLabel("Close note (optional)").fill(note);
  await page.getByRole("checkbox").check();
  await button.click();
  await expect(dayState(page)).toHaveText("Closed");
}
async function reopenDate(page: Page, reason: string) {
  await page.getByRole("button", { name: "Review reopen" }).click();
  const button = page.getByRole("button", { name: "Reopen business date" });
  await page.getByRole("checkbox").check();
  // The reason is mandatory: the confirmation alone does not reopen the date.
  await button.click();
  expect(await invalid(page, "Reason for reopening")).toBe(true);
  await expect(dayState(page)).toHaveText("Closed");
  await page.getByLabel("Reason for reopening").fill(reason);
  await button.click();
  await expect(dayState(page)).toHaveText("Open");
}
async function fillExpense(page: Page, shop: string, date: string, amount: string, description: string, reason: string) {
  await page.goto(`/expenses?shop=${shop}`);
  // The drawer opens only once React has hydrated, so the controlled date input keeps what is typed.
  const form = await openAddExpense(page);
  await form.getByLabel("Amount (QAR)", { exact: true }).fill(amount);
  await form.getByLabel("Description", { exact: true }).fill(description);
  const dateInput = form.getByLabel("Business date", { exact: true });
  await dateInput.fill(date);
  await expect(dateInput).toHaveValue(date);
  await expect(form.getByLabel("Reason for backdating")).toBeVisible();
  await form.getByLabel("Reason for backdating").fill(reason);
  return form;
}

test("an owner reviews, closes and reopens a business date, and the close blocks new entries", async ({ page, browser }) => {
  const date = oldDate(4);
  const description = `Close E2E ${Date.now()}`;
  await login(page, OWNER);
  // An entry on the open date, so the summary has something to review.
  const first = await fillExpense(page, SHOP_2, date, "12.50", `${description} first`, "entered late");
  await saveExpense(first);
  await expect(first).toHaveCount(0);

  await page.getByRole("link", { name: "Daily close" }).click();
  await expect(page.getByRole("heading", { name: "Daily close" })).toBeVisible();
  await page.getByRole("link", { name: "Shop 2" }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/closing" && url.searchParams.get("shop") === SHOP_2);
  await page.getByLabel("Business date").fill(date);
  await page.getByRole("button", { name: "Show date" }).click();
  await expect(page.getByRole("heading", { name: `Summary for ${date}` })).toBeVisible();
  await expect(dayState(page)).toHaveText("Open");
  await expect(metric(page, "expensesDirham")).toHaveText("QAR 12.50");
  await expect(metric(page, "netCashMovementDirham")).toHaveText("QAR -12.50");
  await expect(page.getByText("This date has never been closed.")).toBeVisible();
  await expect(page.getByText(/profit/i)).toHaveText(/none of these figures is profit/);

  await closeDate(page, "counted and checked");
  await expect(page.getByText("Close note: counted and checked")).toBeVisible();
  await expect(page.locator("div").filter({ hasText: /^Closed byLocal Owner$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close business date" })).toHaveCount(0);
  await expect(page.getByText(`Closed · Shop 2 · ${date}`)).toBeVisible();
  expect(closeState(SHOP_2, date)).toBe("closed");

  try {
    // A new entry for the closed date is refused by the server and nothing is written.
    const blocked = await fillExpense(page, SHOP_2, date, "3.00", `${description} blocked`, "entered late");
    await saveExpense(blocked);
    await expect(page.getByRole("alert").filter({ hasText: "This business date is closed. Reopen it before recording a new expense." })).toBeVisible();
    expect(scalar(`select count(*) from public.expenses where description = '${description} blocked'`)).toBe("0");

    // Staff see the state but are offered neither action.
    const staffContext = await browser.newContext();
    const staff = await staffContext.newPage();
    await login(staff, STAFF);
    await staff.goto(`/closing?shop=${SHOP_1}&date=${today()}`);
    await expect(staff.getByText("Only a manager or owner can close this date.")).toBeVisible();
    await expect(staff.getByRole("button", { name: /business date/ })).toHaveCount(0);
    // A shop the staff member is not assigned to is never shown.
    await staff.goto(`/closing?shop=${SHOP_2}&date=${date}`);
    await expect(staff.locator("main header")).toContainText("Shop 1");
    await expect(dayState(staff)).toHaveText("Open");
    await staffContext.close();

    await page.goto(`/closing?shop=${SHOP_2}&date=${date}`);
    await expect(dayState(page)).toHaveText("Closed");
    await reopenDate(page, "one more receipt to record");
  } finally {
    if (closeState(SHOP_2, date) === "closed") localDbQuery(`insert into public.daily_closes (shop_id, business_date, event_type, actor_id, reason) values ('${SHOP_2}', '${date}', 'reopened', '${OWNER_ID}', 'e2e cleanup')`);
  }
  await expect(page.getByText(`Reopened · Shop 2 · ${date}`)).toBeVisible();
  await expect(page.getByText("Reason: one more receipt to record")).toBeVisible();
  // The earlier close stays in the history.
  await expect(page.getByText(`Closed · Shop 2 · ${date}`)).toBeVisible();

  const allowed = await fillExpense(page, SHOP_2, date, "3.00", `${description} after reopen`, "entered late");
  await saveExpense(allowed);
  await expect(allowed).toHaveCount(0);
  expect(scalar(`select count(*) from public.expenses where description = '${description} after reopen' and business_date = '${date}'`)).toBe("1");
  await page.goto(`/closing?shop=${SHOP_2}&date=${date}`);
  await expect(metric(page, "expensesDirham")).toHaveText("QAR 15.50");
});

test("staff cannot backdate; an owner backdates with a reason and the entry is shown as backdated", async ({ page, browser }) => {
  const date = oldDate(5);
  test.setTimeout(60_000);   // two sign-ins and four screens; the default 30 s leaves no margin for the form to become interactive under a full parallel run
  const description = `Backdate E2E ${crypto.randomUUID()}`;
  await login(page, STAFF);
  await expect(page.getByLabel("Business date")).toBeDisabled();
  await expect(page.getByLabel("Business date")).toHaveValue(today());
  await page.goto(`/expenses?shop=${SHOP_1}`);
  const staffForm = await openAddExpense(page);
  await expect(staffForm.getByLabel("Business date", { exact: true })).toHaveAttribute("readonly", "");
  await expect(staffForm.getByLabel("Reason for backdating")).toHaveCount(0);

  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await login(owner, OWNER);
  await owner.goto(`/expenses?shop=${SHOP_2}`);
  // The drawer opens only once the page is interactive, so the earlier date is taken at once.
  const form = await openAddExpense(owner);
  await form.getByLabel("Business date", { exact: true }).fill(date);
  await expect(form.getByLabel("Reason for backdating")).toBeVisible();
  await form.getByLabel("Amount (QAR)", { exact: true }).fill("45.00");
  await form.getByLabel("Description", { exact: true }).fill(description);
  await expect(form.getByLabel("Business date", { exact: true })).toHaveValue(date);
  // No reason, no backdated entry.
  await form.getByRole("button", { name: "Review expense" }).click();
  await expect(form.getByText("Enter the reason for backdating.")).toBeVisible();
  await expect(form.getByRole("button", { name: "Save expense" })).toHaveCount(0);
  await form.getByLabel("Reason for backdating").fill("receipt found during stock count");
  await saveExpense(form);
  await expect(form).toHaveCount(0);

  await owner.goto(`/closing?shop=${SHOP_2}&date=${date}`);
  const entry = owner.locator("article").filter({ hasText: description });
  await expect(entry).toContainText("Backdated expense · QAR 45.00");
  await expect(entry).toContainText(`Business date ${date} · recorded`);
  await expect(entry).toContainText("by Local Owner");
  await expect(entry).toContainText("Reason: receipt found during stock count");
  await expect(metric(owner, "expensesDirham")).toHaveText("QAR 45.00");
  // The report lists it under its business date and shows the later recorded time beside it.
  await owner.goto(`/reports?shop=${SHOP_2}&report=expenses&from=${date}&to=${date}`);
  const row = owner.getByRole("row").filter({ hasText: description });
  await expect(row).toContainText(date);
  await expect(row).toContainText("Backdated: receipt found during stock count");
  expect(scalar(`select count(*) from public.audit_events where action = 'create_expense' and reason = 'receipt found during stock count' and metadata ->> 'business_date' = '${date}'`)).toBe("1");
  expect(scalar(`select (recorded_at at time zone 'Asia/Qatar')::date from public.expenses where description = '${description}'`)).toBe(today());
  await ownerContext.close();
});

test("a date closed by a manager while a draft was offline rejects the draft and keeps it", async ({ page, context, browser }) => {
  const invoice = `CLOSE-OFF-${Date.now()}`;
  const date = oldDate(7);
  await login(page, OWNER);
  await page.getByLabel("Business date").fill(date);
  await page.getByLabel("Backdate reason").fill("missed entry");
  await queueOffline(page, invoice);

  // Another authorized user closes that date through the app while this device is offline.
  const managerContext = await browser.newContext();
  const manager = await managerContext.newPage();
  await login(manager, MANAGER);
  await manager.goto(`/closing?shop=${SHOP_1}&date=${date}`);
  await closeDate(manager);
  try {
    await context.setOffline(false);
    await expect(page.getByRole("alert").filter({ hasText: "This business date is closed." })).toBeVisible({ timeout: 30_000 });
    await expect(draftStatus(page)).toHaveText("Conflict — not saved to ShopKhata");
    expect(invoiceCount(invoice)).toBe("0");
    expect(scalar(`select count(*) from public.batches where shop_id = '${SHOP_1}' and business_date = '${date}'`)).toBe("0");
    await expect(entryRows(page).nth(0).getByLabel("Invoice ID")).toHaveValue(invoice);
    await expect(page.getByLabel("Business date")).toHaveValue(date);
    await expect(page.getByLabel("Backdate reason")).toHaveValue("missed entry");
    await expectStoredRows(page, [invoice]);

    // A manager closed it, but only the owner may reopen an earlier date.
    await manager.reload();
    await expect(manager.getByText("Only the owner can reopen an earlier business date.")).toBeVisible();
    await expect(manager.getByRole("button", { name: "Reopen business date" })).toHaveCount(0);
    await managerContext.close();

    const ownerContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    await login(owner, OWNER);
    await owner.goto(`/closing?shop=${SHOP_1}&date=${date}`);
    await expect(owner.locator("div").filter({ hasText: /^Closed byLocal Shop 1 Manager$/ })).toBeVisible();
    await reopenDate(owner, "late batch from an offline device");
    await ownerContext.close();
  } finally {
    if (closeState(SHOP_1, date) === "closed") localDbQuery(`insert into public.daily_closes (shop_id, business_date, event_type, actor_id, reason) values ('${SHOP_1}', '${date}', 'reopened', '${OWNER_ID}', 'e2e cleanup')`);
  }

  // The preserved draft saves once, on its original date.
  await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
  await expect(savedNotice(page)).toBeVisible();
  expect(scalar(`select count(*) from public.invoices i join public.batches b on b.id = i.batch_id where i.invoice_id = '${invoice}' and b.business_date = '${date}' and b.is_backdated`)).toBe("1");
});

test("reports show reconciled values for invoices, payments, dues, credit, expenses and corrections, and export them", async ({ page }) => {
  test.setTimeout(120_000);
  const date = oldDate(6);
  const suffix = Date.now();
  const a = `REP-A-${suffix}`, b = `REP-B-${suffix}`, c = `REP-C-${suffix}`;
  const customerName = `Report Customer ${suffix}`;
  const now = today();

  // Fixture activity through the same RPCs the app uses, as the owner in Shop 2.
  const envText = execFileSync(process.execPath, [join(process.cwd(), "node_modules/supabase/dist/supabase.js"), "--agent", "no", "status", "-o", "env"], { encoding: "utf8" });
  const env = Object.fromEntries(envText.split(/\r?\n/).map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/)).filter((match) => match !== null).map((match) => [match[1], match[2]]));
  const owner = createClient(env.API_URL, env.PUBLISHABLE_KEY ?? env.ANON_KEY);
  expect((await owner.auth.signInWithPassword(OWNER)).error).toBeNull();
  async function rpc(name: string, command: Record<string, unknown>) {
    const { data, error } = await owner.rpc(name, { command: { shop_id: SHOP_2, ...command } });
    if (error) throw new Error(`${name}: ${error.message} ${error.details ?? ""}`);
    return data;
  }
  const key = () => crypto.randomUUID();
  const customerId = (await rpc("create_customer", { name: customerName, mobile: null })).customer_id as string;
  const row = (invoiceNumber: string, totalDirham: number, received: number, withCustomer: boolean) => ({
    row_id: key(), invoice_number: invoiceNumber, total_dirham: totalDirham, received_dirham: received, payment_method: "cash", delivered: withCustomer,
    customer: withCustomer ? { type: "existing", customer_id: customerId } : null,
  });
  const batch = await rpc("submit_batch", { business_date: date, is_backdated: true, backdated_reason: "report fixture", idempotency_key: key(), rows: [row(a, 1000, 400, true), row(b, 500, 500, false), row(c, 300, 0, true)] });
  const [invoiceA, , invoiceC] = batch.rows.map((item: { invoice_id: string }) => item.invoice_id);
  await rpc("record_payment", { invoice_id: invoiceA, amount_dirham: 100, payment_method: "cash", business_date: date, backdated_reason: "report fixture", idempotency_key: key() });
  await rpc("approve_overpayment", { invoice_id: invoiceA, amount_dirham: 550, payment_method: "cash", business_date: date, reason: "paid extra", idempotency_key: key() });
  const expense = await rpc("create_expense", { amount_dirham: 120, business_date: date, category: "supplies", description: `Report paper ${suffix}`, backdated_reason: "report fixture", idempotency_key: key() });
  await rpc("create_expense", { amount_dirham: 80, business_date: date, category: "rent", description: `Report rent ${suffix}`, backdated_reason: "report fixture", idempotency_key: key() });
  // These can only be dated today.
  await rpc("apply_customer_credit", { customer_id: customerId, amount_dirham: 50, business_date: now, idempotency_key: key() });
  await rpc("record_customer_payment", { customer_id: customerId, amount_dirham: 20, business_date: now, idempotency_key: key() });
  const correction = await rpc("request_invoice_correction", { invoice_id: invoiceC, payment_id: null, amount_delta_dirham: -30, reason: "price agreed lower", idempotency_key: key() });
  await rpc("decide_invoice_correction", { request_id: correction.request_id, expected_revision: 0, decision: "approved", reason: null, idempotency_key: key() });
  const expenseCorrection = await rpc("request_expense_correction", { expense_id: expense.expense_id, amount_dirham: 150, category: "supplies", description: `Report paper ${suffix}`, reason: "receipt total", idempotency_key: key() });
  await rpc("decide_expense_correction", { request_id: expenseCorrection.request_id, decision: "approved", idempotency_key: key() });

  await login(page, OWNER);
  const exportReport = async () => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export this report (.xlsx)" }).click()]);
    return (await readDownload(download))[0].data;
  };

  // Daily summary for the fixture's business date.
  await page.getByRole("link", { name: "Reports" }).click();
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Shop 2" }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/reports" && url.searchParams.get("shop") === SHOP_2);
  await page.getByLabel("Business date").fill(date);
  await page.getByRole("button", { name: "Show report" }).click();
  const expectedDay: Record<string, string> = {
    invoiceCount: "3", grossInvoiceDirham: "QAR 18.00", initialReceivedDirham: "QAR 9.00", dueCreatedDirham: "QAR 9.00", followupPaymentsDirham: "QAR 6.00",
    customerPaymentsDirham: "QAR 0.00", paymentCorrectionsDirham: "QAR 0.00", invoiceCorrectionsDirham: "QAR 0.00", creditCreatedDirham: "QAR 0.50",
    creditAppliedDirham: "QAR 0.00", expenseCount: "2", expensesDirham: "QAR 2.30", cashReceivedDirham: "QAR 15.50", bankReceivedDirham: "QAR 0.00", totalReceivedDirham: "QAR 15.50", netCashMovementDirham: "QAR 13.20",
    netDueMovementDirham: "QAR 3.00",
  };
  for (const [name, value] of Object.entries(expectedDay)) await expect(metric(page, name)).toHaveText(value);
  await expect(page.getByRole("cell", { name: /profit/i })).toHaveText(/This is not profit/);
  expect(await exportReport()).toEqual([DAILY_SUMMARY_HEADERS, [date, 3, 18, 9, 9, 6, 0, 0, 0, 0.5, 0, 2, 2.3, 15.5, 0, 15.5, 13.2, 3]]);

  // Sales on the fixture date: original amounts. C's -0.30 correction is dated today, so it does not rewrite this date.
  await page.goto(`/reports?shop=${SHOP_2}&report=sales&from=${date}&to=${date}`);
  await expect(total(page, "invoiceCount")).toHaveText("3");
  await expect(total(page, "gross")).toHaveText("QAR 18.00");
  await expect(total(page, "corrections")).toHaveText("QAR 0.00");
  await expect(total(page, "net")).toHaveText("QAR 18.00");
  // Current state of those invoices.
  await expect(total(page, "paid")).toHaveText("QAR 15.20");
  await expect(total(page, "credit")).toHaveText("QAR 0.50");
  await expect(total(page, "due")).toHaveText("QAR 2.00");
  const rowC = page.getByRole("row").filter({ hasText: c });
  await expect(rowC).toHaveCount(1);
  for (const text of ["Sale", customerName, "QAR 3.00", "QAR 2.70", "QAR 2.00", "Delivered"]) await expect(rowC).toContainText(text);
  await expect(page.getByRole("row").filter({ hasText: b })).toContainText("Advance");
  const sales = await exportReport();
  expect(sales).toHaveLength(8);
  expect(sales.slice(-4).map((item) => [item[0], item[3]])).toEqual([["Gross sales", 18], ["Invoice corrections", 0], ["Net sales", 18], ["Current state of these invoices", null]]);
  expect(sales.at(-1)?.slice(7, 11)).toEqual([15.2, 0.5, 2, "2 delivered, 0 partially delivered, 1 not delivered"]);
  expect(sales.find((item) => item[2] === c)?.slice(0, 4)).toEqual([date, "Sale", c, 3]);
  expect(sales.find((item) => item[2] === c)?.slice(6, 12)).toEqual([2.7, 0.2, 0.5, 2, "Yes", "ACTIVE"]);
  // The correction appears on its own business date, today; the range from the fixture date to today nets to the current total.
  await page.goto(`/reports?shop=${SHOP_2}&report=sales&from=${now}&to=${now}`);
  const correctionC = page.locator("tr[data-movement=invoice_correction]").filter({ hasText: c });
  await expect(correctionC).toHaveCount(1);
  await expect(correctionC.locator("[data-amount]")).toHaveText("QAR -0.30");
  await expect(page.locator("tr[data-movement=sale]").filter({ hasText: c })).toHaveCount(0);

  // Customer dues: the customer's due equals the due left on the invoices above.
  await page.goto(`/reports?shop=${SHOP_2}&report=dues`);
  const customerRow = page.getByRole("row").filter({ hasText: customerName });
  await expect(customerRow).toContainText("QAR 2.00");
  await expect(customerRow).toContainText(now);
  const dues = await exportReport();
  expect(dues.find((item) => item[1] === customerName)?.slice(3, 7)).toEqual([2, 0, 2, now]);
  expect(scalar(`select outstanding_due_dirham from public.report_customer_due_totals('${SHOP_2}')`)).toBe(String(Math.round((dues.find((item) => item[0] === "Total")?.[3] as number) * 100)));

  // Expenses: the corrected amount, once.
  await page.goto(`/reports?shop=${SHOP_2}&report=expenses&from=${date}&to=${date}`);
  await expect(total(page, "expenses")).toHaveText("QAR 2.30");
  const paper = page.getByRole("row").filter({ hasText: `Report paper ${suffix}` });
  for (const text of ["QAR 1.50", "Corrected", "supplies", "Local Owner"]) await expect(paper).toContainText(text);
  await expect(page.getByRole("row").filter({ hasText: `Report rent ${suffix}` })).toContainText("As entered");
  expect((await exportReport()).at(-1)?.slice(0, 4)).toEqual(["Total", null, "2 expenses", 2.3]);

  // Payments for that date: cash equals cash received in the daily summary.
  await page.goto(`/reports?shop=${SHOP_2}&report=payments&from=${date}&to=${date}`);
  await expect(total(page, "cash")).toHaveText("QAR 15.50");
  await expect(total(page, "credit")).toHaveText("QAR 0.00");
  await expect(page.getByRole("row").filter({ hasText: "Overpayment kept as credit" })).toContainText("QAR 0.50");
  const payments = await exportReport();
  expect(payments[0]).toEqual(PAYMENT_REPORT_HEADERS);
  expect(payments.slice(1, 6).map((item) => [item[2], item[4]]).sort()).toEqual([
    ["Follow-up invoice payment", 1], ["Follow-up invoice payment", 5], ["Overpayment kept as credit", 0.5], ["Received at invoice entry", 4], ["Received at invoice entry", 5],
  ].sort());
  expect(payments.slice(-4).map((item) => [item[0], item[4]])).toEqual([["Total cash received", 15.5], ["Total bank received", 0], ["Total received (cash + bank)", 15.5], ["Total customer credit applied", 0]]);
  // The credit application and customer payment are dated today and appear there exactly once.
  await page.goto(`/reports?shop=${SHOP_2}&report=payments&from=${now}&to=${now}`);
  const todayRows = page.getByRole("row").filter({ hasText: c });
  await expect(todayRows).toHaveCount(2);
  await expect(todayRows.filter({ hasText: "Customer credit applied" })).toContainText("QAR 0.50");
  await expect(todayRows.filter({ hasText: "Customer payment" })).toContainText("QAR 0.20");

  // Another shop's staff get neither the screen nor the export.
  await page.context().clearCookies();
  await login(page, STAFF);
  await page.goto(`/reports?shop=${SHOP_2}&report=daily&date=${date}`);
  await expect(page.locator("main header")).toContainText("Shop 1");
  await expect(metric(page, "invoiceCount")).toHaveText("0");
  expect((await page.request.get(`/exports/report-daily?shop=${SHOP_2}&from=${date}&to=${date}`)).status()).toBe(403);
  expect((await page.request.get(`/exports/report-dues?shop=${SHOP_2}`)).status()).toBe(403);
});
