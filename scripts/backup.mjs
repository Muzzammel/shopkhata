// ShopKhata backup and restore rehearsal.
//
//   pnpm backup:db                      back up the database and the private receipt files
//   pnpm backup:verify                  back up the local stack, restore it and prove the restore
//   pnpm backup:verify --from <dir>     rehearse an existing (for example production) backup locally
//   node scripts/backup.mjs restore-receipts --from <dir> --confirm <host>
//                                       upload a backup's receipt files into the project being recovered
//   node scripts/backup.mjs record --from <dir>
//                                       re-check a backup's file hashes and list it in Admin > Backup & Recovery
//
// Source: the local Supabase stack, or a remote project when SHOPKHATA_BACKUP_DB_URL is set
// (see docs/operations/backup-restore.md for every variable). The restore rehearsal only ever
// writes to the local stack; restoring into a hosted project is a deliberate manual procedure.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { createClient } from "@supabase/supabase-js";

const REPO = resolve(import.meta.dirname, "..");
const CLI = join(REPO, "node_modules", "supabase", "dist", "supabase.js");
const BUCKET = "expense-receipts";
// supabase_db_<project_id from supabase/config.toml>
const LOCAL_DB_CONTAINER = "supabase_db_shopkhata";
const DUMPS = ["roles.sql", "schema.sql", "data.sql"];

class BackupError extends Error {}
const fail = (message) => { throw new BackupError(message); };
const log = (message) => console.log(`[backup] ${message}`);
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function supabase(args, { json = false } = {}) {
  try {
    const out = execFileSync(process.execPath, [CLI, "--agent", "no", ...(json ? ["--output-format", "json"] : []), ...args], {
      cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, timeout: 600_000,
    });
    return json ? JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1)) : out;
  } catch (error) {
    // Never echo the arguments: a remote source carries its password in the connection string.
    fail(`supabase ${args[0]} ${args[1]} failed: ${String(error.stderr || error.message).replace(/postgres(ql)?:\/\/\S+/g, "<db-url>").trim()}`);
  }
}

function source() {
  const dbUrl = process.env.SHOPKHATA_BACKUP_DB_URL;
  if (!dbUrl) {
    const env = Object.fromEntries(supabase(["status", "-o", "env"]).split(/\r?\n/).flatMap((line) => {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line); return match ? [[match[1], match[2].replace(/^"|"$/g, "")]] : [];
    }));
    if (!env.API_URL || !env.SERVICE_ROLE_KEY) fail("The local Supabase stack is not running (pnpm exec supabase start).");
    return { args: ["--local"], environment: "local", label: "local Supabase stack", apiUrl: env.API_URL, serviceKey: env.SERVICE_ROLE_KEY, publicKey: env.PUBLISHABLE_KEY ?? env.ANON_KEY };
  }
  const environment = process.env.SHOPKHATA_BACKUP_ENV;
  const apiUrl = process.env.SHOPKHATA_BACKUP_SUPABASE_URL;
  const serviceKey = process.env.SHOPKHATA_BACKUP_SERVICE_ROLE_KEY;
  if (!environment || !/^[a-z0-9-]+$/.test(environment)) fail("Set SHOPKHATA_BACKUP_ENV (for example: production) when backing up a remote database.");
  // A database dump without the receipt files is not a complete ShopKhata backup, so it is refused.
  if (!apiUrl || !serviceKey) fail("Set SHOPKHATA_BACKUP_SUPABASE_URL and SHOPKHATA_BACKUP_SERVICE_ROLE_KEY so the private receipt files are backed up too.");
  let host;
  try { host = new URL(dbUrl).host; } catch { fail("SHOPKHATA_BACKUP_DB_URL is not a valid connection string."); }
  return { args: ["--db-url", dbUrl], environment, label: host, apiUrl, serviceKey };
}

const localSource = () => { const saved = process.env.SHOPKHATA_BACKUP_DB_URL; delete process.env.SHOPKHATA_BACKUP_DB_URL; try { return source(); } finally { if (saved) process.env.SHOPKHATA_BACKUP_DB_URL = saved; } };
const query = (src, sql) => supabase(["db", "query", ...src.args, sql], { json: true });
const fingerprint = (src) => supabase(["db", "query", ...src.args, "-f", join("scripts", "backup-fingerprint.sql")], { json: true })[0].fingerprint;

function receiptPath(dir, name) {
  const target = resolve(dir, "storage", BUCKET, name);
  if (!target.startsWith(resolve(dir, "storage", BUCKET) + sep)) fail(`Unsafe storage object name: ${name}`);
  return target;
}

