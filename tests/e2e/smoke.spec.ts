import { expect, test } from "@playwright/test";

test("redirects an unauthenticated visitor to the sign-in page", async ({ page }) => {
  await page.goto("/");
  expect(new URL(page.url()).pathname).toBe("/login");
  await expect(
    page.getByRole("heading", { name: "Sign in to ShopKhata", exact: true }),
  ).toBeVisible();
});
