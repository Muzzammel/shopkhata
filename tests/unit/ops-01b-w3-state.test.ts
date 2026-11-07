import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyW3 } from "../../scripts/ops-01b-w3-state.mjs";

// OPS-01B W3 invariant: UNKNOWN is not OFF. Uncertain or inconsistent maintenance state never reopens traffic; only a
// definite database refusal of the enable plus two authoritative OFF reads (case 1) may lead to firewall removal.
const REF = "rel-1";
const T0 = Date.parse("2026-11-04T10:00:00Z");
const off = { enabled: false, enabled_at: null, enabled_by: null, has_reason: false, release_ref: null, bypass_user_id: null };
const on = { enabled: true, enabled_at: "2026-11-04T09:59:00Z", enabled_by: "u", has_reason: true, release_ref: REF, bypass_user_id: null };
type Read = { at?: number; maintenance?: unknown[]; last?: unknown; pending?: number; visible?: boolean };
const read = ({ at = T0, maintenance = [off], last = null, pending = 0, visible = true }: Read = {}) =>
  JSON.stringify([{ read_at: new Date(at).toISOString(), maintenance, last_transition: last, pending_controls: pending, activity_visible: visible }]);
const twoReads = (r: Read = {}) => [read({ ...r, at: T0 }), read({ ...r, at: T0 + 10_000 })];
const refused = { exit: 1, output: '{"_tag":"Error","error":{"message":"failed to execute query: ERROR: INSUFFICIENT_ROLE (SQLSTATE 42501)"}}' };
const enabledAudit = { action: "maintenance.enabled", release_ref: REF };

describe("W3 classifier: uncertain or inconsistent state keeps the firewall ON", () => {
  type Input = { ref: string; transition?: string; enable: { exit: number | null; output: string | null }; reads: string[] };
  const keepOn: [string, Input, number][] = [
    ["enable timed out, state OFF", { ref: REF, enable: { exit: 1, output: "failed to connect: timeout: context deadline exceeded" }, reads: twoReads() }, 3],
    ["client crashed: no enable output or exit code", { ref: REF, enable: { exit: null, output: null }, reads: twoReads() }, 3],
    ["dropped connection", { ref: REF, enable: { exit: 1, output: "unexpected EOF" }, reads: twoReads() }, 3],
    ["an enable call is still running", { ref: REF, enable: refused, reads: twoReads({ pending: 1 }) }, 3],
    ["state cannot be queried (no reads)", { ref: REF, enable: refused, reads: [] }, 4],
    ["only one read", { ref: REF, enable: refused, reads: [read()] }, 4],
    ["a read failed", { ref: REF, enable: refused, reads: [read(), '{"_tag":"Error","error":{"message":"connection refused"}}'] }, 4],
    ["reads less than 10 s apart", { ref: REF, enable: refused, reads: [read(), read({ at: T0 + 9_000 })] }, 4],
    ["singleton missing", { ref: REF, enable: refused, reads: twoReads({ maintenance: [] }) }, 4],
    ["singleton duplicated", { ref: REF, enable: refused, reads: twoReads({ maintenance: [off, off] }) }, 4],
    ["reads disagree", { ref: REF, enable: refused, reads: [read(), read({ at: T0 + 10_000, maintenance: [on], last: enabledAudit })] }, 4],
    ["row internally inconsistent", { ref: REF, enable: refused, reads: twoReads({ maintenance: [{ ...off, enabled_at: "2026-11-04T09:00:00Z" }] }) }, 4],
    ["a bypass present", { ref: REF, enable: refused, reads: twoReads({ maintenance: [{ ...on, bypass_user_id: "u" }], last: enabledAudit }) }, 4],
    ["audit says enabled but state OFF", { ref: REF, enable: refused, reads: twoReads({ last: enabledAudit }) }, 4],
    ["state ON without the audit row", { ref: REF, enable: refused, reads: twoReads({ maintenance: [on] }) }, 4],
    ["enable reported success but state OFF", { ref: REF, enable: { exit: 0, output: '[{"set_maintenance":{"changed":true,"enabled":true}}]' }, reads: twoReads() }, 4],
    ["sessions not visible", { ref: REF, enable: refused, reads: twoReads({ visible: false }) }, 4],
    ["no release ref", { ref: "", enable: refused, reads: twoReads() }, 4],
    ["maintenance ON (locked)", { ref: REF, enable: { exit: 0, output: '{"changed":true,"enabled":true}' }, reads: twoReads({ maintenance: [on], last: enabledAudit }) }, 2],
  ];
  for (const [name, input, expectedCase] of keepOn) {
    it(`${name} -> case ${expectedCase}, KEEP_ON`, () => {
      const result = classifyW3(input);
      expect(result.firewall).toBe("KEEP_ON");
      expect(result.case).toBe(expectedCase);
    });
  }

  it("positive: enable definitely refused by the database + two authoritative OFF reads -> case 1, MAY_REMOVE", () => {
    expect(classifyW3({ ref: REF, enable: refused, reads: twoReads() })).toMatchObject({ case: 1, firewall: "MAY_REMOVE" });
    expect(classifyW3({ ref: REF, enable: refused, reads: twoReads({ last: { action: "maintenance.disabled", release_ref: REF } }) }).firewall).toBe("MAY_REMOVE");
  });

  it("a deliberate disable reopens only on a definite success plus authoritative OFF reads", () => {
    const disabled = { action: "maintenance.disabled", release_ref: REF };
    const ok = { exit: 0, output: '[{"set_maintenance":{"ok":true,"changed":true,"enabled":false}}]' };
    expect(classifyW3({ ref: REF, transition: "disable", enable: ok, reads: twoReads({ last: disabled }) })).toMatchObject({ case: 1, firewall: "MAY_REMOVE" });
    // The real `supabase db query --output-format json` output is pretty-printed.
    const pretty = { exit: 0, output: JSON.stringify([{ set_maintenance: { changed: true, enabled: false, ok: true } }], null, 2) };
    expect(classifyW3({ ref: REF, transition: "disable", enable: pretty, reads: twoReads({ last: disabled }) }).firewall).toBe("MAY_REMOVE");
    expect(classifyW3({ ref: REF, transition: "disable", enable: { exit: 1, output: "timeout" }, reads: twoReads({ last: disabled }) }).firewall).toBe("KEEP_ON");
    expect(classifyW3({ ref: REF, transition: "disable", enable: { exit: null, output: null }, reads: twoReads({ last: disabled }) }).firewall).toBe("KEEP_ON");
    expect(classifyW3({ ref: REF, transition: "disable", enable: ok, reads: [read({ last: disabled })] }).firewall).toBe("KEEP_ON");
    expect(classifyW3({ ref: REF, transition: "disable", enable: ok, reads: twoReads({ maintenance: [on], last: enabledAudit }) }).firewall).toBe("KEEP_ON");
    expect(classifyW3({ ref: REF, transition: "bogus", enable: ok, reads: twoReads({ last: disabled }) }).firewall).toBe("KEEP_ON");
  });
});

