import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CRLF, LONE_CR, MIXED, PASS, edit, gate, gatePrefix, git, migrations, represent, stageCheckout } from "./fingerprint-gates";
import { NEW_VERSIONS, V35, psql, resetLocal } from "./release-helpers";
import { escapedCr, lineEndingSensitive, literals } from "./sql-literals";

// OPS-01B P1C. (1) The post-36 P03 gate protects private.assert_maintenance_controller(), the pre-lock authorization of
// both control RPCs, exactly like the other P03 functions (signature, canonical body, SECURITY DEFINER, owner,
// proconfig) in BOTH the W2b and the restore variant; every drift of it STOPs and line endings alone do not.
// (2) The canonical rule (CRLF/lone CR -> LF) is only sound because no protected body has a literal whose runtime value
// depends on line endings: proven here for every body C05, C15 and P03 hash, using each gate's own object sets.

const V36 = NEW_VERSIONS[0];
const CTL = "private.assert_maintenance_controller()";
const MIGRATION_36 = "supabase/migrations/20261103140000_ops_01b_maintenance_guard.sql";
const PREFLIGHT = readFileSync("scripts/ops-01b-preflight.sql", "utf8");
const POST36 = readFileSync("scripts/ops-01b-post36-verify.sql", "utf8");
const RESTORE = readFileSync("scripts/ops-01b-post36-verify-restore.sql", "utf8");
const BEFORE_P1C = git(["show", "0503958dd52de8f131dd2e08f372665bb6b082c3:scripts/ops-01b-post36-verify.sql"]);
// Functions migration 36 creates by name that P03 deliberately does not hash: immutable, SECURITY INVOKER, no API grant
// (P05), reached only from the hashed control RPCs. Any OTHER function migration 36 adds must be in P03.
const NOT_IN_P03 = ["private.maintenance_reason(jsonb)", "private.maintenance_state(private.system_maintenance)"];
// P1D: the pre-36 authorization chain both control RPCs call, hashed by P03 too (and by preflight C23 at DB35).
const PRE36_IN_P03 = ["private.assert_account_admin()", "private.is_owner()"];
const P03_MD5 = "178bf849bb844cf50ff82a29fc2bf4b8"; // P1D, 12 functions; P1C (10): a90805db457c021474c8a0ad5e934dd3

