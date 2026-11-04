# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: invoices.spec.ts >> opens with the last-30-day default and a visible status filter
- Location: tests\e2e\invoices.spec.ts:15:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('heading', { name: 'Shop 1' })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByRole('heading', { name: 'Shop 1' }) with timeout 5000ms
  - waiting for getByRole('heading', { name: 'Shop 1' })

```

```yaml
- main:
  - region "Sign in to ShopKhata":
    - heading "Sign in to ShopKhata" [level=1]
    - text: Email
    - textbox "Email"
    - text: Password
    - textbox "Password"
    - button "Sign in"
- region "Notifications alt+T"
- alert: Sign in to ShopKhata
```

# Test source

```ts
  1   | import { execFileSync } from "node:child_process";
  2   | import { readFileSync } from "node:fs";
  3   | import { tmpdir } from "node:os";
  4   | import { join } from "node:path";
  5   | import { expect, type Download, type Locator, type Page } from "@playwright/test";
  6   | import readXlsxFile from "read-excel-file/universal";
  7   | import writeXlsxFile from "write-excel-file/universal";
  8   | 
  9   | import { IMPORT_SHEET_NAME } from "@/lib/excel/invoice-import";
  10  | 
  11  | export const SHOP_1 = "10000000-0000-4000-8000-000000000001";
  12  | export const SHOP_2 = "10000000-0000-4000-8000-000000000002";
  13  | export const OWNER_ID = "10000000-0000-4000-8000-000000000101";
  14  | export const MANAGER_ID = "10000000-0000-4000-8000-000000000104";
  15  | export const STAFF = { email: "staff1@shopkhata.local", password: "<redacted>" };
  16  | export const OWNER = { email: "owner@shopkhata.local", password: "<redacted>" };
  17  | export const MANAGER = { email: "manager@shopkhata.local", password: "<redacted>" };
  18  | export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  19  | 
  20  | // The Supabase CLI rewrites a state file in the home directory on every run. Parallel workers
  21  | // racing on that one file make a query fail now and then, so each worker gets its own.
  22  | const CLI_HOME = join(tmpdir(), `shopkhata-e2e-supabase-${process.pid}`);
  23  | 
  24  | export function localDbQuery(sql: string) {
  25  |   return execFileSync(process.execPath, [
  26  |     join(process.cwd(), "node_modules", "supabase", "dist", "supabase.js"),
  27  |     "--agent", "no", "db", "query", "--local", sql,
  28  |   ], { encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: CLI_HOME, USERPROFILE: CLI_HOME } });
  29  | }
  30  | /** Runs a single-value SQL expression and returns it as text. */
  31  | export function scalar(expression: string): string {
  32  |   const token = `v${crypto.randomUUID().replaceAll("-", "")}`;
  33  |   return localDbQuery(`select '${token}=' || (${expression})::text || ';' as value`).match(new RegExp(`${token}=([^;]*);`))?.[1] ?? "";
  34  | }
  35  | export const invoiceCount = (number: string, shop = SHOP_1) => scalar(`select count(*) from public.invoices where shop_id = '${shop}' and lower(invoice_id) = lower('${number}')`);
  36  | export const paymentCount = (number: string) => scalar(`select count(*) from public.payments p join public.invoices i on i.id = p.invoice_id where i.shop_id = '${SHOP_1}' and i.invoice_id = '${number}'`);
  37  | 
  38  | /**
  39  |  * A sign-in of its own for one test. Signing out ends every session of that account, so a test
  40  |  * that signs out must not share an account with tests running beside it.
  41  |  */
  42  | export function createAccount(role: "manager" | "staff", shopId = SHOP_1) {
  43  |   const id = crypto.randomUUID();
  44  |   const user = { email: `e2e-${id}@shopkhata.local`, password: "<redacted>" };
  45  |   localDbQuery(`with u as (insert into auth.users(id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, confirmation_token, recovery_token, email_change, email_change_token_new, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  46  |       values ('${id}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '${user.email}', extensions.crypt('${user.password}', extensions.gen_salt('bf')), now(), '', '', '', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()) returning id),
  47  |     i as (insert into auth.identities(id, user_id, identity_data, provider, provider_id, created_at, updated_at, last_sign_in_at)
  48  |       select gen_random_uuid(), id, jsonb_build_object('sub', id::text, 'email', '${user.email}'), 'email', id::text, now(), now(), now() from u),
  49  |     p as (insert into public.profiles(id, email, display_name, role, is_active) select id, '${user.email}', 'E2E ${role} ${id.slice(0, 8)}', '${role}', true from u)
  50  |     insert into public.user_shop_assignments(user_id, shop_id) select id, '${shopId}' from u`);
  51  |   return user;
  52  | }
  53  | 
  54  | export async function login(page: Page, user = STAFF) {
  55  |   await page.goto("/login");
  56  |   await page.getByLabel(/email/i).fill(user.email);
  57  |   await page.getByLabel(/password/i).fill(user.password);
  58  |   await page.getByRole("button", { name: /sign in|log in/i }).click();
> 59  |   await expect(page.getByRole("heading", { name: "Shop 1" })).toBeVisible();
      |                                                               ^ Error: expect(locator).toBeVisible() failed
  60  | }
  61  | 
  62  | /** Sign out from the profile menu in the top bar. */
  63  | export async function signOut(page: Page) {
  64  |   await page.getByRole("button", { name: "Profile" }).click();
  65  |   await page.getByRole("menuitem", { name: "Sign out" }).click();
  66  | }
  67  | 
  68  | export const entryRows = (page: Page) => page.locator("[data-entry-row]");
  69  | export const draftStatus = (page: Page) => page.locator("[data-draft-status]");
  70  | export const savedNotice = (page: Page) => page.getByRole("status").filter({ hasText: /Sale saved|\d+ invoices saved/ });
  71  | 
  72  | export async function fillRow(page: Page, index: number, invoice: string, total: string, received = "") {
  73  |   const row = entryRows(page).nth(index);
  74  |   await row.getByLabel("Invoice ID").fill(invoice);
  75  |   await row.getByLabel("Total QAR").fill(total);
  76  |   if (received) await row.getByLabel("Received QAR").fill(received);
  77  | }
  78  | 
  79  | /** What is actually stored on the device, read straight from IndexedDB. */
  80  | export async function storedDrafts(page: Page): Promise<{ key: string; userId: string; shopId: string; idempotencyKey: string; rows: { rowId: string; invoiceId: string }[]; submission: { status: string; idempotencyKey: string } | null }[]> {
  81  |   return page.evaluate(() => new Promise((resolve, reject) => {
  82  |     const open = indexedDB.open("shopkhata-local");
  83  |     open.onerror = () => reject(open.error);
  84  |     open.onsuccess = () => {
  85  |       const db = open.result;
  86  |       if (!db.objectStoreNames.contains("drafts")) { db.close(); resolve([]); return; }
  87  |       const all = db.transaction("drafts").objectStore("drafts").getAll();
  88  |       all.onsuccess = () => { db.close(); resolve(all.result); };
  89  |       all.onerror = () => { db.close(); reject(all.error); };
  90  |     };
  91  |   }));
  92  | }
  93  | export async function expectStoredRows(page: Page, numbers: string[]) {
  94  |   await expect.poll(async () => (await storedDrafts(page)).flatMap((draft) => draft.rows.map((row) => row.invoiceId))).toEqual(numbers);
  95  | }
  96  | 
  97  | export async function workbook(data: (string | number | boolean | null)[][], sheet = IMPORT_SHEET_NAME) {
  98  |   return Buffer.from(await (await writeXlsxFile([{ sheet, data }]).toBlob()).arrayBuffer());
  99  | }
  100 | export async function readDownload(download: Download) {
  101 |   return readXlsxFile(new Blob([readFileSync(await download.path())]));
  102 | }
  103 | /** New Sale keeps Import Excel, Record payment and Recent invoices under "Other tools". */
  104 | export async function openSaleTools(page: Page) {
  105 |   const tools = page.locator("[data-sale-tools]");
  106 |   if (!await tools.evaluate((element) => (element as HTMLDetailsElement).open)) await tools.locator(":scope > summary").click();
  107 | }
  108 | /** Several invoices show one form at a time; this opens invoice `index` (0-based) for editing. */
  109 | export async function editRow(page: Page, index: number) {
  110 |   await page.getByRole("button", { name: `Edit invoice ${index + 1}` }).click();
  111 | }
  112 | /** Expenses: "Add expense" opens the entry drawer; retried because a click before hydration does nothing. */
  113 | export async function openDrawer(page: Page, name: string) {
  114 |   const drawer = page.getByRole("dialog", { name });
  115 |   await expect(async () => {
  116 |     if (!await drawer.isVisible()) await page.getByRole("button", { name }).click();
  117 |     await expect(drawer).toBeVisible({ timeout: 1_000 });
  118 |   }).toPass();
  119 |   return drawer;
  120 | }
  121 | export const openAddExpense = (page: Page) => openDrawer(page, "Add expense");
  122 | /** Review, then save: the drawer closes once ShopKhata confirms the expense. */
  123 | export async function saveExpense(drawer: Locator) {
  124 |   await drawer.getByRole("button", { name: "Review expense" }).click();
  125 |   await drawer.getByRole("button", { name: "Save expense" }).click();
  126 | }
  127 | /** The list row (a card on phones) for an expense, found by its description. */
  128 | export const expenseRow = (page: Page, description: string) => page.locator("[data-expense]").filter({ hasText: description }).first();
  129 | export async function importFile(page: Page, buffer: Buffer, name = "batch.xlsx") {
  130 |   await openSaleTools(page);
  131 |   await page.getByLabel("Import Excel (.xlsx)").setInputFiles({ name, mimeType: XLSX, buffer });
  132 | }
  133 | 
  134 | /** The service worker controls the page and has the offline page cached. */
  135 | export async function waitForOfflineShell(page: Page) {
  136 |   await expect.poll(() => page.evaluate(async () => Boolean(navigator.serviceWorker.controller) && Boolean(await caches.match("/offline"))), { timeout: 60_000 }).toBe(true);
  137 | }
  138 | 
  139 | /** Types a one-row batch while offline and queues it. Returns nothing committed. */
  140 | export async function queueOffline(page: Page, invoice: string, total = "12.00") {
  141 |   await fillRow(page, 0, invoice, total);
  142 |   await expectStoredRows(page, [invoice]);
  143 |   await page.context().setOffline(true);
  144 |   await expect(page.locator("[data-offline-banner]")).toBeVisible();
  145 |   await page.getByRole("button", { name: "Review sale" }).click();
  146 |   await page.getByRole("button", { name: "Save when back online" }).click();
  147 |   await expect(draftStatus(page)).toHaveText("Submission pending — will send when you reconnect");
  148 |   expect(invoiceCount(invoice)).toBe("0");
  149 | }
  150 | 
```