// A runbook line (paragraph, bullet or table row) that mentions an uncertain/unknown state AND reopening traffic must
// say explicitly that the firewall stays ON / traffic never reopens. A softer "do not continue" is not enough: that is
// exactly how the reviewed 9f3a2dd text allowed removal on an uncertain enable.
const REOPENS = /remove (the|it)|firewall (off|removal)|reopen|resume normal operation/i;
const UNCERTAIN = /uncertain|unknown|cannot be (established|queried)|timed out|timeout|crash|dropped/i;
const KEEPS_ON = /never reopen|do not reopen|never remove|firewall (stays|remains) ON|firewall ON|keep the firewall ON|KEEP_ON|UNKNOWN is not OFF/i;
const permissive = (markdown: string) => markdown.replace(/```[\s\S]*?```/g, "").split(/\n+/)
  .filter((line) => UNCERTAIN.test(line) && REOPENS.test(line) && !KEEPS_ON.test(line));

describe("runbook: no path from an uncertain state to firewall removal", () => {
  const runbook = readFileSync("docs/operations/ops-01b-slice1-release-runbook.md", "utf8");

  it("the check catches the permissive text of the reviewed commit 9f3a2dd", () => {
    const old = [
      "7. **If the lock cannot be established** (the enable fails or stays uncertain): do **not** continue. 36 is inert while maintenance is off and compatible with the old app, so remove the firewall and resume normal operation at 36, or retry the enable (idempotent). Nothing is restored.",
      "  - *Failure or uncertain:* re-run V2 until it is definite; re-run W3 (idempotent). If it cannot be established, see §10 \"Bootstrap abort\" (36 is inert and compatible; remove the firewall).",
    ];
    expect(permissive(old.join("\n"))).toEqual(old);
  });
  it("no line of the current runbook permits reopening on an uncertain state", () => {
    expect(permissive(runbook)).toEqual([]);
  });
  it("the W3 matrix states the invariant and gates removal on the classifier", () => {
    expect(runbook).toContain("if the maintenance state is unknown or uncertain, the firewall stays ON");
    expect(runbook).toMatch(/scripts\/ops-01b-w3-state\.mjs[^\n]*MAY_REMOVE/);
  });
});
