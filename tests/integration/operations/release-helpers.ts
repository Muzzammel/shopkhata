import { execFile, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertLocalEndpoint, classifyDatabaseTarget } from "../../../scripts/backup-target.mjs";
import { boundedDocker, CLI, guardedLocalReset, runTree, sourcePins, stagePins as stageValidatedPins } from "../../../scripts/local-reset.mjs";
import { acquireRestoreOperation, dockerCli, INHERIT_ENV, inheritRestoreLock, pinLocalDocker, processTable, releaseRestoreOperation } from "../../../scripts/restore-lock.mjs";

// Shared by the OPS-01B release/recovery rehearsals: the runbook's real commands against the local stack.
const execFileP = promisify(execFile);
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
export const DB_CONTAINER = "supabase_db_shopkhata";
export const DB_URL = "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
export const V35 = "20261031165915";
export const NEW_VERSIONS = ["20261103140000", "20261103150000", "20261103190000", "20261103203806"];
export const SHOP_1 = "10000000-0000-4000-8000-000000000001";
export const OWNER_ID = "10000000-0000-4000-8000-000000000101";
export const STAFF1_ID = "10000000-0000-4000-8000-000000000102";
export const OWNER = { email: "owner@shopkhata.local", password: "ShopKhata-Local-Owner-E2E-Only-2026!" };
export const MANAGER = { email: "manager@shopkhata.local", password: "ShopKhata-Local-Manager-E2E-Only-2026!" };
export const STAFF1 = { email: "staff1@shopkhata.local", password: "ShopKhata-Local-E2E-Only-2026!" };
export const RELEASE_REF = "ops-01b-slice1-rehearsal";
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const uid = () => Math.random().toString(36).slice(2, 10);

export async function sh(args: string[], env: Record<string, string> = {}, timeout = 300_000): Promise<string> {
  const win = process.platform === "win32";
  try {
    const { stdout, stderr } = await execFileP(win ? (process.env.ComSpec ?? "cmd.exe") : PNPM, win ? ["/d", "/s", "/c", "call", PNPM, ...args] : args, {
      timeout, maxBuffer: 64 * 1024 * 1024, encoding: "utf-8",
      env: { ...process.env, ...env, PATH: `${join(process.cwd(), "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}` },
    });
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`pnpm ${args.join(" ")} failed:\n${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`);
  }
}
export const supabase = (args: string[], env?: Record<string, string>, timeout?: number) => sh(["exec", "supabase", "--agent", "no", ...args], env, timeout);
// ---- LOCAL-ONLY subprocess environment (G6-B) ---------------------------------------------------------------------
// Every `node scripts/backup.mjs` these rehearsals start gets an environment BUILT here, never the caller's: only the
// operating-system variables below, the run's restore-lock handover, the pinned local Docker engine, and what the
// caller passes explicitly. So no SHOPKHATA_BACKUP_* / SHOPKHATA_RESTORE_* routing or credential, no SUPABASE_*, PG*,
// DOCKER_CONTEXT or proxy variable of the launching shell can reach the tool; and anything passed explicitly that
// names a database or API must be this computer's local stack, or nothing is started.
export const LOCAL_API = "http://127.0.0.1:55321";
const OS_ENV = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA)$/i;
type Env = Record<string, string | undefined>;
type LocalDeps = { base?: Env; docker?: (args: string[]) => { ok: boolean; stdout: string; stderr: string }; run?: typeof runTree };
export function localOnlyEnv(extra: Record<string, string> = {}, base: Env = process.env, docker: LocalDeps["docker"] = dockerCli): NodeJS.ProcessEnv {
  for (const [name, value] of Object.entries(extra)) {
    if (/^SHOPKHATA_BACKUP_(DB_URL|SUPABASE_URL|SERVICE_ROLE_KEY|ENV)$/.test(name)) throw new Error(`${name} would route a backup to a remote source; these rehearsals read the local stack only. Nothing was started.`);
    if (/_DB_URL$/.test(name) && classifyDatabaseTarget(value) !== "local") throw new Error(`${name} is not the local database; these rehearsals use the local stack only. Nothing was started.`);
    if (/_SUPABASE_URL$/.test(name) && value !== LOCAL_API) throw new Error(`${name} is not the local API (${LOCAL_API}); these rehearsals use the local stack only. Nothing was started.`);
  }
  const env: Env = Object.fromEntries(Object.entries(base).filter(([name]) => OS_ENV.test(name)));
  for (const name of Object.values(INHERIT_ENV)) if (base[name]) env[name] = base[name];
  env.DOCKER_HOST = pinLocalDocker({ DOCKER_HOST: base.DOCKER_HOST }, docker); // refuses anything but the local daemon
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}
/** `pnpm backup:db` of the LOCAL stack only, into `dir`; returns the backup folder. Before the tool is started: the
 *  local database and API containers are verified on the pinned engine, and the Supabase CLI, in the very environment
 *  the tool will get, must report exactly the local API and database. scripts/backup.mjs is unchanged: with no
 *  SHOPKHATA_BACKUP_DB_URL in that environment it can only select the local stack, and its manifest must say `local`. */
