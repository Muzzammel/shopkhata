import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEW_VERSIONS, OWNER_ID, STAFF1_ID, lastJson, psql, resetLocal, session, sleep } from "./release-helpers";

// OPS-01B executable release gates, on a database at exactly migration 36 (the W2b/W3 moment):
//   (1) the post-36 gate enforces the EXPECTED STATE (P00 mode, P08 singleton/OFF/no bypass, P10 no restore context),
//       with a separate restore mode that is the W2b file with only the mode literal changed;
//   (2) the W3 decision through the real operator procedure (supabase db query + scripts/ops-01b-w3-state.mjs):
//       a definite refusal + authoritative OFF reads may reopen (case 1); an enable whose client is gone never does.

const V36 = NEW_VERSIONS[0];
const W2B = readFileSync("scripts/ops-01b-post36-verify.sql", "utf8");
const RESTORE = readFileSync("scripts/ops-01b-post36-verify-restore.sql", "utf8");
const REF = "gate-test-ref";
const dir = mkdtempSync(join(tmpdir(), "ops01b-gates-"));
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

/** Runs a command, never throws: {code, out}. */
function run(file: string, args: string[], timeout = 120_000): Promise<{ code: number; out: string }> {
  const win = process.platform === "win32" && file === PNPM;
  return new Promise((resolve) => {
    execFile(win ? (process.env.ComSpec ?? "cmd.exe") : file, win ? ["/d", "/s", "/c", "call", PNPM, ...args] : args,
      { timeout, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: `${join(process.cwd(), "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}` } },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out: `${stdout}${stderr}` }));
  });
}
const dbQuery = (file: string) => run(PNPM, ["exec", "supabase", "--agent", "no", "db", "query", "--local", "-f", file, "--output-format", "json"]);
const jsonOf = (out: string) => out.slice(out.indexOf("["), out.lastIndexOf("]") + 1); // stdout only, as the runbook redirects it
const control = (sub: string, enabled: boolean) =>
  `select public.set_maintenance(jsonb_build_object('enabled', ${enabled}, 'reason', 'Gate test window', 'release_ref', '${REF}')) from (select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '${sub}')::text, true)) s`;

async function gate(sql: string, setup = ""): Promise<{ verdict: string; failed: string[] }> {
  const result = lastJson(await psql(`begin;\n${setup}\n${sql}\nrollback;\n`));
  return { verdict: result.verdict, failed: result.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id.split(" ")[0]) };
}
const ON = "update private.system_maintenance set enabled = true, enabled_at = now(), enabled_by = '10000000-0000-4000-8000-000000000101', reason = 'x', release_ref = 'r';";
const BYPASS = `${ON} update private.system_maintenance set bypass_user_id = '${OWNER_ID}', bypass_expires_at = now() + interval '10 minutes', bypass_enabled_by = '${OWNER_ID}', bypass_reason = 'smoke';`;
const CONTEXT = "insert into private.receipt_restore_objects values ('expense-receipts', 'x', 'r', now() + interval '1 hour', now());";

async function classify(enable: { code: number | null; out: string | null }, reads: string[], transition = "enable") {
  const files = reads.map((text, i) => { const p = join(dir, `read-${Date.now()}-${i}.json`); writeFileSync(p, text); return p; });
  const args = ["scripts/ops-01b-w3-state.mjs", "--release-ref", REF, "--transition", transition, ...files.flatMap((p) => ["--read", p])];
  if (enable.code !== null) args.push("--enable-exit", String(enable.code));
  if (enable.out !== null) { const p = join(dir, `enable-${Date.now()}.json`); writeFileSync(p, enable.out); args.push("--enable-output", p); }
  const result = await run(process.execPath, args);
  return { exit: result.code, decision: JSON.parse(result.out.trim().split(/\r?\n/).pop()!) };
}
async function twoStateReads() {
  const first = await dbQuery("scripts/ops-01b-w3-state.sql");
  await sleep(10_500);
  const second = await dbQuery("scripts/ops-01b-w3-state.sql");
  expect(first.code, first.out).toBe(0); expect(second.code, second.out).toBe(0);
  return [jsonOf(first.out), jsonOf(second.out)];
}

