import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { expenseRow, login, MANAGER, openAddExpense, openDrawer, OWNER, SHOP_1, SHOP_2, STAFF } from "./offline-helpers";

// UI/UX V2 phase 4 — Expenses. Expense, receipt and correction rules are covered by the
// customer-expenses suites; this file holds the presentation guarantees the redesign adds.

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const qatarToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Qatar" }).format(new Date());

/** Expenses through the same RPCs the app calls: a rent one with a pending correction, a transport one corrected and approved. */
async function seedExpenses(shopId = SHOP_1) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const envText = execFileSync(process.execPath, [join(process.cwd(), "node_modules/supabase/dist/supabase.js"), "--agent", "no", "status", "-o", "env"], { encoding: "utf8" });
  const env = Object.fromEntries(envText.split(/\r?\n/).map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/)).filter((match) => match !== null).map((match) => [match[1], match[2]]));
  const owner = createClient(env.API_URL, env.PUBLISHABLE_KEY ?? env.ANON_KEY);
  expect((await owner.auth.signInWithPassword(OWNER)).error).toBeNull();
  const rpc = async (name: string, command: Record<string, unknown>) => {
    const { data, error } = await owner.rpc(name, { command: { shop_id: shopId, idempotency_key: crypto.randomUUID(), ...command } });
    if (error) throw new Error(`${name}: ${error.message}`);
    return data;
  };
  const create = async (description: string, category: string, amount: number) => (await rpc("create_expense", { amount_dirham: amount, business_date: qatarToday(), category, description })).expense_id as string;
  const rent = `V2 rent ${suffix}`, transport = `V2 transport ${suffix}`;
  const rentId = await create(rent, "rent", 10_000);
  const transportId = await create(transport, "transport", 2_000);
  await rpc("request_expense_correction", { expense_id: rentId, amount_dirham: 11_000, category: "rent", description: rent, reason: "Landlord added service charge" });
  const fix = await rpc("request_expense_correction", { expense_id: transportId, amount_dirham: 2_500, category: "transport", description: transport, reason: "Taxi receipt shows 25" });
  await rpc("decide_expense_correction", { request_id: fix.request_id, decision: "approved" });
  await owner.auth.signOut();
  return { rent, rentId, transport, transportId };
}

