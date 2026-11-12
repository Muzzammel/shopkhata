// Restore-rehearsal comparison and evidence (scripts/backup.mjs verify / record; the lock is scripts/restore-lock.mjs).
// Pure apart from the evidence file, so the rules below are unit-tested (tests/unit/backup-verification.test.ts).
import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { toleratedLocalOnlyStorage } from "./backup-local-storage.mjs";

export function differences(expected, actual, path = "") {
  if (isDeepStrictEqual(expected, actual)) return [];
  const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!plain(expected) || !plain(actual)) return [`${path || "(root)"}: backup ${JSON.stringify(expected)} / restored ${JSON.stringify(actual)}`];
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].flatMap((key) => differences(expected[key], actual[key], path ? `${path}.${key}` : key));
}

// The local rehearsal's comparison: the backup's fingerprint against the restored one, minus only the local-only
// Storage tables that qualify (scripts/backup-local-storage.mjs). Neither input is modified.
export function compareRestored(expected, restored) {
  const { compared, tolerated } = toleratedLocalOnlyStorage(expected, restored);
  return { differences: differences(expected, compared), tolerated };
}

// Whole-file replace: a reader sees the previous evidence or the new one, never a partial file.
export function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Runs a rehearsal (under the restore lock) so that its evidence file can say ok=true ONLY after the last check passed:
//  - first the previous evidence file is deleted; if it cannot be, no check runs (fail closed). Then the running marker
//    {ok:false, status:"running", runId} is written, so a run that cannot write it, or is interrupted, leaves no success;
//  - `body(check, record)` calls check(name) before each required check and record({...}) for evidence to keep
//    (manifestSha256, differences, toleratedLocalOnly, restoredFingerprint). Recorded fields never override
//    ok/status/runId/checks/failedCheck;
//  - success: {ok:true, status:"passed", runId, checks, ...}; any error: {ok:false, status:"failed", runId, failedCheck,
//    error, checks passed so far, ...}, then the error is rethrown (the command exits nonzero).
// Returns what body returned. A failed final ok=true write throws, leaving the running marker. A failed failure write
// leaves the running marker and still rethrows the original error.
export const releaseReceiptPath = (path, runId) => `${path}.release-${runId}.json`;

/** @param {string} path @param {(check: (name: string) => void, record: (fields: object) => void) => Promise<any>} body
 * @param {{write?: typeof writeJsonAtomic, remove?: (file: string) => void, now?: () => string, warn?: (message: string) => void, complete?: (evidence: any) => void}} [options] */
export async function runRestoreChecks(path, body, { write = writeJsonAtomic, remove = (file) => rmSync(file, { force: true }), now = () => new Date().toISOString(), warn = console.error, complete = undefined } = {}) {
  const runId = randomUUID();
  const startedAt = now();
  const recorded = {};
  const checks = [];
  let current = null;
  remove(path);
  write(path, { verifiedAt: startedAt, ok: false, status: "running", runId, startedAt });
  const check = (name) => { if (current !== null) checks.push(current); current = name; };
  const record = (fields) => Object.assign(recorded, fields);
  let result;
  try {
    result = await body(check, record);
  } catch (error) {
    try {
      write(path, { ...recorded, verifiedAt: now(), ok: false, status: "failed", runId, startedAt, failedCheck: current, error: String(error?.message ?? error), checks });
    } catch (writeError) {
      warn(`[backup] Could not write the failure evidence to ${path} (${writeError.message}); it still says ok=false, status running.`);
    }
    throw error;
  }
  if (current !== null) checks.push(current);
  const evidence = { ...recorded, verifiedAt: now(), ok: true, status: "passed", runId, startedAt, checks };
  write(path, evidence);
  try { complete?.(evidence); }
  catch (error) {
    try { write(path, { ...evidence, ok: false, status: "failed", failedCheck: "evidence finalization", error: String(error?.message ?? error) }); }
    catch (writeError) { warn(`[backup] Could not write finalization failure evidence: ${writeError.message}`); }
    throw error;
  }
  return result;
}

// What `backup:record` may report for a backup folder's restore-verification.json (`text`, or null when absent), given
// the SHA-256 of that backup's manifest. Only a completed pass bound to THIS manifest and a run counts as verified; a
// completed failure bound to THIS manifest counts as failed; anything else (running/interrupted, another backup's manifest, evidence from
// before run binding, malformed) counts as no rehearsal. Returns { rehearsal: {verifiedAt, ok} | null, reason }.
/** @param {string | null} text @param {string} manifestSha256 @param {string | null} [releaseText] */
export function acceptedRehearsal(text, manifestSha256, releaseText = null) {
  if (text === null || text === undefined) return { rehearsal: null, reason: "no restore rehearsal yet" };
  let evidence;
  try { evidence = JSON.parse(text); } catch { return { rehearsal: null, reason: "restore-verification.json is malformed; ignored" }; }
  const run = typeof evidence?.runId === "string" && evidence.runId.length > 0 && typeof evidence?.verifiedAt === "string";
  if (!run) return { rehearsal: null, reason: "restore-verification.json has no verification run identity (older or foreign evidence); ignored" };
  if (evidence.status === "failed") {
    // A failure is attributed to this backup only when bound to its manifest (a failure before the manifest was read,
    // or one copied from another backup, is not).
    if (evidence.manifestSha256 !== manifestSha256) return { rehearsal: null, reason: "restore-verification.json records a failure not bound to this manifest; ignored" };
    return { rehearsal: { verifiedAt: evidence.verifiedAt, ok: false }, reason: "restore rehearsal FAILED" };
  }
  if (evidence.status !== "passed") return { rehearsal: null, reason: `restore rehearsal not completed (status ${JSON.stringify(evidence.status)}): running elsewhere or interrupted; ignored` };
  if (evidence.manifestSha256 !== manifestSha256) return { rehearsal: null, reason: "restore-verification.json belongs to a different manifest; ignored" };
  if (evidence.ok !== true) return { rehearsal: null, reason: "restore-verification.json is inconsistent (passed without ok=true); ignored" };
  let receipt;
  try { receipt = JSON.parse(releaseText); } catch { /* incomplete or malformed finalization */ }
  if (receipt?.released !== true || receipt.runId !== evidence.runId || receipt.manifestSha256 !== manifestSha256) {
    return { rehearsal: null, reason: "restore checks passed but lock release was not finalized; ignored" };
  }
  return { rehearsal: { verifiedAt: evidence.verifiedAt, ok: true }, reason: "restore rehearsal passed" };
}