const inventory = (script: string) => {
  const list = /guard_fns\(sig\) as \(values ([\s\S]*?)\nfns as/.exec(script.replace(/\r\n?/g, "\n"))?.[1];
  if (!list) throw new Error("P03 inventory not found");
  return [...list.replace(/--[^\n]*/g, "").matchAll(/\('([^']+)'\)/g)].map((m) => m[1]);
};
const expectedMd5 = (script: string) => [...script.matchAll(/ = '([0-9a-f]{32})' from fns\)/g)].map((m) => m[1]);
const p03 = (r: { checks: { id: string; got: unknown }[] }) => r.checks.find((c) => c.id.startsWith("P03"))!.got as { md5: string; missing: string[] };
/** The canonical bodies of a gate's own object set, read through the gate file's CTEs. */
async function bodies(script: string, select: string) {
  return JSON.parse(await psql(`${gatePrefix(script)}zz_p1c as (select 1)\nselect coalesce(json_agg(json_build_object('sig', sig, 'src', src) order by sig), '[]') from (${select}) x(sig, src);`)) as { sig: string; src: string }[];
}
/** Literal inspection: none may span a line break (its value would follow the file's line endings). */
function inspect(rows: { sig: string; src: string }[]) {
  const report = { functions: rows.length, literals: 0, line_break_literals: [] as string[], escaped_cr: [] as string[], chr13: [] as string[] };
  for (const { sig, src } of rows) {
    report.literals += literals(src).length;
    for (const l of lineEndingSensitive(src)) report.line_break_literals.push(`${sig}: ${l.text.slice(0, 80)}`);
    for (const l of escapedCr(src)) report.escaped_cr.push(`${sig}: ${l.text.slice(0, 80)}`);
    if (/chr\s*\(\s*13\s*\)/i.test(src)) report.chr13.push(sig);
  }
  console.log(`[P1C literal inspection] ${JSON.stringify(report)}`);
  return report;
}

describe("OPS-01B P1C: P03 protects the maintenance controller; canonical bodies carry no line-ending-sensitive literal", () => {
  it("the literal lexer finds what it must (bounded self-check)", () => {
    const src = "begin\n  -- it's a comment 'x\n  /* nested /* 'y\n */ */ raise exception 'a''b';\n  x := E'p\\'q\\r';\n  y := $f$one\ntwo$f$ || $1;\n  z := 'multi\r\nline';\nend";
    expect(literals(src).map((l) => l.kind)).toEqual(["quoted", "escape", "dollar", "quoted"]);
    expect(lineEndingSensitive(src).map((l) => l.text)).toEqual(["$f$one\ntwo$f$", "'multi\r\nline'"]);
    expect(escapedCr(src).map((l) => l.text)).toEqual(["'p\\'q\\r'"]);
  });

  it("both post-36 variants protect the identical inventory, including the controller, with one expected fingerprint", () => {
    const normal = inventory(POST36);
    expect(inventory(RESTORE)).toEqual(normal);
    expect(normal).toContain(CTL);
    expect(inventory(BEFORE_P1C), "the omission this closes").not.toContain(CTL);
    expect(expectedMd5(POST36)).toEqual([P03_MD5]);
    expect(expectedMd5(RESTORE)).toEqual(expectedMd5(POST36));
    // Every function migration 36 creates by name is hashed by P03 unless it is a reviewed exclusion.
    const created = [...readFileSync(MIGRATION_36, "utf8").matchAll(/^create function ([a-z_]+\.[a-z_]+)\(([^)]*)\)/gm)]
      .map((m) => `${m[1]}(${m[2].split(",").map((a) => a.trim().split(/\s+/).slice(1).join(" ")).filter(Boolean).join(",")})`)
    expect(created.filter((s) => !NOT_IN_P03.includes(s)).sort()).toEqual(normal.filter((s) => !PRE36_IN_P03.includes(s)).sort());
    expect(normal.filter((s) => PRE36_IN_P03.includes(s)).sort(), "the pre-36 authorization chain").toEqual(PRE36_IN_P03);
    console.log(`[P1C P03 inventory] ${JSON.stringify(normal)}`);
  });

  it("C05/C15 (DB35) and P03 (DB36) bodies: no line-ending-sensitive literal; every controller drift STOPs P03", async () => {
    try {
      // ---- DB35: the bodies preflight C05 (api_fns) and C15 (app_triggers' functions) hash -------------------------
      await resetLocal(["--version", V35]);
      expect(await migrations()).toBe(`35 ${V35}`);
      const c05 = await bodies(PREFLIGHT, "select 'C05 ' || sig, prosrc from api_fns");
      const c15 = await bodies(PREFLIGHT, "select distinct 'C15 ' || a.fn, regexp_replace(p.prosrc, E'\\r\\n?', E'\\n', 'g') from app_triggers a join pg_proc p on p.oid = to_regprocedure(a.fn)");
      expect(c05).toHaveLength(32);
      expect(c15.map((b) => b.sig.slice(4)).sort()).toEqual(["private.enforce_active_shop()", "private.enforce_open_business_date()", "private.enforce_open_expense_correction()", "reject_append_only_mutation()"]);
      const c23 = await bodies(PREFLIGHT, "select 'C23 ' || sig, prosrc from auth_deps"); // P1D: the authorization chain
      expect(c23.map((b) => b.sig.slice(4))).toEqual(PRE36_IN_P03);
      const pre = inspect([...c05, ...c15, ...c23]);
      expect(pre.line_break_literals).toEqual([]);
      expect(pre.escaped_cr).toEqual([]);
      expect(pre.chr13).toEqual([]);

      // ---- DB36 built from the committed migrations materialized with LF (the reviewed bytes) ----------------------
      await resetLocal(["--no-seed"], { workdir: stageCheckout(V36, "lf") });
      expect(await migrations()).toBe(`36 ${V36}`);
      const p03Bodies = await bodies(POST36, "select sig, prosrc from fns");
      expect(p03Bodies.map((b) => b.sig)).toContain(CTL);
      expect(p03Bodies).toHaveLength(inventory(POST36).length);
      const post = inspect(p03Bodies);
      expect(post.line_break_literals).toEqual([]);
      expect(post.escaped_cr).toEqual([]);
      expect(post.chr13).toEqual([]);

      const ctlCrlf = represent("crlf", `and p.oid = '${CTL}'::regprocedure`);
      const ctlHasCr = `do $c$ begin if (select prosrc !~ E'\\r' from pg_proc where oid = '${CTL}'::regprocedure) then raise exception 'controller has no CR'; end if; end $c$;`;
      const copy = `do $cp$ begin execute replace(replace(pg_get_functiondef('${CTL}'::regprocedure), 'private.assert_maintenance_controller()', 'private.zz_p1c_ctl()'), 'if not private.is_owner()', 'if false'); end $cp$; revoke all on function private.zz_p1c_ctl() from public;`;
      const drifts: [string, string][] = [
        ["A1 owner check weakened (if false and ...)", edit(CTL, "if not private.is_owner()", "if false and not private.is_owner()")],
        ["A2 owner check removed", edit(CTL, String.raw`\n\s*if not private\.is_owner\(\)[^\n]*`, "", true)],
        ["A3 owner check weakened under CRLF", CRLF + edit(CTL, "if not private.is_owner()", "if false and not private.is_owner()")],
        ["B side-effecting statement added", edit(CTL, String.raw`\mbegin\M`, "begin update private.system_maintenance set updated_at = now() where id;", true)],
        ["C SECURITY DEFINER -> INVOKER", `alter function ${CTL} security invoker;`],
        ["D owner changed", `create role zz_p1c_owner; grant zz_p1c_owner to postgres; grant create on schema private to zz_p1c_owner; alter function ${CTL} owner to zz_p1c_owner;`],
        ["E1 search_path changed", `alter function ${CTL} set search_path = public;`],
        ["E2 search_path removed", `alter function ${CTL} reset search_path;`],
        ["E3 extra proconfig setting", `alter function ${CTL} set statement_timeout = '1s';`],
        ["F1 behavior replaced, name/signature/flags/owner kept", `create or replace function ${CTL} returns void language plpgsql security definer set search_path = '' as $$\nbegin\n  perform 1;\nend $$;`],
        ["F2 behavior redirected to a weakened copy", `${copy}\ncreate or replace function ${CTL} returns void language plpgsql security definer set search_path = '' as $$\nbegin\n  perform private.zz_p1c_ctl();\nend $$;`],
        ["G1 one extra space", edit(CTL, String.raw`\mbegin\M`, "begin ", true)],
        ["G2 a tab instead of a space", edit(CTL, "raise exception 'INSUFFICIENT_ROLE'", "raise\texception 'INSUFFICIENT_ROLE'")],
        ["G3 one extra space under CRLF", CRLF + edit(CTL, String.raw`\mbegin\M`, "begin ", true)],
      ];
      for (const [label, script] of [["W2b", POST36], ["restore", RESTORE]] as const) {
        const clean = await gate(script);
        expect(clean, `${label} clean`).toMatchObject(PASS);
        expect(clean.crBodies, `${label}: LF reference`).toBe(0);
        expect(p03(clean)).toEqual({ md5: P03_MD5, missing: [] });
        // H: representation only.
        for (const [name, rep] of [["CRLF", CRLF], ["lone CR", LONE_CR], ["mixed", MIXED], ["controller-only CRLF", ctlCrlf + ctlHasCr],
          ["controller-only lone CR", represent("cr", `and p.oid = '${CTL}'::regprocedure`) + ctlHasCr]] as const) {
          const r = await gate(script, rep);
          console.log(`[P1C ${label}] H ${name}: ${r.verdict} ${JSON.stringify(r.failed)} cr_bodies=${r.crBodies} p03=${p03(r).md5}`);
          expect(r.crBodies, `${label} ${name}: CR present`).toBeGreaterThan(0);
          expect(r, `${label} ${name}`).toMatchObject(PASS);
        }
        // A-G: every drift of the controller STOPs P03; the database is restored (rolled back) and PASSes again.
        for (const [name, sql] of drifts) {
          const r = await gate(script, sql);
          console.log(`[P1C ${label}] ${name}: ${r.verdict} ${JSON.stringify(r.failed)} p03=${p03(r).md5}`);
          expect(r.verdict, `${label} ${name}`).toBe("STOP");
          expect(r.failed, `${label} ${name}`).toContain("P03");
          expect(p03(r).md5, `${label} ${name}: fingerprint moved`).not.toBe(P03_MD5);
          expect(await gate(script), `${label} after ${name}: restored`).toMatchObject(PASS);
        }
      }
      // The gate as it was at 0503958 accepted a weakened controller: the MAJOR this closes.
      expect(await gate(BEFORE_P1C, drifts[0][1]), "pre-P1C P03 is blind to the controller").toMatchObject(PASS);
      // F2's copy must not survive the rolled-back transaction.
      expect(await psql("select to_regprocedure('private.zz_p1c_ctl()') is null and to_regrole('zz_p1c_owner') is null")).toBe("t");
    } finally {
      await resetLocal();
    }
  }, 1_200_000);
});
