import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CRLF, LONE_CR, MIXED, PASS, edit, gate, gatePrefix, git, migrations, represent, stageCheckout } from "./fingerprint-gates";
import { NEW_VERSIONS, OWNER_ID, STAFF1_ID, V35, psql, supabase } from "./release-helpers";

// OPS-01B P1D. The maintenance authorization chain is
//   pre-lock:  public.set_maintenance* -> private.assert_maintenance_controller() -> private.is_owner()
//   lock:      private.maintenance_lock_exclusive()                                   (L1)
//   post-lock: private.assert_account_admin() [advisory lock 'account-administration' = L2] -> private.is_owner()
// is_owner() and assert_account_admin() exist BEFORE migration 36, so they are protected twice:
//   DB35 preflight C23: their reviewed definitions (plus the public.profiles columns is_owner() reads) before the window;
//   post-36 P03: the complete chain (12 functions) right after 36, in the W2b and the restore variant.
// Every drift below runs inside a rolled-back transaction against the REAL gate files.

const V36 = NEW_VERSIONS[0];
const OWN = "private.is_owner()";
const ADM = "private.assert_account_admin()";
const PREFLIGHT = readFileSync("scripts/ops-01b-preflight.sql", "utf8");
const POST36 = readFileSync("scripts/ops-01b-post36-verify.sql", "utf8");
const RESTORE = readFileSync("scripts/ops-01b-post36-verify-restore.sql", "utf8");
const P1C = "c428414c15f7c47b85502af54f1c195714de1bd0"; // the gates before P1D
const OLD_PREFLIGHT = git(["show", `${P1C}:scripts/ops-01b-preflight.sql`]);
const OLD_POST36 = git(["show", `${P1C}:scripts/ops-01b-post36-verify.sql`]);
// Derived from a fresh DB35 (`db reset --version 20261031165915`) and a fresh LF-built DB36; not guessed.
const C23_FNS = "6676d9f5a8180efcb74c813ecab78c54";
const C23_PROFILES = "964a6b4f6c9be934f7f53be7a2f95eb2";
const P03_MD5 = "178bf849bb844cf50ff82a29fc2bf4b8";
const P03_INVENTORY = ["private.storage_receipt_maintenance_guard()", "private.maintenance_admit(uuid)", "private.maintenance_allows(private.system_maintenance,uuid)",
  "private.assert_not_in_maintenance()", "private.maintenance_lock_exclusive()", "private.receipt_restore_open(text,text[],integer)", "private.receipt_restore_close(text)",
  "private.assert_maintenance_controller()", "public.set_maintenance(jsonb)", "public.set_maintenance_bypass(jsonb)", OWN, ADM];

