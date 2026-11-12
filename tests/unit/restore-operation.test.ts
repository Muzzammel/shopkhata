import { fork, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireRestoreLock, INHERIT_ENV, releaseRestoreLock } from "../../scripts/restore-lock.mjs";
import { acceptedRehearsal, releaseReceiptPath } from "../../scripts/backup-verification.mjs";
import { operationDocker } from "./helpers/operation-docker.mjs";

const childPath = resolve("tests/unit/helpers/operation-child.mjs");
function launch(root: string, mode: string, evidence: string, folder: string, parent: { id: string; token: string }, override: object = {}) {
  const child = fork(childPath, [root, mode, evidence, folder], { silent: true, env: { ...process.env,
    [INHERIT_ENV.id]: parent.id, [INHERIT_ENV.token]: parent.token, ...override,
  } });
  const messages: { held?: boolean; refused?: boolean; error?: string; done?: boolean; checked?: boolean }[] = [];
  const waiters: (() => void)[] = [];
  child.on("message", (message) => { messages.push(message as typeof messages[number]); waiters.splice(0).forEach((done) => done()); });
  const exit = new Promise<number | null>((done) => child.once("exit", done));
  return { child, exit, next: async () => { if (!messages.length) await new Promise<void>((done) => waiters.push(done)); return messages.shift()!; } };
}

