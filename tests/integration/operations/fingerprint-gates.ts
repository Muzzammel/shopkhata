import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { psql, stagePins } from "./release-helpers";

// Shared by the OPS-01B fingerprint tests (P1B line endings, P1C maintenance controller): runs the REAL gate SQL files
// against the local stack after a drift that is applied and rolled back in the same transaction.

export const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Every SQL/PL/pgSQL function of the application schemas (API RPCs, wrappers, trigger and guard functions). */
export const APP_FNS = "select p.oid::regprocedure from pg_proc p join pg_language l on l.oid = p.prolang where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prokind = 'f' and l.lanname in ('plpgsql', 'sql')";
/** Re-creates functions from their own definition with another line-ending representation (owner and grants survive). */
export const represent = (eol: "crlf" | "cr", where = "") => `do $rw$ declare f regprocedure; begin
  for f in ${APP_FNS} ${where} loop
    execute replace(replace(pg_get_functiondef(f), E'\\r\\n', E'\\n'), E'\\n', ${eol === "crlf" ? "E'\\r\\n'" : "E'\\r'"});
  end loop; end $rw$;`;
export const CRLF = represent("crlf");
export const LONE_CR = represent("cr");
export const MIXED = represent("crlf", "and p.oid::bigint % 2 = 0"); // the production shape: some bodies CRLF, the rest LF
export function lit(s: string) { return `E'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\t/g, "\\t")}'`; }
/** Edits one function's definition text; raises if the text to change is not there (the drift must be real). */
export const edit = (fn: string, from: string, to: string, regex = false) => `do $ed$ declare d text := pg_get_functiondef('${fn}'::regprocedure); e text; begin
  e := ${regex ? `regexp_replace(d, ${lit(from)}, ${lit(to)}, 'i')` : `replace(d, ${lit(from)}, ${lit(to)})`};
  if e = d then raise exception 'drift text not found in ${fn}'; end if; execute e; end $ed$;`;
const CR_BODIES = `select '{"cr_bodies":' || count(*) || '}' from (${APP_FNS}) f(oid) join pg_proc p on p.oid = f.oid where p.prosrc ~ E'\\r';`;

export type GateResult = { verdict: string; failed: string[]; crBodies: number; checks: { id: string; ok: boolean; got: unknown }[] };
/** Runs a gate after `setup` inside a rolled-back transaction: verdict, failing check ids, and the CR-body count. */
export async function gate(script: string, setup = ""): Promise<GateResult> {
  const lines = (await psql(`begin;\n${setup}\n${CR_BODIES}\n${script}\nrollback;\n`)).split(/\r?\n/).filter((l) => l.startsWith("{"));
  const result = JSON.parse(lines.at(-1)!);
  return { verdict: result.verdict, failed: result.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id.split(" ")[0]), crBodies: JSON.parse(lines[0]).cr_bodies, checks: result.checks };
}
export const PASS = { verdict: "PASS", failed: [] };
export const stop = (...failed: string[]) => ({ verdict: "STOP", failed });

/** A workdir holding the migrations up to `last` exactly as committed, materialized with LF or CRLF line endings, plus
 *  this checkout's validated Supabase CLI pins. Reset it only through `resetLocal`, which checks the images first. */
export function stageCheckout(last: string, eol: "lf" | "crlf"): string {
  const dir = mkdtempSync(join(tmpdir(), `ops01b-${eol}-`));
  mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
  writeFileSync(join(dir, "supabase", "config.toml"), readFileSync("supabase/config.toml"));
  for (const file of git(["ls-tree", "--name-only", "HEAD", "supabase/migrations/"]).split("\n").filter(Boolean)) {
    if (file.split("/").pop()!.split("_")[0] > last) continue;
    const text = git(["show", `HEAD:${file}`]).replace(/\r\n/g, "\n");
    writeFileSync(join(dir, file), eol === "crlf" ? text.replace(/\n/g, "\r\n") : text);
  }
  stagePins(dir);
  return dir;
}
export const migrations = () => psql("select count(*) || ' ' || max(version) from supabase_migrations.schema_migrations");

/** The gate file's own CTE prefix (everything before its checks), so a test can query the gate's exact object sets. */
export function gatePrefix(script: string): string {
  const text = script.replace(/\r\n?/g, "\n");
  const start = text.search(/^with$/m);
  const end = text.indexOf("\nchecks(id, ok, got) as (");
  if (start < 0 || end < 0) throw new Error("gate CTE prefix not found");
  return text.slice(start, end + 1);
}
