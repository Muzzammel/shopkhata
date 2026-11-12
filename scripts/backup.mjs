// ShopKhata backup and restore rehearsal.
//
//   pnpm backup:db                      back up the database and the private receipt files
//   pnpm backup:verify                  back up the local stack, restore it and prove the restore
//   pnpm backup:verify --from <dir>     rehearse an existing (for example production) backup locally
//   node scripts/backup.mjs restore --from <dir> --confirm <host>
//                                       restore a backup into a NEW, empty hosted project: exactly the
//                                       backup's migrations, its data, its receipt files; then verify
//   node scripts/backup.mjs restore-receipts --from <dir> --confirm <host>
//                                       only upload a backup's receipt files into the project being recovered
//   node scripts/backup.mjs record --from <dir>
//                                       re-check a backup's file hashes and list it in Admin > Backup & Recovery
//
// Source: the local Supabase stack, or a remote project when SHOPKHATA_BACKUP_DB_URL is set
// (see docs/operations/backup-restore.md for every variable). The restore rehearsal only ever
// writes to the local stack; restoring into a hosted project is a deliberate manual procedure.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { createClient } from "@supabase/supabase-js";

import { acceptedRehearsal, compareRestored, differences, releaseReceiptPath, runRestoreChecks } from "./backup-verification.mjs";
import { assertRestoreLockHeld, queueRestoreCompletion, RestoreLockError, withRestoreLock } from "./restore-lock.mjs";
import { assertLocalEndpoint, classifyDatabaseTarget, validateRestoreEndpoints } from "./backup-target.mjs";
import { guardedLocalReset, LocalResetError } from "./local-reset.mjs";

const REPO = resolve(import.meta.dirname, "..");
const CLI = join(REPO, "node_modules", "supabase", "dist", "supabase.js");
const BUCKET = "expense-receipts";
// supabase_db_<project_id from supabase/config.toml>
const LOCAL_DB_CONTAINER = "supabase_db_shopkhata";
const DUMPS = ["roles.sql", "schema.sql", "data.sql"];
// Total budget of the verify's guarded local reset (snapshot, image checks, reset, kill confirmation); shorter than
// any outer supervisor (release-helpers VERIFY_TIMEOUT) so the inner deadline expires first.
const BACKUP_RESET_BUDGET = 300_000;
// The psql client used against a URL-addressed (hosted) database: the image of the documented manual restore.
const PSQL_IMAGE = "public.ecr.aws/supabase/postgres:17.6.1.159";

class BackupError extends Error {}
const fail = (message) => { throw new BackupError(message); };
const log = (message) => console.log(`[backup] ${message}`);
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function supabase(args, { json = false, all = false } = {}) {
  try {
    const run = spawnSync(process.execPath, [CLI, "--agent", "no", ...(json ? ["--output-format", "json"] : []), ...args], {
      cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, timeout: 600_000,
    });
    if (run.status !== 0) throw Object.assign(new Error(run.error?.message ?? `exit ${run.status}`), { stderr: run.stderr });
    const out = run.stdout;
    // `all`: the CLI prints some reports (the push dry run) on stderr.
    return json ? JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1)) : all ? `${out}\n${run.stderr}` : out;
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

// OPS-01B W5/W6: the authoritative recovery point may only be taken while nothing else is running or holding a
// transaction open (scripts/ops-01b-quiescence.sql). SHOPKHATA_BACKUP_REQUIRE_QUIESCENT=1 checks it before and after
// the dumps; an old transaction still open (for example a pre-guard RPC) makes the backup refuse.
function requireQuiescent(src, when) {
  const q = supabase(["db", "query", ...src.args, "-f", join("scripts", "ops-01b-quiescence.sql")], { json: true })[0].quiescence;
  if (!q.quiescent) {
    fail(`The database is not quiescent ${when} (busy sessions ${q.busy}, open writers ${q.open_writers}, lock waiters ${q.lock_waiters}, write locks: ${q.write_locks.join("; ") || "none"}). This cannot be the recovery point: find the session (runbook V7 / W5), let it finish, and run the backup again.`);
  }
  log(`Quiescent ${when}: ${q.sessions.length} other session(s), all idle with no open transaction.`);
}

