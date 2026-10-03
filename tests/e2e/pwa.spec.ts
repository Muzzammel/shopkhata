import { expect, test } from "@playwright/test";

import { IMPORT_HEADERS } from "@/lib/excel/invoice-import";

import {
  SHOP_1, draftStatus, entryRows, expectStoredRows, fillRow, importFile, login, savedNotice, scalar, storedDrafts, waitForOfflineShell, workbook,
} from "./offline-helpers";

// Runs against a production build (see playwright.config.ts): a development
// server cannot start a page without its hot-reload connection, so a real
// offline page load can only be verified against built assets.
test.describe.configure({ mode: "default" });

test.describe("offline page load", () => {
  test("drafts can be created, edited and reloaded offline, then commit exactly once on reconnect", async ({ page, context }) => {
    const prefix = `OFFLINE-${Date.now()}`;
    await login(page);
    await waitForOfflineShell(page);
    await fillRow(page, 0, `${prefix}-1`, "25.00", "5.00");
    await expectStoredRows(page, [`${prefix}-1`]);

    await context.setOffline(true);
    await expect(page.locator("[data-offline-banner]")).toContainText("You are offline.");
    await expect(draftStatus(page)).toHaveText("Offline — draft saved locally");
    await expect(page.getByLabel("Recent invoices")).toContainText("may be out of date");
    // Create and edit while offline.
    await page.getByRole("button", { name: "Add row" }).click();
    await fillRow(page, 1, `${prefix}-2`, "10.00");
    await entryRows(page).nth(0).getByLabel("Total QAR").fill("30.00");
    await expectStoredRows(page, [`${prefix}-1`, `${prefix}-2`]);
    // Import into the draft while offline.
    await importFile(page, await workbook([[...IMPORT_HEADERS], [`${prefix}-3`, 4.25, 4.25, "No", null, null, null]]));
    await page.getByRole("region", { name: "Import preview" }).getByRole("button", { name: "Add to current draft" }).click();
    await expectStoredRows(page, [`${prefix}-1`, `${prefix}-2`, `${prefix}-3`]);

    // Reload with no network: the service worker serves the data-free offline page.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Shop 1" })).toBeVisible();
    await expect(page.locator("[data-offline-banner]")).toBeVisible();
    await expect(entryRows(page)).toHaveCount(3);
    await expect(entryRows(page).nth(0).getByLabel("Total QAR")).toHaveValue("30.00");
    await expect(entryRows(page).nth(2).getByLabel("Invoice ID")).toHaveValue(`${prefix}-3`);
    // No server data is shown from a cache.
    await expect(page.getByRole("heading", { name: "Recent invoices" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Record Payment" })).toHaveCount(0);

    // Local review works; saving only queues.
    await page.getByRole("button", { name: "Review batch" }).click();
    await expect(page.getByText("QAR 44.25")).toBeVisible();
    await page.getByRole("button", { name: "Save when back online" }).click();
    await expect(draftStatus(page)).toHaveText("Submission pending — will send when you reconnect");
    await expect(savedNotice(page)).toHaveCount(0);
    expect(scalar(`select count(*) from public.invoices where invoice_id like '${prefix}-%'`)).toBe("0");
    const queued = (await storedDrafts(page))[0];
    expect(queued.submission).toMatchObject({ status: "queued", idempotencyKey: queued.idempotencyKey });

    // Reconnect, including a burst of duplicate online events.
    await context.setOffline(false);
    await expect(savedNotice(page)).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => { for (let i = 0; i < 5; i++) window.dispatchEvent(new Event("online")); });
    await expect(page.getByLabel("Recent invoices")).toContainText(`${prefix}-3`);
    expect(scalar(`select string_agg(invoice_id || ':' || total_amount_dirham, ',' order by invoice_id) from public.invoices where shop_id = '${SHOP_1}' and invoice_id like '${prefix}-%'`))
      .toBe(`${prefix}-1:3000,${prefix}-2:1000,${prefix}-3:425`);
    expect(scalar(`select count(*) from public.batches where shop_id = '${SHOP_1}' and idempotency_key = '${queued.idempotencyKey}'`)).toBe("1");
    expect(scalar(`select count(*) from public.payments p join public.invoices i on i.id = p.invoice_id where i.invoice_id like '${prefix}-%'`)).toBe("2");
    await expect.poll(async () => (await storedDrafts(page)).length).toBe(0);
  });
});

test.describe("offline page privacy", () => {
  test("never opens a local draft while the server can be reached to authenticate", async ({ page, context }) => {
    const invoice = `SHELL-PRIVATE-${Date.now()}`;
    await login(page);
    await fillRow(page, 0, invoice, "5.00");
    await expectStoredRows(page, [invoice]);

    // Signed in and online: the offline page hands straight back to the real workspace.
    await page.goto("/offline");
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: "Shop 1" })).toBeVisible();

    // Session gone and online: it leads to the login form and shows no draft.
    await context.clearCookies();
    await page.goto("/offline");
    await expect(page.getByRole("heading", { name: "Sign in to ShopKhata" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(invoice);
    await expect(entryRows(page)).toHaveCount(0);

    // Having reached the login page, the device no longer opens the previous user's draft offline either.
    await waitForOfflineShell(page);
    await context.setOffline(true);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "ShopKhata is offline" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(invoice);
    await expect(entryRows(page)).toHaveCount(0);
    await context.setOffline(false);
  });
});

test.describe("installable shell", () => {
  test("serves a valid manifest and a service worker that caches no authenticated data", async ({ page }) => {
    await login(page);
    const manifest = await (await page.request.get("/manifest.webmanifest")).json();
    expect(manifest).toMatchObject({ name: "ShopKhata", start_url: "/", scope: "/", display: "standalone" });
    expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const icon of manifest.icons as { src: string }[]) expect((await page.request.get(icon.src)).headers()["content-type"]).toBe("image/png");
    const worker = await page.request.get("/sw.js");
    expect(worker.headers()["cache-control"]).toContain("no-store");

    await waitForOfflineShell(page);
    // Load authenticated pages and data, then inspect everything the worker cached.
    await page.goto("/customers");
    await page.goto("/expenses");
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Shop 1" })).toBeVisible();
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
      return urls;
    });
    expect(cached).toContain("/offline");
    expect(cached.filter((path) => path !== "/offline" && !path.startsWith("/_next/static/") && !/^\/icon-\d+\.png$/.test(path))).toEqual([]);
    // The cached offline page itself carries no user or financial data.
    const shell = await page.evaluate(async () => (await (await caches.match("/offline"))!.text()));
    expect(shell).not.toContain("Local Shop 1 Staff");
    expect(shell).not.toContain("staff1@shopkhata.local");
  });
});
