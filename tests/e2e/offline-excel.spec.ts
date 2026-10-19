import { expect, test } from "@playwright/test";

import { EXPENSE_EXPORT_HEADERS, INVOICE_EXPORT_HEADERS, LEDGER_EXPORT_HEADERS } from "@/lib/excel/exports";
import { IMPORT_HEADERS, IMPORT_SHEET_NAME } from "@/lib/excel/invoice-import";
import { qatarBusinessDate } from "@/lib/invoice-entry";

import {
  MANAGER, MANAGER_ID, OWNER, OWNER_ID, SHOP_1, SHOP_2, STAFF, draftStatus, entryRows, expectStoredRows, fillRow, importFile, invoiceCount,
  localDbQuery, login, paymentCount, queueOffline, readDownload, savedNotice, scalar, signOut, storedDrafts, workbook,
} from "./offline-helpers";

// These tests change shared server state (closed dates, shop assignments) and
// count rows in the seeded shops, so they run one at a time.
test.describe.configure({ mode: "default" });

test.describe("Excel import", () => {
  test("downloads the template and imports a valid workbook through preview, review and save", async ({ page }) => {
    const prefix = `XL-${Date.now()}`;
    await login(page);

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download template" }).click()]);
    expect(download.suggestedFilename()).toBe("shopkhata-invoice-import-template.xlsx");
    const template = await readDownload(download);
    expect(template.map((sheet) => sheet.sheet)).toEqual([IMPORT_SHEET_NAME, "Instructions"]);
    expect(template[0].data).toEqual([[...IMPORT_HEADERS]]);

    await importFile(page, await workbook([
      [...IMPORT_HEADERS],
      [`${prefix}-A`, 150, 150, "Yes", null, null, "paid in full"],
      [`${prefix}-B`, 80.5, 20, "Yes", `Import Mary ${prefix}`, null, null],
      [`${prefix}-C`, 60, 10, "No", null, null, null],
    ]));
    const preview = page.getByRole("region", { name: "Import preview" });
    await expect(preview.locator("[data-import-row]")).toHaveCount(3);
    await expect(preview).toContainText("Not saved.");
    await expect(preview.getByRole("list", { name: "Import errors" })).toHaveCount(0);
    // Choosing a file commits nothing.
    expect(scalar(`select count(*) from public.invoices where invoice_id like '${prefix}-%'`)).toBe("0");

    await preview.getByRole("button", { name: "Add rows to draft" }).click();
    await expect(entryRows(page)).toHaveCount(3);
    await expect(entryRows(page).nth(1).getByLabel("Invoice ID")).toHaveValue(`${prefix}-B`);
    await expect(entryRows(page).nth(1).getByLabel("Total QAR")).toHaveValue("80.50");
    await expect(entryRows(page).nth(1).getByLabel("New customer name")).toHaveValue(`Import Mary ${prefix}`);
    await expect(entryRows(page).nth(0).getByLabel("Note")).toHaveValue("paid in full");
    expect(scalar(`select count(*) from public.invoices where invoice_id like '${prefix}-%'`)).toBe("0");

    // Same review and save path as manual rows.
    await page.getByRole("button", { name: "Review batch" }).click();
    await expect(page.getByText("QAR 290.50")).toBeVisible();
    await expect(page.getByLabel("New invoice batch").getByText("Due QAR 60.50", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save batch" }).click();
    await expect(savedNotice(page)).toBeVisible();
    await expect(draftStatus(page)).toHaveText("Saved to ShopKhata");

    expect(scalar(`select string_agg(i.invoice_id || ':' || i.total_amount_dirham || ':' || i.delivered || ':' || coalesce(i.note, '') || ':' || coalesce(c.name, '') || ':' || coalesce((select sum(p.amount_dirham) from public.payments p where p.invoice_id = i.id), 0), ',' order by i.invoice_id)
      from public.invoices i left join public.customers c on c.id = i.customer_id where i.shop_id = '${SHOP_1}' and i.invoice_id like '${prefix}-%'`))
      .toBe(`${prefix}-A:15000:true:paid in full::15000,${prefix}-B:8050:true::Import Mary ${prefix}:2000,${prefix}-C:6000:false:::1000`);
    expect(scalar(`select count(distinct batch_id) from public.invoices where invoice_id like '${prefix}-%'`)).toBe("1");
    await expect(page.getByLabel("Recent invoices")).toContainText(`${prefix}-B`);
  });

  test("merges an import into a non-blank draft or replaces it, by explicit choice", async ({ page }) => {
    const prefix = `XLM-${Date.now()}`;
    await login(page);
    await fillRow(page, 0, `${prefix}-MANUAL`, "5.00");
    const file = await workbook([[...IMPORT_HEADERS], [`${prefix}-X`, 10, 0, "No", null, null, null]]);
    await importFile(page, file);
    const preview = page.getByRole("region", { name: "Import preview" });
    await preview.getByRole("button", { name: "Add to current draft" }).click();
    await expect(entryRows(page)).toHaveCount(2);
    await expect(entryRows(page).nth(0).getByLabel("Invoice ID")).toHaveValue(`${prefix}-MANUAL`);
    await expect(entryRows(page).nth(1).getByLabel("Invoice ID")).toHaveValue(`${prefix}-X`);

    // Importing the same number again collides with the draft row and is blocked for merge.
    await importFile(page, file);
    await expect(preview.getByRole("list", { name: "Import errors" })).toContainText("Row 2: Invoice ID already exists in this shop.");
    await expect(preview.getByRole("button", { name: "Add to current draft" })).toBeDisabled();
    await preview.getByRole("button", { name: "Replace current draft" }).click();
    await expect(entryRows(page)).toHaveCount(1);
    await expect(entryRows(page).nth(0).getByLabel("Invoice ID")).toHaveValue(`${prefix}-X`);
    expect(scalar(`select count(*) from public.invoices where invoice_id like '${prefix}-%'`)).toBe("0");
  });

  test("rejects malformed headers, rows and money values before anything can be saved", async ({ page }) => {
    const prefix = `XLBAD-${Date.now()}`;
    await login(page);
    await fillRow(page, 0, `${prefix}-EXISTING`, "9.00");
    await page.getByRole("button", { name: "Review batch" }).click();
    await page.getByRole("button", { name: "Save batch" }).click();
    await expect(savedNotice(page)).toBeVisible();
    const preview = page.getByRole("region", { name: "Import preview" });
    const rejected = page.getByRole("alert").filter({ hasText: "Import rejected" });

    // Wrong file type.
    await page.getByLabel("Import Excel (.xlsx)").setInputFiles({ name: "batch.csv", mimeType: "text/csv", buffer: Buffer.from("Invoice Number,Total QAR\nA,1\n") });
    await expect(rejected).toContainText("Choose an .xlsx workbook");
    // Not a real workbook.
    await importFile(page, Buffer.from("this is not a zip archive"));
    await expect(rejected).toContainText("not a readable .xlsx workbook");
    // Missing column.
    await importFile(page, await workbook([[...IMPORT_HEADERS.slice(0, 6)], [`${prefix}-1`, 10, 0, "No", null, null]]));
    await expect(rejected).toContainText("Missing column: Note");
    // Shifted financial columns.
    await importFile(page, await workbook([["Invoice Number", "Received QAR", "Total QAR", ...IMPORT_HEADERS.slice(3)], [`${prefix}-1`, 0, 10, "No", null, null, null]]));
    await expect(rejected).toContainText("Columns must be in this order");
    // Unknown extra column.
    await importFile(page, await workbook([[...IMPORT_HEADERS, "Discount"], [`${prefix}-1`, 10, 0, "No", null, null, null, 5]]));
    await expect(rejected).toContainText("Unexpected column: discount");
    await expect(preview).toHaveCount(0);

    // Structurally valid, but with blocking row errors: previewed, never mergeable.
    await importFile(page, await workbook([
      [...IMPORT_HEADERS],
      [`${prefix}-OK`, 10, 0, "No", null, null, null],
      [`${prefix}-MONEY`, 10.005, 0, "No", null, null, null],
      [`${prefix}-ZERO`, 0, 0, "No", null, null, null],
      [`${prefix}-OVER`, 10, 10.01, "No", null, null, null],
      [`${prefix}-NEG`, 10, -1, "No", null, null, null],
      [`${prefix}-DELIV`, 10, 0, "maybe", null, null, null],
      [`${prefix}-DUE`, 10, 4, "Yes", null, null, null],
      [`${prefix}-ok`, 10, 0, "No", null, null, null],
      [`${prefix}-existing`, 10, 0, "No", null, null, null],
      [null, 10, 0, "No", null, null, null],
    ]));
    await expect(preview.locator("[data-import-row]")).toHaveCount(10);
    const errors = preview.getByRole("list", { name: "Import errors" });
    await expect(errors).toContainText("Row 3: Enter a positive amount in QAR with at most two decimals.");
    await expect(errors).toContainText("Row 4: Enter a positive amount in QAR with at most two decimals.");
    await expect(errors).toContainText("Row 5: Received must be a valid QAR amount no greater than the total.");
    await expect(errors).toContainText("Row 6: Received must be a valid QAR amount no greater than the total.");
    await expect(errors).toContainText("Row 7: Delivered must be Yes or No.");
    await expect(errors).toContainText("Row 8: A customer is required for a delivered invoice with due.");
    await expect(errors).toContainText("Row 9: Invoice ID already exists in this shop.");
    await expect(errors).toContainText("Row 10: Invoice ID already exists in this shop.");
    await expect(errors).toContainText("Row 11: Invoice ID is required.");
    await expect(errors).not.toContainText("Row 2:");
    await expect(preview.getByRole("alert")).toContainText("Import blocked");
    // The problem names its column and what the cell held, and that cell is highlighted in the preview.
    await expect(errors.getByRole("listitem").filter({ hasText: "Row 7:" })).toContainText('Column: Delivered · Received: "maybe" · Expected: Yes or No (any letter case), TRUE or FALSE, or blank for No');
    await expect(preview.locator('[data-import-cell="delivered"][aria-invalid="true"]')).toHaveText('"maybe"');
    await expect(preview.locator("[data-import-row]").first().locator('[aria-invalid="true"]')).toHaveCount(0);
    await expect(preview.getByRole("button", { name: "Add rows to draft" })).toBeDisabled();

    // The draft is untouched and nothing reached the database.
    await expect(entryRows(page)).toHaveCount(1);
    await expect(entryRows(page).nth(0).getByLabel("Invoice ID")).toHaveValue("");
    expect(scalar(`select count(*) from public.invoices where invoice_id like '${prefix}-%'`)).toBe("1");
  });
});

test.describe("durable local drafts", () => {
  test("a draft survives reload with the same row identities and error mapping", async ({ page }) => {
    const prefix = `DRAFT-${Date.now()}`;
    const customer = { id: crypto.randomUUID(), name: `Draft customer ${prefix}`, publicId: `CUS-${prefix}` };
    localDbQuery(`insert into public.customers (id, shop_id, public_id, name, mobile) values ('${customer.id}', '${SHOP_1}', '${customer.publicId}', '${customer.name}', null)`);
    await login(page);
    await fillRow(page, 0, `${prefix}-1`, "40.00", "15.00");
    await entryRows(page).nth(0).getByLabel("Delivered").check();
    await entryRows(page).nth(0).getByLabel("Customer search", { exact: true }).fill(customer.name);
    await page.getByRole("option", { name: new RegExp(customer.name) }).click();
    await page.getByRole("button", { name: "Add row" }).click();
    await fillRow(page, 1, `${prefix}-2`, "not-money");
    await page.getByRole("button", { name: "Add row" }).click();
    await fillRow(page, 2, `${prefix}-3`, "7.50");
    await entryRows(page).nth(2).getByLabel("Note").fill("keep this note");
    await expect(draftStatus(page)).toHaveText("Saved locally");
    await expectStoredRows(page, [`${prefix}-1`, `${prefix}-2`, `${prefix}-3`]);
    const rowIds = await entryRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-id")));
    const before = (await storedDrafts(page))[0];
    expect(before.key).toBe(`10000000-0000-4000-8000-000000000102:${SHOP_1}`);

    await page.reload();
    await expect(entryRows(page)).toHaveCount(3);
    await expect(page.getByText("Unsaved draft restored from this device.")).toBeVisible();
    expect(await entryRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-id")))).toEqual(rowIds);
    await expect(entryRows(page).nth(0).getByLabel("Invoice ID")).toHaveValue(`${prefix}-1`);
    await expect(entryRows(page).nth(0).getByLabel("Received QAR")).toHaveValue("15.00");
    await expect(entryRows(page).nth(0).getByLabel("Delivered")).toBeChecked();
    await expect(entryRows(page).nth(0)).toContainText(customer.publicId);
    await expect(entryRows(page).nth(1).getByLabel("Total QAR")).toHaveValue("not-money");
    await expect(entryRows(page).nth(2).getByLabel("Note")).toHaveValue("keep this note");
    expect((await storedDrafts(page))[0].idempotencyKey).toBe(before.idempotencyKey);

    // The validation error is still attached to the same row after the reload.
    await page.getByRole("button", { name: "Review batch" }).click();
    await expect(page.locator(`[data-row-id="${rowIds[1]}"]`)).toContainText("Enter a positive amount in QAR with at most two decimals.");
    await expect(page.locator(`[data-row-id="${rowIds[0]}"]`)).not.toContainText("Enter a positive amount");
    await expect(page.getByRole("alert").filter({ hasText: /Fix 1 row error/ })).toBeVisible();

    // Fix it and save: the restored customer link is what gets committed.
    await entryRows(page).nth(1).getByLabel("Total QAR").fill("3.00");
    await page.getByRole("button", { name: "Review batch" }).click();
    await page.getByRole("button", { name: "Save batch" }).click();
    await expect(savedNotice(page)).toBeVisible();
    expect(scalar(`select count(*) from public.invoices where shop_id = '${SHOP_1}' and invoice_id like '${prefix}-%'`)).toBe("3");
    expect(scalar(`select customer_id from public.invoices where shop_id = '${SHOP_1}' and invoice_id = '${prefix}-1'`)).toBe(customer.id);
    // Confirmed success clears the local copy; a reload starts blank.
    await expect.poll(async () => (await storedDrafts(page)).length).toBe(0);
    await page.reload();
    await expect(entryRows(page)).toHaveCount(1);
    await expect(entryRows(page).nth(0).getByLabel("Invoice ID")).toHaveValue("");
  });

  test("a draft can be discarded explicitly and does not come back", async ({ page }) => {
    const invoice = `DISCARD-${Date.now()}`;
    await login(page);
    await fillRow(page, 0, invoice, "5.00");
    await expectStoredRows(page, [invoice]);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(entryRows(page).nth(0).getByLabel("Invoice ID")).toHaveValue("");
    await expect.poll(async () => (await storedDrafts(page)).length).toBe(0);
    await page.reload();
    await expect(entryRows(page).nth(0).getByLabel("Invoice ID")).toHaveValue("");
    expect(invoiceCount(invoice)).toBe("0");
  });

  test("a draft is private to its user on a shared device and is removed on explicit sign-out", async ({ page, context }) => {
    const invoice = `PRIVATE-${Date.now()}`;
    await login(page);
    await fillRow(page, 0, invoice, "5.00");
    await expectStoredRows(page, [invoice]);

    // The session ends without a sign-out; a different user signs in on the same browser.
    await context.clearCookies();
    await login(page, MANAGER);
    await expect(page.getByText("Local Shop 1 Manager")).toBeVisible();
    await expect(entryRows(page)).toHaveCount(1);
    await expect(entryRows(page).nth(0).getByLabel("Invoice ID")).toBeEnabled();
    await expect(entryRows(page).nth(0).getByLabel("Invoice ID")).toHaveValue("");
    await expect(page.getByText("Unsaved draft restored from this device.")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(invoice);
    // The manager's own typing is stored under the manager's key and leaves the other draft alone.
    await fillRow(page, 0, `${invoice}-MGR`, "6.00");
    await expect.poll(async () => (await storedDrafts(page)).map((draft) => draft.userId).sort()).toEqual(["10000000-0000-4000-8000-000000000102", MANAGER_ID]);

    // Explicit sign-out removes that user's readable draft from the device.
    page.once("dialog", (dialog) => void dialog.accept());
    await signOut(page);
    await expect(page).toHaveURL(/\/login/);
    await expect.poll(async () => (await storedDrafts(page)).map((draft) => draft.userId)).toEqual(["10000000-0000-4000-8000-000000000102"]);

    // The original user signs back in and gets their own draft back.
    await login(page);
    await expect(entryRows(page).nth(0).getByLabel("Invoice ID")).toHaveValue(invoice);
    page.once("dialog", (dialog) => void dialog.accept());
    await signOut(page);
    await expect(page).toHaveURL(/\/login/);
    await expect.poll(async () => (await storedDrafts(page)).length).toBe(0);
    await login(page);
    await expect(entryRows(page).nth(0).getByLabel("Invoice ID")).toHaveValue("");
    expect(invoiceCount(invoice)).toBe("0");
  });
});

test.describe("offline operation", () => {
  test("drafts can be created, edited and filled by import while offline, then commit exactly once on reconnect", async ({ page, context }) => {
    const prefix = `OFFLINE-${Date.now()}`;
    await login(page);
    await fillRow(page, 0, `${prefix}-1`, "25.00", "5.00");
    await expectStoredRows(page, [`${prefix}-1`]);

    await context.setOffline(true);
    await expect(page.locator("[data-offline-banner]")).toContainText("You are offline.");
    await expect(draftStatus(page)).toHaveText("Offline — draft saved locally");
    await expect(page.getByLabel("Recent invoices")).toContainText("may be out of date");
    await expect(page.getByRole("button", { name: "Export invoices (.xlsx)" })).toBeDisabled();
    // Create and edit while offline.
    await page.getByRole("button", { name: "Add row" }).click();
    await fillRow(page, 1, `${prefix}-2`, "10.00");
    await entryRows(page).nth(0).getByLabel("Total QAR").fill("30.00");
    // Import and paste into the draft while offline.
    await importFile(page, await workbook([[...IMPORT_HEADERS], [`${prefix}-3`, 4.25, 4.25, "No", null, null, null]]));
    const preview = page.getByRole("region", { name: "Import preview" });
    await preview.getByRole("button", { name: "Add to current draft" }).click();
    await page.getByText("Paste rows copied from Excel").click();
    await page.getByLabel("Paste rows").fill(`${prefix}-4	2.00	0	No			
`);
    await page.getByRole("button", { name: "Preview pasted rows" }).click();
    await preview.getByRole("button", { name: "Add to current draft" }).click();
    await expectStoredRows(page, [1, 2, 3, 4].map((n) => `${prefix}-${n}`));

    // Local review works; saving only queues and claims nothing.
    await page.getByRole("button", { name: "Review batch" }).click();
    await expect(page.getByText("QAR 46.25")).toBeVisible();
    await page.getByRole("button", { name: "Save when back online" }).click();
    await expect(draftStatus(page)).toHaveText("Submission pending — will send when you reconnect");
    await expect(savedNotice(page)).toHaveCount(0);
    expect(scalar(`select count(*) from public.invoices where invoice_id like '${prefix}-%'`)).toBe("0");
    const queued = (await storedDrafts(page))[0];
    expect(queued.submission).toMatchObject({ status: "queued", idempotencyKey: queued.idempotencyKey });

    // Reconnect with a burst of duplicate online events: one submission, one commit.
    let submissions = 0;
    page.on("request", (request) => { if (request.method() === "POST" && request.postData()?.includes(queued.idempotencyKey)) submissions += 1; });
    await context.setOffline(false);
    await page.evaluate(() => { for (let i = 0; i < 5; i++) window.dispatchEvent(new Event("online")); });
    await expect(savedNotice(page)).toBeVisible({ timeout: 30_000 });
    await expect(draftStatus(page)).toHaveText("Saved to ShopKhata");
    await expect(page.getByLabel("Recent invoices")).toContainText(`${prefix}-3`);
    expect(submissions).toBe(1);
    expect(scalar(`select string_agg(invoice_id || ':' || total_amount_dirham, ',' order by invoice_id) from public.invoices where shop_id = '${SHOP_1}' and invoice_id like '${prefix}-%'`))
      .toBe(`${prefix}-1:3000,${prefix}-2:1000,${prefix}-3:425,${prefix}-4:200`);
    expect(scalar(`select count(*) from public.batches where shop_id = '${SHOP_1}' and idempotency_key = '${queued.idempotencyKey}'`)).toBe("1");
    expect(scalar(`select count(*) from public.payments p join public.invoices i on i.id = p.invoice_id where i.invoice_id like '${prefix}-%'`)).toBe("2");
    await expect.poll(async () => (await storedDrafts(page)).length).toBe(0);
  });

  test("a queued submission can be edited before it is sent", async ({ page, context }) => {
    const invoice = `QEDIT-${Date.now()}`;
    await login(page);
    await queueOffline(page, invoice);
    const firstKey = (await storedDrafts(page))[0].idempotencyKey;
    await page.getByRole("button", { name: "Edit draft" }).click();
    await entryRows(page).nth(0).getByLabel("Total QAR").fill("13.00");
    await expect(draftStatus(page)).toHaveText("Offline — draft saved locally");
    await expect.poll(async () => (await storedDrafts(page))[0].submission).toBeNull();
    // It was never sent, so a fresh key for the edited content cannot duplicate anything.
    expect((await storedDrafts(page))[0].idempotencyKey).not.toBe(firstKey);
    await context.setOffline(false);
    await page.getByRole("button", { name: "Review batch" }).click();
    await page.getByRole("button", { name: "Save batch" }).click();
    await expect(savedNotice(page)).toBeVisible();
    expect(scalar(`select total_amount_dirham from public.invoices where shop_id = '${SHOP_1}' and invoice_id = '${invoice}'`)).toBe("1300");
    expect(scalar(`select count(*) from public.batches where idempotency_key = '${firstKey}'`)).toBe("0");
  });
});

test.describe("retry and conflicts", () => {
  test("a lost response stays uncertain, keeps the draft, and resumes after reload without duplicates", async ({ page }) => {
    const invoice = `LOST-${Date.now()}`;
    await login(page);
    await fillRow(page, 0, invoice, "30.00", "12.00");
    await page.getByRole("button", { name: "Review batch" }).click();
    let dropped = false;
    const payloads: string[] = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      // Only the batch submission carries an idempotency key; lookups for the same number do not.
      if (request.method() === "POST" && request.headers()["next-action"] && request.postData()?.includes("idempotencyKey")) {
        payloads.push(request.postData() ?? "");
        if (!dropped) {
          dropped = true;
          await route.fetch(); // the server commits
          return route.abort("failed"); // the browser never hears back
        }
      }
      return route.continue();
    });
    await page.getByRole("button", { name: "Save batch" }).click();
    await expect(page.getByText("Batch was not saved. Try again with the same draft.")).toBeVisible();
    await expect(draftStatus(page)).toHaveText("Submission status uncertain — retry the same batch");
    // The server did commit, but the device does not claim success and keeps the draft locked.
    expect(invoiceCount(invoice)).toBe("1");
    await expect(savedNotice(page)).toHaveCount(0);
    await expect(entryRows(page).nth(0).getByLabel("Invoice ID")).toBeDisabled();
    const uncertain = (await storedDrafts(page))[0];
    expect(uncertain.submission).toMatchObject({ status: "uncertain", idempotencyKey: uncertain.idempotencyKey });

    // Reload mid-doubt: the same submission is restored and retried with its original key.
    await page.reload();
    await expect(savedNotice(page)).toBeVisible({ timeout: 30_000 });
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toBe(payloads[0]);
    expect(payloads[0]).toContain(uncertain.idempotencyKey);
    expect(invoiceCount(invoice)).toBe("1");
    expect(paymentCount(invoice)).toBe("1");
    expect(scalar(`select count(*) from public.batches where shop_id = '${SHOP_1}' and idempotency_key = '${uncertain.idempotencyKey}'`)).toBe("1");
    expect(scalar(`select count(*) from public.audit_events a join public.batches b on a.entity_id = b.id::text where a.action = 'batch.submit' and b.idempotency_key = '${uncertain.idempotencyKey}'`)).toBe("1");
    await expect.poll(async () => (await storedDrafts(page)).length).toBe(0);
    await expect(entryRows(page).nth(0).getByLabel("Invoice ID")).toHaveValue("");
  });

  test("an invoice number used by someone else while offline becomes a row conflict linking to the existing invoice", async ({ page, context, browser }) => {
    const invoice = `INV-500-${Date.now()}`;
    await login(page);
    await queueOffline(page, invoice, "12.00");

    // Another user creates the same number in the same shop before this device reconnects.
    const other = await browser.newPage();
    await login(other, OWNER);
    await fillRow(other, 0, invoice.toLowerCase(), "99.00");
    await other.getByRole("button", { name: "Review batch" }).click();
    await other.getByRole("button", { name: "Save batch" }).click();
    await expect(savedNotice(other)).toBeVisible();
    await other.close();
    const canonical = scalar(`select id from public.invoices where shop_id = '${SHOP_1}' and lower(invoice_id) = lower('${invoice}')`);

    await context.setOffline(false);
    await expect(draftStatus(page)).toHaveText("Conflict — not saved to ShopKhata", { timeout: 30_000 });
    const row = entryRows(page).nth(0);
    await expect(row).toContainText("Invoice ID already exists in this shop.");
    await expect(row.getByRole("alert")).toContainText("Invoice already exists. Outstanding due QAR 99.00.");
    await expect(row.getByRole("link", { name: "Record payment" })).toHaveAttribute("href", `/shops/${SHOP_1}/invoices/${canonical}#record-payment`);
    await expect(savedNotice(page)).toHaveCount(0);
    // The local draft is intact and nothing was overwritten or duplicated.
    await expect(row.getByLabel("Invoice ID")).toHaveValue(invoice);
    await expect(row.getByLabel("Total QAR")).toHaveValue("12.00");
    await expectStoredRows(page, [invoice]);
    expect(invoiceCount(invoice)).toBe("1");
    expect(scalar(`select total_amount_dirham from public.invoices where id = '${canonical}'`)).toBe("9900");

    // The conflict survives a reload and the user resolves it by renumbering the row.
    await page.reload();
    await expect(draftStatus(page)).toHaveText("Conflict — not saved to ShopKhata");
    await expect(entryRows(page).nth(0).getByRole("link", { name: "Record payment" })).toBeVisible();
    await entryRows(page).nth(0).getByLabel("Invoice ID").fill(`${invoice}-B`);
    await page.getByRole("button", { name: "Review batch" }).click();
    await page.getByRole("button", { name: "Save batch" }).click();
    await expect(savedNotice(page)).toBeVisible();
    expect(invoiceCount(invoice)).toBe("1");
    expect(invoiceCount(`${invoice}-B`)).toBe("1");
  });

  test("a business date closed while offline blocks the batch and preserves the draft", async ({ page, context }) => {
    const invoice = `CLOSED-${Date.now()}`;
    const today = qatarBusinessDate(new Date());
    // A backdate nobody else uses, so closing it cannot disturb other tests.
    const backdate = new Date(Date.parse(`${today}T12:00:00.000Z`) - (400 + Math.floor(Math.random() * 3000)) * 86_400_000).toISOString().slice(0, 10);
    await login(page, OWNER);
    await page.getByLabel("Business date").fill(backdate);
    await page.getByLabel("Backdate reason").fill("missed entry");
    await queueOffline(page, invoice);

    localDbQuery(`insert into public.daily_closes (shop_id, business_date, event_type, actor_id) values ('${SHOP_1}', '${backdate}', 'closed', '${OWNER_ID}')`);
    await context.setOffline(false);
    await expect(page.getByRole("alert").filter({ hasText: "This business date is closed." })).toBeVisible({ timeout: 30_000 });
    await expect(draftStatus(page)).toHaveText("Conflict — not saved to ShopKhata");
    expect(invoiceCount(invoice)).toBe("0");
    await expect(entryRows(page).nth(0).getByLabel("Invoice ID")).toHaveValue(invoice);
    await expect(page.getByLabel("Business date")).toHaveValue(backdate);
    await expect(page.getByLabel("Backdate reason")).toHaveValue("missed entry");
    await expectStoredRows(page, [invoice]);

    // Once the date is reopened the preserved draft saves normally.
    localDbQuery(`insert into public.daily_closes (shop_id, business_date, event_type, actor_id, reason) values ('${SHOP_1}', '${backdate}', 'reopened', '${OWNER_ID}', 'late batch')`);
    await page.getByRole("button", { name: "Save batch" }).click();
    await expect(savedNotice(page)).toBeVisible();
    expect(scalar(`select count(*) from public.invoices i join public.batches b on b.id = i.batch_id where i.invoice_id = '${invoice}' and b.business_date = '${backdate}' and b.is_backdated`)).toBe("1");
  });

  test("shop access revoked while offline stops the queued batch from committing", async ({ page, context }) => {
    const invoice = `REVOKED-${Date.now()}`;
    await login(page, MANAGER);
    await queueOffline(page, invoice);
    localDbQuery(`delete from public.user_shop_assignments where user_id = '${MANAGER_ID}' and shop_id = '${SHOP_1}'`);
    try {
      await context.setOffline(false);
      await expect(page.getByRole("alert").filter({ hasText: "You cannot enter invoices for this shop." })).toBeVisible({ timeout: 30_000 });
      await expect(draftStatus(page)).toHaveText("Conflict — not saved to ShopKhata");
      await expect(savedNotice(page)).toHaveCount(0);
      expect(invoiceCount(invoice)).toBe("0");
      await expectStoredRows(page, [invoice]);
      // A manual retry is refused the same way: having prepared it earlier grants nothing.
      await page.getByRole("button", { name: "Retry same batch" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "You cannot enter invoices for this shop." })).toBeVisible();
      expect(invoiceCount(invoice)).toBe("0");
    } finally {
      localDbQuery(`insert into public.user_shop_assignments (user_id, shop_id) values ('${MANAGER_ID}', '${SHOP_1}') on conflict do nothing`);
    }
    // Access restored: the same submission commits once.
    const key = (await storedDrafts(page))[0].idempotencyKey;
    await page.getByRole("button", { name: "Retry same batch" }).click();
    await expect(savedNotice(page)).toBeVisible();
    expect(invoiceCount(invoice)).toBe("1");
    expect(scalar(`select count(*) from public.batches where idempotency_key = '${key}'`)).toBe("1");
  });

  test("an expired session preserves the draft and commits only after signing in again", async ({ page, context }) => {
    const invoice = `SESSION-${Date.now()}`;
    await login(page);
    await queueOffline(page, invoice);
    const key = (await storedDrafts(page))[0].idempotencyKey;
    // The session expires while the device is offline.
    await context.clearCookies();
    await context.setOffline(false);

    // Reconnecting does not commit: the server demands a session first.
    const signIn = page.getByRole("link", { name: "Sign in again" });
    await expect(signIn).toBeVisible({ timeout: 30_000 });
    await expect(draftStatus(page)).toHaveText("Sign in again — draft saved locally");
    await expect(savedNotice(page)).toHaveCount(0);
    expect(invoiceCount(invoice)).toBe("0");
    await expectStoredRows(page, [invoice]);
    expect((await storedDrafts(page))[0].idempotencyKey).toBe(key);

    // Reauthenticate through the real login form; no credential was stored locally.
    const loginUrl = await signIn.getAttribute("href");
    expect(loginUrl).toBe(`/login?next=${encodeURIComponent(`/?shop=${SHOP_1}`)}`);
    await page.goto(loginUrl!);
    await expect(page.getByRole("heading", { name: "Sign in to ShopKhata" })).toBeVisible();
    expect(JSON.stringify(await storedDrafts(page))).not.toContain(STAFF.password);
    await page.getByLabel(/email/i).fill(STAFF.email);
    await page.getByLabel(/password/i).fill(STAFF.password);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await expect(page.getByRole("heading", { name: "Shop 1" })).toBeVisible();

    // The server revalidated the session and shop; the original submission resumes with its original key.
    await expect(savedNotice(page)).toBeVisible({ timeout: 30_000 });
    expect(invoiceCount(invoice)).toBe("1");
    expect(scalar(`select count(*) from public.batches where shop_id = '${SHOP_1}' and idempotency_key = '${key}'`)).toBe("1");
    await expect.poll(async () => (await storedDrafts(page)).length).toBe(0);
  });
});

test.describe("Excel export", () => {
  test("exports invoices, a customer ledger and expenses with effective values, scoped to the shop", async ({ page }) => {
    const suffix = Date.now();
    const invoice = `EXPORT-${suffix}`;
    const customerName = `Export customer ${suffix}`;
    const today = qatarBusinessDate(new Date());
    await login(page);
    await fillRow(page, 0, invoice, "100.00", "30.00");
    await entryRows(page).nth(0).getByLabel("Delivered").check();
    await entryRows(page).nth(0).getByLabel("New customer name").fill(customerName);
    await page.getByRole("button", { name: "Review batch" }).click();
    await page.getByRole("button", { name: "Save batch" }).click();
    await expect(savedNotice(page)).toBeVisible();
    const canonical = scalar(`select id from public.invoices where shop_id = '${SHOP_1}' and invoice_id = '${invoice}'`);
    const customerId = scalar(`select customer_id from public.invoices where id = '${canonical}'`);
    // An approved correction and an approved renumbering change the effective values.
    localDbQuery(`insert into public.corrections (shop_id, invoice_id, amount_delta_dirham, reason, business_date, approved_by)
      values ('${SHOP_1}', '${canonical}', 500, 'approved export adjustment', '${today}', '${OWNER_ID}')`);
    const shop2Invoice = `EXPORT-S2-${suffix}`;
    const shop2Batch = crypto.randomUUID();
    const shop2Id = crypto.randomUUID();
    localDbQuery(`insert into public.batches (id, shop_id, business_date, created_by) values ('${shop2Batch}', '${SHOP_2}', '${today}', '${OWNER_ID}')`);
    localDbQuery(`insert into public.invoices (id, shop_id, batch_id, invoice_id, invoice_type, quantity, total_amount_dirham, business_date, created_by)
      values ('${shop2Id}', '${SHOP_2}', '${shop2Batch}', '${shop2Invoice}', 'advance', 1, 1200, '${today}', '${OWNER_ID}')`);

    // Invoices.
    const [invoiceDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export invoices (.xlsx)" }).click()]);
    expect(invoiceDownload.suggestedFilename()).toBe(`shopkhata-invoices-${today}_${today}.xlsx`);
    const invoiceSheet = (await readDownload(invoiceDownload))[0];
    expect(invoiceSheet.sheet).toBe("Invoices");
    expect(invoiceSheet.data[0]).toEqual(INVOICE_EXPORT_HEADERS);
    const line = invoiceSheet.data.find((cells) => cells[11] === canonical);
    expect(line?.slice(0, 9)).toEqual([invoice, today, 105, 30, 0, 75, "Yes", customerName, null]);
    expect(String(line?.[9])).toMatch(new RegExp(`^${today} \\d{2}:\\d{2}:\\d{2}$`));
    expect(invoiceSheet.data.some((cells) => cells[0] === shop2Invoice)).toBe(false);

    // Customer ledger.
    await page.goto(`/customers/${customerId}?shop=${SHOP_1}`);
    const [ledgerDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export ledger (.xlsx)" }).click()]);
    const ledgerSheet = (await readDownload(ledgerDownload))[0];
    expect(ledgerSheet.data[0]).toEqual(LEDGER_EXPORT_HEADERS);
    const ledgerRows = ledgerSheet.data.slice(1).map((cells) => ({ type: cells[1], invoice: cells[3], debit: Number(cells[4]), credit: Number(cells[5]), balance: Number(cells[6]) }));
    // The invoice and its first payment share one recorded timestamp, so their relative order is not fixed.
    expect(ledgerRows.map((row) => [row.type, row.invoice, row.debit, row.credit]).sort()).toEqual([
      ["invoice", invoice, 100, 0],
      ["invoice correction", invoice, 5, 0],
      ["payment", invoice, 0, 30],
    ].sort());
    // Every running balance follows from the row before it, and the last equals the authoritative due.
    ledgerRows.reduce((previous, row) => { expect(row.balance).toBeCloseTo(previous + row.debit - row.credit, 2); return row.balance; }, 0);
    expect(ledgerRows.at(-1)?.balance).toBe(75);
    await expect(page.getByText("QAR 75.00").first()).toBeVisible();

    // Expenses.
    await page.goto(`/expenses?shop=${SHOP_1}`);
    const expenseForm = page.getByRole("heading", { name: "Record expense" }).locator("..");
    await expenseForm.getByLabel("Amount (QAR)", { exact: true }).fill("12.75");
    await expenseForm.getByLabel("Description", { exact: true }).fill(`Export expense ${suffix}`);
    await expenseForm.getByRole("button", { name: "Save expense" }).click();
    await expect(page.locator("article").filter({ hasText: `Export expense ${suffix}` }).first()).toContainText("QAR 12.75");
    const [expenseDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export expenses (.xlsx)" }).click()]);
    const expenseSheet = (await readDownload(expenseDownload))[0];
    expect(expenseSheet.data[0]).toEqual(EXPENSE_EXPORT_HEADERS);
    expect(expenseSheet.data.find((cells) => cells[2] === `Export expense ${suffix}`)?.slice(0, 5)).toEqual([today, "other", `Export expense ${suffix}`, 12.75, "Local Shop 1 Staff"]);

    // Another shop cannot be exported by naming it, and no export works without a session.
    const range = `from=${today}&to=${today}`;
    expect((await page.request.get(`/exports/invoices?shop=${SHOP_2}&${range}`)).status()).toBe(403);
    expect((await page.request.get(`/exports/expenses?shop=${SHOP_2}&${range}`)).status()).toBe(403);
    expect((await page.request.get(`/exports/customer-ledger?shop=${SHOP_2}&customer=${customerId}`)).status()).toBe(403);
    expect((await page.request.get(`/exports/customer-ledger?shop=${SHOP_1}&customer=${crypto.randomUUID()}`)).status()).toBe(404);
    expect((await page.request.get(`/exports/invoices?shop=${SHOP_1}&from=${today}&to=2000-01-01`)).status()).toBe(400);
    expect((await page.request.get(`/exports/payroll?shop=${SHOP_1}&${range}`)).status()).toBe(404);
    await page.context().clearCookies();
    const anonymous = await page.request.get(`/exports/invoices?shop=${SHOP_1}&${range}`);
    expect(anonymous.headers()["content-type"] ?? "").not.toContain("spreadsheetml");
    expect(anonymous.url()).toContain("/login");
  });
});