// One SQL statement returning a single jsonb column `v`, against a URL-addressed (hosted) database. Written to a file
// so a long statement (every receipt name) never meets a command-line length limit.
function urlSql(dbUrl) {
  if (classifyDatabaseTarget(dbUrl) === "local") return (statement) => JSON.parse(psql(["-c", statement], undefined, new URL(dbUrl).username) || "null");
  return (statement) => {
    const file = join(mkdtempSync(join(tmpdir(), "shopkhata-sql-")), "q.sql");
    writeFileSync(file, statement);
    return supabase(["db", "query", "--db-url", dbUrl, "-f", file], { json: true })[0].v;
  };
}
const lit = (value) => `'${String(value).replaceAll("'", "''")}'`;

// psql against a database URL through the documented client image. A local URL (127.0.0.1) is reached from the
// container as host.docker.internal; that is the only difference from a hosted restore.
function psqlUrl(dbUrl, args, stdin) {
  if (classifyDatabaseTarget(dbUrl) === "local") return psql(args, stdin, new URL(dbUrl).username);
  const url = new URL(dbUrl);
  const result = spawnSync("docker", ["run", "--rm", "-i", PSQL_IMAGE,
    "psql", url.toString(), "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t", ...args], {
    encoding: "utf8", stdio: [stdin ?? "ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, timeout: 900_000,
  });
  if (result.status !== 0) fail(`psql against the restore target failed: ${(result.stderr || result.error?.message || "").replace(/postgres(ql)?:\/\/\S+/g, "<db-url>").trim()}`);
  return result.stdout.trim();
}

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

  const quiet = process.env.SHOPKHATA_BACKUP_REQUIRE_QUIESCENT === "1";
  if (quiet) requireQuiescent(src, "before the dumps");
  const before = fingerprint(src);
  supabase(["db", "dump", ...src.args, "--role-only", "-f", join(dir, "roles.sql")]);
  supabase(["db", "dump", ...src.args, "-f", join(dir, "schema.sql")]);
  supabase(["db", "dump", ...src.args, "--data-only", "--use-copy", "-f", join(dir, "data.sql")]);
  // ponytail: the dumps are not one snapshot. A write that lands while they run makes the backup
  // internally inconsistent, so it is refused. Take backups outside trading hours or retry.
  const fp = fingerprint(src);
  if (!isDeepStrictEqual(before, fp)) fail("The database changed while it was being dumped. Run the backup again when no one is entering data.");
  if (quiet) requireQuiescent(src, "after the dumps");

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

function psql(args, stdin, user = "supabase_admin") {
  const result = spawnSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", LOCAL_DB_CONTAINER, "psql", "-h", "127.0.0.1", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t", ...args], {
    encoding: "utf8", stdio: [stdin ?? "ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, timeout: 900_000,
  });
  if (result.status !== 0) fail(`psql failed: ${(result.stderr || result.error?.message || "").trim()}`);
  return result.stdout.trim();
}

