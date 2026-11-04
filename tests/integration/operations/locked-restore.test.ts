import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { qatarBusinessDate } from "@/lib/invoice-entry";
import {
  DB_URL, NEW_VERSIONS, SHOP_1, STAFF1, STAFF1_ID, backupTool, localEnv, maintenanceOn, psql, runSqlFile, sh, signIn, stageMigrations, supabase, uid,
} from "./release-helpers";

// OPS-01B recovery: a POPULATED backup (expense + registered receipt + real bytes) taken at migration 36 inside the
// release window, i.e. LOCKED, restored
//   (a) by the local rehearsal (`pnpm backup:verify --from`), and
//   (b) by the documented production method (`node scripts/backup.mjs restore`) into a BLANK project while this checkout
//       holds migrations through 39: exactly the manifest's 36 migrations, never 37-39.
// The service-key receipt upload passes the locked Storage guard only through the explicit receipt restore context,
// which admits exactly the backup's object names and is closed afterwards; maintenance stays effective for everyone.

const V36 = NEW_VERSIONS[0];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=", "base64");
const objectRow = (name: string) => psql(`select jsonb_build_object('owner', owner, 'owner_id', owner_id, 'created_at', created_at, 'size', metadata ->> 'size', 'mimetype', metadata ->> 'mimetype', 'etag', metadata ->> 'eTag') from storage.objects where bucket_id = 'expense-receipts' and name = '${name}'`);

describe("OPS-01B locked, populated, exact-version restore", () => {
  it("restores receipts into a locked database through the restore context, at exactly migration 36", async () => {
    try { await rehearse(); } finally { await supabase(["db", "reset", "--local"], undefined, 240_000); }
  }, 1_500_000);
});

