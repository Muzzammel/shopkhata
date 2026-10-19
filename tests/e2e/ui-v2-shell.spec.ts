import { expect, test, type Page } from "@playwright/test";

import { login, OWNER, SHOP_1, SHOP_2 } from "./offline-helpers";

// UI/UX V2 — App Shell and Dashboard: top navigation, quick-action rail, phone bottom bar,
// search, shop switching, theme, motion preferences and responsive composition.

const dashboard = `/dashboard?shop=${SHOP_1}&period=7d`;
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe("desktop", () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 900 }); await login(page, OWNER); });

  test("the dashboard is an asymmetric composition led by the Sales card", async ({ page }) => {
    await page.goto(dashboard);
    const kpis = page.locator("[data-slot=kpi]:visible");
    await expect(kpis).toHaveCount(6);
    const sizes = await kpis.evaluateAll((cards) => cards.map((card) => { const box = card.getBoundingClientRect(); return { label: card.textContent!.slice(0, 30), area: box.width * box.height, width: box.width }; }));
    expect(sizes[0].label).toContain("Sales");
    expect(Math.max(...sizes.slice(1).map((size) => size.area)), "Sales is the dominant card").toBeLessThan(sizes[0].area);
    expect(new Set(sizes.map((size) => Math.round(size.width))).size, "cards are not one equal grid").toBeGreaterThan(2);
    for (const title of ["Sales Overview", "Income vs Expense", "Top Customers", "Top Expense Categories", "Recent Activity", "Needs Attention"]) {
      await expect(page.getByRole("region", { name: title })).toBeVisible();
    }
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeHidden();
    expect(await noOverflow(page)).toBe(true);
  });

  test("Daily closing health and Shop comparison live only inside the collapsed More detail", async ({ page }) => {
    await page.goto(dashboard);
    const more = page.locator("details").filter({ has: page.getByText("More detail") });
    await expect(more).not.toHaveAttribute("open");
    for (const title of ["Daily closing health", "Shop comparison"]) await expect(page.getByRole("region", { name: title })).toBeHidden();
    await page.getByText("More detail").click();
    for (const title of ["Daily closing health", "Shop comparison"]) await expect(more.getByRole("region", { name: title })).toBeVisible();
  });

  test("the top bar marks the current page with the black pill and keeps the shop on every link", async ({ page }) => {
    await page.goto(dashboard);
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link")).toHaveText(["Dashboard", "Sales", "Customers", "Expenses", "Daily Close", "Reports", "Accounts", "Backup"]);
    await expect(nav.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Sales" }).click();
    await expect(page).toHaveURL(new RegExp(`/invoices\\?shop=${SHOP_1}$`));
    await expect(nav.getByRole("link", { name: "Sales" })).toHaveAttribute("aria-current", "page");
    await page.mouse.move(700, 600);
    await expect.poll(() => nav.getByRole("link", { name: "Sales" }).evaluate((link) => getComputedStyle(link).backgroundColor)).toBe("rgb(23, 22, 15)");
  });

  test("the quick-action rail stays put while scrolling and labels every icon", async ({ page }) => {
    await page.goto(dashboard);
    const rail = page.getByRole("navigation", { name: "Quick actions" });
    const before = await rail.boundingBox();
    await page.mouse.wheel(0, 1200);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
    expect(await rail.boundingBox()).toEqual(before);
    await expect(rail.getByRole("link")).toHaveCount(3);
    await rail.getByRole("link", { name: "Add expense" }).hover();
    await expect(page.getByRole("tooltip", { name: "Add expense" })).toBeVisible();
    await rail.getByRole("button", { name: "Notifications" }).click();
    await expect(page.getByRole("dialog").getByText("You're all caught up")).toBeVisible();
    await page.keyboard.press("Escape");
    await rail.getByRole("link", { name: "Record payment" }).click();
    await expect(page).toHaveURL(`/payments?shop=${SHOP_1}`);
  });

  test("Ctrl+K search hands the term to the existing invoice search", async ({ page }) => {
    await page.goto(dashboard);
    await page.keyboard.press("Control+k");
    const box = page.getByRole("combobox", { name: "Search ShopKhata" });
    await expect(box).toBeFocused();
    await box.fill("INV-42");
    await expect(page.getByRole("option").first()).toHaveText(/Find invoice “INV-42”/);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`/invoices?shop=${SHOP_1}&q=INV-42`);
  });

  test("the shop switcher moves the whole page to the other shop", async ({ page }) => {
    await page.goto(dashboard);
    await page.getByRole("button", { name: /^Shop: Shop 1. Change shop$/ }).click();
    await page.getByRole("menuitemradio", { name: "Shop 2" }).click();
    await expect(page).toHaveURL(`/dashboard?shop=${SHOP_2}&period=7d`);
    await expect(page.getByRole("main").getByText("Shop 2", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Sales" })).toHaveAttribute("href", `/invoices?shop=${SHOP_2}`);
  });

  test("KPI cards act in place: Cash Received switches the chart to cash, Customer Due navigates", async ({ page }) => {
    await page.goto(dashboard);
    await page.getByRole("button", { name: "Show Cash Received on the chart" }).click();
    await expect(page.getByRole("navigation", { name: "Chart measure" }).getByRole("button", { name: "Cash" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("region", { name: "Sales Overview" })).toContainText("Cash received per day");
    await page.getByRole("link", { name: "Customer Due: open" }).click();
    await expect(page).toHaveURL(`/customers?shop=${SHOP_1}`);
  });

  test("period pills switch the data, and the chart reads out values from the keyboard", async ({ page }) => {
    await page.goto(`/dashboard?shop=${SHOP_1}`);
    const periods = page.getByRole("navigation", { name: "Choose period" });
    await periods.getByRole("link", { name: "Month" }).click();
    await expect(page).toHaveURL(/period=30d/);
    await expect(periods.getByRole("link", { name: "Month" })).toHaveAttribute("aria-current", "page");
    const chart = page.getByRole("group", { name: /^Sales overview/ });
    await chart.focus();
    await page.keyboard.press("End");
    await expect(chart.locator("[aria-live]")).toHaveText(/^\d{1,2} \w{3}: QAR [\d,]+\.\d{2}$/);
    await expect(page.getByRole("table", { name: /Sales overview/ })).toHaveCount(1);
  });

  test("loading and errors never show a giant spinner: the loading state is skeletons", async ({ page }) => {
    await page.route("**/dashboard?**", async (route) => { await new Promise((resolve) => setTimeout(resolve, 600)); await route.continue(); });
    await page.goto(`/invoices?shop=${SHOP_1}`);
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Dashboard" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.locator("[role=progressbar], .animate-spin")).toHaveCount(0);
  });
});

test.describe("tablet", () => {
  test("pills fold into a Menu sheet and the rail stays available", async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await login(page, OWNER);
    await page.goto(dashboard);
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Quick actions" })).toBeVisible();
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("navigation", { name: "All pages" }).getByRole("link", { name: "Reports" }).click();
    await expect(page).toHaveURL(`/reports?shop=${SHOP_1}`);
    expect(await noOverflow(page)).toBe(true);
  });
});

test.describe("phone", () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 390, height: 844 }); await login(page, OWNER); });

  test("a dedicated composition: full-width Sales card, two-column KPIs, bottom bar, no rail", async ({ page }) => {
    await page.goto(dashboard);
    await expect(page.getByRole("navigation", { name: "Quick actions" })).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeHidden();
    const kpis = await page.locator("[data-slot=kpi]:visible").evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().width));
    expect(kpis).toHaveLength(7);  // Invoices is added on phones
    expect(kpis[0]).toBeGreaterThan(330);
    for (const width of kpis.slice(1)) expect(width).toBeLessThan(200);
    await expect(page.getByRole("navigation", { name: "Choose period" })).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
  });

  test("bottom navigation: Home is current, Add opens the quick actions, More lists every page", async ({ page }) => {
    await page.goto(dashboard);
    const bar = page.getByRole("navigation", { name: "Mobile navigation" });
    await expect(bar.getByRole("link")).toHaveText(["Home", "Sales", "Customers"]);
    await expect(bar.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    const add = bar.getByRole("button", { name: "Add" });
    const addBox = (await add.boundingBox())!, homeBox = (await bar.getByRole("link", { name: "Home" }).boundingBox())!;
    expect(addBox.height, "Add is larger").toBeGreaterThan(48);
    expect(addBox.y, "Add is elevated").toBeLessThan(homeBox.y);
    await add.click();
    const sheet = page.getByRole("dialog", { name: "Quick actions" });
    await expect(sheet.getByRole("link")).toHaveText(["New sale", "Record payment", "Add expense"]);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await bar.getByRole("button", { name: "More" }).click();
    await page.getByRole("navigation", { name: "All pages" }).getByRole("link", { name: "Daily Close" }).click();
    await expect(page).toHaveURL(`/closing?shop=${SHOP_1}`);
    await expect(bar).toBeVisible();
  });

  test("phone order ends in a collapsed More insights holding the secondary cards", async ({ page }) => {
    await page.goto(dashboard);
    const top = (title: string) => page.getByRole("region", { name: title }).evaluate((element) => element.getBoundingClientRect().top);
    const order: number[] = [];
    for (const title of ["Sales Overview", "Income vs Expense", "Needs Attention", "Top Customers", "Recent Activity"]) order.push(await top(title));
    const summary = page.locator("summary").filter({ hasText: "More insights" });
    order.push(await summary.evaluate((element) => element.getBoundingClientRect().top));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    await expect(page.getByText("More detail")).toBeHidden();
    const hidden = ["Top Expense Categories", "Daily closing health", "Shop comparison"];
    for (const title of hidden) await expect(page.getByRole("region", { name: title })).toBeHidden();
    await summary.click();
    for (const title of hidden) await expect(page.locator("details[open]").getByRole("region", { name: title })).toBeVisible();
  });

  test("touch targets in the bars are at least 40px", async ({ page }) => {
    await page.goto(dashboard);
    const targets = page.getByRole("banner").locator("a:visible, button:visible").or(page.getByRole("navigation", { name: "Mobile navigation" }).locator("a, button"));
    for (const box of await targets.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()))) {
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(36);
      expect(Math.max(box.width, box.height)).toBeGreaterThanOrEqual(40);
    }
  });
});