export async function localBackup(dir: string, extra: Record<string, string> = {}, { base = process.env, docker = dockerCli, run = runTree }: LocalDeps = {}): Promise<string> {
  const vars = { ...extra, SHOPKHATA_BACKUP_DIR: dir };
  const env = localOnlyEnv(vars, base, docker);
  assertLocalEndpoint(DB_CONTAINER, 55322, 5432, { docker });
  assertLocalEndpoint("supabase_kong_shopkhata", 55321, 8000, { docker });
  const status = await run(process.execPath, [CLI, "--agent", "no", "status", "-o", "env"], { timeoutMs: 60_000, env });
  const reported = Object.fromEntries(status.stdout.split(/\r?\n/).map((line) => /^([A-Z][A-Z0-9_]*)="?(.*?)"?$/.exec(line)).filter(Boolean).map((m) => [m![1], m![2]]));
  let local = false;
  try { local = status.status === 0 && reported.API_URL === LOCAL_API && classifyDatabaseTarget(reported.DB_URL) === "local"; } catch { /* refused below */ }
  if (!local) throw new Error("The Supabase CLI does not report the local stack (API 127.0.0.1:55321, database 127.0.0.1:55322) as the backup source; nothing was backed up.");
  const backup = (await backupTool([], vars, 300_000, { base, docker, run })).match(/Backup complete: (.+)/)?.[1]?.trim();
  if (!backup) throw new Error("backup.mjs did not report a completed backup.");
  const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8"));
  if (manifest.environment !== "local" || manifest.source !== "local Supabase stack") throw new Error(`The backup at ${backup} was not taken from the local stack (${manifest.environment}); do not use it.`);
  return backup;
}
/** node scripts/backup.mjs ... as a tracked process tree (scripts/local-reset.mjs runTree): resolves with the output,
 *  rejects with it on a non-zero exit. Past `timeout` the WHOLE tree (backup.mjs, its Supabase CLI, psql and Docker
 *  CLI children) is killed and confirmed gone; a backup.mjs killed mid-operation leaves its operation lease, so the
 *  run's restore lock cannot be released (fail closed). It runs in the local-only environment (localOnlyEnv). */
