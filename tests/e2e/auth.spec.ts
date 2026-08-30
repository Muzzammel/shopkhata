import { expect, test } from "@playwright/test";

const STAFF_EMAIL = "staff1@shopkhata.local";
const STAFF_PASSWORD = "ShopKhata-Local-E2E-Only-2026!";
const SHOP_2 = "10000000-0000-4000-8000-000000000002";

test.describe("browser authentication and authorization", () => {
  test.afterEach(async ({ context }) => {
    await context.clearCookies();
    await context.clearPermissions();
  });

  test("redirects an unauthenticated visit to the protected application route to login", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  });

  test("exposes accessible login fields and a submit action", async ({
    page,
  }) => {
    await page.goto("/login");

    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /sign in|log in/i }),
    ).toBeVisible();
  });

  test("shows a safe error for invalid credentials", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("not-a-user@shopkhata.local");
    await page.getByLabel(/password/i).fill("incorrect-local-password");
    await page.getByRole("button", { name: /sign in|log in/i }).click();

    const error = page
      .getByRole("alert")
      .filter({ hasText: /invalid|unable|incorrect|failed/i });
    await expect(error).toBeVisible();
    await expect(error).toContainText(/invalid|unable|incorrect|failed/i);
    await expect(error).not.toContainText(
      /postgres|supabase|stack trace|jwt|secret|hash|internal server/i,
    );
  });

  test("authenticates the seeded local Shop 1 staff user through the real UI", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(STAFF_EMAIL);
    await page.getByLabel(/password/i).fill(STAFF_PASSWORD);
    await page.getByRole("button", { name: /sign in|log in/i }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole("heading", { name: "ShopKhata" }),
    ).toBeVisible();
  });

  test("preserves the authenticated session after refreshing the protected page", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(STAFF_EMAIL);
    await page.getByLabel(/password/i).fill(STAFF_PASSWORD);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await expect(page).toHaveURL(/\/$/);

    await page.reload();

    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole("heading", { name: "ShopKhata" }),
    ).toBeVisible();
  });

  test("does not grant Shop 2 authority through client-controlled URL state", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(STAFF_EMAIL);
    await page.getByLabel(/password/i).fill(STAFF_PASSWORD);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await expect(page).toHaveURL(/\/$/);

    await page.goto(`/?shopId=${SHOP_2}`);

    await expect(page).toHaveURL(/shopId=/);
    await expect(page.getByText(/Shop 2/i)).toHaveCount(0);
  });
});
