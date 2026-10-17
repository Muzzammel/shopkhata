import { expect, test, type Locator, type Page } from "@playwright/test";

// Header regression: at some widths the navigation links ran underneath the Theme and
// Sign out buttons, so a click on Theme landed on a nav link. The owner sees the most links.
const WIDTHS = [320, 375, 414, 640, 641, 700, 768, 820, 900, 901, 920, 960, 980, 1000, 1024, 1100, 1180, 1280, 1440];

async function signInAsOwner(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill("owner@shopkhata.local");
  await page.getByLabel(/password/i).fill("ShopKhata-Local-Owner-E2E-Only-2026!");
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
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
      await page.goto("/");
      const header = page.locator("header").first();
      const controls = header.locator("a, button");
      const all = await boxes(controls);
      expect(all.length).toBeGreaterThan(10);

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
    for (const width of [375, 920, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      await page.locator("header a").first().focus();
      const order: string[] = [];
      for (let i = 0; i < 12; i++) {
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
      expect(order.slice(0, 2), `order at ${width}px`).toEqual(["ShopKhata", "Overview"]);
      expect(order.slice(-2), `order at ${width}px`).toEqual(["Theme", "Sign out"]);
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
});