const inventory = (script: string) => {
  const list = /guard_fns\(sig\) as \(values ([\s\S]*?)\nfns as/.exec(script.replace(/\r\n?/g, "\n"))?.[1];
  if (!list) throw new Error("P03 inventory not found");
  return [...list.replace(/--[^\n]*/g, "").matchAll(/\('([^']+)'\)/g)].map((m) => m[1]);
};
const got = (r: { checks: { id: string; got: unknown }[] }, id: string) => r.checks.find((c) => c.id.startsWith(id))!.got as { md5: string; missing: string[]; profiles?: unknown };

// Behavioural proof that a drift really changes authorization (DB35 has the seed: staff1 is an active staff member).
const claims = (sub: string) => `perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '${sub}')::text, true);`;
const STAFF_IS_OWNER = `do $p$ begin ${claims(STAFF1_ID)} if not private.is_owner() then raise exception 'drift ineffective: staff is not an owner'; end if; perform set_config('request.jwt.claims', '', true); end $p$;`;
const STAFF_PASSES_ADMIN = `do $p$ begin ${claims(STAFF1_ID)} perform private.assert_account_admin(); perform set_config('request.jwt.claims', '', true); end $p$;`;
const OWNER_ROLE = (fn: string) => `create role zz_p1d_owner; grant zz_p1d_owner to postgres; grant create on schema private to zz_p1d_owner; alter function ${fn} owner to zz_p1d_owner;`;
const onlyAuth = `and p.oid in ('${OWN}'::regprocedure, '${ADM}'::regprocedure)`;
const authHasCr = `do $c$ begin if exists (select 1 from pg_proc where oid in ('${OWN}'::regprocedure, '${ADM}'::regprocedure) and prosrc !~ E'\\r') then raise exception 'an authorization helper has no CR'; end if; end $c$;`;

/** [label, drift SQL, behavioural proof (DB35 only, seeded)] */
const DRIFTS: [string, string, string?][] = [
  // private.is_owner()
  ["A is_owner always returns true", `create or replace function ${OWN} returns boolean language sql stable security definer set search_path = '' as $$ select true $$;`, STAFF_IS_OWNER],
  ["B1 is_owner allows an authenticated non-owner (any active role)", edit(OWN, "public.profiles.role = 'owner'", "public.profiles.role in ('owner', 'manager', 'staff')"), STAFF_IS_OWNER],
  ["B2 is_owner allows an inactive owner", edit(OWN, String.raw`\s+and public\.profiles\.is_active = true`, "", true)],
  ["C is_owner body replaced (equivalent text), signature kept", `create or replace function ${OWN} returns boolean language sql stable security definer set search_path = '' as $$ select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner' and p.is_active) $$;`],
  ["D is_owner SECURITY DEFINER -> INVOKER", `alter function ${OWN} security invoker;`],
  ["E is_owner owner changed", OWNER_ROLE(OWN)],
  ["F1 is_owner search_path changed", `alter function ${OWN} set search_path = public;`],
  ["F2 is_owner search_path removed", `alter function ${OWN} reset search_path;`],
  ["F3 is_owner extra proconfig setting", `alter function ${OWN} set statement_timeout = '1s';`],
  ["G1 is_owner one extra space", edit(OWN, "select exists", "select  exists")],
  ["G2 is_owner a tab instead of a space", edit(OWN, "select 1", "select\t1")],
  ["G3 is_owner one extra space under CRLF", CRLF + edit(OWN, "select exists", "select  exists")],
  // private.assert_account_admin()
  ["H assert_account_admin owner check removed", edit(ADM, String.raw`\n\s*if not private\.is_owner\(\)[^\n]*`, "", true), STAFF_PASSES_ADMIN],
  ["I1 assert_account_admin is_owner bypassed (if false and ...)", edit(ADM, "if not private.is_owner()", "if false and not private.is_owner()"), STAFF_PASSES_ADMIN],
  ["I2 assert_account_admin is_owner weakened to is_active_actor", edit(ADM, "if not private.is_owner()", "if not private.is_active_actor()"), STAFF_PASSES_ADMIN],
  ["I3 assert_account_admin is_owner bypassed under CRLF", CRLF + edit(ADM, "if not private.is_owner()", "if false and not private.is_owner()")],
  ["J1 assert_account_admin account-administration lock removed", edit(ADM, String.raw`\n\s*perform pg_advisory_xact_lock\([^\n]*`, "", true)],
  ["J2 assert_account_admin lock key changed", edit(ADM, "'account-administration'", "'account-admin'")],
  ["J3 assert_account_admin lock made non-blocking (try lock)", edit(ADM, "pg_advisory_xact_lock(", "pg_try_advisory_xact_lock(")],
  ["K assert_account_admin body replaced, signature kept", `create or replace function ${ADM} returns uuid language plpgsql security definer set search_path = '' as $$\nbegin\n  return auth.uid();\nend $$;`, STAFF_PASSES_ADMIN],
  ["L assert_account_admin SECURITY DEFINER -> INVOKER", `alter function ${ADM} security invoker;`],
  ["M assert_account_admin owner changed", OWNER_ROLE(ADM)],
  ["N1 assert_account_admin search_path changed", `alter function ${ADM} set search_path = public;`],
  ["N2 assert_account_admin search_path removed", `alter function ${ADM} reset search_path;`],
  ["N3 assert_account_admin extra proconfig setting", `alter function ${ADM} set statement_timeout = '1s';`],
  ["O1 assert_account_admin one extra space", edit(ADM, String.raw`\mbegin\M`, "begin ", true)],
  ["O2 assert_account_admin a tab instead of a space", edit(ADM, "raise exception 'INSUFFICIENT_ROLE'", "raise\texception 'INSUFFICIENT_ROLE'")],
  ["O3 assert_account_admin one extra space under CRLF", CRLF + edit(ADM, String.raw`\mbegin\M`, "begin ", true)],
];
// Structure of the state is_owner() reads (C23 only; the post-36 gate does not re-check table structure).
const PROFILE_DRIFTS: [string, string][] = [
  ["S1 profiles.role defaults to 'owner'", "alter table public.profiles alter column role set default 'owner';"],
  ["S2 profiles.is_active nullable", "alter table public.profiles alter column is_active drop not null;"],
  ["S3 profiles.is_active default changed", "alter table public.profiles alter column is_active set default false;"],
];
const REPRESENTATIONS: [string, string][] = [
  ["CRLF (all bodies)", CRLF], ["lone CR (all bodies)", LONE_CR], ["mixed", MIXED],
  ["authorization helpers only CRLF", represent("crlf", onlyAuth) + authHasCr], ["authorization helpers only lone CR", represent("cr", onlyAuth) + authHasCr],
];

describe("OPS-01B P1D: the maintenance authorization chain is fingerprinted at DB35 (C23) and after migration 36 (P03)", () => {
  it("static inventory: C23 expected values, 12-function P03 identical in both variants", () => {
    expect(PREFLIGHT).toContain(`= '${C23_FNS}' from auth_deps`);
    expect(PREFLIGHT).toContain(`md5 = '${C23_PROFILES}'`);
    expect(PREFLIGHT).toContain("from (values ('private.assert_account_admin()'), ('private.is_owner()')) d(sig)");
    expect(PREFLIGHT).toContain("regexp_replace(p.prosrc, E'\\r\\n?', E'\\n', 'g') as prosrc   -- canonical body (C23)");
    expect(inventory(POST36)).toEqual(P03_INVENTORY);
    expect(inventory(RESTORE)).toEqual(inventory(POST36));
    expect(inventory(OLD_POST36), "P1C's 10 functions").toEqual(P03_INVENTORY.slice(0, 10));
    for (const s of [POST36, RESTORE]) expect([...s.matchAll(/ = '([0-9a-f]{32})' from fns\)/g)].map((m) => m[1])).toEqual([P03_MD5]);
    console.log(`[P1D inventory] C23 ${JSON.stringify([ADM, OWN])} + public.profiles(id, is_active, role); P03 ${P03_INVENTORY.length} ${JSON.stringify(P03_INVENTORY)}`);
  });

  it("DB35 C23 and post-36 P03 STOP on every authorization-chain drift; line endings alone PASS", async () => {
    try {
      // ================= DB35: the mandatory preflight =================
      await supabase(["db", "reset", "--local", "--version", V35], undefined, 240_000);
      expect(await migrations()).toBe(`35 ${V35}`);
      const clean = await gate(PREFLIGHT);
      expect(clean).toMatchObject(PASS);
      expect(clean.checks).toHaveLength(26);
      expect(got(clean, "C23")).toEqual({ md5: C23_FNS, missing: [], profiles: [{ relkind: "r", columns: 3, md5: C23_PROFILES }] });
      console.log(`[P1D DB35] clean preflight ${clean.verdict} ${clean.checks.filter((c) => c.ok).length}/${clean.checks.length}`);
      // The reviewed behaviour the drifts change: staff is not an owner and cannot pass assert_account_admin; the owner can.
      expect(await psql(`begin; select set_config('request.jwt.claims', json_build_object('role','authenticated','sub','${STAFF1_ID}')::text, true) is not null, private.is_owner(); rollback;`)).toContain("t|f");
      expect(await psql(`begin; select set_config('request.jwt.claims', json_build_object('role','authenticated','sub','${OWNER_ID}')::text, true) is not null, private.is_owner(), private.assert_account_admin() = '${OWNER_ID}'; rollback;`)).toContain("t|t|t");
      await expect(psql(`begin; select set_config('request.jwt.claims', json_build_object('role','authenticated','sub','${STAFF1_ID}')::text, true); select private.assert_account_admin(); rollback;`)).rejects.toThrow(/INSUFFICIENT_ROLE/);

      for (const [name, rep] of REPRESENTATIONS) {
        const r = await gate(PREFLIGHT, rep);
        console.log(`[P1D DB35] ${name}: ${r.verdict} ${JSON.stringify(r.failed)} cr_bodies=${r.crBodies} c23=${got(r, "C23").md5}`);
        expect(r.crBodies, `${name}: CR present`).toBeGreaterThan(0);
        expect(r, name).toMatchObject(PASS);
      }
      for (const [name, sql, proof] of [...DRIFTS, ...PROFILE_DRIFTS]) {
        const r = await gate(PREFLIGHT, sql + (proof ?? ""));
        console.log(`[P1D DB35] ${name}: ${r.verdict} ${JSON.stringify(r.failed)} c23=${JSON.stringify(got(r, "C23"))}${proof ? " (behaviour change proven)" : ""}`);
        expect(r.verdict, name).toBe("STOP");
        expect(r.failed, name).toEqual(["C23"]);
        expect(await gate(PREFLIGHT), `after ${name}: restored`).toMatchObject(PASS);
      }
      // The P1C preflight was blind to the authorization chain: the MAJOR this closes.
      for (const i of [0, 12]) expect(await gate(OLD_PREFLIGHT, DRIFTS[i][1]), `P1C preflight blind to ${DRIFTS[i][0]}`).toMatchObject(PASS);

      // ================= DB36 (LF-built from the committed migrations): the post-36 gate =================
      await supabase(["--workdir", stageCheckout(V36, "lf"), "db", "reset", "--local", "--no-seed"], undefined, 240_000);
      expect(await migrations()).toBe(`36 ${V36}`);
      // Migration 36 does not alter the pre-existing dependencies: C23's own object sets give the DB35 values.
      const at36 = JSON.parse(await psql(`${gatePrefix(PREFLIGHT)}zz_p1d as (select 1)\nselect json_build_object('md5', (select md5(string_agg(sig || '|' || prosecdef::text || '|' || coalesce(proconfig::text, '') || '|' || pg_get_userbyid(proowner) || '|' || prosrc, E'\\n' order by sig)) from auth_deps), 'profiles', (select md5 from auth_profiles));`));
      expect(at36, "DB36 authorization dependencies = DB35").toEqual({ md5: C23_FNS, profiles: C23_PROFILES });
      for (const [label, script] of [["W2b", POST36], ["restore", RESTORE]] as const) {
        const ok = await gate(script);
        expect(ok, `${label} clean`).toMatchObject(PASS);
        expect(ok.crBodies, `${label}: LF reference`).toBe(0);
        expect(got(ok, "P03")).toEqual({ md5: P03_MD5, missing: [] });
        console.log(`[P1D DB36 ${label}] clean ${ok.verdict} ${ok.checks.filter((c) => c.ok).length}/${ok.checks.length} p03=${got(ok, "P03").md5}`);
        for (const [name, rep] of REPRESENTATIONS) {
          const r = await gate(script, rep);
          console.log(`[P1D DB36 ${label}] ${name}: ${r.verdict} ${JSON.stringify(r.failed)} cr_bodies=${r.crBodies} p03=${got(r, "P03").md5}`);
          expect(r.crBodies, `${label} ${name}: CR present`).toBeGreaterThan(0);
          expect(r, `${label} ${name}`).toMatchObject(PASS);
        }
        for (const [name, sql] of DRIFTS) {
          const r = await gate(script, sql);
          console.log(`[P1D DB36 ${label}] ${name}: ${r.verdict} ${JSON.stringify(r.failed)} p03=${got(r, "P03").md5}`);
          expect(r.verdict, `${label} ${name}`).toBe("STOP");
          expect(r.failed, `${label} ${name}`).toEqual(["P03"]);
          expect(got(r, "P03").md5, `${label} ${name}: fingerprint moved`).not.toBe(P03_MD5);
          expect(await gate(script), `${label} after ${name}: restored`).toMatchObject(PASS);
        }
      }
      // The P1C post-36 gate was blind to the same drifts.
      for (const i of [0, 12]) expect(await gate(OLD_POST36, DRIFTS[i][1]), `P1C P03 blind to ${DRIFTS[i][0]}`).toMatchObject(PASS);
      expect(await psql("select to_regrole('zz_p1d_owner') is null")).toBe("t");
    } finally {
      await supabase(["db", "reset", "--local"], undefined, 240_000);
    }
  }, 1_800_000);
});
