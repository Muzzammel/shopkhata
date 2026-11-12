import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptedRehearsal, compareRestored, differences, runRestoreChecks, writeJsonAtomic } from "../../scripts/backup-verification.mjs";
import { acquireRestoreLock, INHERIT_ENV, LOCK_LABEL, releaseRestoreLock, RestoreLockError } from "../../scripts/restore-lock.mjs";

// Restore-rehearsal evidence (the lock itself: tests/unit/restore-lock.test.ts). restore-verification.json may say ok=true
// only after EVERY required check of THIS run passed; earlier evidence is invalidated first; `backup:record` accepts only
// a completed pass bound to the same manifest and a verification run.
type Evidence = Record<string, unknown> & { ok: boolean; status: string; runId?: string; failedCheck?: string; checks?: string[] };
let dir: string;
let file: string;
const read = (): Evidence => JSON.parse(readFileSync(file, "utf8"));
const STALE = JSON.stringify({ verifiedAt: "2026-01-01T00:00:00.000Z", ok: true, differences: [] });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "shopkhata-evidence-")); file = join(dir, "restore-verification.json"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A production-shaped backup fingerprint (hosted Storage: no iceberg tables) and its local restore (local Storage adds
// the two iceberg tables, empty).
const prodFingerprint = () => ({
  tables: { shops: "2:3fc542a7a6379213e1f97ef65a75f0a0", expenses: "2:d6cbb56b25715d20cc7bd7ef9e70bbe4", invoices: "0:" },
  auth_users: "1:6679048d9e3298c42990c75a349371b8",
  migrations: ["20261031165915"],
  receipt_objects: "0:",
  shops: { "fbee4969-21ca-4d1e-993f-1d88c9c0e1f9": { sales_totals: { invoice_count: 0 }, customer_due_totals: { outstanding_due_dirham: 0 } } },
  storage: {
    "storage.bucket_lifecycle_states": "0:", "storage.buckets": "1:4bfa4adb0617ccb2aa812c36f94216e1", "storage.buckets_analytics": "0:",
    "storage.buckets_vectors": "0:", "storage.lifecycle_abandoned_artifacts": "0:", "storage.objects": "0:",
    "storage.s3_multipart_uploads": "0:", "storage.s3_multipart_uploads_parts": "0:", "storage.vector_indexes": "0:",
  },
});
const localRestore = (storage: Record<string, unknown> = {}) => {
  const fp = prodFingerprint();
  return { ...fp, storage: { ...fp.storage, "storage.iceberg_namespaces": "0:", "storage.iceberg_tables": "0:", ...storage } };
};

describe("differences (moved verbatim from backup.mjs)", () => {
  it("reports nothing for equal values and a path for each leaf difference, both directions", () => {
    expect(differences({ a: { b: 1 } }, { a: { b: 1 } })).toEqual([]);
    expect(differences({ a: { b: 1 } }, { a: { b: 2 } })).toEqual(["a.b: backup 1 / restored 2"]);
    expect(differences({ a: 1 }, { a: 1, x: "0:" })).toEqual(['x: backup undefined / restored "0:"']);
    expect(differences({ a: 1, x: "0:" }, { a: 1 })).toEqual(['x: backup "0:" / restored undefined']);
    expect(differences(null, {})).toEqual(["(root): backup null / restored {}"]);
  });
});

describe("compareRestored: Stage B tolerance integrated with the fingerprint comparison", () => {
  it("a production-shaped backup reconciles with its local restore that has two empty iceberg tables", () => {
    const expected = prodFingerprint();
    const restored = localRestore();
    const snapshot = structuredClone({ expected, restored });
    expect(compareRestored(expected, restored)).toEqual({ differences: [], tolerated: ["storage.iceberg_namespaces", "storage.iceberg_tables"] });
    expect({ expected, restored }).toEqual(snapshot);
  });

  it("without the tolerance the same pair would fail on exactly the two iceberg tables", () => {
    expect(differences(prodFingerprint(), localRestore())).toEqual([
      'storage.storage.iceberg_namespaces: backup undefined / restored "0:"',
      'storage.storage.iceberg_tables: backup undefined / restored "0:"',
    ]);
  });

  it.each([
    ["a non-empty iceberg table", { "storage.iceberg_tables": "1:abc" }, ['storage.storage.iceberg_tables: backup undefined / restored "1:abc"']],
    ["an unreadable iceberg table", { "storage.iceberg_namespaces": "unreadable" }, ['storage.storage.iceberg_namespaces: backup undefined / restored "unreadable"']],
    ["an unexpected extra empty Storage table", { "storage.surprise": "0:" }, ['storage.storage.surprise: backup undefined / restored "0:"']],
    ["a production Storage table missing locally", { "storage.bucket_lifecycle_states": undefined }, ['storage.storage.bucket_lifecycle_states: backup "0:" / restored undefined']],
    ["a changed shared Storage table", { "storage.buckets": "2:ffff" }, ['storage.storage.buckets: backup "1:4bfa4adb0617ccb2aa812c36f94216e1" / restored "2:ffff"']],
    ["an unreadable shared Storage table", { "storage.objects": "unreadable" }, ['storage.storage.objects: backup "0:" / restored "unreadable"']],
  ])("still fails for %s", (_name, storage, expected) => {
    const restored = localRestore(storage);
    for (const [key, value] of Object.entries(storage)) if (value === undefined) delete (restored.storage as Record<string, unknown>)[key];
    expect(compareRestored(prodFingerprint(), restored).differences).toEqual(expected);
  });

  it("still fails for differences outside Storage", () => {
    const restored = { ...localRestore(), tables: { ...prodFingerprint().tables, invoices: "1:aa" }, auth_users: "0:" };
    expect(compareRestored(prodFingerprint(), restored).differences).toEqual([
      'tables.invoices: backup "0:" / restored "1:aa"',
      'auth_users: backup "1:6679048d9e3298c42990c75a349371b8" / restored "0:"',
    ]);
  });

  it("tolerates nothing when the backup has no Storage inventory (a malformed or pre-inventory backup)", () => {
    const expected: Partial<ReturnType<typeof prodFingerprint>> = prodFingerprint();
    delete expected.storage;
    const result = compareRestored(expected, localRestore());
    expect(result.tolerated).toEqual([]);
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]).toMatch(/^storage: backup undefined \/ restored \{/);
  });
});

// The step sequence of scripts/backup.mjs verifySteps, with the fingerprint comparison passing.
const STEPS = ["backup manifest", "artifact integrity", "migration compatibility", "database restore", "receipt restore", "maintenance state", "fingerprint reconciliation", "shop isolation", "application reads", "restore lock"];
const MANIFEST_SHA = "a".repeat(64);
const rehearsal = (failAt?: string, error: unknown = new Error(`${failAt} failed`)) => async (check: (name: string) => void, record: (fields: object) => void) => {
  for (const step of STEPS) {
    check(step);
    if (step === "backup manifest") record({ manifestSha256: MANIFEST_SHA });
    if (step === "fingerprint reconciliation") {
      const restored = localRestore();
      const { differences: diff, tolerated } = compareRestored(prodFingerprint(), restored);
      record({ differences: diff, toleratedLocalOnly: tolerated, restoredFingerprint: restored });
    }
    if (step === failAt) throw error;
  }
  return 12;
};
const failingSecondWrite = () => {
  let writes = 0;
  return (path: string, value: object) => { writes += 1; if (writes > 1) throw new Error("disk full"); writeJsonAtomic(path, value); };
};

describe("runRestoreChecks: evidence", () => {
  it("writes ok=true only after the last check, bound to the manifest and a run, with the full fingerprint and tolerated names", async () => {
    await expect(runRestoreChecks(file, rehearsal())).resolves.toBe(12);
    const evidence = read();
    expect(evidence).toMatchObject({ ok: true, status: "passed", manifestSha256: MANIFEST_SHA, differences: [], toleratedLocalOnly: ["storage.iceberg_namespaces", "storage.iceberg_tables"], checks: STEPS });
    expect(evidence.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(evidence.restoredFingerprint).toEqual(localRestore()); // unfiltered: still has both iceberg keys
  });

  it("gives every run its own run id", async () => {
    await runRestoreChecks(file, rehearsal());
    const first = read().runId;
    await runRestoreChecks(file, rehearsal());
    expect(read().runId).not.toBe(first);
  });

  it.each(["shop isolation", "application reads"])("a %s failure AFTER a passing fingerprint comparison records ok=false and rethrows", async (step) => {
    await expect(runRestoreChecks(file, rehearsal(step))).rejects.toThrow(`${step} failed`);
    const evidence = read();
    expect(evidence).toMatchObject({ ok: false, status: "failed", failedCheck: step, error: `${step} failed`, differences: [], toleratedLocalOnly: ["storage.iceberg_namespaces", "storage.iceberg_tables"] });
    expect(evidence.checks).toEqual(STEPS.slice(0, STEPS.indexOf(step)));
    expect(evidence.restoredFingerprint).toEqual(localRestore());
    expect(acceptedRehearsal(readFileSync(file, "utf8"), MANIFEST_SHA).rehearsal).toEqual({ verifiedAt: evidence.verifiedAt, ok: false });
  });

  it("a fingerprint mismatch records ok=false with the differences and the full fingerprint", async () => {
    const body = async (check: (name: string) => void, record: (fields: object) => void) => {
      check("fingerprint reconciliation");
      const restored = localRestore({ "storage.iceberg_tables": "3:abc" });
      const { differences: diff, tolerated } = compareRestored(prodFingerprint(), restored);
      record({ differences: diff, toleratedLocalOnly: tolerated, restoredFingerprint: restored });
      throw new Error("does not reconcile");
    };
    await expect(runRestoreChecks(file, body)).rejects.toThrow("does not reconcile");
    expect(read()).toMatchObject({ ok: false, status: "failed", failedCheck: "fingerprint reconciliation", toleratedLocalOnly: ["storage.iceberg_namespaces"], differences: ['storage.storage.iceberg_tables: backup undefined / restored "3:abc"'] });
  });

  it("recorded fields can never override ok, status, run id or checks", async () => {
    const body = async (check: (name: string) => void, record: (fields: object) => void) => {
      check("shop isolation");
      record({ ok: true, status: "passed", runId: "forged", checks: STEPS, failedCheck: null });
      throw new Error("isolation broken");
    };
    await expect(runRestoreChecks(file, body)).rejects.toThrow();
    const evidence = read();
    expect(evidence).toMatchObject({ ok: false, status: "failed", failedCheck: "shop isolation", checks: [] });
    expect(evidence.runId).not.toBe("forged");
  });

  it("a failure before the comparison records the failed check without fingerprint fields", async () => {
    await expect(runRestoreChecks(file, rehearsal("database restore"))).rejects.toThrow();
    const evidence = read();
    expect(evidence).toMatchObject({ ok: false, status: "failed", failedCheck: "database restore", checks: ["backup manifest", "artifact integrity", "migration compatibility"] });
    expect(evidence).not.toHaveProperty("restoredFingerprint");
  });

  it("records a non-Error throw as text", async () => {
    await expect(runRestoreChecks(file, rehearsal("shop isolation", "boom"))).rejects.toBe("boom");
    expect(read()).toMatchObject({ ok: false, failedCheck: "shop isolation", error: "boom" });
  });

  it("invalidates stale success evidence before any check runs", async () => {
    writeFileSync(file, STALE);
    let seen: Evidence | undefined;
    await expect(runRestoreChecks(file, async () => { seen = read(); throw new Error("stop"); })).rejects.toThrow("stop");
    expect(seen).toMatchObject({ ok: false, status: "running" });
    expect(read()).toMatchObject({ ok: false, status: "failed" });
  });

  it("initial marker write fails with a previous ok=true present: the old evidence is gone and no check runs", async () => {
    writeFileSync(file, STALE);
    const body = vi.fn();
    await expect(runRestoreChecks(file, body, { write: () => { throw new Error("disk full"); } })).rejects.toThrow("disk full");
    expect(body).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });

  it("fails closed, running no check, when stale evidence cannot be invalidated", async () => {
    writeFileSync(file, STALE);
    const body = vi.fn();
    const write = vi.fn();
    await expect(runRestoreChecks(file, body, { remove: () => { throw new Error("EPERM"); }, write })).rejects.toThrow("EPERM");
    expect(body).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("an interrupted run (never finishes) leaves ok=false, status running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const run = runRestoreChecks(file, async (check: (name: string) => void) => { check("shop isolation"); await gate; });
    await Promise.resolve();
    expect(read()).toMatchObject({ ok: false, status: "running" });
    expect(acceptedRehearsal(readFileSync(file, "utf8"), MANIFEST_SHA).rehearsal).toBeNull();
    release();
    await run;
  });

  it("rethrows the original error when the failure evidence cannot be written; the running marker stays", async () => {
    const warn = vi.fn();
    await expect(runRestoreChecks(file, rehearsal("application reads"), { write: failingSecondWrite(), warn })).rejects.toThrow("application reads failed");
    expect(warn).toHaveBeenCalledOnce();
    expect(read()).toMatchObject({ ok: false, status: "running" });
  });

  it("fails, and leaves ok=false behind, when the final ok=true write fails", async () => {
    await expect(runRestoreChecks(file, rehearsal(), { write: failingSecondWrite() })).rejects.toThrow("disk full");
    expect(read()).toMatchObject({ ok: false, status: "running" });
  });

  it("writes atomically and leaves no temporary file, also when the rename fails", async () => {
    await runRestoreChecks(file, rehearsal());
    await expect(runRestoreChecks(file, rehearsal("shop isolation"))).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(["restore-verification.json"]);
    const blocked = join(dir, "blocked");
    mkdirSync(join(blocked, "inner"), { recursive: true }); // a non-empty directory cannot be replaced by a file
    expect(() => writeJsonAtomic(blocked, { ok: true })).toThrow();
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("acceptedRehearsal: what backup:record may trust", () => {
  it("rejects passing checks without a successful lock-release receipt", () => {
    const evidence = JSON.stringify({ ok: true, status: "passed", runId: "run-5", verifiedAt: "2026-11-09", manifestSha256: MANIFEST_SHA });
    expect(acceptedRehearsal(evidence, MANIFEST_SHA).rehearsal).toBeNull();
  });
  const passed = (extra: object = {}) => JSON.stringify({ verifiedAt: "2026-11-08T10:00:00.000Z", ok: true, status: "passed", runId: "6f1c0d0e-0000-4000-8000-000000000000", manifestSha256: MANIFEST_SHA, ...extra });

  it("accepts a completed pass bound to this manifest and a run", () => {
    expect(acceptedRehearsal(passed(), MANIFEST_SHA, JSON.stringify({ released: true, runId: "6f1c0d0e-0000-4000-8000-000000000000", manifestSha256: MANIFEST_SHA })).rehearsal).toEqual({ verifiedAt: "2026-11-08T10:00:00.000Z", ok: true });
  });

  it.each([
    ["absent", null],
    ["malformed", "{ok:true"],
    ["legacy ok=true without run identity", STALE],
    ["another backup's manifest", passed({ manifestSha256: "b".repeat(64) })],
    ["a pass without manifest binding", passed({ manifestSha256: undefined })],
    ["a running (concurrent or interrupted) run", passed({ status: "running", ok: false })],
    ["ok=true without status passed", passed({ status: undefined })],
    ["status passed without ok=true", passed({ ok: "true" })],
    ["an empty run id", passed({ runId: "" })],
    ["JSON null", "null"],
  ])("never accepts %s as a pass", (_name, text) => {
    expect(acceptedRehearsal(text, MANIFEST_SHA).rehearsal).toBeNull();
  });

  it("reports a completed failure as failed, never as passed", () => {
    expect(acceptedRehearsal(passed({ ok: false, status: "failed" }), MANIFEST_SHA).rehearsal).toEqual({ verifiedAt: "2026-11-08T10:00:00.000Z", ok: false });
  });
});

describe("scripts/backup.mjs wiring", () => {
  const source = readFileSync(resolve("scripts/backup.mjs"), "utf8");
  const steps = source.slice(source.indexOf("async function verifySteps("), source.indexOf("function localRestoreTarget("));
  const dispatch = source.slice(source.indexOf("\ntry {"));

  it("marks every required check in order: manifest first, comparison before shop isolation and application reads, the lock last", () => {
    expect([...steps.matchAll(/check\("([^"]+)"\)/g)].map((match) => match[1])).toEqual(STEPS);
    expect(steps.indexOf('check("backup manifest")')).toBeLessThan(steps.indexOf("manifest.json"));
    expect(steps).toMatch(/check\("restore lock"\);\s*assertRestoreLockHeld\(lock\);/);
  });

  it("has no other writer of restore-verification.json and declares success only after the checks ran", () => {
    expect(source.match(/restore-verification\.json/g)).toHaveLength(2); // the evidence path, and recordBackup's reader
    expect(steps).not.toMatch(/writeFileSync|RESTORE VERIFIED/);
    const verify = source.slice(source.indexOf("async function verifyRestore("), source.indexOf("async function verifySteps("));
    expect(verify).not.toMatch(/manifest\.json|readFileSync|existsSync/);
    expect(dispatch.indexOf("RESTORE VERIFIED")).toBeGreaterThan(dispatch.indexOf("await locked("));
  });

  it("resets the local database only through the guarded reset, under the run's exclusive lease, inside the locked verify", () => {
    expect(source).not.toMatch(/\[\s*"db",\s*"reset"/); // no direct CLI reset anywhere
    expect(source.match(/guardedLocalReset\(/g)).toHaveLength(1);
    const call = steps.indexOf("await guardedLocalReset({ root: REPO, args: [\"--no-seed\", \"--version\", manifest.migrations.at(-1)], lease: lock.operation, timeoutMs: BACKUP_RESET_BUDGET })");
    expect(call).toBeGreaterThan(steps.indexOf('check("database restore");'));
    expect(call).toBeGreaterThan(steps.indexOf("assertLocalEndpoint(\"supabase_db_shopkhata\", 55322, 5432)"));
    expect(dispatch).toContain('locked(`verify ${value ? resolve(value) : "(new local backup)"}`, (lock) => verifyRestore(value, lock))');
    expect(dispatch).toContain("fn, { exclusive: true }");
  });

  it("paths that never reset (backup, hosted or local restore, receipts, record) need no image inspection", () => {
    const fn = (name: string) => { const start = source.indexOf(`function ${name}(`); return source.slice(start, source.indexOf("\n}\n", start)); };
    for (const name of ["createBackup", "restoreTo", "restoreReceiptsTo", "recordBackup", "stageMigrations"]) {
      expect(fn(name).length, name).toBeGreaterThan(50);
      expect(fn(name), name).not.toMatch(/guardedLocalReset|assertResetImages|image", "inspect/);
    }
  });

  it("a verify inheriting a parent lock reports CHECKS PASSED, never RESTORE VERIFIED, and no integration test expects otherwise", () => {
    // The parent finalizes the lock release; until then a nested run may claim only that its checks passed.
    expect(source.match(/RESTORE VERIFIED/g)).toHaveLength(1);
    expect(dispatch).toContain('${result.inherited ? "RESTORE CHECKS PASSED (pending parent lock release)" : "RESTORE VERIFIED"}');
    expect(source.slice(source.indexOf("async function verifyRestore("), source.indexOf("async function verifySteps("))).toContain("inherited: lock.inherited");
    // Integration suites run backup:verify inside the vitest restore lock (inherited), so none may require the final verdict.
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
    const claims = walk("tests/integration").filter((path) => path.endsWith(".ts") && /(?<!not\.)toContain\(\s*["'`]RESTORE VERIFIED/.test(readFileSync(path, "utf8")));
    expect(claims).toEqual([]);
  });

  it("local recording recursively acquires the database lock before integrity and evidence reads", () => {
    const record = source.slice(source.indexOf("async function recordBackup("), source.indexOf("async function verifyRestore("));
    expect(record.indexOf("withRestoreLock(")).toBeLessThan(record.indexOf("checkArtifacts("));
    expect(record.match(/\{ exclusive: true \}/g)).toHaveLength(2);
    expect(record).toContain("acceptedRehearsal(text, sha256(manifestBytes), release)");
    expect(dispatch).toContain("localRestoreTarget() ? locked(");
    expect(dispatch).toContain('fn, { exclusive: true }');
  });
});

// The real command and the real Docker lock, on backups that fail before any database step: Docker is used for the lock
// container only; the database is never reset, queried or changed. Skipped where the local stack does not exist.
const dockerRun = (args: string[]) => spawnSync("docker", args, { encoding: "utf8", windowsHide: true });
const REAL_TARGET = "supabase_db_shopkhata";
const realStack = process.env.SHOPKHATA_LOCK_DOCKER_TESTS === "1" && dockerRun(["container", "inspect", "--format", "{{.Image}}", REAL_TARGET]).status === 0;
const liveLocks = (target = REAL_TARGET) => dockerRun(["ps", "-a", "--filter", `label=${LOCK_LABEL}.target=${target}`, "--format", "{{.ID}} {{.Names}}"]).stdout.trim();

describe.skipIf(!realStack)("node scripts/backup.mjs with the real Docker lock (end to end, no database)", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const dumps = (target: string) => { for (const name of ["roles.sql", "schema.sql", "data.sql"]) writeFileSync(join(target, name), `-- ${name}\n`); };
  const files = () => Object.fromEntries(["roles.sql", "schema.sql", "data.sql"].map((name) => [name, { sha256: sha(`-- ${name}\n`) }]));
  const backup = (target: string, manifest: object | string) => {
    dumps(target);
    writeFileSync(join(target, "manifest.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    writeFileSync(join(target, "restore-verification.json"), STALE); // stale success from an earlier run
  };
  const run = (args: string[], extra: Record<string, string> = {}, cwd?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
    for (const key of Object.keys(env)) if (key.startsWith("SHOPKHATA_") && !(key in extra)) delete env[key];
    return spawnSync(process.execPath, [resolve("scripts/backup.mjs"), ...args], { encoding: "utf8", env, timeout: 120_000, cwd });
  };
  const inspectLabels = (id: string) => dockerRun(["container", "inspect", "--format", "{{json .Config.Labels}}", id]).stdout.trim();
  beforeEach(() => { expect(liveLocks(), "a restore rehearsal or test run holds the local database lock").toBe(""); });
  afterEach(() => { expect(liveLocks()).toBe(""); });

  it("corrupt dump: exits nonzero, replaces stale success with the failed check, and releases the lock", () => {
    backup(dir, { files: { ...files(), "data.sql": { sha256: "0".repeat(64) } }, receipts: [], migrations: [] });
    const result = run(["verify", "--from", dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("data.sql does not match the hash");
    expect(result.stdout).not.toContain("RESTORE VERIFIED");
    expect(read()).toMatchObject({ ok: false, status: "failed", failedCheck: "artifact integrity", checks: ["backup manifest"] });
    expect(read().manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it("missing migration: exits nonzero and records the failed check", () => {
    backup(dir, { files: files(), receipts: [], migrations: ["99999999999999"] });
    const result = run(["verify", "--from", dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("migration state this checkout does not contain");
    expect(read()).toMatchObject({ ok: false, status: "failed", failedCheck: "migration compatibility", checks: ["backup manifest", "artifact integrity"] });
  }, 60_000);

  it.each([
    ["missing", null, "manifest.json is missing"],
    ["malformed", "{ not json", "manifest.json is not valid JSON"],
  ])("%s manifest with stale success evidence: exits nonzero and the stale success is replaced by a failure", (_name, manifest, message) => {
    dumps(dir);
    if (manifest !== null) writeFileSync(join(dir, "manifest.json"), manifest);
    writeFileSync(file, STALE);
    const result = run(["verify", "--from", dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(read()).toMatchObject({ ok: false, status: "failed", failedCheck: "backup manifest", checks: [] });
    expect(read()).not.toHaveProperty("manifestSha256");
  }, 60_000);

  it("while one run holds the lock, rehearsals of the same or a DIFFERENT folder, from any user profile or directory, are refused and change nothing", () => {
    const owner = acquireRestoreLock(REAL_TARGET, `test: first rehearsal of ${dir}`);
    const other = mkdtempSync(join(tmpdir(), "shopkhata-evidence-other-"));
    try {
      const labelsBefore = inspectLabels(owner.id);
      backup(dir, { files: files(), receipts: [], migrations: [] });
      backup(other, { files: files(), receipts: [], migrations: [] });
      const elsewhere = { USERPROFILE: other, HOME: other, HOMEDRIVE: "Z:", HOMEPATH: "\\elsewhere", TEMP: other, TMP: other };
      const attempts: [string, Record<string, string>, string | undefined][] = [[dir, {}, undefined], [other, {}, undefined], [dir, elsewhere, other], [other, elsewhere, tmpdir()]];
      for (const [target, profile, cwd] of attempts) {
        const result = run(["verify", "--from", target], profile, cwd);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Another run holds the restore lock of the local database supabase_db_shopkhata");
        expect(result.stderr).toContain("Nothing was changed");
        expect(readFileSync(join(target, "restore-verification.json"), "utf8")).toBe(STALE);
        expect(inspectLabels(owner.id)).toBe(labelsBefore);
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
      releaseRestoreLock(owner);
    }
  }, 120_000);

  it("a child inherits its own run's lock (verified, never released by the child)", () => {
    const owner = acquireRestoreLock(REAL_TARGET, "test: integration run");
    try {
      backup(dir, { files: { ...files(), "data.sql": { sha256: "0".repeat(64) } }, receipts: [], migrations: [] });
      const result = run(["verify", "--from", dir], { [INHERIT_ENV.id]: owner.id, [INHERIT_ENV.token]: owner.token });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("data.sql does not match the hash"); // inheritance accepted, the checks ran
      expect(read()).toMatchObject({ ok: false, failedCheck: "artifact integrity" });
      expect(JSON.parse(inspectLabels(owner.id))[`${LOCK_LABEL}.token`]).toBe(owner.token); // still held by the owner
    } finally {
      releaseRestoreLock(owner);
    }
  }, 60_000);

  it.each([
    ["a wrong token", (owner: { id: string }) => ({ [INHERIT_ENV.id]: owner.id, [INHERIT_ENV.token]: "00000000-0000-4000-8000-000000000000" }), "token mismatch"],
    ["only the id", (owner: { id: string }) => ({ [INHERIT_ENV.id]: owner.id }), "needs both"],
    ["an unknown container", () => ({ [INHERIT_ENV.id]: "0".repeat(64), [INHERIT_ENV.token]: "x" }), "no such lock container"],
  ])("a child presenting %s is refused before touching anything", (_name, envFor, message) => {
    const owner = acquireRestoreLock(REAL_TARGET, "test: integration run");
    try {
      backup(dir, { files: files(), receipts: [], migrations: [] });
      const result = run(["verify", "--from", dir], envFor(owner) as Record<string, string>);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(readFileSync(file, "utf8")).toBe(STALE);
    } finally {
      releaseRestoreLock(owner);
    }
  }, 60_000);

  it("a process that is NOT a descendant of the holder cannot inherit, even with the right id and token", async () => {
    const moduleUrl = pathToFileURL(resolve("scripts/restore-lock.mjs")).href;
    const holder = spawn(process.execPath, ["--input-type=module", "-e", `import { acquireRestoreLock, releaseRestoreLock } from ${JSON.stringify(moduleUrl)};
      const owner = acquireRestoreLock(${JSON.stringify(REAL_TARGET)}, "test: sibling holder"); console.log(JSON.stringify({ id: owner.id, token: owner.token }));
      process.stdin.once("data", () => { releaseRestoreLock(owner); process.exit(0); });`], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise((done) => holder.once("exit", done));
    try {
      const line = await new Promise<string>((done, fail) => { holder.stdout.once("data", (d) => done(String(d))); holder.once("exit", () => fail(new Error("holder exited early"))); });
      const granted = JSON.parse(line);
      backup(dir, { files: files(), receipts: [], migrations: [] });
      const result = run(["verify", "--from", dir], { [INHERIT_ENV.id]: granted.id, [INHERIT_ENV.token]: granted.token });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("is not an ancestor of this process");
      expect(readFileSync(file, "utf8")).toBe(STALE);
    } finally {
      holder.stdin.write("release\n");
      await exited;
    }
  }, 120_000);

  it("integration runs and rehearsals exclude each other in both directions (vitest and Playwright global setups)", async () => {
    const { default: vitestSetup } = await import("../integration/restore-lock.global-setup");
    const { default: playwrightSetup } = await import("../e2e/restore-lock.global-setup");
    const provide = vi.fn();
    const teardown = vitestSetup({ config: { name: "unit-test", root: "." }, provide } as never);
    try {
      expect(provide).toHaveBeenCalledWith("shopkhataRestoreLock", expect.objectContaining({ id: expect.any(String), token: expect.any(String) }));
      backup(dir, { files: files(), receipts: [], migrations: [] });
      const result = run(["verify", "--from", dir]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Another run holds the restore lock");
      expect(readFileSync(file, "utf8")).toBe(STALE);
      await expect(playwrightSetup()).rejects.toThrow(RestoreLockError);
    } finally {
      teardown();
    }
    const rehearsal = acquireRestoreLock(REAL_TARGET, "test: rehearsal");
    try {
      expect(() => vitestSetup({ config: { name: "unit-test", root: "." }, provide } as never)).toThrow(RestoreLockError);
      await expect(playwrightSetup()).rejects.toThrow(RestoreLockError);
    } finally {
      releaseRestoreLock(rehearsal);
    }
    const e2eTeardown = await playwrightSetup();
    expect(liveLocks()).not.toBe("");
    await e2eTeardown();
  }, 120_000);
});
