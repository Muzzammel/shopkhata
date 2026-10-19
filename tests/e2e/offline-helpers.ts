import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Download, type Page } from "@playwright/test";
import readXlsxFile from "read-excel-file/universal";
import writeXlsxFile from "write-excel-file/universal";

import { IMPORT_SHEET_NAME } from "@/lib/excel/invoice-import";

export const SHOP_1 = "10000000-0000-4000-8000-000000000001";
export const SHOP_2 = "10000000-0000-4000-8000-000000000002";
export const OWNER_ID = "10000000-0000-4000-8000-000000000101";
export const MANAGER_ID = "10000000-0000-4000-8000-000000000104";
export const STAFF = { email: "staff1@shopkhata.local", password: "ShopKhata-Local-E2E-Only-2026!" };
export const OWNER = { email: "owner@shopkhata.local", password: "ShopKhata-Local-Owner-E2E-Only-2026!" };
export const MANAGER = { email: "manager@shopkhata.local", password: "ShopKhata-Local-Manager-E2E-Only-2026!" };
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// The Supabase CLI rewrites a state file in the home directory on every run. Parallel workers
// racing on that one file make a query fail now and then, so each worker gets its own.
const CLI_HOME = join(tmpdir(), `shopkhata-e2e-supabase-${process.pid}`);

export function localDbQuery(sql: string) {
  return execFileSync(process.execPath, [
    join(process.cwd(), "node_modules", "supabase", "dist", "supabase.js"),
    "--agent", "no", "db", "query", "--local", sql,
  ], { encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: CLI_HOME, USERPROFILE: CLI_HOME } });
}
/** Runs a single-value SQL expression and returns it as text. */
export function scalar(expression: string): string {
  const token = `v${crypto.randomUUID().replaceAll("-", "")}`;
  return localDbQuery(`select '${token}=' || (${expression})::text || ';' as value`).match(new RegExp(`${token}=([^;]*);`))?.[1] ?? "";
}
export const invoiceCount = (number: string, shop = SHOP_1) => scalar(`select count(*) from public.invoices where shop_id = '${shop}' and lower(invoice_id) = lower('${number}')`);
export const paymentCount = (number: string) => scalar(`select count(*) from public.payments p join public.invoices i on i.id = p.invoice_id where i.shop_id = '${SHOP_1}' and i.invoice_id = '${number}'`);

/**
 * A sign-in of its own for one test. Signing out ends every session of that account, so a test
 * that signs out must not share an account with tests running beside it.
 */
export function createAccount(role: "manager" | "staff", shopId = SHOP_1) {
  const id = crypto.randomUUID();
  const user = { email: `e2e-${id}@shopkhata.local`, password: `E2E-Local-Only-${id}!` };
  localDbQuery(`with u as (insert into auth.users(id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, confirmation_token, recovery_token, email_change, email_change_token_new, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values ('${id}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '${user.email}', extensions.crypt('${user.password}', extensions.gen_salt('bf')), now(), '', '', '', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()) returning id),
    i as (insert into auth.identities(id, user_id, identity_data, provider, provider_id, created_at, updated_at, last_sign_in_at)
      select gen_random_uuid(), id, jsonb_build_object('sub', id::text, 'email', '${user.email}'), 'email', id::text, now(), now(), now() from u),
    p as (insert into public.profiles(id, email, display_name, role, is_active) select id, '${user.email}', 'E2E ${role} ${id.slice(0, 8)}', '${role}', true from u)
    insert into public.user_shop_assignments(user_id, shop_id) select id, '${shopId}' from u`);
  return user;
}

export async function login(page: Page, user = STAFF) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).fill(user.password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page.getByRole("heading", { name: "Shop 1" })).toBeVisible();
}

/** Sign out from the profile menu in the top bar. */
export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Profile" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
}

export const entryRows = (page: Page) => page.locator("[data-entry-row]");
export const draftStatus = (page: Page) => page.locator("[data-draft-status]");
export const savedNotice = (page: Page) => page.locator('p[role="status"]').filter({ hasText: "Batch saved" });

export async function fillRow(page: Page, index: number, invoice: string, total: string, received = "") {
  const row = entryRows(page).nth(index);
  await row.getByLabel("Invoice ID").fill(invoice);
  await row.getByLabel("Total QAR").fill(total);
  if (received) await row.getByLabel("Received QAR").fill(received);
}

/** What is actually stored on the device, read straight from IndexedDB. */
export async function storedDrafts(page: Page): Promise<{ key: string; userId: string; shopId: string; idempotencyKey: string; rows: { rowId: string; invoiceId: string }[]; submission: { status: string; idempotencyKey: string } | null }[]> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open("shopkhata-local");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("drafts")) { db.close(); resolve([]); return; }
      const all = db.transaction("drafts").objectStore("drafts").getAll();
      all.onsuccess = () => { db.close(); resolve(all.result); };
      all.onerror = () => { db.close(); reject(all.error); };
    };
  }));
}
export async function expectStoredRows(page: Page, numbers: string[]) {
  await expect.poll(async () => (await storedDrafts(page)).flatMap((draft) => draft.rows.map((row) => row.invoiceId))).toEqual(numbers);
}

export async function workbook(data: (string | number | boolean | null)[][], sheet = IMPORT_SHEET_NAME) {
  return Buffer.from(await (await writeXlsxFile([{ sheet, data }]).toBlob()).arrayBuffer());
}
export async function readDownload(download: Download) {
  return readXlsxFile(new Blob([readFileSync(await download.path())]));
}
export async function importFile(page: Page, buffer: Buffer, name = "batch.xlsx") {
  await page.getByLabel("Import Excel (.xlsx)").setInputFiles({ name, mimeType: XLSX, buffer });
}

/** The service worker controls the page and has the offline page cached. */
export async function waitForOfflineShell(page: Page) {
  await expect.poll(() => page.evaluate(async () => Boolean(navigator.serviceWorker.controller) && Boolean(await caches.match("/offline"))), { timeout: 60_000 }).toBe(true);
}

/** Types a one-row batch while offline and queues it. Returns nothing committed. */
export async function queueOffline(page: Page, invoice: string, total = "12.00") {
  await fillRow(page, 0, invoice, total);
  await expectStoredRows(page, [invoice]);
  await page.context().setOffline(true);
  await expect(page.locator("[data-offline-banner]")).toBeVisible();
  await page.getByRole("button", { name: "Review batch" }).click();
  await page.getByRole("button", { name: "Save when back online" }).click();
  await expect(draftStatus(page)).toHaveText("Submission pending — will send when you reconnect");
  expect(invoiceCount(invoice)).toBe("0");
}
