import { expect, test, type Locator, type Page } from "@playwright/test";

import { SHOP_1 } from "./offline-helpers";

// Header regression: at some widths the navigation links ran underneath the Theme and
// Sign out buttons, so a click on Theme landed on a nav link. The owner sees the most links.
// V2 shell: pills from 1280px, a Menu sheet on tablets, a bottom bar on phones.
const WIDTHS = [320, 375, 414, 640, 641, 700, 767, 768, 820, 900, 920, 960, 1024, 1100, 1180, 1279, 1280, 1366, 1440];

async function signInAsOwner(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill("owner@shopkhata.local");
  await page.getByLabel(/password/i).fill("ShopKhata-Local-Owner-E2E-Only-2026!");
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page.getByRole("button", { name: "Profile" })).toBeVisible();
}

async function boxes(controls: Locator) {
  return controls.evaluateAll((elements) => elements.map((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { name: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim(), x, y, width, height };
  }));
}

test.describe("app header layout", () => {
  test.beforeEach(async ({ page }) => signInAsOwner(page));

  for (const width of WIDTHS) {
    test(`controls never overlap, clip or sit under another control at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/dashboard?shop=${SHOP_1}`);
      const header = page.locator("header").first();
      const controls = header.locator("a:visible, button:visible");
      const all = await boxes(controls);
      expect(all.length).toBeGreaterThanOrEqual(width >= 1280 ? 14 : 4);

      for (const box of all) {
        expect(box.width, `${box.name} has width`).toBeGreaterThan(0);
        expect(box.x, `${box.name} is clipped on the left at ${width}px`).toBeGreaterThanOrEqual(-0.5);
        expect(box.x + box.width, `${box.name} is clipped on the right at ${width}px`).toBeLessThanOrEqual(width + 0.5);
      }
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i], b = all[j];
          const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;
          expect(overlap, `${a.name} overlaps ${b.name} at ${width}px`).toBe(false);
        }
      }

      // The centre of every control must hit that control, not a neighbour drawn on top of it.
      const count = await controls.count();
      for (let i = 0; i < count; i++) {
        const hit = await controls.nth(i).evaluate((element) => {
          const { x, y, width: w, height: h } = element.getBoundingClientRect();
          const top = document.elementFromPoint(x + w / 2, y + h / 2);
          return Boolean(top && element.contains(top));
        });
        expect(hit, `${all[i].name} is covered at ${width}px`).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal page scroll").toBe(true);
    });
  }

  test("keyboard order follows the visual order and every focus target is fully visible", async ({ page }) => {
    for (const [width, first, last] of [[375, ["ShopKhata", "Shop: Shop 1. Change shop", "Notifications"], "Profile"], [920, ["ShopKhata", "Shop: Shop 1. Change shop", "Quick find"], "Profile"], [1280, ["ShopKhata", "Shop: Shop 1. Change shop", "Dashboard"], "Profile"]] as const) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/dashboard?shop=${SHOP_1}`);
      await page.getByRole("link", { name: "ShopKhata" }).focus();
      const order: string[] = [];
      for (let i = 0; i < 16; i++) {
        const info = await page.evaluate(() => {
          const element = document.activeElement as HTMLElement;
          const { x, y, width: w, height: h } = element.getBoundingClientRect();
          return { name: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim(), x, y, right: x + w, bottom: y + h, inHeader: Boolean(element.closest("header")) };
        });
        if (!info.inHeader) break;
        expect(info.x, `${info.name} focus target clipped at ${width}px`).toBeGreaterThanOrEqual(-0.5);
        expect(info.right, `${info.name} focus target clipped at ${width}px`).toBeLessThanOrEqual(width + 0.5);
        expect(info.y).toBeGreaterThanOrEqual(0);
        order.push(info.name);
        await page.keyboard.press("Tab");
      }
      expect(order.slice(0, 3), `order at ${width}px`).toEqual(first);
      expect(order.at(-1), `order at ${width}px`).toBe(last);
    }
  });

  test("the theme menu opens from a real click at a narrow desktop width in Light, Dark and System", async ({ page }) => {
    await page.setViewportSize({ width: 920, height: 800 });
    await page.goto("/");
    for (const [label, dark] of [["Dark", true], ["Light", false], ["System", false]] as const) {
      await page.getByRole("button", { name: "Theme" }).click();
      await expect(page.getByRole("menuitemradio", { name: label })).toBeVisible();
      await page.getByRole("menuitemradio", { name: label }).click();
      await expect(page.locator("html")).toHaveClass(dark ? /dark/ : /^((?!dark).)*$/);
      await expect(page).toHaveURL(/\/$/);
    }
  });

  test("on a phone the theme lives in the profile menu", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Theme" })).toBeHidden();
    await page.getByRole("button", { name: "Profile" }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("button", { name: "Profile" }).click();
    await page.getByRole("menuitemradio", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveClass(/^((?!dark).)*$/);
  });
});
