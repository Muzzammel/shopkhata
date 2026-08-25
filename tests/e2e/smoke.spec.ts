import { expect, test } from "@playwright/test";

test("renders the application shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "ShopKhata" })).toBeVisible();
});
