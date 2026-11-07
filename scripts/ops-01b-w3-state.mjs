// Classifies the W3 (maintenance ON) outcome into the runbook's four cases (§7 "W3 failure matrix") and decides the
// firewall. INVARIANT: unknown or uncertain maintenance state => firewall stays ON. Only case 1 (the enable DEFINITELY
// failed in the database AND two authoritative reads prove OFF) allows the bootstrap abort to remove the firewall.
//
// The same rule gates every other reopen after a deliberate disable (bootstrap abort with maintenance ON, W15):
// --transition disable allows removal only if the disable DEFINITELY succeeded and two authoritative reads prove OFF.
//
// Usage: node scripts/ops-01b-w3-state.mjs --release-ref REF [--transition enable|disable] --enable-exit N
//          --enable-output w3.json --read state-1.json --read state-2.json
//   --enable-output / --enable-exit: what the control `supabase db query` printed and its exit code (missing = uncertain)
//   --read: outputs of scripts/ops-01b-w3-state.sql (supabase db query --output-format json), new connection each
// Prints {"case","firewall","reasons"}. Exit 0 ONLY for firewall "MAY_REMOVE"; any other exit means KEEP_ON.
import { readFileSync } from "node:fs";

export const MIN_READ_GAP_MS = 10_000;
// Errors raised by the database itself: the enable transaction rolled back, nothing can commit later.
const DEFINITE_DB_ERROR = /\b(MAINTENANCE_STATE_MISSING|INSUFFICIENT_ROLE|AUTHENTICATION_REQUIRED|REASON_REQUIRED|INVALID_REQUEST)\b|SQLSTATE 42601|syntax error at or near/;

const keepOn = (n, reasons) => ({ case: n, firewall: "KEEP_ON", reasons });

function parseRead(text) {
  try {
    const rows = JSON.parse(text);
    if (!Array.isArray(rows) || rows.length !== 1) return null;
    const r = rows[0];
    if (!r || typeof r.read_at !== "string" || !Array.isArray(r.maintenance) || typeof r.activity_visible !== "boolean") return null;
    return { ...r, at: Date.parse(r.read_at), pending: Number(r.pending_controls) };
  } catch { return null; }
}

function consistent(m, ref) {
  if (m.bypass_user_id !== null) return false;
  return m.enabled
    ? Boolean(m.enabled_at && m.enabled_by && m.has_reason && m.release_ref === ref)
    : m.enabled_at === null && m.enabled_by === null && m.release_ref === null && !m.has_reason;
}

/** enable: {exit: number|null, output: string|null} of the control call; reads: raw state-read texts; ref: release ref;
 *  transition: "enable" (W3, default) or "disable" (a deliberate maintenance OFF before reopening). */
export function classifyW3({ enable, reads, ref, transition = "enable" }) {
  if (transition !== "enable" && transition !== "disable") return keepOn(4, ["unknown transition"]);
  if (!ref) return keepOn(4, ["no release ref: the state cannot be matched to this release"]);
  const parsed = (reads ?? []).map(parseRead);
  if (parsed.length < 2) return keepOn(4, ["fewer than two state reads"]);
  if (parsed.some((r) => r === null)) return keepOn(4, ["a state read failed, is not exactly one result row, or cannot be parsed"]);
  const [first, last] = [parsed[0], parsed.at(-1)];
  if (!(last.at - first.at >= MIN_READ_GAP_MS)) return keepOn(4, [`the first and last reads are not ${MIN_READ_GAP_MS / 1000} s apart`]);
  if (parsed.some((r) => r.maintenance.length !== 1)) return keepOn(4, ["the maintenance singleton is missing or duplicated"]);
  const states = parsed.map((r) => r.maintenance[0]);
  if (states.some((m) => !consistent(m, ref))) return keepOn(4, ["the maintenance row is internally inconsistent, has a bypass, or belongs to another release"]);
  if (states.some((m) => m.enabled !== states[0].enabled || m.enabled_at !== states[0].enabled_at)) return keepOn(4, ["the reads disagree"]);
  if (parsed.some((r) => !r.activity_visible)) return keepOn(4, ["this session cannot see other sessions (pending control calls unknowable)"]);
  const on = states[0].enabled;
  const lastOn = parsed.map((r) => r.last_transition?.action === "maintenance.enabled" && r.last_transition?.release_ref === ref);
  if (lastOn.some((v) => v !== on)) return keepOn(4, ["the audit trail disagrees with the state"]);
  if (parsed.some((r) => r.pending > 0)) return keepOn(3, ["a set_maintenance call is still running and may still change the state"]);
  if (on) return keepOn(2, ["maintenance is ON (locked): continue at W4 or follow locked/forward recovery"]);
  const output = enable?.output ?? null;
  const exit = enable?.exit ?? null;
  if (transition === "disable") {
    // Authoritatively OFF after a deliberate disable: removal only if the disable definitely succeeded.
    if (exit !== 0 || output === null || !/"enabled"\s*:\s*false/.test(output) || !/"ok"\s*:\s*true/.test(output)) {
      return keepOn(3, ["the disable result is not a definite success: retry the disable (idempotent) to obtain one"]);
    }
    return { case: 1, firewall: "MAY_REMOVE", reasons: ["the disable definitely succeeded and two authoritative reads prove maintenance OFF"] };
  }
  // Authoritatively OFF. Removal only if the enable DEFINITELY failed in the database.
  if (exit === 0 || (output && /"enabled"\s*:\s*true/.test(output))) return keepOn(4, ["the enable reported success but the state is OFF"]);
  if (exit === null || output === null || !DEFINITE_DB_ERROR.test(output)) {
    return keepOn(3, ["the enable result is uncertain (no definite database error): retry W3 to obtain a definite result"]);
  }
  return { case: 1, firewall: "MAY_REMOVE", reasons: ["the enable definitely failed and two authoritative reads prove maintenance OFF: bootstrap abort may proceed"] };
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/ops-01b-w3-state.mjs")) {
  const args = process.argv.slice(2);
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const reads = args.flatMap((a, i) => (a === "--read" ? [args[i + 1]] : [])).map((path) => { try { return readFileSync(path, "utf8"); } catch { return ""; } });
  const exitText = value("--enable-exit");
  let output = null;
  try { output = value("--enable-output") ? readFileSync(value("--enable-output"), "utf8") : null; } catch { output = null; }
  const result = classifyW3({ ref: value("--release-ref"), transition: value("--transition") ?? "enable", enable: { exit: exitText === undefined || !/^\d+$/.test(exitText) ? null : Number(exitText), output }, reads });
  console.log(JSON.stringify(result));
  process.exit(result.firewall === "MAY_REMOVE" ? 0 : 3);
}