test.describe("phone bottom bar never covers content", () => {
  for (const [width, height] of [[320, 568], [360, 740], [390, 844], [430, 932]] as const) {
    test(`${width}x${height}: keyboard focus and the end of the page stay above the bar`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await login(page, OWNER);
      await page.goto(dashboard);
      const bar = page.getByRole("navigation", { name: "Mobile navigation" });
      await expect(bar).toBeVisible();
      // The raised Add button and its 4px ring are the highest point of the bar.
      const barTop = await bar.evaluate((nav) => Math.min(nav.getBoundingClientRect().top, nav.querySelector("[data-slot=add]")!.getBoundingClientRect().top - 4));
      const lowestContent = () => page.evaluate(() => Math.max(...[...document.querySelectorAll("#content main *")].filter((element) => element.checkVisibility()).map((element) => element.getBoundingClientRect().bottom)));

      // Every focus stop in the page scrolls fully clear of the bar.
      await page.locator("#content").focus();
      for (let stop = 0; stop < 120; stop++) {
        await page.keyboard.press("Tab");
        const focused = await page.evaluate(() => {
          const element = document.activeElement!;
          return element.closest("#content main") ? { name: element.textContent!.trim().slice(0, 40), bottom: element.getBoundingClientRect().bottom } : null;
        });
        if (!focused) break;
        expect(focused.bottom, `focused "${focused.name}" is above the bar`).toBeLessThanOrEqual(barTop + 0.5);
      }

      // At the end of the page nothing sits under the bar, with More insights closed or open.
      for (const open of [false, true]) {
        if (open) await page.locator("summary").filter({ hasText: "More insights" }).click();
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await expect.poll(lowestContent, `content clears the bar (More insights ${open ? "open" : "closed"})`).toBeLessThanOrEqual(barTop);
      }
    });
  }
});

