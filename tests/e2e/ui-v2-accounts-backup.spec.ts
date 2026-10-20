import { expect, test, type Page } from "@playwright/test";

import { createAccount, localDbQuery, login, MANAGER, OWNER, scalar, STAFF } from "./offline-helpers";

// UI/UX V2 phase 6: Accounts and Backup & Recovery. Registration, role/status/shop changes and
// their effect on the changed account are covered by release-acceptance.spec.ts; the read-only
// backup rules by backup-recovery.spec.ts. This file holds the presentation guarantees the redesign
// adds: the directory and cards, the review drawer, focus, phone widths, dark mode, and backup states.

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const luminance = (page: Page) => page.evaluate(() => {
  const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g)!.map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
});
const directory = (page: Page) => page.getByRole("table", { name: "What each account can reach right now" });

test.describe("Accounts", () => {
  test("the directory states each role, status and shop access in words", async ({ page }) => {
    await login(page, OWNER);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1, name: "Accounts" })).toBeVisible();
    await expect(page.getByText("Owner only · All shops")).toBeVisible();
    const row = (email: string) => directory(page).getByRole("row", { name: new RegExp(email.replaceAll(".", "\\.")) });
    await expect(row(OWNER.email).locator("[data-role]")).toHaveText("owner");
    await expect(row(MANAGER.email).locator("[data-role]")).toHaveText("manager");
    await expect(row(STAFF.email).locator("[data-role]")).toHaveText("staff");
    await expect(row(STAFF.email).locator("[data-status=active]")).toHaveText("Active");
    // Shop isolation is shown as it is enforced: staff1 reaches Shop 1 only.
    await expect(row(STAFF.email)).toContainText("Shop 1");
    await expect(row(STAFF.email)).not.toContainText("Shop 2");
    // The owner cannot manage their own account; every other account has a Manage button.
    await expect(row(OWNER.email).getByRole("button")).toHaveCount(0);
    await expect(row(STAFF.email).getByRole("button", { name: /^Manage / })).toBeVisible();
    await expect(page.getByRole("list", { name: "Account summary" })).toContainText("Active");
  });

  test("an account without a shop and a deactivated account are labelled, not only coloured", async ({ page }) => {
    const user = createAccount("staff");
    const id = scalar(`select id from public.profiles where email = '${user.email}'`);
    localDbQuery(`delete from public.user_shop_assignments where user_id = '${id}'`);
    await login(page, OWNER);
    await page.goto("/admin");
    const row = directory(page).getByRole("row", { name: new RegExp(user.email) });
    await expect(row.locator("[data-status=no-shop]")).toHaveText("No shop access");
    await expect(row).toContainText("No access (no shop assigned)");

    // Deactivate it through the drawer: the review shows current against new values and the impact.
    await row.getByRole("button", { name: /^Manage / }).click();
    const drawer = page.getByRole("dialog", { name: /^Manage / });
    await drawer.getByLabel("Account is active").uncheck();
    await drawer.getByRole("button", { name: "Review changes" }).click();
    const comparison = drawer.getByRole("table", { name: "Requested account change" });
    await expect(comparison.getByRole("row", { name: /Status/ })).toContainText("Active");
    await expect(comparison.getByRole("row", { name: /Status/ })).toContainText("Deactivated");
    await expect(drawer.getByRole("list", { name: "What this change does" })).toContainText("loses all access");
    await drawer.getByRole("button", { name: "Save account" }).click();
    await expect(drawer).toHaveCount(0);
    await expect(row.locator("[data-status=deactivated]")).toHaveText("Deactivated");
    expect(scalar(`select is_active from public.profiles where id = '${id}'`)).toBe("false");
  });

  test("the Manage drawer saves nothing until confirmed, and Escape returns focus to its button", async ({ page }) => {
    await login(page, OWNER);
    await page.goto("/admin");
    const trigger = directory(page).getByRole("row", { name: /staff2@shopkhata\.local/ }).getByRole("button", { name: /^Manage / });
    await trigger.click();
    const drawer = page.getByRole("dialog", { name: /^Manage / });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("radio", { name: "Staff" })).toBeChecked();

    // Nothing changed: the review is not offered.
    await drawer.getByRole("button", { name: "Review changes" }).click();
    await expect(drawer.getByRole("status")).toHaveText("Nothing differs from the current account yet.");

    await drawer.getByRole("radio", { name: "Manager" }).check();
    await drawer.getByRole("button", { name: "Review changes" }).click();
    await expect(drawer.getByRole("table", { name: "Requested account change" }).getByRole("row", { name: /Role/ })).toContainText(/Staff\s*Manager/);
    await drawer.getByRole("button", { name: "Edit" }).click();
    await expect(drawer.getByRole("radio", { name: "Manager" })).toBeChecked();

    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(scalar("select role from public.profiles where email = 'staff2@shopkhata.local'")).toBe("staff");
  });

  test("registration is validated in the drawer before anything is sent", async ({ page }) => {
    await login(page, OWNER);
    await page.goto("/admin");
    await page.getByRole("button", { name: "Register account" }).click();
    const drawer = page.getByRole("dialog", { name: "Register an account" });
    await drawer.getByRole("button", { name: "Review account" }).click();
    await expect(drawer.getByText("Enter the sign-in email address.")).toBeVisible();
    await expect(drawer.getByText("Enter the name people will see.")).toBeVisible();
    await expect(drawer.getByLabel("Sign-in email")).toBeFocused();
    await expect(drawer.getByLabel("Sign-in email")).toHaveAttribute("aria-invalid", "true");
    await expect(drawer.getByRole("button", { name: "Register account" })).toHaveCount(0);
  });

  test("staff and managers are offered neither Accounts nor Backup and get 404 by URL", async ({ browser }) => {
    for (const user of [STAFF, MANAGER]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await login(page, user);
      await expect(page.getByRole("link", { name: "Accounts" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Backup" })).toHaveCount(0);
      for (const path of ["/admin", "/admin/backup"]) expect((await page.goto(path))?.status(), `${user.email} ${path}`).toBe(404);
      await context.close();
    }
  });

  for (const width of [390, 360]) {
    test(`shows cards without page overflow at ${width}px, and the drawer is a full-width sheet`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: 800 } });
      const page = await context.newPage();
      await login(page, OWNER);
      await page.goto("/admin");
      await expect(directory(page).locator("thead")).toHaveCSS("position", "absolute");
      expect(await noOverflow(page)).toBe(true);
      await directory(page).getByRole("row", { name: /staff1@shopkhata\.local/ }).getByRole("button", { name: /^Manage / }).click();
      const drawer = page.getByRole("dialog", { name: /^Manage / });
      await expect(drawer).toBeVisible();
      expect((await drawer.boundingBox())!.width).toBeGreaterThanOrEqual(width - 1);
      expect(await noOverflow(page)).toBe(true);
      await context.close();
    });
  }

  test("dark mode uses the charcoal canvas", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await login(page, OWNER);
    await page.evaluate(() => localStorage.setItem("theme", "dark"));
    await page.goto("/admin");
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(await luminance(page)).toBeLessThan(0.2);
    await expect(directory(page)).toBeVisible();
  });
});

