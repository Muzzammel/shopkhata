import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_FNS, CRLF, LONE_CR, MIXED, PASS, edit, gate, git, migrations, stageCheckout, stop } from "./fingerprint-gates";
import { DB_URL, NEW_VERSIONS, V35, psql, resetLocal, runbookV3, supabase } from "./release-helpers";

// OPS-01B P1B: the function-body fingerprints of the release gates (preflight C05/C15, post-36 P03) hash a CANONICAL body,
// regexp_replace(prosrc, E'\r\n?', E'\n', 'g'): CRLF -> LF, lone CR -> LF, nothing else. Production stores bodies with
// whatever line endings the migration file had when Git materialized it (P1A, 2026-11-05: 20/32 API bodies CRLF), so the
// raw hash false-failed. Proven here: (1) LF, CRLF, lone-CR and mixed bodies give the reviewed fingerprints and the old raw
// gates STOP on them; (2) a statement, an authorization predicate, a trigger's timing/event/orientation/WHEN/function, and
// ordinary spaces and tabs still STOP; (3) databases built from migration FILES checked out as CRLF pass the gates at 35,
// 36 and 39, and a real drift at 39 still fails V3.

const V36 = NEW_VERSIONS[0];
const V39 = NEW_VERSIONS[3];
const PRE_P1B = "c1cdd2eb85011ee105dff7ef2e403a5cb9ee2106"; // the gates as they were before canonicalization
const RULE = String.raw`regexp_replace(p.prosrc, E'\r\n?', E'\n', 'g')`;
const PREFLIGHT = readFileSync("scripts/ops-01b-preflight.sql", "utf8");
const POST36 = readFileSync("scripts/ops-01b-post36-verify.sql", "utf8");
const RESTORE = readFileSync("scripts/ops-01b-post36-verify-restore.sql", "utf8");
const OLD_PREFLIGHT = git(["show", `${PRE_P1B}:scripts/ops-01b-preflight.sql`]);
const OLD_POST36 = git(["show", `${PRE_P1B}:scripts/ops-01b-post36-verify.sql`]);