test.describe("Expenses list", () => {
  test("shows the period summary, a structured table with factual flags, and filters by category", async ({ page }) => {
    const { rent, transport } = await seedExpenses();
    await login(page, OWNER);
    await page.goto(`/expenses?shop=${SHOP_1}`);
    await expect(page.getByRole("heading", { name: "Expenses", level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Date range" }).getByRole("link", { name: "30 days" })).toHaveAttribute("aria-current", "page");
    const summary = page.getByRole("group", { name: "Expense summary" });
    for (const label of ["Total expenses", "Expense count", "Top category", "Average expense"]) await expect(summary).toContainText(label);
    await expect(page.getByText(/Last 30 days · .* · all categories · current approved values/)).toBeVisible();
    await expect(page.locator("[data-slot=expense-table] thead th")).toHaveText(["Date", "Category", "Description", "Amount", "Receipt", "Status"]);

    const pending = expenseRow(page, rent);
    await expect(pending).toContainText("QAR 100.00");
    await expect(pending.locator("[data-flag]")).toHaveText(["Pending approval"]);
    const corrected = expenseRow(page, transport);
    await expect(corrected).toContainText("QAR 25.00"); // the approved value, never the original
    await expect(corrected.locator("[data-flag]")).toHaveText(["Corrected"]);
    await expect(corrected).toContainText("No receipt");

    await page.getByRole("navigation", { name: "Filter by category" }).getByRole("link", { name: "Rent" }).click();
    await expect(page).toHaveURL(/category=rent/);
    await expect(page.locator("[data-expense] [data-category]").first()).toBeVisible();
    for (const category of await page.locator("[data-expense] [data-category]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-category")))) expect(category).toBe("rent");
    await expect(summary).toContainText("Rent");
    await expect(page.getByText(/· Rent · current approved values/)).toBeVisible();

    // A row opens its expense from anywhere on it.
    await expenseRow(page, rent).getByRole("cell").nth(3).click({ force: true });
    await expect(page.getByRole("heading", { name: rent, level: 1 })).toBeVisible();
  });

  test("says when filters match nothing and offers a reset", async ({ page }) => {
    await login(page, OWNER);
    await page.goto(`/expenses?shop=${SHOP_1}&from=2020-01-01&to=2020-01-01&category=maintenance`);
    await expect(page.getByRole("heading", { name: "No expenses match these filters" })).toBeVisible();
    await page.getByRole("main").getByRole("link", { name: "Reset filters" }).last().click();
    await expect(page).toHaveURL(new RegExp(`/expenses\\?shop=${SHOP_1}$`));
  });

  test("phones get cards, not a squeezed table, with no horizontal scroll", async ({ browser }) => {
    const { rent } = await seedExpenses();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await login(page, OWNER);
    await page.goto(`/expenses?shop=${SHOP_1}`);
    await expect(expenseRow(page, rent)).toBeVisible();
    await expect(page.locator("[data-slot=expense-table] thead")).toHaveCSS("position", "absolute"); // sr-only header
    expect(await expenseRow(page, rent).evaluate((row) => getComputedStyle(row).display)).toBe("grid");
    expect(await noOverflow(page)).toBe(true);
    const drawer = await openAddExpense(page);
    expect((await drawer.boundingBox())!.width).toBeGreaterThanOrEqual(389);
    expect(await noOverflow(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expenseRow(page, rent).getByRole("link").click();
    await expect(page.getByRole("heading", { name: rent, level: 1 })).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
    await context.close();
  });
});

test.describe("Add expense", () => {
  test("validates each field immediately, reviews before saving, and returns focus on Escape", async ({ page }) => {
    await login(page, STAFF);
    await page.goto(`/expenses?shop=${SHOP_1}`);
    const drawer = await openAddExpense(page);
    await expect(drawer.getByLabel("Business date")).toHaveAttribute("readonly", ""); // only owners backdate
    await drawer.getByRole("button", { name: "Review expense" }).click();
    await expect(drawer.getByText("Enter a positive QAR amount with up to two decimal places.")).toBeVisible();
    await expect(drawer.getByText("Enter what this expense was for.")).toBeVisible();
    await expect(drawer.getByLabel("Amount (QAR)")).toBeFocused();
    await expect(drawer.getByLabel("Amount (QAR)")).toHaveAttribute("aria-invalid", "true");
    await drawer.getByLabel("Amount (QAR)").fill("12.345");
    await expect(drawer.getByText("Enter a positive QAR amount with up to two decimal places.")).toBeVisible();
    await drawer.getByLabel("Amount (QAR)").fill("12.50");
    await expect(drawer.getByText("Enter a positive QAR amount with up to two decimal places.")).toHaveCount(0);
    await drawer.getByRole("radio", { name: "Utilities" }).check({ force: true });
    await drawer.getByLabel("Description").fill("Water bill");
    await drawer.getByLabel("Receipt (optional)").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await expect(drawer.getByText("Receipt must be a JPG, PNG, WebP or PDF file no larger than 10 MB.")).toBeVisible();
    await drawer.getByRole("button", { name: "Remove receipt notes.txt" }).click();
    await drawer.getByRole("button", { name: "Review expense" }).click();
    const review = drawer.getByRole("region", { name: "Review before saving" });
    await expect(review).toContainText("QAR 12.50");
    await expect(review).toContainText("Utilities");
    await expect(review).toContainText("No receipt attached");
    await drawer.getByRole("button", { name: "Edit" }).click();
    await expect(drawer.getByLabel("Amount (QAR)")).toHaveValue("12.50");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add expense" })).toBeFocused();
  });

  test("the Add expense quick action opens the drawer directly", async ({ page }) => {
    await login(page, OWNER);
    await page.goto(`/dashboard?shop=${SHOP_1}`);
    await page.getByRole("navigation", { name: "Quick actions" }).getByRole("link", { name: "Add expense" }).click();
    await expect(page.getByRole("dialog", { name: "Add expense" })).toBeVisible();
  });
});

test.describe("Expense detail", () => {
  test("is a governed document: no receipt state, request shows the difference, staff cannot decide, a manager rejects with a reason", async ({ page, browser }) => {
    const { transport, transportId } = await seedExpenses();
    await login(page, STAFF);
    await page.goto(`/expenses/${transportId}?shop=${SHOP_1}`);
    await expect(page.getByRole("heading", { name: transport, level: 1 })).toBeVisible();
    await expect(page.locator("[data-slot=amount]")).toHaveText("QAR 25.00");
    await expect(page.getByText("Originally recorded as QAR 20.00")).toBeVisible();
    await expect(page.getByRole("region", { name: "Receipt" })).toContainText("No receipt attached");
    const history = page.getByRole("region", { name: "History" });
    await expect(history.locator("[data-event]")).toHaveCount(2);
    await expect(history).toContainText("Approved");

    const correction = await openDrawer(page, "Request correction");
    await expect(correction.getByLabel("Corrected amount (QAR)")).toHaveValue("25.00");
    await correction.getByLabel("Corrected amount (QAR)").fill("27.00");
    await expect(correction.getByText("Difference: +QAR 2.00")).toBeVisible();
    await expect(correction.getByText("Requires manager or owner approval.", { exact: false })).toBeVisible();
    await correction.getByRole("button", { name: "Submit correction request" }).click();
    await expect(correction.getByText("Enter the reason for this correction.")).toBeVisible();
    await correction.getByLabel("Reason").fill("Toll was missed");
    await correction.getByRole("button", { name: "Submit correction request" }).click();
    await expect(correction).toHaveCount(0);
    const awaiting = page.getByRole("region", { name: "Awaiting approval" });
    await expect(awaiting).toContainText("Amount: QAR 25.00 → QAR 27.00 (+QAR 2.00)");
    await expect(awaiting.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(awaiting).toContainText("A manager or owner will review this request.");
    await expect(page.locator("[data-slot=amount]")).toHaveText("QAR 25.00");

    const manager = await browser.newPage();
    await login(manager, MANAGER);
    await manager.goto(`/expenses/${transportId}?shop=${SHOP_1}`);
    const decide = manager.getByRole("region", { name: "Awaiting approval" });
    await decide.getByLabel("Decision reason (optional)").fill("Toll is a separate expense");
    await decide.getByRole("button", { name: "Reject" }).click();
    await expect(decide).toHaveCount(0);
    await expect(manager.locator("[data-slot=amount]")).toHaveText("QAR 25.00");
    await expect(manager.getByRole("region", { name: "History" })).toContainText("Decision reason: Toll is a separate expense");
    await manager.close();
  });

  test("an expense in another shop is a real 404", async ({ page }) => {
    const { rentId } = await seedExpenses(SHOP_2);
    await login(page, STAFF);
    const response = await page.goto(`/expenses/${rentId}?shop=${SHOP_2}`);
    expect(response?.status()).toBe(404);
  });
});