function gitCommit() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(); } catch { return null; }
}

async function createBackup() {
  const src = source();
  const root = resolve(process.env.SHOPKHATA_BACKUP_DIR ?? join(homedir(), "shopkhata-backups"));
  if (!relative(REPO, root).startsWith("..")) fail(`Backups must be written outside the repository; ${root} is inside it.`);
  const createdAt = new Date();
  const dir = join(root, `shopkhata-${src.environment}-${createdAt.toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dir, { recursive: true });
  log(`Backing up ${src.label} (${src.environment}) to ${dir}`);

  const before = fingerprint(src);
  supabase(["db", "dump", ...src.args, "--role-only", "-f", join(dir, "roles.sql")]);
  supabase(["db", "dump", ...src.args, "-f", join(dir, "schema.sql")]);
  supabase(["db", "dump", ...src.args, "--data-only", "--use-copy", "-f", join(dir, "data.sql")]);
  // ponytail: the dumps are not one snapshot. A write that lands while they run makes the backup
  // internally inconsistent, so it is refused. Take backups outside trading hours or retry.
  const fp = fingerprint(src);
  if (!isDeepStrictEqual(before, fp)) fail("The database changed while it was being dumped. Run the backup again when no one is entering data.");

  const files = {};
  for (const name of DUMPS) {
    const content = readFileSync(join(dir, name));
    if (content.length === 0) fail(`${name} is empty.`);
    files[name] = { bytes: content.length, sha256: sha256(content) };
  }
  if (!readFileSync(join(dir, "data.sql"), "utf8").includes('COPY "public"."invoices"')) fail("data.sql does not contain the invoices table.");

  const storage = createClient(src.apiUrl, src.serviceKey, { auth: { persistSession: false } }).storage.from(BUCKET);
  const objects = query(src, `select name, coalesce(metadata ->> 'mimetype', 'application/octet-stream') content_type from storage.objects where bucket_id = '${BUCKET}' order by name`);
  const receipts = [];
  for (const object of objects) {
    const { data, error } = await storage.download(object.name);
    if (error || !data) fail(`Receipt ${object.name} could not be downloaded: ${error?.message ?? "no data"}`);
    const content = Buffer.from(await data.arrayBuffer());
    const target = receiptPath(dir, object.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    receipts.push({ name: object.name, bytes: content.length, sha256: sha256(content), contentType: object.content_type });
  }
  // Every receipt the database knows about must have its file in the backup, at the recorded size.
  const attachments = query(src, "select file_path, byte_size from public.attachments where expense_id is not null order by file_path");
  const stored = new Map(receipts.map((receipt) => [receipt.name, receipt.bytes]));
  const problems = attachments.filter((a) => stored.get(a.file_path) !== Number(a.byte_size)).map((a) => a.file_path);

  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({
    format: 1, createdAt: createdAt.toISOString(), environment: src.environment, source: src.label,
    app: { version: JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version, gitCommit: gitCommit() },
    migrations: fp.migrations, files, receipts, receiptAttachments: attachments.length, fingerprint: fp,
  }, null, 2)}\n`);
  if (problems.length) fail(`${problems.length} receipt record(s) have no matching file in storage: ${problems.join(", ")}. The backup at ${dir} is incomplete.`);
  log(`Database: ${DUMPS.map((name) => `${name} ${files[name].bytes} bytes`).join(", ")}`);
  log(`Receipts: ${receipts.length} file(s) for ${attachments.length} receipt record(s); migrations: ${fp.migrations.length} (latest ${fp.migrations.at(-1)})`);
  log(`Backup complete: ${dir}`);
  log("This copy is on this computer only. Copy the whole folder to storage outside the Supabase and hosting accounts.");
  return dir;
}

function psql(args, stdin) {
  const result = spawnSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", LOCAL_DB_CONTAINER, "psql", "-h", "127.0.0.1", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t", ...args], {
    encoding: "utf8", stdio: [stdin ?? "ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, timeout: 900_000,
  });
  if (result.status !== 0) fail(`psql failed: ${(result.stderr || result.error?.message || "").trim()}`);
  return result.stdout.trim();
}

function differences(expected, actual, path = "") {
  if (isDeepStrictEqual(expected, actual)) return [];
  const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!plain(expected) || !plain(actual)) return [`${path || "(root)"}: backup ${JSON.stringify(expected)} / restored ${JSON.stringify(actual)}`];
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].flatMap((key) => differences(expected[key], actual[key], path ? `${path}.${key}` : key));
}