describe("OPS-01B release fingerprints are line-ending stable, and nothing else is", () => {
  it("states one canonicalization rule in every body-hashing gate", () => {
    for (const [name, text] of [["preflight", PREFLIGHT], ["post-36", POST36], ["post-36 restore", RESTORE]]) {
      expect(text, name).toContain(RULE);
      expect(text.replace(/\r\n/g, "\n"), `${name} hashes no raw body`).not.toMatch(/md5\(f\.prosrc\)|proowner, p\.prosrc\b/);
    }
    expect(PREFLIGHT).toContain("md5(regexp_replace(f.prosrc, E'\\r\\n?', E'\\n', 'g')) as body");
    expect(PREFLIGHT).toContain("'81a19e9eeb0e97453269b242ac153eae'"); // C05, reproduced from a clean DB35
    expect(PREFLIGHT).toContain("'0d7b1051a65dc974e1b7fa20368f38eb'"); // C15
  });

  it("gates pass on any line-ending representation and still STOP on every real drift", async () => {
    try {
      // ---- DB35, preflight C05/C15 -----------------------------------------------------------------------------------
      await resetLocal(["--version", V35]);
      expect(await migrations()).toBe(`35 ${V35}`);
      expect(await gate(PREFLIGHT)).toMatchObject(PASS);
      for (const [name, rep] of [["CRLF", CRLF], ["lone CR", LONE_CR], ["mixed", MIXED]] as const) {
        const now = await gate(PREFLIGHT, rep);
        expect(now.crBodies, `${name}: the bodies really carry CR`).toBeGreaterThan(name === "mixed" ? 10 : 30);
        expect(now, `${name}: canonical gate`).toMatchObject(PASS);
        const old = await gate(OLD_PREFLIGHT, rep);
        expect(old.verdict, `${name}: the old raw gate false-fails`).toBe("STOP");
        if (name !== "mixed") expect(old.failed, name).toEqual(["C05", "C15"]); // mixed: which trigger bodies got CR depends on oids
        else expect(old.failed).toContain("C05");
      }
      const CC = "public.create_customer(jsonb)";
      const TF = "private.enforce_open_business_date()";
      const trigger = (spec: string, fn = TF) => `drop trigger payments_open_business_date on public.payments; create trigger payments_open_business_date ${spec} execute function ${fn};`;
      const drifts: [string, string, string[]][] = [
        ["C: an added statement", edit(CC, String.raw`\mbegin\M`, "begin perform 1;", true), ["C05"]],
        ["D: a weakened authorization predicate", edit(CC, "if not private.has_shop_access(sid)", "if false and not private.has_shop_access(sid)"), ["C05"]],
        ["D under CRLF", CRLF + edit(CC, "if not private.has_shop_access(sid)", "if false and not private.has_shop_access(sid)"), ["C05"]],
        ["F: one extra space", edit(CC, String.raw`\mbegin\M`, "begin ", true), ["C05"]],
        ["F: a tab instead of a space", edit(CC, "raise exception 'UNAUTHORIZED_SHOP'", "raise\texception 'UNAUTHORIZED_SHOP'"), ["C05"]],
        ["F: an extra space in a trigger function", edit(TF, String.raw`\mbegin\M`, "begin ", true), ["C15"]],
        ["E: trigger timing BEFORE -> AFTER", trigger("after insert on public.payments for each row"), ["C15"]],
        ["E: trigger event INSERT -> INSERT OR UPDATE", trigger("before insert or update on public.payments for each row"), ["C15"]],
        ["E: trigger orientation ROW -> STATEMENT", trigger("before insert on public.payments for each statement"), ["C15"]],
        ["E: trigger WHEN added", trigger("before insert on public.payments for each row when (new.shop_id is not null)"), ["C15"]],
        ["E: trigger function identity (identical body, other function)",
          `do $cp$ begin execute replace(pg_get_functiondef('${TF}'::regprocedure), 'private.enforce_open_business_date()', 'private.zz_copy()'); end $cp$; revoke all on function private.zz_copy() from public;` + trigger("before insert on public.payments for each row", "private.zz_copy()"), ["C15"]],
        ["E under CRLF", CRLF + trigger("after insert on public.payments for each row"), ["C15"]],
      ];
      for (const [name, sql, stops] of drifts) expect(await gate(PREFLIGHT, sql), name).toMatchObject(stop(...stops));

      // ---- DB36, post-36 P03 (W2b and restore mode) ------------------------------------------------------------------
      await resetLocal(["--version", V36]);
      expect(await migrations()).toBe(`36 ${V36}`);
      const G = "private.storage_receipt_maintenance_guard()";
      for (const script of [POST36, RESTORE]) {
        expect(await gate(script)).toMatchObject(PASS);
        for (const rep of [CRLF, LONE_CR, MIXED]) expect(await gate(script, rep)).toMatchObject(PASS); // P03 and P09 both hold
        expect(await gate(script, edit(G, String.raw`\mbegin\M`, "begin perform 1;", true)), "a guard statement").toMatchObject(stop("P03"));
        expect(await gate(script, CRLF + edit(G, "if new.owner_id is null and exists", "if exists")), "the restore-context authorization under CRLF").toMatchObject(stop("P03"));
        expect(await gate(script, edit(G, String.raw`\mbegin\M`, "begin\t", true)), "a tab").toMatchObject(stop("P03"));
      }
      expect(await gate(OLD_POST36, CRLF), "the old raw P03 false-fails").toMatchObject(stop("P03"));

      // ---- databases built from migration FILES checked out with CRLF (Windows autocrlf) ----------------------------
      await resetLocal(["--no-seed"], { workdir: stageCheckout(V35, "crlf") });
      expect(await migrations()).toBe(`35 ${V35}`);
      const crlf35 = await gate(PREFLIGHT);
      expect(crlf35.crBodies).toBeGreaterThan(30);
      expect(crlf35).toMatchObject(PASS);
      expect(await gate(OLD_PREFLIGHT)).toMatchObject(stop("C05", "C15"));
      await supabase(["--workdir", stageCheckout(V36, "crlf"), "db", "push", "--db-url", DB_URL], undefined, 240_000);
      expect(await migrations()).toBe(`36 ${V36}`);
      expect(await gate(POST36)).toMatchObject(PASS);
      expect(await gate(OLD_POST36)).toMatchObject(stop("P03"));
      await supabase(["--workdir", stageCheckout(V39, "crlf"), "db", "push", "--db-url", DB_URL], undefined, 240_000);
      expect(await migrations()).toBe(`39 ${V39}`);
      expect(await psql(`select count(*) from (${APP_FNS}) f(oid) join pg_proc p on p.oid = f.oid where p.prosrc ~ E'\\r'`)).not.toBe("0");
      expect(await psql(runbookV3()), "V3 at 39 on CRLF bodies: every write RPC guarded").toBe("");
      const unguarded = "create or replace function public.create_customer(command jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$\r\nbegin\r\n  return private.create_customer(command);\r\nend\r\n$$;";
      expect(await psql(`begin;\n${unguarded}\n${runbookV3()}\nrollback;`), "a real drift at 39 still fails V3").toMatch(/^(public\.)?create_customer\(jsonb\)$/m);

      // ---- and from an LF checkout ----------------------------------------------------------------------------------
      await resetLocal(["--no-seed"], { workdir: stageCheckout(V35, "lf") });
      const lf35 = await gate(PREFLIGHT);
      expect(lf35.crBodies).toBe(0);
      expect(lf35).toMatchObject(PASS);
    } finally {
      await resetLocal();
    }
  }, 1_800_000);
});
