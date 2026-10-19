import { expect, test, type Page } from "@playwright/test";

import { groupedQar } from "@/lib/dashboard-view";
import { IMPORT_HEADERS, MAX_IMPORT_ROWS } from "@/lib/excel/invoice-import";

import { MANAGER, OWNER, SHOP_1, SHOP_2, STAFF, entryRows, fillRow, importFile, localDbQuery, login, savedNotice, scalar, signOut, workbook } from "./offline-helpers";

// BIG SLICE 5 release acceptance in a real browser: owner administration,
// security headers and session handling, the largest allowed Excel batch, and
// usability and accessibility of every workspace at three screen sizes.
test.describe.configure({ mode: "default" });

async function signIn(page: Page, user: { email: string; password: string }, heading: string) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
}

test.describe("owner administration", () => {
  test("an owner registers an account, assigns a shop, deactivates and re-roles it, and each change applies at once", async ({ page, browser }) => {
    const stamp = Date.now();
    const hire = { email: `hire-${stamp}@shopkhata.local`, password: `Hire-Local-E2E-${stamp}!` };
    const id = crypto.randomUUID();
    // A sign-in created the way the Supabase dashboard creates it: no ShopKhata profile yet.
    localDbQuery(`with u as (insert into auth.users(id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, confirmation_token, recovery_token, email_change, email_change_token_new, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values ('${id}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '${hire.email}', extensions.crypt('${hire.password}', extensions.gen_salt('bf')), now(), '', '', '', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()) returning id)
      insert into auth.identities(id, user_id, identity_data, provider, provider_id, created_at, updated_at, last_sign_in_at)
      select gen_random_uuid(), id, jsonb_build_object('sub', id::text, 'email', '${hire.email}'), 'email', id::text, now(), now(), now() from u`);

    // Staff and managers are offered no administration and cannot reach it by URL.
    for (const user of [STAFF, MANAGER]) {
      const context = await browser.newContext();
      const other = await context.newPage();
      await login(other, user);
      await expect(other.getByRole("link", { name: "Accounts" })).toHaveCount(0);
      expect((await other.goto("/admin"))?.status()).toBe(404);
      await expect(other.getByText(hire.email)).toHaveCount(0);
      await context.close();
    }

    const hireContext = await browser.newContext();
    const hirePage = await hireContext.newPage();
    // Before registration the sign-in works but reaches nothing.
    await hirePage.goto("/login");
    await hirePage.getByLabel(/email/i).fill(hire.email);
    await hirePage.getByLabel(/password/i).fill(hire.password);
    await hirePage.getByRole("button", { name: "Sign in" }).click();
    await expect(hirePage.getByRole("heading", { name: "Sign in to ShopKhata" })).toBeVisible();
    await expect(hirePage).toHaveURL(/\/login/);

    await login(page, OWNER);
    await page.getByRole("link", { name: "Accounts" }).click();
    await expect(page.getByRole("heading", { name: "Accounts and shop access" })).toBeVisible();
    const accounts = page.getByRole("table");
    await expect(accounts.getByRole("row", { name: /owner@shopkhata\.local/ })).toContainText("All shops (owner)");
    await expect(accounts.getByRole("row", { name: /staff1@shopkhata\.local/ })).toContainText("Shop 1");
    await expect(page.locator('[data-manage="owner@shopkhata.local"]')).toContainText("This is your own account.");
    await expect(page.locator('[data-manage="owner@shopkhata.local"]').getByRole("button")).toHaveCount(0);

    // Register: an unknown email is refused, the real one is accepted with no access yet.
    const register = page.getByRole("heading", { name: "Register an account" }).locator("..");
    await register.getByLabel("Sign-in email").fill(`nobody-${stamp}@shopkhata.local`);
    await register.getByLabel("Display name").fill("Nobody");
    await register.getByRole("button", { name: "Register account" }).click();
    await expect(register.getByRole("alert")).toContainText("No sign-in exists for that email");
    await register.getByLabel("Sign-in email").fill(hire.email);
    await register.getByLabel("Display name").fill(`New Hire ${stamp}`);
    await register.getByRole("button", { name: "Register account" }).click();
    const row = accounts.getByRole("row", { name: new RegExp(hire.email) });
    await expect(row).toContainText("No access (no shop assigned)");
    await hirePage.goto("/");
    await expect(hirePage.getByRole("heading", { name: "No shop assigned" })).toBeVisible();

    // Assign Shop 2: the account's next page load is Shop 2 and only Shop 2.
    const manage = page.locator(`[data-manage="${hire.email}"]`);
    await manage.getByLabel("Shop 2").check();
    await manage.getByRole("button", { name: "Save account" }).click();
    await expect(row).toContainText("Shop 2");
    await hirePage.goto("/");
    await expect(hirePage.getByRole("heading", { name: "Shop 2" })).toBeVisible();
    await hirePage.goto(`/?shop=${SHOP_1}`);
    await expect(hirePage.getByRole("heading", { name: "Shop 2" })).toBeVisible();
    await expect(hirePage.getByRole("heading", { name: "Shop 1" })).toHaveCount(0);

    // Deactivate: the open session is told why and can do nothing.
    await manage.getByLabel("Account is active").uncheck();
    await manage.getByRole("button", { name: "Save account" }).click();
    await expect(row).toContainText("No access (deactivated)");
    await hirePage.goto("/customers");
    await expect(hirePage.getByRole("heading", { name: "Account deactivated" })).toBeVisible();
    await expect(hirePage.getByRole("navigation")).toHaveCount(0);

    // Reactivate as a Shop 1 manager and take Shop 2 away.
    await manage.getByLabel("Account is active").check();
    await manage.getByLabel("Role").selectOption("manager");
    await manage.getByLabel("Shop 1").check();
    await manage.getByLabel("Shop 2").uncheck();
    await manage.getByRole("button", { name: "Save account" }).click();
    await expect(row).toContainText("manager");
    await expect(row).toContainText("Shop 1");
    await expect(row).not.toContainText("Shop 2");
    await hirePage.goto("/closing");
    await expect(hirePage.getByRole("button", { name: "Close business date" })).toBeVisible();
    await expect(hirePage.getByRole("link", { name: "Shop 2" })).toHaveCount(0);
    await expect(hirePage.getByRole("link", { name: "Accounts" })).toHaveCount(0);
    await hireContext.close();

    // Every change is in the audit trail, attributed to the owner, and shown on the page.
    expect(scalar(`select string_agg(action, ',' order by recorded_at, action) from public.audit_events where entity_type = 'profile' and entity_id = '${id}'`))
      .toBe("account.register,assignment.add,account.update,account.update,assignment.add,assignment.remove");
    expect(scalar(`select count(distinct actor_id) from public.audit_events where entity_type = 'profile' and entity_id = '${id}' and actor_id = '10000000-0000-4000-8000-000000000101'`)).toBe("1");
    const history = page.getByRole("heading", { name: "Recent account changes" }).locator("..");
    await expect(history).toContainText(`Registered account · New Hire ${stamp}`);
    await expect(history).toContainText(`Removed shop access · New Hire ${stamp} · Shop 2`);
    // Leave no usable extra manager behind for other tests.
    await manage.getByLabel("Account is active").uncheck();
    await manage.getByRole("button", { name: "Save account" }).click();
    await expect(row).toContainText("No access (deactivated)");
  });
});