// Runs as each active non-owner account under row-level security: it must see exactly the receipt
// objects and invoices of its assigned shops and nothing of any other shop.
const ISOLATION_SQL = `do $$
declare u record; seen_objects bigint; own_objects bigint; seen_invoices bigint; own_invoices bigint;
begin
  for u in select p.id, coalesce(array_agg(a.shop_id) filter (where a.shop_id is not null), '{}') shops
           from public.profiles p left join public.user_shop_assignments a on a.user_id = p.id
           where p.is_active and p.role <> 'owner' group by p.id loop
    select count(*) into own_objects from storage.objects o join public.attachments t on t.file_path = o.name and t.expense_id is not null
      where o.bucket_id = '${BUCKET}' and t.shop_id = any(u.shops);
    select count(*) into own_invoices from public.invoices i where i.shop_id = any(u.shops);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', u.id, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into seen_objects from storage.objects where bucket_id = '${BUCKET}';
    select count(*) into seen_invoices from public.invoices;
    reset role;
    if seen_objects <> own_objects or seen_invoices <> own_invoices then
      raise exception 'ISOLATION_FAILED user % sees % receipt objects (expected %) and % invoices (expected %)', u.id, seen_objects, own_objects, seen_invoices, own_invoices;
    end if;
  end loop;
end $$;`;

// Uploads every receipt file of a backup under its original path and reads each one back.
// The database rows (storage.objects, public.attachments) come from data.sql; this puts the
// bytes behind them, so it runs after the database restore.
async function restoreReceipts(dir, manifest, apiUrl, serviceKey) {
  const storage = createClient(apiUrl, serviceKey, { auth: { persistSession: false } }).storage.from(BUCKET);
  // A local storage service restarts with the database reset; wait until it answers.
  for (let attempt = 1; (await storage.list("", { limit: 1 })).error; attempt++) {
    if (attempt === 60) fail("The storage service is not answering.");
    await new Promise((done) => setTimeout(done, 1000));
  }
  for (const receipt of manifest.receipts) {
    const { error } = await storage.upload(receipt.name, readFileSync(receiptPath(dir, receipt.name)), { upsert: true, contentType: receipt.contentType });
    if (error) fail(`Receipt ${receipt.name} could not be restored: ${error.message}`);
    const { data: blob, error: readError } = await storage.download(receipt.name);
    if (readError || sha256(Buffer.from(await blob.arrayBuffer())) !== receipt.sha256) fail(`Restored receipt ${receipt.name} does not read back identically.`);
  }
}

// The one step of a real (hosted) recovery that needs a tool. It is never run implicitly:
// the target is named explicitly and must be repeated on the command line.
async function restoreReceiptsTo(from, confirmHost) {
  const dir = resolve(from);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const apiUrl = process.env.SHOPKHATA_RESTORE_SUPABASE_URL;
  const serviceKey = process.env.SHOPKHATA_RESTORE_SERVICE_ROLE_KEY;
  if (!apiUrl || !serviceKey) fail("Set SHOPKHATA_RESTORE_SUPABASE_URL and SHOPKHATA_RESTORE_SERVICE_ROLE_KEY to the project being restored.");
  if (new URL(apiUrl).host !== confirmHost) fail(`--confirm must repeat the target host exactly (${new URL(apiUrl).host}).`);
  log(`Restoring ${manifest.receipts.length} receipt file(s) from the ${manifest.environment} backup of ${manifest.createdAt} into ${confirmHost}`);
  await restoreReceipts(dir, manifest, apiUrl, serviceKey);
  log(`Receipts restored: ${manifest.receipts.length} file(s) uploaded and read back byte-identical.`);
}

function checkArtifacts(dir, manifest) {
  for (const name of DUMPS) {
    if (sha256(readFileSync(join(dir, name))) !== manifest.files[name]?.sha256) fail(`${name} does not match the hash recorded when the backup was taken.`);
  }
  for (const receipt of manifest.receipts) {
    if (sha256(readFileSync(receiptPath(dir, receipt.name))) !== receipt.sha256) fail(`Receipt file ${receipt.name} does not match its recorded hash.`);
  }
}