// A skipped (empty) COPY section of a public or Storage table is allowed only if the backup's own fingerprint proves the
// SOURCE table had 0 rows; the restored fingerprint must then equal it, which proves the TARGET has 0 rows too. A table
// the fingerprint does not cover, or could not read, STOPs the restore. (A non-empty section is always loaded; one the
// target role cannot write fails the load loudly.) Other schemas (auth: users are fingerprinted as a whole) are outside
// this rule.
function provenEmpty(manifest, skipped) {
  const fp = manifest.fingerprint ?? {};
  for (const quoted of skipped) {
    const [schema, table] = quoted.split(".").map((part) => part.replace(/^"|"$/g, ""));
    if (schema !== "public" && schema !== "storage") continue;
    const count = schema === "public" ? fp.tables?.[table] : fp.storage?.[`storage.${table}`];
    if (count === undefined) fail(`STOP: data.sql has an empty section for ${schema}.${table}, but the backup's fingerprint has no inventory for it (a backup taken before the Storage inventory, or an unknown table). Take a new backup.`);
    if (count !== "0:") fail(`STOP: data.sql has an empty section for ${schema}.${table}, but the source fingerprint records ${count === "unreadable" ? "an unreadable table" : `${count.split(":")[0]} row(s)`}.`);
  }
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
// bytes behind them, so it runs after the database restore. `sql` runs one statement returning jsonb `v` on the target.
//
// A restored database can be LOCKED (OPS-01B maintenance on, by design), and these service-key uploads carry no
// uploader, so the Storage maintenance trigger refuses them. The tool therefore opens the database's receipt restore
// context for exactly the manifest's object names (private.receipt_restore_open: database owner only, logged), and
// closes it in every case afterwards. Unlocked databases need no context (the context refuses to open while OFF). Nothing else is admitted: an ordinary user, or a service-key upload of any other
// name, is still refused while maintenance is on.
async function restoreReceipts(dir, manifest, apiUrl, serviceKey, sql) {
  const storage = createClient(apiUrl, serviceKey, { auth: { persistSession: false } }).storage.from(BUCKET);
  // A local storage service restarts with the database reset; wait until it answers.
  for (let attempt = 1; (await storage.list("", { limit: 1 })).error; attempt++) {
    if (attempt === 60) fail("The storage service is not answering.");
    await new Promise((done) => setTimeout(done, 1000));
  }
  const names = manifest.receipts.map((receipt) => receipt.name);
  if (!names.length) return { files: 0, context: false };
  // The rows data.sql loaded ARE the backup's object metadata; the upload must keep them (owner, size, type, eTag).
  const objectRows = () => sql(`select coalesce(jsonb_object_agg(name, jsonb_build_object('owner', owner, 'owner_id', owner_id, 'created_at', created_at,
    'size', metadata ->> 'size', 'mimetype', metadata ->> 'mimetype', 'etag', metadata ->> 'eTag', 'user_metadata', user_metadata)), '{}') as v
    from storage.objects where bucket_id = '${BUCKET}'`);
  const loaded = objectRows();
  const missing = names.filter((name) => !loaded[name]);
  if (missing.length) fail(`The restored database has no storage.objects row for ${missing.length} receipt(s) (${missing.slice(0, 3).join(", ")}). Load data.sql before the receipts.`);
  const unknown = Object.keys(loaded).filter((name) => !names.includes(name));
  if (unknown.length) fail(`The restored database lists ${unknown.length} receipt object(s) that are not in the backup (${unknown.slice(0, 3).join(", ")}).`);

  // Only a LOCKED database needs (and accepts) the context: it opens only while maintenance is on. Unlocked, the
  // guard admits the uploads anyway.
  const context = maintenanceState(sql)?.enabled === true;
  const ref = `receipt-restore ${manifest.createdAt} at ${new Date().toISOString()}`;
  if (context) log(`Receipt restore context opened for ${sql(`select to_jsonb(private.receipt_restore_open(${lit(ref)}, array[${names.map(lit).join(", ")}]::text[], 60)) as v`)} object(s) (${ref}).`);
  try {
    for (const receipt of manifest.receipts) {
      const { error } = await storage.upload(receipt.name, readFileSync(receiptPath(dir, receipt.name)), { upsert: true, contentType: receipt.contentType });
      if (error) fail(`Receipt ${receipt.name} could not be restored: ${error.message}`);
      const { data: blob, error: readError } = await storage.download(receipt.name);
      if (readError || sha256(Buffer.from(await blob.arrayBuffer())) !== receipt.sha256) fail(`Restored receipt ${receipt.name} does not read back identically.`);
    }
  } finally {
    if (context) {
      sql(`select to_jsonb(private.receipt_restore_close(${lit(ref)})) as v`);
      const left = sql("select to_jsonb(count(*)::int) as v from private.receipt_restore_objects");
      if (left !== 0) fail(`The receipt restore context still lists ${left} object(s) after closing. Close it by hand: select private.receipt_restore_close('<ref>').`);
      log("Receipt restore context closed; no object is admitted past maintenance any more.");
    }
  }
  const restored = objectRows();
  const changed = names.filter((name) => !isDeepStrictEqual(loaded[name], restored[name]));
  if (changed.length) fail(`Restoring the bytes changed the stored metadata of ${changed.length} receipt(s): ${changed.slice(0, 3).join(", ")}`);
  return { files: names.length, context };
}

// The maintenance state of a restored database, or null for a backup taken before migration 36 (no table yet).
const maintenanceState = (sql) => (sql("select to_jsonb(to_regclass('private.system_maintenance') is not null) as v")
  ? sql("select to_jsonb(x) as v from (select enabled, bypass_user_id is not null as bypass from private.system_maintenance) x") : null);

const localSql = (statement) => JSON.parse(psql(["-c", statement]) || "null");

function restoreTarget(confirmHost) {
  const apiUrl = process.env.SHOPKHATA_RESTORE_SUPABASE_URL;
  const serviceKey = process.env.SHOPKHATA_RESTORE_SERVICE_ROLE_KEY;
  const dbUrl = process.env.SHOPKHATA_RESTORE_DB_URL;
  if (!apiUrl || !serviceKey || !dbUrl) fail("Set SHOPKHATA_RESTORE_SUPABASE_URL, SHOPKHATA_RESTORE_SERVICE_ROLE_KEY and SHOPKHATA_RESTORE_DB_URL to the project being restored.");
  if (new URL(apiUrl).host !== confirmHost) fail(`--confirm must repeat the target host exactly (${new URL(apiUrl).host}).`);
  validateRestoreEndpoints(dbUrl, apiUrl);
  return { apiUrl, serviceKey, dbUrl };
}

// Copies EXACTLY the backup's migrations, in order, from this checkout into a staging folder for `supabase db push`.
// A later migration in the checkout is never staged, so a restore cannot run past the backup's version.
function stageMigrations(versions) {
  if (!versions.length || versions.some((v, i) => !/^\d{14}$/.test(v) || (i && versions[i - 1] >= v))) fail("STOP: the manifest's migration list is not a strictly increasing list of versions.");
  const files = readdirSync(join(REPO, "supabase", "migrations")).filter((name) => name.endsWith(".sql"));
  const stage = mkdtempSync(join(tmpdir(), "shopkhata-restore-"));
  mkdirSync(join(stage, "supabase", "migrations"), { recursive: true });
  copyFileSync(join(REPO, "supabase", "config.toml"), join(stage, "supabase", "config.toml"));
  for (const version of versions) {
    const match = files.filter((name) => name.split("_")[0] === version);
    if (match.length !== 1) fail(`STOP: migration ${version} of the backup is ${match.length ? "ambiguous" : "missing"} in this checkout. Check out the release named in manifest.app.gitCommit.`);
    copyFileSync(join(REPO, "supabase", "migrations", match[0]), join(stage, "supabase", "migrations", match[0]));
  }
  return stage;
}

// Restores a backup into a NEW, empty Supabase project: exactly the manifest's migrations (never a later one in this
// checkout), then data.sql in one transaction, then the receipt files; then verifies the migration set, the receipts
// and the fingerprint. A database backed up inside a release window comes back LOCKED; this never unlocks it.
async function restoreTo(from, confirmHost) {
  const dir = resolve(from);
  if (!existsSync(join(dir, "manifest.json"))) fail(`${dir} is not a ShopKhata backup (manifest.json is missing).`);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  checkArtifacts(dir, manifest);
  // Empty COPY blocks are dropped: they carry no rows, and the postgres role of a Supabase project may not write some of
  // Supabase's own tables (storage.buckets_vectors, ...), which refuse even an empty COPY. A block WITH rows for such a
  // table still fails the load loudly. (Found by the production-equivalent restore rehearsal; the local rehearsal loads
  // as the superuser and never saw it.) Each skipped public/Storage section must be proven empty at the source, before
  // anything touches the target.
  const skipped = [];
  const loadable = readFileSync(join(dir, "data.sql"), "utf8").replace(/^COPY ("[^"\n]+"\."[^"\n]+") \([^\n]*\) FROM stdin;\r?\n\\\.\r?\n/gm, (_, table) => { skipped.push(table); return ""; });
  provenEmpty(manifest, skipped);
  const { apiUrl, serviceKey, dbUrl } = restoreTarget(confirmHost);
  const sql = urlSql(dbUrl);
  const applied = () => sql("select to_jsonb(coalesce((select array_agg(version order by version) from supabase_migrations.schema_migrations), '{}')) as v");
  const expected = manifest.migrations;
  log(`Restoring the ${manifest.environment} backup of ${manifest.createdAt} into ${confirmHost}: exactly ${expected.length} migrations (last ${expected.at(-1)}).`);

  if (sql("select to_jsonb(to_regclass('supabase_migrations.schema_migrations') is not null) as v") && applied().length) {
    fail("STOP: the target already has migrations applied. Restore only into a new, empty Supabase project.");
  }
  const stage = stageMigrations(expected);
  const dry = supabase(["--workdir", stage, "db", "push", "--db-url", dbUrl, "--dry-run"], { all: true });
  const listed = [...dry.matchAll(/\b(\d{14})_\S*\.sql/g)].map((m) => m[1]);
  if (!isDeepStrictEqual(listed, expected)) fail(`STOP: the dry run would apply [${listed.join(", ")}], not exactly the backup's [${expected.join(", ")}].`);
  supabase(["--workdir", stage, "db", "push", "--db-url", dbUrl]);
  if (!isDeepStrictEqual(applied(), expected)) fail(`STOP: the target reports migrations [${applied().join(", ")}], expected exactly [${expected.join(", ")}]. Inspect it; do not repair the history by hand.`);
  log(`Schema: exactly the backup's ${expected.length} migrations applied (last ${expected.at(-1)}); nothing later.`);

  // The migrations create rows of their own (the receipt bucket, the maintenance singleton); the backup replaces them.
  psqlUrl(dbUrl, ["-c", "set session_replication_role = replica; delete from storage.objects; delete from storage.buckets; do $$ begin if to_regclass('private.system_maintenance') is not null then delete from private.system_maintenance; end if; end $$;"]);
  // The empty sections were proven empty at the source above (provenEmpty); the restored fingerprint proves the target.
  const loadFile = join(mkdtempSync(join(tmpdir(), "shopkhata-load-")), "data.sql");
  writeFileSync(loadFile, loadable);
  const data = openSync(loadFile, "r");
  try { psqlUrl(dbUrl, ["--single-transaction"], data); } finally { closeSync(data); }
  psqlUrl(dbUrl, ["-c", "analyze"]);
  log(`Data: data.sql loaded in one transaction (${skipped.length} empty table(s) skipped, every public/storage one proven empty at the source), then analyzed.`);

  const receipts = await restoreReceipts(dir, manifest, apiUrl, serviceKey, sql);
  const orphans = sql(`select to_jsonb(count(*)::int) as v from public.attachments a where a.expense_id is not null and not exists (select 1 from storage.objects o where o.bucket_id = '${BUCKET}' and o.name = a.file_path and (o.metadata ->> 'size')::bigint = a.byte_size)`);
  if (orphans) fail(`${orphans} restored receipt record(s) have no matching stored file.`);
  log(`Receipts: ${receipts.files} file(s) uploaded and read back byte-identical, metadata unchanged, every receipt record has its file${receipts.context ? "; restore context closed" : ""}.`);

  const restored = fingerprint({ args: ["--db-url", dbUrl] });
  const diff = differences(manifest.fingerprint, restored);
  const maintenance = maintenanceState(sql);
  const evidence = { restoredAt: new Date().toISOString(), target: confirmHost, ok: diff.length === 0, migrations: applied(), maintenance, receipts: receipts.files, skippedEmptySections: skipped, storageInventory: restored.storage, differences: diff };
  writeFileSync(join(dir, `restore-${confirmHost.replace(/[^a-z0-9.-]/gi, "_")}-${evidence.restoredAt.replace(/[:.]/g, "-")}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  if (diff.length) fail(`The restored state does not reconcile with the backup:\n  ${diff.join("\n  ")}`);
  if (!isDeepStrictEqual(evidence.migrations, expected)) fail("STOP: the migration set changed during the restore.");
  log(`Maintenance state of the restored database: ${maintenance ? (maintenance.enabled ? `LOCKED (enabled${maintenance.bypass ? ", WITH an operator bypass" : ", no bypass"})` : "off") : "not installed (backup before migration 36)"}.`);
  log(`RESTORED: ${confirmHost} is at exactly ${expected.at(-1)} with the backup's data and receipts; fingerprint identical. Validate it (backup-restore.md) before pointing anything at it.`);
}

// The one step of a real (hosted) recovery that needs a tool. It is never run implicitly:
// the target is named explicitly and must be repeated on the command line.
async function restoreReceiptsTo(from, confirmHost) {
  const dir = resolve(from);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const { apiUrl, serviceKey, dbUrl } = restoreTarget(confirmHost);
  log(`Restoring ${manifest.receipts.length} receipt file(s) from the ${manifest.environment} backup of ${manifest.createdAt} into ${confirmHost}`);
  await restoreReceipts(dir, manifest, apiUrl, serviceKey, urlSql(dbUrl));
  log(`Receipts restored: ${manifest.receipts.length} file(s) uploaded and read back byte-identical, stored metadata unchanged.`);
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
async function recordBackup(from, locked = false) {
  // Read only routing metadata outside the lock; all integrity/evidence reads and the write happen inside it.
  const route = JSON.parse(readFileSync(join(resolve(from), "manifest.json"), "utf8"));
  if (route.environment === "local" && !locked) return withRestoreLock(LOCAL_DB_CONTAINER, "backup record", () => recordBackup(from, true), { exclusive: true });
  const dir = resolve(from);
  if (!existsSync(join(dir, "manifest.json"))) fail(`${dir} is not a ShopKhata backup (manifest.json is missing).`);
  const manifestBytes = readFileSync(join(dir, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.environment === "local" && !locked) return withRestoreLock(LOCAL_DB_CONTAINER, "backup record", () => recordBackup(from, true), { exclusive: true });
  checkArtifacts(dir, manifest);
  log(`Integrity: ${DUMPS.length} dump files and ${manifest.receipts.length} receipt file(s) match their recorded SHA-256`);

  // The record goes to the environment the backup was taken from, never to another one.
  let apiUrl = process.env.SHOPKHATA_BACKUP_SUPABASE_URL;
  let serviceKey = process.env.SHOPKHATA_BACKUP_SERVICE_ROLE_KEY;
  if (manifest.environment === "local") {
    if (apiUrl) fail("This is a backup of the local stack. Unset SHOPKHATA_BACKUP_SUPABASE_URL to record it there.");
    ({ apiUrl, serviceKey } = localSource());
    if (new URL(apiUrl).origin !== "http://127.0.0.1:55321") fail("Unexpected local recording API target.");
    assertLocalEndpoint("supabase_kong_shopkhata", 55321, 8000);
  } else if (!apiUrl || !serviceKey || process.env.SHOPKHATA_BACKUP_ENV !== manifest.environment) {
    fail(`Set SHOPKHATA_BACKUP_ENV=${manifest.environment}, SHOPKHATA_BACKUP_SUPABASE_URL and SHOPKHATA_BACKUP_SERVICE_ROLE_KEY to the project this backup was taken from.`);
  }
  if (manifest.environment !== "local" && !/^https:\/\/[a-z0-9]{20}\.supabase\.co\/?$/.test(apiUrl)) fail("Recording a hosted backup requires its hosted Supabase API.");
  const rehearsalPath = join(dir, "restore-verification.json");
  // Only a completed rehearsal bound to THIS manifest and a verification run counts (scripts/backup-verification.mjs).
  const text = existsSync(rehearsalPath) ? readFileSync(rehearsalPath, "utf8") : null;
  let release = null;
  try {
    const runId = JSON.parse(text)?.runId;
    if (typeof runId === "string" && /^[a-zA-Z0-9-]+$/.test(runId)) {
      const receipt = releaseReceiptPath(rehearsalPath, runId);
      if (existsSync(receipt)) release = readFileSync(receipt, "utf8");
    }
  } catch { /* malformed evidence is rejected by acceptedRehearsal */ }
  const { rehearsal, reason } = acceptedRehearsal(text, sha256(manifestBytes), release);
  if (!rehearsal && existsSync(rehearsalPath)) log(`Restore evidence not used: ${reason}.`);
  const { error } = await createClient(apiUrl, serviceKey, { auth: { persistSession: false } }).from("backup_records").upsert({
    backup_created_at: manifest.createdAt, environment: manifest.environment, source: manifest.source,
    app_version: manifest.app?.version ?? null, git_commit: manifest.app?.gitCommit ?? null, latest_migration: manifest.migrations.at(-1),
    dump_bytes: DUMPS.reduce((sum, name) => sum + manifest.files[name].bytes, 0), receipt_count: manifest.receipts.length,
    manifest_sha256: sha256(manifestBytes), restore_verified_at: rehearsal?.verifiedAt ?? null, restore_verified_ok: rehearsal ? rehearsal.ok === true : null,
  }, { onConflict: "manifest_sha256,restore_verified_at", ignoreDuplicates: true });
  if (error) fail(`The backup could not be recorded: ${error.message}`);
  log(`Recorded the ${manifest.environment} backup of ${manifest.createdAt} (${rehearsal ? `restore rehearsal ${rehearsal.ok ? "passed" : "FAILED"} at ${rehearsal.verifiedAt}` : "no restore rehearsal yet"}).`);
}

async function verifyRestore(from, lock) {
  // Runs under the restore lock `lock` (see the dispatch below).
  const dir = from ? resolve(from) : await createBackup();
  const evidence = join(dir, "restore-verification.json");
  // The evidence says ok=true only once every check below has passed (scripts/backup-verification.mjs); earlier
  // evidence is invalidated first, a failure or an interrupted run leaves ok=false with the failed check, and the error
  // still ends the command nonzero.
  const { passes, environment } = await runRestoreChecks(evidence, (check, record) => verifySteps(dir, check, record, lock), {
    complete: (value) => queueRestoreCompletion(lock, evidence, value),
  });
  if (environment !== "local") log("The local database now holds the restored data. Run `pnpm exec supabase db reset --local` when you have finished inspecting it.");
  return { passes, evidence, inherited: lock.inherited };
}

// Every required check of the rehearsal, in order; check(name) marks the one now running.
async function verifySteps(dir, check, record, lock) {
  let passes = 0;
  const pass = (name, detail) => { passes += 1; log(`PASS ${name}: ${detail}`); };

  check("backup manifest");
  if (!existsSync(join(dir, "manifest.json"))) fail(`${dir} is not a ShopKhata backup (manifest.json is missing).`);
  const manifestBytes = readFileSync(join(dir, "manifest.json"));
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch (error) { fail(`manifest.json is not valid JSON: ${error.message}`); }
  // The evidence is bound to this exact manifest (backup:record accepts a pass only for the same SHA-256).
  record({ manifestSha256: sha256(manifestBytes) });

  check("artifact integrity");
  checkArtifacts(dir, manifest);
  pass("artifact integrity", `${DUMPS.length} dump files and ${manifest.receipts.length} receipt file(s) match their recorded SHA-256`);

  check("migration compatibility");
  const repoMigrations = readdirSync(join(REPO, "supabase", "migrations")).filter((name) => name.endsWith(".sql")).map((name) => name.split("_")[0]).sort();
  if (!isDeepStrictEqual(repoMigrations.slice(0, manifest.migrations.length), manifest.migrations)) {
    fail("The backup was taken at a migration state this checkout does not contain. Check out the release that produced it.");
  }
  pass("migration compatibility", `backup is at ${manifest.migrations.at(-1)} (${manifest.migrations.length} of ${repoMigrations.length} migrations in this checkout)`);

  check("database restore");
  assertRestoreLockHeld(lock);
  const target = localSource();
  if (new URL(target.apiUrl).origin !== "http://127.0.0.1:55321") fail("Unexpected local rehearsal API target.");
  assertLocalEndpoint("supabase_db_shopkhata", 55322, 5432);
  assertLocalEndpoint("supabase_kong_shopkhata", 55321, 8000);
  log("Resetting the LOCAL Supabase database (the disposable restore target) to the backup's migration state...");
  // Only through the guarded reset (scripts/local-reset.mjs), under this run's exclusive operation lease: the images are
  // proven before anything is reset, and a reset that cannot be confirmed stopped keeps the lease (fail closed).
  await guardedLocalReset({ root: REPO, args: ["--no-seed", "--version", manifest.migrations.at(-1)], lease: lock.operation, timeoutMs: BACKUP_RESET_BUDGET });
  const reset = localSql("select to_jsonb(array_agg(version order by version)) from supabase_migrations.schema_migrations");
  if (!isDeepStrictEqual(reset, manifest.migrations)) fail(`The local reset reached ${reset?.at(-1)}, not exactly the backup's migration state.`);
  const tables = [...readFileSync(join(dir, "data.sql"), "utf8").matchAll(/^COPY ("[a-z_]+"\."[a-z_0-9]+") /gm)].map((match) => match[1]);
  // The migrations create rows of their own (the receipt bucket); the backup is the only source of data.
  psql(["-c", `set session_replication_role = replica; truncate ${tables.join(", ")} cascade;`]);
  const data = openSync(join(dir, "data.sql"), "r");
  try { psql(["--single-transaction"], data); } finally { closeSync(data); }
  // A bulk load leaves the planner without statistics; until autovacuum catches up the invoice
  // projection is slow enough to hit the API statement timeout. ANALYZE is part of every restore.
  psql(["-c", "analyze"]);
  pass("database restore", `${tables.length} tables restored from data.sql in one transaction, then analyzed`);

  check("receipt restore");
  const receipts = await restoreReceipts(dir, manifest, target.apiUrl, target.serviceKey, localSql);
  const orphans = Number(psql(["-c", `select count(*) from public.attachments a where a.expense_id is not null and not exists (select 1 from storage.objects o where o.bucket_id = '${BUCKET}' and o.name = a.file_path and (o.metadata ->> 'size')::bigint = a.byte_size)`]));
  if (orphans) fail(`${orphans} restored receipt record(s) have no matching stored file.`);
  pass("receipt restore", `${manifest.receipts.length} file(s) uploaded and read back byte-identical, stored metadata unchanged${receipts.context ? ", through the receipt restore context (closed again)" : ""}; all ${manifest.receiptAttachments} receipt record(s) have their file`);
  check("maintenance state");
  const maintenance = maintenanceState(localSql);
  if (maintenance) pass("maintenance state", maintenance.enabled ? `restored LOCKED (maintenance on${maintenance.bypass ? ", with the backup's operator bypass" : ", no bypass"}), as in the backup` : "maintenance off, as in the backup");

  check("fingerprint reconciliation");
  const restored = fingerprint(target);
  // Only the comparison skips the local-only Storage tables (scripts/backup-local-storage.mjs); the evidence keeps the full restored fingerprint.
  const { differences: diff, tolerated } = compareRestored(manifest.fingerprint, restored);
  record({ differences: diff, toleratedLocalOnly: tolerated, restoredFingerprint: restored });
  if (tolerated.length) log(`Local-only Storage tables absent from the backup and empty here, left out of the comparison: ${tolerated.join(", ")}.`);
  if (diff.length) fail(`The restored state does not reconcile with the backup:\n  ${diff.join("\n  ")}`);
  const rows = Object.values(restored.tables).reduce((sum, value) => sum + Number(value.split(":")[0]), 0);
  pass("table reconciliation", `${Object.keys(restored.tables).length} tables, ${rows} rows: every count and row hash identical`);
  for (const [shopId, shop] of Object.entries(restored.shops)) {
    pass(`financial reconciliation ${shopId}`, `invoices ${shop.sales_totals.invoice_count}, net sales ${shop.sales_totals.net_sales_dirham ?? shop.sales_totals.effective_total_dirham}, paid ${shop.sales_totals.effective_paid_dirham}, due ${shop.sales_totals.effective_due_dirham}, customer due ${shop.customer_due_totals.outstanding_due_dirham}, available credit ${shop.customer_due_totals.available_credit_dirham} (dirham); ledger, balances, expenses and closed dates identical`);
  }

  check("shop isolation");
  psql(["-c", ISOLATION_SQL]);
  pass("shop isolation", "every active non-owner account sees only its own shops' invoices and receipt objects under row-level security");

  check("application reads");
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

  // Nothing else touched the database meanwhile only if the lock was ours throughout.
  check("restore lock");
  assertRestoreLockHeld(lock);
  pass("restore lock", `held for the whole rehearsal (${lock.inherited ? "inherited from the run that started this one" : "taken by this run"})`);
  return { passes, environment: manifest.environment };
}

// A restore whose target is this computer's local database (SHOPKHATA_RESTORE_DB_URL on localhost) needs the lock too.
function localRestoreTarget() {
  return validateRestoreEndpoints(process.env.SHOPKHATA_RESTORE_DB_URL, process.env.SHOPKHATA_RESTORE_SUPABASE_URL) === "local";
}

try {
  const [mode, flag, value, confirmFlag, confirmHost] = process.argv.slice(2);
  const hasBackup = flag === "--from" && value && statSync(value).isDirectory();
  // Whatever resets or loads the local database runs only while holding its restore lock in Docker
  // (scripts/restore-lock.mjs). Local record takes the same lock inside recordBackup, across evidence validation and
  // the database write. Hosted recording requires a hosted API and a finalized release receipt, without a local daemon.
  const locked = (purpose, fn) => withRestoreLock(LOCAL_DB_CONTAINER, `node scripts/backup.mjs ${purpose}`, fn, { exclusive: true });
  if (mode === undefined) await createBackup();
  else if (mode === "verify" && (flag === undefined || hasBackup)) {
    const result = await locked(`verify ${value ? resolve(value) : "(new local backup)"}`, (lock) => verifyRestore(value, lock));
    log(`${result.inherited ? "RESTORE CHECKS PASSED (pending parent lock release)" : "RESTORE VERIFIED"}: ${result.passes} checks passed. Evidence: ${result.evidence}`);
  }
  else if (mode === "record" && hasBackup && confirmFlag === undefined) await recordBackup(value);
  else if (mode === "restore" && hasBackup && confirmFlag === "--confirm" && confirmHost) await (localRestoreTarget() ? locked(`restore ${resolve(value)} (local target)`, () => restoreTo(value, confirmHost)) : restoreTo(value, confirmHost));
  else if (mode === "restore-receipts" && hasBackup && confirmFlag === "--confirm" && confirmHost) await (localRestoreTarget() ? locked(`restore-receipts ${resolve(value)} (local target)`, () => restoreReceiptsTo(value, confirmHost)) : restoreReceiptsTo(value, confirmHost));
  else fail("Usage: node scripts/backup.mjs [verify [--from <backup directory>] | record --from <backup directory> | restore --from <backup directory> --confirm <target host> | restore-receipts --from <backup directory> --confirm <target host>]");
} catch (error) {
  console.error(`[backup] FAILED: ${error instanceof BackupError || error instanceof RestoreLockError || error instanceof LocalResetError ? error.message : error.stack}`);
  process.exit(1);
}