test.describe("security headers and sessions", () => {
  test("sends the security headers on public and authenticated pages without breaking the application", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (message) => { if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text()); });
    const anonymous = await page.goto("/login");
    for (const response of [anonymous!, await (await login(page), page.goto("/reports"))]) {
      const headers = response!.headers();
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(headers["permissions-policy"]).toContain("camera=()");
      expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(headers["content-security-policy"]).toContain("object-src 'none'");
      expect(headers["content-security-policy"]).toMatch(/connect-src 'self' http:\/\/127\.0\.0\.1:\d+ ws:\/\/127\.0\.0\.1:\d+/);
      // Local HTTP: HSTS must not be sent unless the deployment opts in.
      expect(headers["strict-transport-security"]).toBeUndefined();
    }
    // The pages that talk to Supabase from the browser and run client code still work under the policy.
    await page.goto("/");
    await fillRow(page, 0, `CSP-${Date.now()}`, "3.00");
    await page.getByRole("button", { name: "Review sale" }).click();
    await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
    await expect(savedNotice(page)).toBeVisible();
    await page.goto("/expenses");
    await expect(page.getByRole("heading", { name: "Record expense" })).toBeVisible();
    expect(violations).toEqual([]);
  });

  test("rejects unauthenticated access, ignores hostile return addresses, and ends the session on sign-out and expiry", async ({ page, context }) => {
    // Every protected route sends an anonymous visitor to the sign-in page and remembers only a local path.
    for (const path of ["/", "/customers", "/expenses", "/closing", "/reports", "/admin", `/shops/${SHOP_1}/invoices/${crypto.randomUUID()}`]) {
      await page.goto(path);
      await expect(page).toHaveURL((url) => url.pathname === "/login" && url.searchParams.get("next") === path);
    }
    expect((await page.request.get(`/exports/invoices?shop=${SHOP_1}`, { maxRedirects: 0 })).status()).not.toBe(200);

    // A return address that points off-site is never followed.
    for (const next of ["https://evil.example/steal", "//evil.example/steal", "/\\evil.example", "javascript:alert(1)"]) {
      await context.clearCookies();
      await page.goto(`/login?next=${encodeURIComponent(next)}`);
      await page.getByLabel(/email/i).fill(STAFF.email);
      await page.getByLabel(/password/i).fill(STAFF.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("heading", { name: "Shop 1" })).toBeVisible();
      expect(new URL(page.url()).origin).toBe("http://localhost:3000");
    }
    // A local return address is honoured.
    await context.clearCookies();
    await page.goto("/customers");
    await page.getByLabel(/email/i).fill(STAFF.email);
    await page.getByLabel(/password/i).fill(STAFF.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/customers$/);

    // Nothing that authenticates is kept outside the session cookie.
    const stored = await page.evaluate(async () => {
      const text = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
      for (const { name } of await indexedDB.databases()) {
        const db: IDBDatabase = await new Promise((resolve, reject) => { const open = indexedDB.open(name!); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
        for (const store of db.objectStoreNames) {
          text.push(JSON.stringify(await new Promise((resolve) => { const all = db.transaction(store).objectStore(store).getAll(); all.onsuccess = () => resolve(all.result); })));
        }
        db.close();
      }
      return text.join("\n");
    });
    expect(stored).not.toMatch(/access_token|refresh_token|eyJhbGciOi/);

    // Sign-out ends the session: protected pages and exports are refused afterwards.
    await page.goto("/");
    await signOut(page);
    await expect(page.getByRole("heading", { name: "Sign in to ShopKhata" })).toBeVisible();
    await page.goto("/reports");
    await expect(page).toHaveURL(/\/login\?next=%2Freports$/);
    expect((await context.cookies()).filter((cookie) => cookie.name.includes("auth-token") && cookie.value)).toEqual([]);

    // An expired or removed session: the next navigation and the next save both fail closed.
    await signIn(page, STAFF, "Shop 1");
    const invoice = `EXPIRED-${Date.now()}`;
    await fillRow(page, 0, invoice, "4.00");
    await context.clearCookies();
    await page.getByRole("button", { name: "Review sale" }).click();
    await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
    await expect(page.getByRole("alert").filter({ hasText: /Sign in again/ })).toBeVisible();
    expect(scalar(`select count(*) from public.invoices where invoice_id = '${invoice}'`)).toBe("0");
    await page.goto("/customers");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("largest Excel batch", () => {
  test(`imports, reviews and saves ${MAX_IMPORT_ROWS} rows as one batch, and maps a bad row to its own line`, async ({ page }) => {
    const prefix = `XLMAX-${Date.now()}`;
    const line = (index: number) => [`${prefix}-${String(index).padStart(3, "0")}`, 100 + index, index % 3 === 0 ? 100 + index : index % 3 === 1 ? 10 : 0, index % 2 ? "Yes" : "No", index % 2 ? `Bulk Customer ${prefix} ${index}` : null, null, index % 10 === 0 ? `note ${index}` : null];
    const rows = Array.from({ length: MAX_IMPORT_ROWS }, (_, index) => line(index + 1));
    await login(page);
    const preview = page.getByRole("region", { name: "Import preview" });

    // One row over the limit is refused as a whole.
    await importFile(page, await workbook([[...IMPORT_HEADERS], ...rows, line(MAX_IMPORT_ROWS + 1)]));
    await expect(page.getByRole("alert").filter({ hasText: `The workbook has ${MAX_IMPORT_ROWS + 1} rows. Import at most ${MAX_IMPORT_ROWS} rows per batch.` })).toBeVisible();
    await expect(preview).toHaveCount(0);

    // A full file with two bad rows: each error names its own spreadsheet row.
    const broken = rows.map((row) => [...row]);
    broken[56][1] = "12.345";
    broken[98][0] = broken[2][0];
    await importFile(page, await workbook([[...IMPORT_HEADERS], ...broken]));
    const errors = preview.getByRole("list", { name: "Import errors" });
    await expect(errors.getByRole("listitem").filter({ hasText: /^Row 58:/ })).not.toHaveCount(0);
    await expect(errors.getByRole("listitem").filter({ hasText: /^Row 100:/ })).not.toHaveCount(0);
    await expect(errors.getByRole("listitem").filter({ hasText: /^Row (57|59|99|101):/ })).toHaveCount(0);
    await expect(preview.getByRole("button", { name: "Add rows to draft" })).toBeDisabled();
    expect(scalar(`select count(*) from public.invoices where invoice_id like '${prefix}-%'`)).toBe("0");

    // The valid full file: parsed and previewed promptly.
    const started = Date.now();
    await importFile(page, await workbook([[...IMPORT_HEADERS], ...rows]));
    await expect(preview.locator("[data-import-row]")).toHaveCount(MAX_IMPORT_ROWS);
    const parseMs = Date.now() - started;
    expect(parseMs).toBeLessThan(10_000);
    await expect(preview.getByRole("list", { name: "Import errors" })).toHaveCount(0);
    await preview.getByRole("button", { name: "Add rows to draft" }).click();
    await expect(entryRows(page)).toHaveCount(MAX_IMPORT_ROWS);

    // The review stays usable: totals are exact and the last row is reachable and editable.
    const invoiced = rows.reduce((sum, row) => sum + (row[1] as number), 0);
    await entryRows(page).nth(MAX_IMPORT_ROWS - 1).getByLabel("Note").fill("edited last row");
    await page.getByRole("button", { name: "Review sale" }).click();
    await expect(page.getByLabel("Sale review").getByText(`QAR ${groupedQar(invoiced * 100)}`, { exact: true }).first()).toBeVisible();
    const saveStarted = Date.now();
    await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
    await expect(savedNotice(page)).toBeVisible({ timeout: 60_000 });
    const saveMs = Date.now() - saveStarted;
    expect(saveMs).toBeLessThan(30_000);
    console.log(`[large-excel] ${MAX_IMPORT_ROWS} rows: parse and preview ${parseMs} ms, save ${saveMs} ms`);

    // One atomic batch with every row, payment and quick-added customer.
    expect(scalar(`select count(*) || ':' || count(distinct batch_id) || ':' || sum(total_amount_dirham) from public.invoices where shop_id = '${SHOP_1}' and invoice_id like '${prefix}-%'`)).toBe(`${MAX_IMPORT_ROWS}:1:${invoiced * 100}`);
    expect(scalar(`select count(*) from public.customers where shop_id = '${SHOP_1}' and name like 'Bulk Customer ${prefix} %'`)).toBe(String(MAX_IMPORT_ROWS / 2));
    expect(scalar(`select note from public.invoices where invoice_id = '${prefix}-${MAX_IMPORT_ROWS}'`)).toBe("edited last row");
    expect(scalar(`select count(*) from public.payments p join public.invoices i on i.id = p.invoice_id where i.invoice_id like '${prefix}-%'`)).toBe(String(rows.filter((row) => (row[2] as number) > 0).length));
  });
});

// Everything a keyboard or screen-reader user needs, checked in the page itself.
// It complements, and does not replace, the manual review in the verification document.
const audit = () => {
  const issues: string[] = [];
  const visible = (element: Element) => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none"; };
  const describe = (element: Element) => `<${element.tagName.toLowerCase()}${element.getAttribute("name") ? ` name=${element.getAttribute("name")}` : ""}> "${(element.textContent ?? "").trim().slice(0, 40)}"`;
  const named = (element: Element) => Boolean(
    element.getAttribute("aria-label")?.trim() || element.getAttribute("title")?.trim()
    || (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).some((id) => id && document.getElementById(id)?.textContent?.trim())
    || (element as HTMLInputElement).labels?.length && [...(element as HTMLInputElement).labels!].some((label) => label.textContent?.trim()));

  if (!document.documentElement.lang) issues.push("html has no lang");
  if (!document.title.trim()) issues.push("page has no title");
  if (document.querySelectorAll("h1").length !== 1) issues.push(`expected one h1, found ${document.querySelectorAll("h1").length}`);
  for (const field of document.querySelectorAll("input:not([type=hidden]), select, textarea")) if (visible(field) && !named(field)) issues.push(`unlabelled field ${describe(field)}`);
  for (const control of document.querySelectorAll("button, a[href], summary")) if (visible(control) && !control.textContent?.trim() && !named(control)) issues.push(`unnamed control ${describe(control)}`);
  for (const table of document.querySelectorAll("table")) {
    if (!table.querySelector("th")) issues.push("table without header cells");
    if ([...table.querySelectorAll("thead th")].some((cell) => !cell.getAttribute("scope"))) issues.push("table header without scope");
  }
  for (const image of document.querySelectorAll("img")) if (!image.hasAttribute("alt")) issues.push("image without alt");
  for (const live of document.querySelectorAll("[role=alert], [role=status]")) if (visible(live) && !live.textContent?.trim()) issues.push("empty status message");
  if (new Set([...document.querySelectorAll("[id]")].map((element) => element.id)).size !== document.querySelectorAll("[id]").length) issues.push("duplicate id");

  // Usability: no control may be cut off by the screen edge, unless it sits in a deliberately scrollable area.
  const scrollable = (element: Element | null): boolean => !!element && element !== document.body && (/(auto|scroll)/.test(getComputedStyle(element).overflowX) || scrollable(element.parentElement));
  for (const control of document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea")) {
    const box = control.getBoundingClientRect();
    if (visible(control) && !scrollable(control.parentElement) && (box.right > window.innerWidth + 1 || box.left < -1)) issues.push(`off-screen control ${describe(control)} (${Math.round(box.left)}..${Math.round(box.right)} of ${window.innerWidth})`);
  }
  if (document.documentElement.scrollWidth > window.innerWidth + 1) issues.push(`page is ${document.documentElement.scrollWidth}px wide in a ${window.innerWidth}px window`);
  return issues;
};

const SIZES = [["desktop", 1366, 768], ["tablet", 820, 1180], ["mobile", 390, 844]] as const;

test.describe("responsive usability and accessibility", () => {
  test.describe.configure({ timeout: 60_000 });

  for (const [name, width, height] of SIZES) {
    test(`every workspace is usable and accessible at ${name} size (${width}x${height})`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const stamp = `${name}-${Date.now()}`;
      const issues: Record<string, string[]> = {};
      const check = async (label: string) => { const found = await page.evaluate(audit); if (found.length) issues[label] = found; };

      await page.goto("/login");
      await check("sign in");
      // The whole sign-in works from the keyboard, with a visible focus indicator on each stop.
      await page.getByLabel(/email/i).focus();
      await page.keyboard.type(OWNER.email);
      await page.keyboard.press("Tab");
      await page.keyboard.type(OWNER.password);
      for (const stop of ["#password", "button[type=submit]"]) {
        await page.locator(stop).focus();
        expect(await page.locator(stop).evaluate((element) => { const style = getComputedStyle(element); return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0; })).toBe(true);
      }
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Shop 1" })).toBeVisible();

      // Invoice entry, review and save.
      await fillRow(page, 0, `RWD-${stamp}`, "50.00", "20.00");
      await page.getByRole("button", { name: "Add another invoice" }).click();
      await fillRow(page, 1, `RWD-${stamp}-2`, "5.00");
      await page.getByRole("button", { name: "Review sale" }).click();
      await check("invoice entry with review");
      await page.getByRole("button", { name: /^Save (sale|\d+ invoices)$/ }).click();
      await expect(savedNotice(page)).toBeVisible();
      await expect(savedNotice(page)).toHaveAttribute("role", "status");
      // A rejected row is announced and described next to its own row, in words.
      await fillRow(page, 0, `RWD-${stamp}`, "1.00");
      await expect(entryRows(page).nth(0)).toContainText(/already exists/i);
      await page.getByRole("button", { name: "Review sale" }).click();
      await expect(page.getByRole("alert").first()).toBeVisible();
      await check("invoice entry with errors");

      // Excel import preview.
      await page.reload();
      await page.getByRole("button", { name: "Discard draft" }).click().catch(() => undefined);
      await importFile(page, await workbook([[...IMPORT_HEADERS], [`RWD-${stamp}-X`, 10, 0, "No", null, null, null], [`RWD-${stamp}-Y`, "bad", 0, "No", null, null, null]]));
      await expect(page.getByRole("region", { name: "Import preview" })).toBeVisible();
      await check("excel import preview");

      // Invoice Detail and a follow-up payment.
      const invoiceId = scalar(`select id from public.invoices where shop_id = '${SHOP_1}' and invoice_id = 'RWD-${stamp}'`);
      await page.goto(`/shops/${SHOP_1}/invoices/${invoiceId}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await check("invoice detail");

      // Customers, a customer ledger and the payment panel.
      await page.goto(`/customers?shop=${SHOP_1}`);
      await page.getByRole("button", { name: "Add customer" }).first().click();
      await page.getByLabel("Name", { exact: true }).fill(`RWD Customer ${stamp}`);
      await page.getByLabel("Mobile", { exact: true }).fill(`6${String(Date.now()).slice(-8)}`);
      await check("customers");
      await page.getByRole("button", { name: "Create customer" }).click();
      await expect(page.getByRole("heading", { name: `RWD Customer ${stamp}` }).first()).toBeVisible();
      await check("customer ledger");

      // Expenses.
      await page.goto(`/expenses?shop=${SHOP_1}`);
      const expense = page.getByRole("heading", { name: "Record expense" }).locator("..");
      await expense.getByLabel("Amount (QAR)", { exact: true }).fill("2.50");
      await expense.getByLabel("Description", { exact: true }).fill(`RWD expense ${stamp}`);
      await check("expenses");
      await Promise.all([page.waitForEvent("load"), expense.getByRole("button", { name: "Save expense" }).click()]);
      await expect(page.locator("article").filter({ hasText: `RWD expense ${stamp}` }).first()).toBeVisible();

      // Daily close: the state is words, not only a colour.
      await page.goto(`/closing?shop=${SHOP_2}&date=2020-01-0${SIZES.findIndex((size) => size[0] === name) + 1}`);
      await expect(page.locator("[data-day-state]")).toHaveText(/^(Open|Closed)$/);
      await expect(page.getByRole("button", { name: /business date$/ })).toBeVisible();
      await check("daily close");

      // Reports, all five.
      for (const report of ["daily", "sales", "dues", "expenses", "payments"]) {
        await page.goto(`/reports?shop=${SHOP_1}&report=${report}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await check(`report ${report}`);
      }

      // Invoices: the 30-day default history browser.
      await page.goto(`/invoices?shop=${SHOP_1}`);
      await expect(page.getByRole("heading", { name: "Sales", exact: true })).toBeVisible();
      await check("invoices");

      // Payments: Record Payment plus history, at the same screen size as Overview's.
      await page.goto(`/payments?shop=${SHOP_1}`);
      await expect(page.getByRole("heading", { name: "Payments" })).toBeVisible();
      await check("payments");

      // Dashboard: KPIs, trend, and every section's empty/populated state.
      await page.goto(`/dashboard?shop=${SHOP_1}`);
      await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
      await check("dashboard today");
      await page.goto(`/dashboard?shop=${SHOP_1}&period=30d`);
      await check("dashboard 30 days");

      // Owner administration.
      await page.goto("/admin");
      await expect(page.getByRole("table")).toBeVisible();
      await check("administration");

      // The navigation reaches every workspace and the offline state is announced in words.
      // Wide screens show the pills in the top bar; tablets and phones list every page in a menu sheet.
      const links = ["Dashboard", "Sales", "Customers", "Expenses", "Daily Close", "Reports", "Accounts", "Backup"];
      if (width >= 1280) {
        for (const link of links) await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: link, exact: true })).toBeInViewport({ ratio: 1 });
      } else {
        await page.getByRole("button", { name: width >= 768 ? "Menu" : "More" }).click();
        for (const link of [...links, "Payments"]) await expect(page.getByRole("navigation", { name: "All pages" }).getByRole("link", { name: link, exact: true })).toBeInViewport({ ratio: 1 });
        await page.keyboard.press("Escape");
      }
      await page.goto("/");
      await page.context().setOffline(true);
      await expect(page.locator("[data-offline-banner]")).toContainText("You are offline.");
      await check("offline state");
      await page.context().setOffline(false);

      expect(issues).toEqual({});
    });
  }
});