// Lists a backup in the application's owner-only Backup & Recovery screen. Deliberately a separate,
// explicit step: taking a backup stays read-only against its source. Only a summary is written
// (times, sizes, the manifest hash, the rehearsal result); the backup itself never leaves this computer.
async function recordBackup(from) {
  const dir = resolve(from);
  if (!existsSync(join(dir, "manifest.json"))) fail(`${dir} is not a ShopKhata backup (manifest.json is missing).`);
  const manifestBytes = readFileSync(join(dir, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  checkArtifacts(dir, manifest);
  log(`Integrity: ${DUMPS.length} dump files and ${manifest.receipts.length} receipt file(s) match their recorded SHA-256`);

  // The record goes to the environment the backup was taken from, never to another one.
  let apiUrl = process.env.SHOPKHATA_BACKUP_SUPABASE_URL;
  let serviceKey = process.env.SHOPKHATA_BACKUP_SERVICE_ROLE_KEY;
  if (manifest.environment === "local") {
    if (apiUrl) fail("This is a backup of the local stack. Unset SHOPKHATA_BACKUP_SUPABASE_URL to record it there.");
    ({ apiUrl, serviceKey } = localSource());
  } else if (!apiUrl || !serviceKey || process.env.SHOPKHATA_BACKUP_ENV !== manifest.environment) {
    fail(`Set SHOPKHATA_BACKUP_ENV=${manifest.environment}, SHOPKHATA_BACKUP_SUPABASE_URL and SHOPKHATA_BACKUP_SERVICE_ROLE_KEY to the project this backup was taken from.`);
  }
  const rehearsalPath = join(dir, "restore-verification.json");
  const rehearsal = existsSync(rehearsalPath) ? JSON.parse(readFileSync(rehearsalPath, "utf8")) : null;
  const { error } = await createClient(apiUrl, serviceKey, { auth: { persistSession: false } }).from("backup_records").upsert({
    backup_created_at: manifest.createdAt, environment: manifest.environment, source: manifest.source,
    app_version: manifest.app?.version ?? null, git_commit: manifest.app?.gitCommit ?? null, latest_migration: manifest.migrations.at(-1),
    dump_bytes: DUMPS.reduce((sum, name) => sum + manifest.files[name].bytes, 0), receipt_count: manifest.receipts.length,
    manifest_sha256: sha256(manifestBytes), restore_verified_at: rehearsal?.verifiedAt ?? null, restore_verified_ok: rehearsal ? rehearsal.ok === true : null,
  }, { onConflict: "manifest_sha256,restore_verified_at", ignoreDuplicates: true });
  if (error) fail(`The backup could not be recorded: ${error.message}`);
  log(`Recorded the ${manifest.environment} backup of ${manifest.createdAt} (${rehearsal ? `restore rehearsal ${rehearsal.ok ? "passed" : "FAILED"} at ${rehearsal.verifiedAt}` : "no restore rehearsal yet"}).`);
}

async function verifyRestore(from) {
  const dir = from ? resolve(from) : await createBackup();
  if (!existsSync(join(dir, "manifest.json"))) fail(`${dir} is not a ShopKhata backup (manifest.json is missing).`);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const checks = [];
  const pass = (name, detail) => { checks.push({ name, detail }); log(`PASS ${name}: ${detail}`); };

  checkArtifacts(dir, manifest);
  pass("artifact integrity", `${DUMPS.length} dump files and ${manifest.receipts.length} receipt file(s) match their recorded SHA-256`);

  const repoMigrations = readdirSync(join(REPO, "supabase", "migrations")).filter((name) => name.endsWith(".sql")).map((name) => name.split("_")[0]).sort();
  if (!isDeepStrictEqual(repoMigrations.slice(0, manifest.migrations.length), manifest.migrations)) {
    fail("The backup was taken at a migration state this checkout does not contain. Check out the release that produced it.");
  }
  pass("migration compatibility", `backup is at ${manifest.migrations.at(-1)} (${manifest.migrations.length} of ${repoMigrations.length} migrations in this checkout)`);

  const target = localSource();
  log("Resetting the LOCAL Supabase database (the disposable restore target) to the backup's migration state...");
  supabase(["db", "reset", "--local", "--no-seed", "--version", manifest.migrations.at(-1)]);
  const tables = [...readFileSync(join(dir, "data.sql"), "utf8").matchAll(/^COPY ("[a-z_]+"\."[a-z_0-9]+") /gm)].map((match) => match[1]);
  // The migrations create rows of their own (the receipt bucket); the backup is the only source of data.
  psql(["-c", `set session_replication_role = replica; truncate ${tables.join(", ")} cascade;`]);
  const data = openSync(join(dir, "data.sql"), "r");
  try { psql(["--single-transaction"], data); } finally { closeSync(data); }
  // A bulk load leaves the planner without statistics; until autovacuum catches up the invoice
  // projection is slow enough to hit the API statement timeout. ANALYZE is part of every restore.
  psql(["-c", "analyze"]);
  pass("database restore", `${tables.length} tables restored from data.sql in one transaction, then analyzed`);

  await restoreReceipts(dir, manifest, target.apiUrl, target.serviceKey);
  const orphans = Number(psql(["-c", `select count(*) from public.attachments a where a.expense_id is not null and not exists (select 1 from storage.objects o where o.bucket_id = '${BUCKET}' and o.name = a.file_path and (o.metadata ->> 'size')::bigint = a.byte_size)`]));
  if (orphans) fail(`${orphans} restored receipt record(s) have no matching stored file.`);
  pass("receipt restore", `${manifest.receipts.length} file(s) uploaded and read back byte-identical; all ${manifest.receiptAttachments} receipt record(s) have their file`);

  const restored = fingerprint(target);
  const diff = differences(manifest.fingerprint, restored);
  writeFileSync(join(dir, "restore-verification.json"), `${JSON.stringify({ verifiedAt: new Date().toISOString(), ok: diff.length === 0, differences: diff, restoredFingerprint: restored }, null, 2)}\n`);
  if (diff.length) fail(`The restored state does not reconcile with the backup:\n  ${diff.join("\n  ")}`);
  const rows = Object.values(restored.tables).reduce((sum, value) => sum + Number(value.split(":")[0]), 0);
  pass("table reconciliation", `${Object.keys(restored.tables).length} tables, ${rows} rows: every count and row hash identical`);
  for (const [shopId, shop] of Object.entries(restored.shops)) {
    pass(`financial reconciliation ${shopId}`, `invoices ${shop.sales_totals.invoice_count}, net sales ${shop.sales_totals.net_sales_dirham ?? shop.sales_totals.effective_total_dirham}, paid ${shop.sales_totals.effective_paid_dirham}, due ${shop.sales_totals.effective_due_dirham}, customer due ${shop.customer_due_totals.outstanding_due_dirham}, available credit ${shop.customer_due_totals.available_credit_dirham} (dirham); ledger, balances, expenses and closed dates identical`);
  }

  psql(["-c", ISOLATION_SQL]);
  pass("shop isolation", "every active non-owner account sees only its own shops' invoices and receipt objects under row-level security");

  // Representative reads the way the application makes them: a restored owner account signs in
  // (one-time link, so no password is needed) and reads through the API under row-level security.
  const ownerEmail = psql(["-c", "select email from public.profiles where role = 'owner' and is_active order by created_at limit 1"]);
  if (!ownerEmail) fail("The restored database has no active owner account.");
  const admin = createClient(target.apiUrl, target.serviceKey, { auth: { persistSession: false } });
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: ownerEmail });
  const api = createClient(target.apiUrl, target.publicKey, { auth: { persistSession: false } });
  const session = link.error ? link : await api.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  if (session.error) fail(`The restored owner account could not sign in: ${session.error.message}`);
  for (const [shopId, shop] of Object.entries(restored.shops)) {
    const invoices = await api.from("effective_invoices").select("*", { count: "exact", head: true }).eq("shop_id", shopId);
    const due = await api.rpc("report_customer_due_totals", { p_shop_id: shopId });
    if (invoices.error || due.error) fail(`API read of shop ${shopId} failed: ${(invoices.error ?? due.error).message}`);
    if (invoices.count !== shop.sales_totals.invoice_count || due.data?.[0]?.outstanding_due_dirham !== shop.customer_due_totals.outstanding_due_dirham) {
      fail(`API reads of shop ${shopId} do not match the restored database.`);
    }
  }
  pass("application reads", "a restored owner signed in and read the invoice projection and customer-due report through the API; both match for every shop");

  log(`RESTORE VERIFIED: ${checks.length} checks passed. Evidence: ${join(dir, "restore-verification.json")}`);
  if (manifest.environment !== "local") log("The local database now holds the restored data. Run `pnpm exec supabase db reset --local` when you have finished inspecting it.");
}

try {
  const [mode, flag, value, confirmFlag, confirmHost] = process.argv.slice(2);
  const hasBackup = flag === "--from" && value && statSync(value).isDirectory();
  if (mode === undefined) await createBackup();
  else if (mode === "verify" && (flag === undefined || hasBackup)) await verifyRestore(value);
  else if (mode === "record" && hasBackup && confirmFlag === undefined) await recordBackup(value);
  else if (mode === "restore-receipts" && hasBackup && confirmFlag === "--confirm" && confirmHost) await restoreReceiptsTo(value, confirmHost);
  else fail("Usage: node scripts/backup.mjs [verify [--from <backup directory>] | record --from <backup directory> | restore-receipts --from <backup directory> --confirm <target host>]");
} catch (error) {
  console.error(`[backup] FAILED: ${error instanceof BackupError ? error.message : error.stack}`);
  process.exit(1);
}