test.describe("theme and motion", () => {
  test("dark mode is a designed charcoal palette, not an inversion; only Sales is heavily filled", async ({ page }) => {
    await login(page, OWNER);
    await page.goto(dashboard);
    const colours = () => page.evaluate(() => {
      const card = (label: string) => getComputedStyle([...document.querySelectorAll("[data-slot=kpi]")].find((kpi) => kpi.textContent!.includes(label))!).backgroundColor;
      return { body: getComputedStyle(document.body).backgroundColor, sales: card("Sales"), net: card("Net Position"), due: card("Customer Due") };
    });
    // Net Position is the plain card surface with a yellow accent, not a yellow block.
    await expect.poll(colours).toEqual({ body: "rgb(246, 242, 233)", sales: "rgb(23, 22, 15)", net: "rgb(255, 253, 248)", due: "rgb(252, 234, 214)" });
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    // Dark: the ink Sales card sinks below the canvas, status cards sit on the plain card surface.
    await expect.poll(colours).toEqual({ body: "rgb(19, 18, 16)", sales: "rgb(10, 10, 8)", net: "rgb(31, 30, 26)", due: "rgb(31, 30, 26)" });
  });

  test("reduced motion turns entrances and counters off", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await login(page, OWNER);
    await page.goto(dashboard);
    const durations = await page.locator(".sk-enter").evaluateAll((elements) => elements.map((element) => parseFloat(getComputedStyle(element).animationDuration)));
    expect(durations.length).toBeGreaterThan(5);
    expect(Math.max(...durations)).toBeLessThan(0.001);
    await context.close();
  });

  test("desktop and phone screenshots in light and dark", async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    for (const colorScheme of ["light", "dark"] as const) {
      for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
        const context = await browser.newContext({ viewport: { width, height }, colorScheme, reducedMotion: "reduce" });
        const page = await context.newPage();
        await login(page, OWNER);
        await page.goto(`/dashboard?shop=${SHOP_1}&period=30d`);
        await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
        const path = testInfo.outputPath(`dashboard-${name}-${colorScheme}.png`);
        // A full-page capture would paint the fixed bottom bar at its first-screen position, over the
        // KPIs. Growing the viewport to the page height draws it where it really ends up.
        await page.setViewportSize({ width, height: await page.evaluate(() => document.documentElement.scrollHeight) });
        await page.screenshot({ path });
        await testInfo.attach(`dashboard-${name}-${colorScheme}`, { path, contentType: "image/png" });
        expect(await noOverflow(page)).toBe(true);
        await context.close();
      }
    }
  });
});