export async function backupTool(args: string[], env: Record<string, string> = {}, timeout = 600_000, { base = process.env, docker = dockerCli, run = runTree }: LocalDeps = {}): Promise<string> {
  const localEnv = localOnlyEnv(env, base, docker);
  let result;
  try {
    result = await run(process.execPath, ["scripts/backup.mjs", ...args], { timeoutMs: timeout, env: localEnv });
  } catch (error) {
    throw Object.assign(new Error(`backup.mjs ${args[0]} failed: ${(error as Error).message}`), { leaseAbandoned: (error as { leaseAbandoned?: boolean }).leaseAbandoned === true });
  }
  if (result.status !== 0) throw new Error(`backup.mjs ${args[0]} failed:\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}
/** Outer supervisor of `backup.mjs verify` (see BACKUP_RESET_BUDGET in scripts/backup.mjs): longer than the verify's
 *  guarded reset budget plus its data load and checks, so the inner deadlines expire first. */
export const VERIFY_TIMEOUT = 900_000;
export const backupVerify = (from: string, env: Record<string, string> = {}) => backupTool(["verify", "--from", from], env, VERIFY_TIMEOUT);

export async function psql(sql: string, user = "postgres"): Promise<string> {
  const child = execFileP("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", DB_CONTAINER, "psql", "-h", "127.0.0.1", "-U", user, "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], { maxBuffer: 64 * 1024 * 1024 });
  child.child.stdin?.end(sql);
  return (await child).stdout.trim();
}
/** A long-lived psql session (for transactions held open across other steps). */
export function session(user = "postgres") {
  const child = spawn("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", DB_CONTAINER, "psql", "-h", "127.0.0.1", "-U", user, "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = ""; let err = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  return {
    send: (sql: string) => { child.stdin.write(`${sql}\n`); },
    until: async (marker: string, ms = 30_000) => {
      const end = Date.now() + ms;
      while (!out.includes(marker)) { if (Date.now() > end) throw new Error(`session never printed ${marker}; stderr: ${err}`); await sleep(50); }
    },
    output: () => out, errors: () => err,
    end: async () => { child.stdin.end(); return exited; },
  };
}
export const lastJson = (text: string) => JSON.parse(text.split(/\r?\n/).filter((line) => line.startsWith("{")).pop() ?? "null");
export const runSqlFile = async (path: string) => lastJson(await psql(readFileSync(path, "utf8")));
export async function localEnv(): Promise<Record<string, string>> {
  return Object.fromEntries((await supabase(["status", "-o", "env"])).split(/\r?\n/).map((line) => /^([A-Z][A-Z0-9_]*)="?(.*?)"?$/.exec(line)).filter(Boolean).map((m) => [m![1], m![2]]));
}
export async function signIn(env: Record<string, string>, { email, password }: { email: string; password: string }): Promise<SupabaseClient> {
  const client = createClient(env.API_URL, env.PUBLISHABLE_KEY ?? env.ANON_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password }); if (error) throw error; return client;
}

// Local resets go through scripts/local-reset.mjs (shared with `node scripts/backup.mjs verify`): a private snapshot of
// the project with only its validated supabase/.temp version pins, PostgreSQL and Storage proven to be the running
// images (tag and local image ID) BEFORE anything is reset, the reset run as a bounded, confirmed-killed process tree,
// all under an exclusive operation lease of the run's restore lock (G6-B).
export { PIN_MAX_BYTES, SUPABASE_PINS, assertResetImages as assertStagedImages, supabaseImage } from "../../../scripts/local-reset.mjs";
/** Writes this checkout's (or `root`'s) validated pins, byte for byte, into the staged project `dir`. */
export const stagePins = (dir: string, root = "."): void => stageValidatedPins(dir, root);
/** A folder holding only the migrations up to `last` (runbook section 5); `last` = "" stages none (a blank project).
 *  It carries the source's validated service pins, so the CLI resolves the same images from it. */
export function stageMigrations(last: string, root = "."): string {
  sourcePins(root); // validated before anything is created
  const dir = mkdtempSync(join(tmpdir(), "ops01b-stage-"));
  mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
  cpSync(join(root, "supabase", "config.toml"), join(dir, "supabase", "config.toml"));
  for (const file of readdirSync(join(root, "supabase", "migrations"))) if (file.split("_")[0] <= last) cpSync(join(root, "supabase", "migrations", file), join(dir, "supabase", "migrations", file));
  stageValidatedPins(dir, root);
  return dir;
}
type Lease = { parentId: string; image: string };
type Docker = ReturnType<typeof boundedDocker>;
type ResetDeps = Partial<Pick<Parameters<typeof guardedLocalReset>[0], "docker" | "services" | "run" | "held">> & {
  acquireLease?: (purpose: string, docker: Docker, deadline: number) => Lease;
  releaseLease?: (lease: Lease, docker: Docker) => void;
};
/** Time kept back from the reset for releasing the lease (bounded Docker calls) before the caller's deadline. */
export const RELEASE_RESERVE = 20_000;
function leaseOfThisRun(purpose: string, docker: Docker, deadline: number): Lease {
  pinLocalDocker(process.env, docker); // bounded by the reset deadline, like every other Docker call here
  const owner = inheritRestoreLock(DB_CONTAINER, process.env, { docker, table: () => processTable({ timeoutMs: Math.max(1, Math.min(15_000, deadline - Date.now())) }) });
  return acquireRestoreOperation(owner, purpose, { docker });
}
/** THE local reset of the OPS-01B operations tests: `db reset --local <args>` of `workdir`'s project (default: this
 *  checkout), everything (lease, checks, reset, kill confirmation, release) within `timeoutMs`. Holds an exclusive
 *  operation lease of the vitest run's restore lock throughout, so neither another reset nor the run's lock release can
 *  start meanwhile. The lease is released only after the reset's whole process tree is confirmed gone; otherwise (or if
 *  the release itself cannot finish in time) it stays: fail closed, the run's lock then cannot be released. */
export async function resetLocal(args: string[] = [], { workdir = ".", timeoutMs = 240_000, acquireLease = leaseOfThisRun, releaseLease = (lease, docker) => releaseRestoreOperation(lease, { docker }), ...deps }: ResetDeps & { workdir?: string; timeoutMs?: number } = {}): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const docker = deps.docker ?? boundedDocker(deadline);
  const lease = acquireLease(`operations test reset ${args.join(" ")}`.trim(), docker, deadline);
  let release = true;
  try {
    return await guardedLocalReset({ root: workdir, args, lease, ...deps, docker, timeoutMs: deadline - RELEASE_RESERVE - Date.now() });
  } catch (error) {
    if ((error as { leaseAbandoned?: boolean }).leaseAbandoned === true) release = false;
    throw error;
  } finally {
    if (release) releaseLease(lease, docker);
  }
}
/** supabase CLI push of only the migrations up to `last`; the dry run must list exactly `expectListed`. */
export async function pushUpTo(last: string, expectListed: string): Promise<void> {
  const dir = stageMigrations(last);
  const dry = await supabase(["--workdir", dir, "db", "push", "--db-url", DB_URL, "--dry-run"]);
  const listed = dry.split(/\r?\n/).filter((line) => /^\s*•?\s*\d{14}_/.test(line));
  if (listed.length !== 1 || !listed[0].includes(expectListed)) throw new Error(`the dry run must list exactly ${expectListed}, listed:\n${listed.join("\n")}`);
  await supabase(["--workdir", dir, "db", "push", "--db-url", DB_URL]);
}
/** Runbook section 6: ONE statement per control, the owner claims set inside it. */
export async function control(fn: "set_maintenance" | "set_maintenance_bypass", command: object): Promise<{ changed: boolean }> {
  const file = join(mkdtempSync(join(tmpdir(), "ops01b-ctl-")), "control.sql");
  writeFileSync(file, `select public.${fn}('${JSON.stringify(command)}'::jsonb) as result from (select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '${OWNER_ID}')::text, true)) s`);
  const out = await supabase(["db", "query", "--db-url", DB_URL, "-f", file, "--output-format", "json"]);
  const rows = JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1)) as { result: { changed: boolean } }[];
  return rows[0].result;
}
export const maintenanceOn = () => control("set_maintenance", { enabled: true, reason: "OPS-01B slice 1 release window", release_ref: RELEASE_REF });
export const maintenanceOff = () => control("set_maintenance", { enabled: false, reason: "Candidate healthy; reopening", release_ref: RELEASE_REF });
export const bypassOn = () => control("set_maintenance_bypass", { user_id: OWNER_ID, minutes: 60, reason: "Operator smoke of the candidate" });
export const bypassOff = () => control("set_maintenance_bypass", { user_id: null, reason: "Operator smoke finished" });

/** V3 exactly as documented in the runbook (section 6), so the test runs the operator's query, not a copy. */
export function runbookV3(): string {
  const runbook = readFileSync("docs/operations/ops-01b-slice1-release-runbook.md", "utf8");
  const v3 = /-- V3:[^\n]*\n([\s\S]*?)\n-- V4:/.exec(runbook)?.[1];
  if (!v3) throw new Error("V3 not found in the runbook");
  return v3.split("\n").filter((line) => !line.startsWith("--")).join("\n");
}
/** W5 (runbook): two quiescence observations at least `gapMs` apart, plus the lock and session inventory. */
export async function observeQuiescence(gapMs = 5000) {
  const first = await runSqlFile("scripts/ops-01b-quiescence.sql");
  await sleep(gapMs);
  const second = await runSqlFile("scripts/ops-01b-quiescence.sql");
  return { first: first.quiescence ?? first, second: second.quiescence ?? second };
}
