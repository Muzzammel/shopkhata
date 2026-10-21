import { expect, test, type Page } from "@playwright/test";

import { login, OWNER, SHOP_1, SHOP_2 } from "./offline-helpers";

// UI/UX V2 phase 5: Daily Close and Reports. Close, reopen, report and export rules are covered
// by closing-reports.spec.ts and the closing/reports integration suites; this file holds the
// presentation guarantees the redesign adds: layout at phone widths, the review drawer's focus
// behaviour, period presets, and dark mode.

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const luminance = (page: Page) => page.evaluate(() => {
  const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g)!.map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
});

test.describe("Daily close", () => {
  for (const width of [390, 360]) {
    test(`has no page-level horizontal overflow at ${width}px, and the review is a full-width sheet`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: 800 } });
      const page = await context.newPage();
      await login(page, OWNER);
      await page.goto(`/closing?shop=${SHOP_1}`);
      await expect(page.getByRole("heading", { level: 1, name: "Daily close" })).toBeVisible();
      expect(await noOverflow(page)).toBe(true);

      await page.getByRole("button", { name: "Review close" }).click();
      const drawer = page.getByRole("dialog", { name: /^Close / });
      await expect(drawer).toBeVisible();
      expect((await drawer.boundingBox())!.width).toBeGreaterThanOrEqual(width - 1);
      expect(await noOverflow(page)).toBe(true);
      await context.close();
    });
  }

  test("Escape closes the review and returns focus to the button that opened it", async ({ page }) => {
    await login(page, OWNER);
    await page.goto(`/closing?shop=${SHOP_2}`);
    const trigger = page.getByRole("button", { name: "Review close" });
    await trigger.click();
    await expect(page.getByRole("dialog", { name: /^Close / })).toBeVisible();
    await expect(page.getByLabel("Close note (optional)")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: /^Close / })).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("the state is written as words and the page headings are in order", async ({ page }) => {
    await login(page, OWNER);
    await page.goto(`/closing?shop=${SHOP_1}`);
    await expect(page.locator("[data-day-state]")).toHaveText(/^(Open|Closed)$/);
    await expect(page.getByRole("heading", { level: 2, name: /^Status for / })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: /^Summary for / })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Close and reopen history" })).toBeVisible();
  });

  test("dark mode uses the charcoal canvas and keeps the state readable", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/login");
    await page.evaluate(() => localStorage.setItem("theme", "dark"));
    await login(page, OWNER);
    await page.goto(`/closing?shop=${SHOP_1}`);
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(await luminance(page)).toBeLessThan(0.2);
    await expect(page.locator("[data-day-state]")).toBeVisible();
  });
});

test.describe("Reports", () => {
  for (const width of [390, 360]) {
    test(`has no page-level horizontal overflow at ${width}px on every report`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: 800 } });
      const page = await context.newPage();
      await login(page, OWNER);
      for (const report of ["daily", "sales", "dues", "expenses", "payments"]) {
        await page.goto(`/reports?shop=${SHOP_1}&report=${report}`);
        await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
        expect(await noOverflow(page), report).toBe(true);
      }
      await context.close();
    });
  }

  test("period presets set the range and show which one is active", async ({ page }) => {
    await login(page, OWNER);
    await page.goto(`/reports?shop=${SHOP_1}&report=sales`);
    const period = page.getByRole("navigation", { name: "Period" });
    await expect(period.getByRole("link", { name: "30 days" })).toBeVisible();
    await period.getByRole("link", { name: "7 days" }).click();
    await expect(page).toHaveURL(/report=sales/);
    await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    await expect(period.getByRole("link", { name: "7 days" })).toHaveAttribute("aria-current", "page");
    await expect(period.getByRole("link", { name: "30 days" })).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 2, name: "Sales by invoice date" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Sales" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Collection" })).toBeVisible();
  });

  test("a custom range is validated and falls back to today with a reason", async ({ page }) => {
    await login(page, OWNER);
    await page.goto(`/reports?shop=${SHOP_1}&report=expenses&from=2026-10-10&to=2026-10-01`);
    await expect(page.getByRole("alert")).toContainText("The start date must not be after the end date.");
    await expect(page.getByRole("alert")).toContainText("Showing");
  });

  test("dark mode keeps report figures on the charcoal surfaces", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await login(page, OWNER);
    await page.evaluate(() => localStorage.setItem("theme", "dark"));
    await page.goto(`/reports?shop=${SHOP_1}&report=payments`);
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(await luminance(page)).toBeLessThan(0.2);
    await expect(page.locator("[data-total=cash]")).toBeVisible();
  });
});
