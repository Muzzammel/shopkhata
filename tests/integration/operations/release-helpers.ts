import { execFile, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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
/** node scripts/backup.mjs ... ; resolves with the output, rejects with it on a non-zero exit. */
export async function backupTool(args: string[], env: Record<string, string> = {}, timeout = 600_000): Promise<string> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, ["scripts/backup.mjs", ...args], { timeout, maxBuffer: 64 * 1024 * 1024, encoding: "utf-8", env: { ...process.env, ...env } });
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`backup.mjs ${args[0]} failed:\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`);
  }
}

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

/** A folder holding only the migrations up to `last` (runbook section 5); `last` = "" stages none (a blank project). */
export function stageMigrations(last: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ops01b-stage-"));
  mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
  cpSync("supabase/config.toml", join(dir, "supabase", "config.toml"));
  for (const file of readdirSync("supabase/migrations")) if (file.split("_")[0] <= last) cpSync(join("supabase/migrations", file), join(dir, "supabase", "migrations", file));
  return dir;
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
