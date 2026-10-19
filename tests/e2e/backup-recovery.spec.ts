import { expect, test } from "@playwright/test";

import { login, OWNER, STAFF } from "./offline-helpers";

test("the owner sees backup status and a recovery workflow, with no way to restore from the browser", async ({ page }) => {
  await login(page, OWNER);
  await page.getByRole("link", { name: "Accounts" }).click();
  await page.getByRole("navigation", { name: "Admin sections" }).getByRole("link", { name: "Backup & Recovery" }).click();
  await expect(page.getByRole("heading", { name: "Backup & Recovery", level: 1 })).toBeVisible();

  const status = page.getByRole("region", { name: "Backup status" });
  for (const label of ["Latest backup", "File integrity", "Restore rehearsal"]) await expect(status).toContainText(label);
  await expect(page.getByRole("heading", { name: "Backup history" })).toBeVisible();

  await expect(page.getByRole("alert").filter({ hasText: "Restoring production is not available from the browser" })).toBeVisible();
  // Read-only: no control on this page creates, downloads or restores anything.
  await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("main").locator("form, input, a[download]")).toHaveCount(0);
});

test("a non-owner cannot open Backup & Recovery or read the backup record", async ({ page }) => {
  await login(page, STAFF);
  const response = await page.goto("/admin/backup");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Backup & Recovery" })).toHaveCount(0);
});

test("the theme choice is applied, persists across a reload, and follows the system when asked", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await login(page, STAFF);
  const html = page.locator("html");
  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(html).toHaveClass(/dark/);
  await page.reload();
  // Set before first paint by the inline script, so there is no light flash to wait out.
  await expect(html).toHaveClass(/dark/);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(19, 18, 16)");

  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("menuitemradio", { name: "System" }).click();
  await expect(html).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveClass(/dark/);
});