describe("OPS-01B release gates at migration 36 (post-36 expected state, W3 decision)", () => {
  it("enforces the expected state and the W3 invariant", async () => {
    await resetLocal(["--version", V36]);
    try {
      // ---- (1) post-36 expected state --------------------------------------------------------------------------------
      expect(RESTORE, "the restore file is the W2b file with only the mode literal (and a header line) changed").toBe(
        "-- RESTORE MODE of scripts/ops-01b-post36-verify.sql (runbook §10 restore step 7; derived: only the mode literal differs).\n"
        + W2B.replace("mode(expected) as (values ('w2b')),", "mode(expected) as (values ('restore')),"));
      expect(await gate(W2B)).toEqual({ verdict: "PASS", failed: [] });
      expect(await gate(W2B, ON), "maintenance enabled during normal W2b").toEqual({ verdict: "STOP", failed: ["P08"] });
      expect(await gate(W2B, BYPASS), "bypass present during normal W2b").toEqual({ verdict: "STOP", failed: ["P08"] });
      expect(await gate(W2B, CONTEXT), "restore context present during normal W2b").toEqual({ verdict: "STOP", failed: ["P10"] });
      expect(await gate(W2B, "delete from private.system_maintenance;"), "missing singleton").toEqual({ verdict: "STOP", failed: ["P08"] });
      expect(await gate(W2B.replace("values ('w2b')", "values ('W2B ')")), "unknown mode").toEqual({ verdict: "STOP", failed: ["P00", "P08"] });
      expect(await gate(W2B.replace("values ('w2b')", "values (null::text)")), "absent mode (null)").toEqual({ verdict: "STOP", failed: ["P00", "P08"] });
      expect(await gate(W2B.replace("values ('w2b')", "select 'w2b' where false")), "absent mode (no row)").toEqual({ verdict: "STOP", failed: ["P00", "P08"] });
      // Restore mode: a locked restored database is expected; a bypass or an open context is not.
      expect(await gate(RESTORE)).toEqual({ verdict: "PASS", failed: [] });
      expect(await gate(RESTORE, ON), "restore mode accepts a locked database").toEqual({ verdict: "PASS", failed: [] });
      expect(await gate(RESTORE, BYPASS)).toEqual({ verdict: "STOP", failed: ["P08"] });
      expect(await gate(RESTORE, CONTEXT)).toEqual({ verdict: "STOP", failed: ["P10"] });
      expect(await gate(RESTORE, "delete from private.system_maintenance;")).toEqual({ verdict: "STOP", failed: ["P08"] });

      // ---- (2) W3 through the operator procedure ----------------------------------------------------------------------
      // Case 1: the enable is DEFINITELY refused by the database (a non-owner actor), two authoritative reads show OFF.
      const refusedFile = join(dir, "w3-refused.sql"); writeFileSync(refusedFile, control(STAFF1_ID, true));
      const refused = await dbQuery(refusedFile);
      expect(refused.code).not.toBe(0);
      expect(refused.out).toContain("INSUFFICIENT_ROLE");
      const offReads = await twoStateReads();
      expect(await classify(refused, offReads)).toMatchObject({ exit: 0, decision: { case: 1, firewall: "MAY_REMOVE" } });
      // The same OFF reads with an uncertain enable (client crashed: no output, no exit code) never reopen.
      expect(await classify({ code: null, out: null }, offReads)).toMatchObject({ exit: 3, decision: { case: 3, firewall: "KEEP_ON" } });

      // Case 3: why UNKNOWN is not OFF. An enable is stuck behind a lock and its client is gone; the state still reads OFF.
      const holder = session();
      holder.send("begin;\nselect 'held' from private.system_maintenance where id for update;");
      await holder.until("held");
      const enabler = session();
      enabler.send(`${control(OWNER_ID, true)};\nselect 'enable-returned';`);
      for (let i = 0; i < 100 && (await psql("select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%set_maintenance%'")) !== "1"; i++) await sleep(100);
      const stuckReads = await twoStateReads();
      expect(JSON.parse(stuckReads[1])[0]).toMatchObject({ pending_controls: 1, maintenance: [{ enabled: false }] });
      const stuck = await classify({ code: null, out: null }, stuckReads);
      expect(stuck).toMatchObject({ exit: 3, decision: { case: 3, firewall: "KEEP_ON" } });
      // ... and the "OFF" was not real: once the lock goes, the abandoned enable commits and maintenance is ON.
      holder.send("commit;"); await holder.end();
      await enabler.until("enable-returned"); await enabler.end();
      const onReads = await twoStateReads();
      expect(JSON.parse(onReads[1])[0].maintenance[0].enabled).toBe(true);
      expect(await classify({ code: null, out: null }, onReads)).toMatchObject({ exit: 3, decision: { case: 2, firewall: "KEEP_ON" } });

      // Deliberate disable (bootstrap abort with maintenance ON): reopen only on a definite success + authoritative OFF.
      const disableFile = join(dir, "disable.sql"); writeFileSync(disableFile, control(OWNER_ID, false));
      const disabled = await dbQuery(disableFile);
      expect(disabled.code, disabled.out).toBe(0);
      const afterReads = await twoStateReads();
      expect(await classify(disabled, afterReads, "disable")).toMatchObject({ exit: 0, decision: { case: 1, firewall: "MAY_REMOVE" } });
      expect(await classify({ code: 1, out: "context deadline exceeded" }, afterReads, "disable")).toMatchObject({ exit: 3, decision: { firewall: "KEEP_ON" } });
    } finally {
      await resetLocal();
    }
  }, 900_000);
});