async function rehearse(): Promise<void> {
  // ---- source: production modeled at 36, a real receipt, maintenance ON (inside the window) ------------------------
  await supabase(["db", "reset", "--local", "--version", V36], undefined, 240_000);
  let env = await localEnv();
  const staff = await signIn(env, STAFF1);
  const today = qatarBusinessDate(new Date());
  const expense = await staff.rpc("create_expense", { command: { shop_id: SHOP_1, amount_dirham: 4200, business_date: today, category: "supplies", description: `Receipt restore ${uid()}`, idempotency_key: crypto.randomUUID() } });
  expect(expense.error).toBeNull();
  const expenseId = expense.data.expense_id as string;
  const path = `${SHOP_1}/${expenseId}/${crypto.randomUUID()}.png`;
  expect((await staff.storage.from("expense-receipts").upload(path, new Blob([PNG], { type: "image/png" }), { contentType: "image/png" })).error).toBeNull();
  const registered = await staff.rpc("register_expense_attachment", { command: { shop_id: SHOP_1, expense_id: expenseId, file_path: path, file_name: "receipt.png", content_type: "image/png", byte_size: PNG.length, idempotency_key: crypto.randomUUID() } });
  expect(registered.error).toBeNull();
  const sourceObject = await objectRow(path);
  expect(JSON.parse(sourceObject).owner_id).toBe(STAFF1_ID);
  const sourceAttachment = await psql(`select a.shop_id || '|' || a.expense_id || '|' || a.byte_size || '|' || e.shop_id from public.attachments a join public.expenses e on e.id = a.expense_id where a.file_path = '${path}'`);
  expect((await maintenanceOn()).changed).toBe(true);

  // The M1 defect, shown on the source: while locked, a plain service-key upload is refused by the Storage guard.
  const service = () => createClient(env.API_URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false } }).storage.from("expense-receipts");
  const plain = await service().upload(`${SHOP_1}/${expenseId}/${crypto.randomUUID()}.png`, PNG, { contentType: "image/png" });
  expect(plain.error, "a service-key upload is NOT exempt from maintenance").not.toBeNull();

  // ---- recovery backup at 36, locked, quiescent ------------------------------------------------------------------
  const backups = mkdtempSync(join(tmpdir(), "ops01b-locked-restore-"));
  const backup = (await sh(["backup:db"], { SHOPKHATA_BACKUP_DIR: backups, SHOPKHATA_BACKUP_REQUIRE_QUIESCENT: "1" })).match(/Backup complete: (.+)/)?.[1]?.trim();
  expect(backup).toBeTruthy();
  const manifest = JSON.parse(readFileSync(join(backup!, "manifest.json"), "utf8"));
  expect(manifest.migrations.at(-1)).toBe(V36);
  expect(manifest.migrations).toHaveLength(36);
  expect(manifest.receipts.map((r: { name: string }) => r.name)).toEqual([path]);
  expect(manifest.receiptAttachments).toBe(1);

  // ---- (a) local rehearsal restore of the locked, populated backup ------------------------------------------------
  const verified = await sh(["backup:verify", "--from", backup!], {}, 600_000);
  expect(verified).toContain("RESTORE VERIFIED");
  expect(verified).toContain("through the receipt restore context (closed again)");
  expect(verified).toContain("restored LOCKED (maintenance on, no bypass)");

  // ---- (b) production-equivalent restore into a BLANK project, checkout at 39 -------------------------------------
  const checkout = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).map((f) => f.split("_")[0]);
  expect(checkout, "the checkout holds migrations through 39").toEqual(expect.arrayContaining(NEW_VERSIONS));
  await supabase(["--workdir", stageMigrations(""), "db", "reset", "--local", "--no-seed"], undefined, 240_000);
  expect(await psql("select to_regclass('supabase_migrations.schema_migrations') is null and to_regclass('public.shops') is null"), "a blank project, like a new hosted one").toBe("t");
  env = await localEnv();
  const target = { SHOPKHATA_RESTORE_DB_URL: DB_URL, SHOPKHATA_RESTORE_SUPABASE_URL: env.API_URL, SHOPKHATA_RESTORE_SERVICE_ROLE_KEY: env.SERVICE_ROLE_KEY };
  const host = new URL(env.API_URL).host;
  const restored = await backupTool(["restore", "--from", backup!, "--confirm", host], target);
  expect(restored).toContain("RESTORED:");
  expect(restored).toContain("LOCKED (enabled, no bypass)");

  // Exactly the manifest's migration set: 36, never 37/38/39 from this checkout.
  expect(JSON.parse(await psql("select to_jsonb(array_agg(version order by version)) from supabase_migrations.schema_migrations"))).toEqual(manifest.migrations);
  for (const later of NEW_VERSIONS.slice(1)) expect(await psql(`select count(*) from supabase_migrations.schema_migrations where version = '${later}'`), `${later} must be absent`).toBe("0");
  expect(await psql("select to_regclass('public.invoice_voids') is null and to_regprocedure('public.void_invoice(jsonb)') is null")).toBe("t");
  // The maintenance mechanism is present and exactly as reviewed, and the restored state is LOCKED.
  const post36 = await runSqlFile("scripts/ops-01b-post36-verify.sql");
  expect(post36.verdict, JSON.stringify(post36.checks.filter((c: { ok: boolean }) => !c.ok))).toBe("PASS");
  expect(await psql("select enabled::text || ':' || (bypass_user_id is null)::text from private.system_maintenance")).toBe("true:true");

  // Receipt: bytes, storage.objects metadata, the attachment relationship, no orphan.
  const bytes = await service().download(path);
  expect(Buffer.from(await bytes.data!.arrayBuffer()).equals(PNG)).toBe(true);
  expect(await objectRow(path)).toBe(sourceObject);
  expect(await psql(`select a.shop_id || '|' || a.expense_id || '|' || a.byte_size || '|' || e.shop_id from public.attachments a join public.expenses e on e.id = a.expense_id where a.file_path = '${path}'`)).toBe(sourceAttachment);
  expect(await psql("select count(*) from public.attachments a where a.expense_id is not null and not exists (select 1 from storage.objects o where o.bucket_id = 'expense-receipts' and o.name = a.file_path)")).toBe("0");
  expect(await psql("select count(*) from storage.objects o where o.bucket_id = 'expense-receipts' and not exists (select 1 from public.attachments a where a.file_path = o.name)")).toBe("0");

  // The restore context is closed and its use is on record.
  expect(await psql("select count(*) from private.receipt_restore_objects")).toBe("0");
  expect(await psql("select string_agg(action || ':' || object_count, ',' order by id) from private.receipt_restore_log")).toBe("opened:1,closed:1");

  // Maintenance stays effective: ordinary users refused (RPC and upload), and a service-key upload is refused again,
  // for a new name AND for the restored name now that the context is closed.
  const staffAgain = await signIn(env, STAFF1);
  expect((await staffAgain.rpc("create_customer", { command: { shop_id: SHOP_1, name: "After restore", mobile: null } })).error?.message).toBe("MAINTENANCE_ACTIVE");
  expect((await staffAgain.storage.from("expense-receipts").upload(`${SHOP_1}/${expenseId}/${crypto.randomUUID()}.png`, new Blob([PNG], { type: "image/png" }), { contentType: "image/png" })).error).not.toBeNull();
  expect((await service().upload(`${SHOP_1}/${expenseId}/${crypto.randomUUID()}.png`, PNG, { contentType: "image/png" })).error).not.toBeNull();
  expect((await service().upload(path, PNG, { contentType: "image/png", upsert: true })).error, "the closed context admits nothing").not.toBeNull();
  expect(await psql("select count(*) from storage.objects where bucket_id = 'expense-receipts'")).toBe("1");

  // A second restore into the now non-empty target is refused before anything is pushed.
  await expect(backupTool(["restore", "--from", backup!, "--confirm", host], target)).rejects.toThrow(/already has migrations applied/);
  console.log(`[locked-restore] PASS: ${manifest.migrations.length} migrations (last ${V36}), 1 receipt restored locked, context closed, maintenance effective`);
}