describe("real sibling processes, shared parent lock, no database", () => {
  it.each([
    ["record", false], ["verify", false], ["record", true], ["verify", true],
  ])("%s excludes its sibling (different backup folders=%s)", async (firstMode, differentFolders) => {
    const dir = mkdtempSync(join(tmpdir(), "shopkhata-operation-test-"));
    const root = join(dir, "daemon");
    // daemon substitute has its own directory, separate from evidence files.
    mkdirSync(root);
    const docker = operationDocker(root);
    const parent = acquireRestoreLock("supabase_db_shopkhata", "test parent", { docker });
    const evidence = join(dir, "evidence.json");
    const stale = JSON.stringify({ ok: true, status: "passed", runId: "old", manifestSha256: "a", verifiedAt: "old" });
    writeFileSync(evidence, stale);
    const siblingEvidence = differentFolders ? join(dir, "backup-B-evidence.json") : evidence;
    if (differentFolders) writeFileSync(siblingEvidence, stale);
    const first = launch(root, firstMode, evidence, "backup-A", parent);
    let second: ReturnType<typeof launch> | undefined;
    try {
      expect(await first.next()).toMatchObject({ held: true });
      const heldEvidence = readFileSync(evidence, "utf8");
      second = launch(root, firstMode === "record" ? "verify" : "record", siblingEvidence, differentFolders ? "backup-B" : "backup-A", parent);
      expect(await second.next()).toMatchObject({ refused: true, error: expect.stringContaining("operation lease") });
      expect(await second.exit).toBe(1);
      expect(readFileSync(evidence, "utf8")).toBe(heldEvidence);
      if (differentFolders) expect(readFileSync(siblingEvidence, "utf8")).toBe(stale);
      // Teardown must not remove the shared DB lock beneath an active child operation.
      expect(() => releaseRestoreLock(parent, { docker })).toThrow(/operation lease/);
      first.child.send("finish");
      expect(await first.next()).toMatchObject({ done: true });
      expect(await first.exit).toBe(0);
      if (firstMode === "record") expect(readFileSync(`${evidence}.recorded`, "utf8")).toBe(stale);
      else expect(acceptedRehearsal(readFileSync(evidence, "utf8"), "a").rehearsal).toBeNull();
      releaseRestoreLock(parent, { docker });
      if (firstMode === "verify") {
        const text = readFileSync(evidence, "utf8");
        const receipt = readFileSync(releaseReceiptPath(evidence, JSON.parse(text).runId), "utf8");
        expect(acceptedRehearsal(text, "a", receipt).rehearsal?.ok).toBe(true);
      }
      expect(readdirSync(root)).toEqual([]);
    } finally {
      if (first.child.exitCode === null) first.child.kill();
      if (second?.child.exitCode === null) second.child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(["fail", "crash", "verify-crash", "checked-crash", "forged", "unauthorized"])("fails closed for %s without automatic abandoned-lease reclamation", async (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), "shopkhata-operation-failure-"));
    const root = join(dir, "daemon");
    mkdirSync(root);
    const docker = operationDocker(root);
    const parent = acquireRestoreLock("supabase_db_shopkhata", "parent", { docker });
    const unrelated = scenario === "unauthorized" ? spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "ignore", windowsHide: true }) : null;
    if (unrelated) {
      const path = join(root, parent.name, "container.json");
      const live = JSON.parse(readFileSync(path, "utf8"));
      live.Config.Labels["com.shopkhata.restore-lock.pid"] = String(unrelated.pid);
      writeFileSync(path, JSON.stringify(live));
    }
    const evidence = join(dir, "evidence.json");
    const original = JSON.stringify({ ok: true, status: "passed", runId: "old", manifestSha256: "a", verifiedAt: "old" });
    const oldReceipt = JSON.stringify({ released: true, runId: "old", manifestSha256: "a" });
    writeFileSync(evidence, original);
    expect(acceptedRehearsal(original, "a", oldReceipt).rehearsal?.ok).toBe(true);
    const first = launch(root, scenario === "checked-crash" ? "checked-crash" : scenario === "verify-crash" ? "verify" : "record", evidence, "A", parent, scenario === "forged" ? { [INHERIT_ENV.token]: "wrong" } : {});
    try {
      if (scenario === "forged" || scenario === "unauthorized") expect(await first.next()).toMatchObject({ refused: true, error: expect.stringContaining(scenario === "forged" ? "token mismatch" : "not an ancestor") });
      else {
        expect(await first.next()).toMatchObject({ held: true });
        if (scenario === "checked-crash") {
          first.child.send("finish");
          expect(await first.next()).toMatchObject({ checked: true });
          first.child.kill();
        } else if (scenario === "crash" || scenario === "verify-crash") first.child.kill(); else first.child.send("fail");
      }
      await first.exit;
      if (scenario === "verify-crash" || scenario === "checked-crash") {
        const current = readFileSync(evidence, "utf8");
        expect(JSON.parse(current)).toMatchObject(scenario === "verify-crash" ? { ok: false, status: "running" } : { ok: true, status: "passed" });
        expect(acceptedRehearsal(current, "a", oldReceipt).rehearsal).toBeNull();
      } else expect(readFileSync(evidence, "utf8")).toBe(original);
      expect(existsSync(`${evidence}.recorded`)).toBe(false);
      if (scenario === "crash" || scenario === "verify-crash" || scenario === "checked-crash") {
        const next = launch(root, "verify", evidence, "B", parent);
        expect(await next.next()).toMatchObject({ refused: true, error: expect.stringContaining("operation lease") });
        expect(await next.exit).toBe(1);
        expect(() => releaseRestoreLock(parent, { docker })).toThrow(/operation lease/);
        expect(readdirSync(root).some((name) => name.endsWith(".operation"))).toBe(true);
        if (scenario === "checked-crash") {
          // Even manual removal of the abandoned operation cannot manufacture a release receipt.
          const abandoned = JSON.parse(readFileSync(join(root, `${parent.name}.operation`, "container.json"), "utf8"));
          docker(["container", "rm", abandoned.Id]);
          expect(() => releaseRestoreLock(parent, { docker })).toThrow(/did not finalize/);
          const text = readFileSync(evidence, "utf8");
          expect(existsSync(releaseReceiptPath(evidence, JSON.parse(text).runId))).toBe(false);
        }
      } else {
        releaseRestoreLock(parent, { docker });
        expect(readdirSync(root)).toEqual([]);
      }
    } finally {
      unrelated?.kill();
      if (first.child.exitCode === null) first.child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