test.describe("Backup & Recovery", () => {
  const hash = (n: number) => String(n).repeat(64).slice(0, 64);

  test("shows the empty state, then recorded backups newest first with integrity and rehearsal, and never offers a restore", async ({ page }) => {
    await login(page, OWNER);
    try {
      localDbQuery("truncate public.backup_records");
      await page.goto("/admin/backup");
      await expect(page.getByRole("heading", { level: 1, name: "Backup & Recovery" })).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: "No backup has been recorded" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Backup status" })).toContainText("None recorded");
      await expect(page.locator("[data-backup]")).toHaveCount(0);

      // Rows as the operator's record tool writes them: an older rehearsed backup, and a newer one recorded twice.
      localDbQuery(`insert into public.backup_records(backup_created_at, environment, source, app_version, latest_migration, dump_bytes, receipt_count, manifest_sha256, restore_verified_at, restore_verified_ok, recorded_at) values
        (now() - interval '3 days', 'local', 'local Supabase stack', '1.0.0', '20261017100000', 2400000, 3, '${hash(1)}', null, null, now() - interval '3 days'),
        (now() - interval '3 days', 'local', 'local Supabase stack', '1.0.0', '20261017100000', 2400000, 3, '${hash(1)}', now() - interval '2 days', true, now() - interval '2 days'),
        (now() - interval '2 hours', 'local', 'local Supabase stack', '1.0.0', '20261017100000', 2500000, 4, '${hash(2)}', null, null, now() - interval '2 hours')`);
      await page.reload();
      await expect(page.getByRole("alert").filter({ hasText: "No backup has been recorded" })).toHaveCount(0);
      await expect(page.locator("[data-freshness]")).toHaveText("Current");
      const rows = page.locator("[data-backup]");
      await expect(rows).toHaveCount(2);
      await expect(rows.first()).toHaveAttribute("data-backup", hash(2));
      await expect(rows.first()).toContainText("Latest");
      await expect(rows.first()).toContainText("Not rehearsed");
      await expect(rows.nth(1)).toContainText("Restore verified");
      await expect(rows.nth(1)).not.toContainText("Latest");
      await expect(page.getByRole("region", { name: "Recovery workflow" })).toContainText(hash(1).slice(0, 16));
      // The source host is never shown.
      await expect(page.getByRole("main")).not.toContainText("local Supabase stack");

      await expect(page.getByRole("alert").filter({ hasText: "Restoring production is not available from the browser" })).toBeVisible();
      await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
      await expect(page.getByRole("main").locator("form, input, a[download]")).toHaveCount(0);
    } finally {
      // Append-only by row trigger; the local fixture rows are removed as a whole.
      localDbQuery("truncate public.backup_records");
    }
  });

  for (const [width, dark] of [[390, false], [390, true]] as const) {
    test(`has no page-level horizontal overflow at ${width}px${dark ? " in dark mode" : ""}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: dark ? "dark" : "light" });
      const page = await context.newPage();
      await login(page, OWNER);
      if (dark) await page.evaluate(() => localStorage.setItem("theme", "dark"));
      await page.goto("/admin/backup");
      await expect(page.getByRole("heading", { name: "Recovery workflow" })).toBeVisible();
      if (dark) expect(await luminance(page)).toBeLessThan(0.2);
      expect(await noOverflow(page)).toBe(true);
      await context.close();
    });
  }
});
