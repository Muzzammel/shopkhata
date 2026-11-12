import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { acceptedRehearsal, releaseReceiptPath, runRestoreChecks } from "../../scripts/backup-verification.mjs";
import { runLockedCommand } from "../../scripts/with-restore-lock.mjs";
import { hostname, tmpdir } from "node:os";
import { join, matchesGlob, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  acquireRestoreLock, assertRestoreLockHeld, INHERIT_ENV, inheritRestoreLock, isAncestor, LOCK_LABEL, lockIdentity, processTable,
  releaseRestoreLock, RestoreLockError, withRestoreLock, queueRestoreCompletion, pinLocalDocker, acquireRestoreOperation, releaseRestoreOperation,
} from "../../scripts/restore-lock.mjs";

// The local database's restore lock lives in the Docker engine that runs the database (scripts/restore-lock.mjs).
// Logic tests use an in-memory Docker engine that enforces unique container names the way the daemon does; the real-Docker
// tests below use throwaway lock targets (never the database's own lock) and only create/inspect/remove lock containers.

type Result = { ok: boolean; stdout: string; stderr: string };
type Container = { id: string; name: string; labels: Record<string, string> };
const IMAGE = `sha256:${"7".repeat(64)}`;

class FakeDocker {
  engine = "engine-a";
  containers = new Map<string, Container>();
  calls: string[][] = [];
  labelFiles: string[] = [];
  down = false;
  failCreate: string | null = null;
  failRm = false;
  dbContainers = new Set(["supabase_db_shopkhata"]);
  databaseId = "d".repeat(64);
  project = "shopkhata";
  composeProject = "shopkhata";
  image = IMAGE;
  running = true;
  serviceImage = "public.ecr.aws/supabase/postgres:17.11.0.003";
  port = "55322";
  volume = "original-volume";
  run = (args: string[]): Result => {
    this.calls.push(args);
    if (this.down) return { ok: false, stdout: "", stderr: "error during connect: the Docker daemon is not running" };
    const [cmd, sub] = args;
    if (cmd === "info") return { ok: true, stdout: this.engine, stderr: "" };
    if (cmd === "container" && sub === "inspect") {
      const ref = args.at(-1)!;
      if (args[3] === "{{.Image}}") return this.dbContainers.has(ref) ? { ok: true, stdout: this.image, stderr: "" } : { ok: false, stdout: "", stderr: `Error: No such container: ${ref}` };
      if (this.dbContainers.has(ref)) return { ok: true, stdout: JSON.stringify({ Id: this.databaseId, Name: `/${ref}`, Image: this.image, Config: { Image: this.serviceImage, Labels: { "com.supabase.cli.project": this.project, "com.docker.compose.project": this.composeProject } }, NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: this.port }] } }, Mounts: [{ Name: this.volume, Destination: "/var/lib/postgresql/data" }], State: { Running: this.running } }), stderr: "" };
      const found = this.find(ref);
      return found ? { ok: true, stdout: JSON.stringify({ Id: found.id, Name: `/${found.name}`, Config: { Labels: found.labels } }), stderr: "" } : { ok: false, stdout: "", stderr: `Error: No such container: ${ref}` };
    }
    if (cmd === "container" && sub === "create") {
      if (this.failCreate) return { ok: false, stdout: "", stderr: this.failCreate };
      const name = args[args.indexOf("--name") + 1];
      const labelFile = args[args.indexOf("--label-file") + 1];
      this.labelFiles.push(labelFile);
      if ([...this.containers.values()].some((c) => c.name === name)) return { ok: false, stdout: "", stderr: `Error response from daemon: Conflict. The container name "/${name}" is already in use by container "x".` };
      const labels = Object.fromEntries(readFileSync(labelFile, "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
      const id = randomBytes(32).toString("hex");
      this.containers.set(id, { id, name, labels });
      return { ok: true, stdout: id, stderr: "" };
    }
    if (cmd === "container" && sub === "rm") {
      if (this.failRm) return { ok: false, stdout: "", stderr: "Error response from daemon: device busy" };
      return this.containers.delete(args[2]) ? { ok: true, stdout: args[2], stderr: "" } : { ok: false, stdout: "", stderr: `Error: No such container: ${args[2]}` };
    }
    return { ok: false, stdout: "", stderr: `unexpected docker ${args.join(" ")}` };
  };
  find = (ref: string) => this.containers.get(ref) ?? [...this.containers.values()].find((c) => c.name === ref);
  // Another party (or a person) creates a container directly, e.g. a replaced lock.
  plant = (name: string, labels: Record<string, string>) => { const id = randomBytes(32).toString("hex"); this.containers.set(id, { id, name, labels }); return id; };
}

const T = "supabase_db_shopkhata";
const deadPid = () => { const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]); return child.pid!; };

describe("lock identity", () => {
  it("depends only on the Docker engine and the database container: not on user profile, home, directory or backup folder", () => {
    const docker = new FakeDocker();
    const first = lockIdentity(T, { docker: docker.run });
    const saved = { ...process.env };
    const cwd = process.cwd();
    try {
      Object.assign(process.env, { USERPROFILE: "C:\\Users\\Someone", HOME: "/home/someone", TEMP: tmpdir(), TMP: tmpdir() });
      process.chdir(tmpdir());
      expect(lockIdentity(T, { docker: docker.run })).toEqual(first);
    } finally {
      process.chdir(cwd);
      process.env = saved;
    }
    expect(first.name).toMatch(/^shopkhata-restore-lock\.supabase_db_shopkhata\.[0-9a-f]{16}$/);
    expect(first.image).toBe(IMAGE);
    docker.engine = "engine-b";
    expect(lockIdentity(T, { docker: docker.run }).name).not.toBe(first.name);
  });

  it.each([["", "empty"], ["../x", "path"], ["a b", "space"], ["-flag", "leading dash"]])("refuses the target name %j (%s)", (target) => {
    expect(() => lockIdentity(target, { docker: new FakeDocker().run })).toThrow(RestoreLockError);
  });

  it("fails closed when Docker is unreachable, reports no identity, or the database container does not exist", () => {
    const down = new FakeDocker(); down.down = true;
    expect(() => acquireRestoreLock(T, "x", { docker: down.run })).toThrow(/Docker is not reachable[^]*fail closed/);
    const blank = new FakeDocker(); blank.engine = "";
    expect(() => acquireRestoreLock(T, "x", { docker: blank.run })).toThrow(/no identity/);
    const missing = new FakeDocker(); missing.dbContainers.clear();
    expect(() => acquireRestoreLock(T, "x", { docker: missing.run })).toThrow(/local database container supabase_db_shopkhata was not found/);
    for (const docker of [down, blank, missing]) expect(docker.calls.some((args) => args[1] === "create")).toBe(false);
  });
});

describe("acquire / release", () => {
  it("creates an inert, offline container from the local database image, the token only in a deleted label file", () => {
    const docker = new FakeDocker();
    const owner = acquireRestoreLock(T, "verify X\nwith newline", { docker: docker.run });
    const create = docker.calls.find((args) => args[1] === "create")!;
    expect(create).toEqual(expect.arrayContaining(["--network", "none", "--pull", "never", "--restart", "no", "--entrypoint", "/bin/true", IMAGE]));
    expect(create.join(" ")).not.toMatch(/ -v | --volume| --mount| -e | --env| --privileged/);
    expect(create.join(" ")).not.toContain(owner.token);
    expect(existsSync(docker.labelFiles[0])).toBe(false);
    const live = docker.find(owner.name)!;
    expect(live.id).toBe(owner.id);
    expect(live.labels).toMatchObject({ [LOCK_LABEL]: "1", [`${LOCK_LABEL}.token`]: owner.token, [`${LOCK_LABEL}.pid`]: String(process.pid), [`${LOCK_LABEL}.host`]: hostname(), [`${LOCK_LABEL}.target`]: T, [`${LOCK_LABEL}.purpose`]: "verify X with newline" });
    expect(releaseRestoreLock(owner, { docker: docker.run })).toBe(true);
    expect(docker.containers.size).toBe(0);
  });

  it("is atomic: a second holder is refused by the name conflict, and the first lock is untouched", () => {
    const docker = new FakeDocker();
    const first = acquireRestoreLock(T, "rehearsal of folder A", { docker: docker.run });
    const before = structuredClone(docker.find(first.name));
    expect(() => acquireRestoreLock(T, "rehearsal of folder B", { docker: docker.run })).toThrow(RestoreLockError);
    expect(() => acquireRestoreLock(T, "rehearsal of folder B", { docker: docker.run })).toThrow(/Another run holds the restore lock[^]*rehearsal of folder A; that process IS running[^]*Nothing was changed/);
    expect(docker.find(first.name)).toEqual(before);
    expect(docker.containers.size).toBe(1);
  });

  it("fails closed on any other create failure", () => {
    const docker = new FakeDocker(); docker.failCreate = "Error response from daemon: no space left on device";
    expect(() => acquireRestoreLock(T, "x", { docker: docker.run })).toThrow(/could not create the restore lock[^]*no space left/);
  });

  it("fails closed, leaving it in place, when the created lock does not carry this owner's token", () => {
    const docker = new FakeDocker();
    const original = docker.run;
    docker.run = (args) => {
      const result = original(args);
      if (args[1] === "create" && result.ok) docker.containers.get(result.stdout)!.labels[`${LOCK_LABEL}.token`] = "tampered";
      return result;
    };
    expect(() => acquireRestoreLock(T, "x", { docker: docker.run })).toThrow(/ownership cannot be verified; it is left in place/);
    expect(docker.containers.size).toBe(1);
  });

  it("never removes a lock whose token no longer matches, or that was replaced under the same name", () => {
    const docker = new FakeDocker();
    const owner = acquireRestoreLock(T, "x", { docker: docker.run });
    docker.find(owner.name)!.labels[`${LOCK_LABEL}.token`] = "someone-else";
    expect(() => releaseRestoreLock(owner, { docker: docker.run })).toThrow(/no longer held by this run/);
    expect(docker.containers.size).toBe(1);
    docker.containers.clear();
    const replacement = docker.plant(owner.name, { [LOCK_LABEL]: "1", [`${LOCK_LABEL}.token`]: "new-owner" });
    expect(() => assertRestoreLockHeld(owner, { docker: docker.run })).toThrow(/no longer held/);
    expect(() => releaseRestoreLock(owner, { docker: docker.run })).toThrow(/no longer held/);
    expect(docker.containers.has(replacement)).toBe(true);
    expect(docker.calls.some((args) => args[1] === "rm")).toBe(false);
  });

  it("reports a failed removal and leaves the lock in place", () => {
    const docker = new FakeDocker();
    const owner = acquireRestoreLock(T, "x", { docker: docker.run });
    docker.failRm = true;
    expect(() => releaseRestoreLock(owner, { docker: docker.run })).toThrow(/could not be removed[^]*left in place/);
    expect(docker.find(owner.id)).toBeDefined();
    expect(docker.find(`${owner.name}.operation`)).toBeDefined();
  });

  it("an abandoned lock (holder gone), however old, is reported with the safe manual procedure and never removed", () => {
    const docker = new FakeDocker();
    const name = lockIdentity(T, { docker: docker.run }).name;
    docker.plant(name, { [LOCK_LABEL]: "1", [`${LOCK_LABEL}.token`]: randomUUID(), [`${LOCK_LABEL}.pid`]: String(deadPid()), [`${LOCK_LABEL}.host`]: hostname(), [`${LOCK_LABEL}.startedAt`]: "2000-01-01T00:00:00.000Z", [`${LOCK_LABEL}.purpose`]: "crashed rehearsal" });
    let message = "";
    try { acquireRestoreLock(T, "next", { docker: docker.run }); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/crashed rehearsal; that process is NOT running \(abandoned\?\)/);
    for (const step of ["node scripts/backup.mjs", "Playwright e2e", "supabase db reset", "pg_stat_activity", name, "docker rm <verified-full-id>", "owner token", "completed-run provenance", "operation leases", "never removed automatically", "docker container prune"]) expect(message).toContain(step);
    expect(docker.containers.size).toBe(1);
    expect(docker.calls.some((args) => args[1] === "rm")).toBe(false);
  });
});

describe("withRestoreLock", () => {
  it("does not strand a new standalone parent when it collides with a previous run's finalization lease", async () => {
    const docker = new FakeDocker();
    const old = acquireRestoreLock(T, "old", { docker: docker.run });
    const run = docker.run;
    let next: Promise<unknown> | undefined;
    const callback = vi.fn();
    docker.run = (args) => {
      const result = run(args);
      if (args[1] === "rm" && args[2] === old.id && result.ok) {
        next = withRestoreLock(T, "new exclusive run", callback, { env: {}, docker: docker.run, exclusive: true }).catch((error) => error);
      }
      return result;
    };
    releaseRestoreLock(old, { docker: docker.run });
    expect(await next).toBeInstanceOf(RestoreLockError);
    expect(callback).not.toHaveBeenCalled();
    expect(docker.containers.size).toBe(0);
  });

  it("operation ownership is verified and an abandoned lease is never reclaimed", () => {
    const docker = new FakeDocker();
    const parent = acquireRestoreLock(T, "parent", { docker: docker.run });
    const lease = acquireRestoreOperation(parent, "crashed", { docker: docker.run });
    expect(() => releaseRestoreOperation({ ...lease, token: "forged" }, { docker: docker.run })).toThrow(/no longer held/);
    expect(docker.find(lease.id)).toBeDefined();
    expect(() => acquireRestoreOperation(parent, "next folder", { docker: docker.run })).toThrow(/operation lease[^]*never removed automatically/);
    expect(docker.find(lease.id)).toBeDefined();
    releaseRestoreOperation(lease, { docker: docker.run });
    releaseRestoreLock(parent, { docker: docker.run });
  });

  it.each([false, true])("failed operation removal cannot publish passing evidence (inherited=%s)", async (inherited) => {
    const docker = new FakeDocker();
    const dir = mkdtempSync(join(tmpdir(), "operation-release-failure-"));
    const path = join(dir, "evidence.json");
    const parent = inherited ? acquireRestoreLock(T, "parent", { docker: docker.run }) : null;
    const env = parent ? { [INHERIT_ENV.id]: parent.id, [INHERIT_ENV.token]: parent.token } : {};
    const run = docker.run;
    docker.run = (args) => args[1] === "rm" && docker.find(args[2])?.name.endsWith(".operation")
      ? { ok: false, stdout: "", stderr: "simulated operation release failure" } : run(args);
    try {
      await expect(withRestoreLock(T, "verify", async (owner) => {
        await runRestoreChecks(path, async (_check: (name: string) => void, record: (value: object) => void) => record({ manifestSha256: "a" }), {
          complete: (evidence) => queueRestoreCompletion(owner, path, evidence, { docker: docker.run }),
        });
      }, { env, docker: docker.run, exclusive: true })).rejects.toThrow(/operation lease[^]*could not be removed/);
      const text = readFileSync(path, "utf8");
      expect(acceptedRehearsal(text, "a").rehearsal).toBeNull();
      expect(existsSync(releaseReceiptPath(path, JSON.parse(text).runId))).toBe(false);
      if (parent) expect(() => releaseRestoreLock(parent, { docker: docker.run })).toThrow(/operation lease/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("failure after queueing a checked result never finalizes that result", async () => {
    const docker = new FakeDocker();
    const parent = acquireRestoreLock(T, "parent", { docker: docker.run });
    const dir = mkdtempSync(join(tmpdir(), "operation-body-failure-"));
    const path = join(dir, "evidence.json");
    try {
      await expect(withRestoreLock(T, "verify", async (owner) => {
        await runRestoreChecks(path, async (_check: (name: string) => void, record: (value: object) => void) => record({ manifestSha256: "a" }), {
          complete: (evidence) => queueRestoreCompletion(owner, path, evidence, { docker: docker.run }),
        });
        throw new Error("failure after checks");
      }, { env: { [INHERIT_ENV.id]: parent.id, [INHERIT_ENV.token]: parent.token }, docker: docker.run, exclusive: true })).rejects.toThrow("failure after checks");
      releaseRestoreLock(parent, { docker: docker.run });
      const text = readFileSync(path, "utf8");
      expect(existsSync(releaseReceiptPath(path, JSON.parse(text).runId))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("exclusive operations refuse legitimate siblings sharing the same inherited parent", async () => {
    const docker = new FakeDocker();
    const parent = acquireRestoreLock(T, "parent", { docker: docker.run });
    const env = { [INHERIT_ENV.id]: parent.id, [INHERIT_ENV.token]: parent.token };
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const deps = { env, docker: docker.run, exclusive: true };
    const record = withRestoreLock(T, "record", async () => { await pending; }, deps);
    try {
      await expect(withRestoreLock(T, "verify", async () => "invalidated", deps)).rejects.toThrow(/operation/i);
    } finally { finish(); await record; releaseRestoreLock(parent, { docker: docker.run }); }
  });
  it.each([false, true])("keeps parent, child and operation ownership across an authorized reset (volume replaced=%s)", async (replaceVolume) => {
    const docker = new FakeDocker();
    const owner = acquireRestoreLock(T, "verify", { docker: docker.run });
    const env = { [INHERIT_ENV.id]: owner.id, [INHERIT_ENV.token]: owner.token };
    const operation = acquireRestoreOperation(owner, "authorized reset", { docker: docker.run });
    docker.databaseId = "e".repeat(64);
    if (replaceVolume) docker.volume = "replacement-volume";
    assertRestoreLockHeld(owner, { docker: docker.run });
    assertRestoreLockHeld(operation, { docker: docker.run });
    expect(inheritRestoreLock(T, env, { docker: docker.run }).id).toBe(owner.id);
    const callback = vi.fn();
    await expect(withRestoreLock(T, "sibling record", callback, { env, docker: docker.run, exclusive: true })).rejects.toThrow(/operation lease/);
    expect(callback).not.toHaveBeenCalled();
    releaseRestoreOperation(operation, { docker: docker.run });
    await withRestoreLock(T, "child verify", async () => undefined, { env, docker: docker.run, exclusive: true });
    releaseRestoreLock(owner, { docker: docker.run });
    expect(docker.containers.size).toBe(0);
  });

  it.each(["project", "composeProject", "engine", "serviceImage", "port", "image"] as const)("rejects replacement with wrong %s before touching evidence or the database", async (field) => {
    const docker = new FakeDocker();
    const owner = acquireRestoreLock(T, "parent", { docker: docker.run });
    docker.databaseId = "e".repeat(64);
    docker[field] = field === "image" ? `sha256:${"8".repeat(64)}` : "unexpected";
    const callback = vi.fn();
    const before = structuredClone([...docker.containers]);
    const calls = docker.calls.length;
    await expect(withRestoreLock(T, "verify", callback, { env: { [INHERIT_ENV.id]: owner.id, [INHERIT_ENV.token]: owner.token }, docker: docker.run, exclusive: true })).rejects.toThrow(RestoreLockError);
    expect(() => assertRestoreLockHeld(owner, { docker: docker.run })).toThrow(RestoreLockError);
    expect(callback).not.toHaveBeenCalled();
    expect([...docker.containers]).toEqual(before);
    expect(docker.calls.slice(calls).every((args) => args[0] === "info" || args[1] === "inspect")).toBe(true);
  });

  it("fails closed during the missing/stopped reset interval and resumes only after the service returns", () => {
    const docker = new FakeDocker();
    const owner = acquireRestoreLock(T, "reset", { docker: docker.run });
    docker.dbContainers.clear();
    expect(() => releaseRestoreLock(owner, { docker: docker.run })).toThrow(RestoreLockError);
    expect(docker.find(owner.id)).toBeDefined();
    docker.dbContainers.add(T);
    docker.running = false;
    expect(() => assertRestoreLockHeld(owner, { docker: docker.run })).toThrow(RestoreLockError);
    docker.running = true;
    docker.databaseId = "f".repeat(64);
    releaseRestoreLock(owner, { docker: docker.run });
    expect(docker.containers.size).toBe(0);
  });

  it.each(["identityVersion", "project", "service", "imageSource", "image", "engine", "target", "kind", "parentId"])("refuses altered lock %s labels without removal", (field) => {
    const docker = new FakeDocker();
    const owner = acquireRestoreLock(T, "parent", { docker: docker.run });
    docker.find(owner.id)!.labels[`${LOCK_LABEL}.${field}`] = "tampered";
    expect(() => releaseRestoreLock(owner, { docker: docker.run })).toThrow(RestoreLockError);
    expect(() => inheritRestoreLock(T, { [INHERIT_ENV.id]: owner.id, [INHERIT_ENV.token]: owner.token }, { docker: docker.run })).toThrow(RestoreLockError);
    expect(docker.find(owner.id)).toBeDefined();
    expect(docker.calls.some((args) => args[1] === "rm")).toBe(false);
  });

  it.each(["tcp://127.0.0.1:2375", "ssh://other", "unix:///tmp/tunnel.sock", ""])("rejects unsupported engine endpoint %j", (endpoint) => {
    expect(() => pinLocalDocker({ DOCKER_HOST: endpoint }, () => ({ ok: true, stdout: endpoint, stderr: "" }))).toThrow(/engine endpoint/);
  });

  it.each(["npipe:////./pipe/docker_engine", "npipe:////./pipe/dockerDesktopLinuxEngine", "unix:///var/run/docker.sock"])("pins the supported local endpoint %s", (endpoint) => {
    const env = { DOCKER_HOST: endpoint, DOCKER_CONTEXT: "possibly-remote" };
    expect(pinLocalDocker(env)).toBe(endpoint);
    expect(env.DOCKER_CONTEXT).toBeUndefined();
  });

  it("a local harness cannot start destructive setup while verification holds the lock", async () => {
    const docker = new FakeDocker();
    const owner = acquireRestoreLock(T, "verify", { docker: docker.run });
    let writes = 0;
    const run = () => { writes++; return { status: 0 }; };
    await expect(runLockedCommand("setup", [], { run, env: {}, docker: docker.run })).rejects.toThrow(/Another run/);
    expect(writes).toBe(0);
    releaseRestoreLock(owner, { docker: docker.run });
    await runLockedCommand("setup", [], { run, env: {}, docker: docker.run });
    expect(writes).toBe(1);
    expect(docker.containers.size).toBe(0);
  });

  it.each(["release fails", "interrupted before release", "receipt write fails", "released"])("passing evidence is recordable only after successful finalization: %s", async (scenario) => {
    const docker = new FakeDocker();
    const dir = mkdtempSync(join(tmpdir(), "round5-finalize-"));
    const path = join(dir, "evidence.json");
    const owner = acquireRestoreLock(T, "verify", { docker: docker.run });
    try {
      await runRestoreChecks(path, async (_check: (name: string) => void, record: (value: object) => void) => record({ manifestSha256: "a".repeat(64) }), {
        complete: (evidence) => queueRestoreCompletion(owner, path, evidence, { docker: docker.run }),
      });
      const text = readFileSync(path, "utf8");
      const evidence = JSON.parse(text);
      const receipt = releaseReceiptPath(path, evidence.runId);
      expect(acceptedRehearsal(text, "a".repeat(64)).rehearsal).toBeNull();
      if (scenario === "release fails") {
        docker.failRm = true;
        expect(() => releaseRestoreLock(owner, { docker: docker.run })).toThrow(/could not be removed/);
        expect(existsSync(receipt)).toBe(false);
      } else if (scenario === "receipt write fails") {
        // Model interruption/disk failure after Docker rm but before the atomic receipt rename.
        rmSync(dir, { recursive: true, force: true });
        expect(() => releaseRestoreLock(owner, { docker: docker.run })).toThrow();
        expect(docker.containers.size).toBe(0);
        expect(acceptedRehearsal(text, "a".repeat(64), null).rehearsal).toBeNull();
      } else if (scenario === "released") {
        releaseRestoreLock(owner, { docker: docker.run });
        const release = readFileSync(receipt, "utf8");
        expect(acceptedRehearsal(text, "a".repeat(64), release).rehearsal?.ok).toBe(true);
        await runRestoreChecks(path, async () => {});
        expect(acceptedRehearsal(readFileSync(path, "utf8"), "a".repeat(64), release).rehearsal).toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(tmpdir(), `shopkhata-lock-finalize-${owner.id}`), { recursive: true, force: true });
    }
  });

  it("an inherited rehearsal is finalized only when its parent releases", async () => {
    const docker = new FakeDocker();
    const parent = acquireRestoreLock(T, "integration", { docker: docker.run });
    const inherited = inheritRestoreLock(T, { [INHERIT_ENV.id]: parent.id, [INHERIT_ENV.token]: parent.token }, {
      docker: docker.run, table: () => new Map(), running: () => true,
    });
    const dir = mkdtempSync(join(tmpdir(), "round5-parent-"));
    const path = join(dir, "evidence.json");
    try {
      await runRestoreChecks(path, async (_check: (name: string) => void, record: (value: object) => void) => record({ manifestSha256: "a" }), {
        complete: (evidence) => queueRestoreCompletion(inherited, path, evidence, { docker: docker.run }),
      });
      const text = readFileSync(path, "utf8");
      const receipt = releaseReceiptPath(path, JSON.parse(text).runId);
      expect(releaseRestoreLock(inherited, { docker: docker.run })).toBe(false);
      expect(existsSync(receipt)).toBe(false);
      releaseRestoreLock(parent, { docker: docker.run });
      expect(acceptedRehearsal(text, "a", readFileSync(receipt, "utf8")).rehearsal?.ok).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses work completion on a different Docker engine", () => {
    const docker = new FakeDocker();
    const owner = acquireRestoreLock(T, "verify", { docker: docker.run });
    docker.engine = "wrong-engine";
    expect(() => assertRestoreLockHeld(owner, { docker: docker.run })).toThrow(/engine/i);
  });

  it("local record excludes verification throughout its evidence read and database write", async () => {
    const docker = new FakeDocker();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const record = withRestoreLock(T, "record", async () => { await gate; return "recorded"; }, { env: {}, docker: docker.run });
    await expect(withRestoreLock(T, "verify", async () => "invalidated", { env: {}, docker: docker.run })).rejects.toThrow(/Another run/);
    finish();
    await expect(record).resolves.toBe("recorded");
  });

  it("verification cannot invalidate evidence between a local record read and write", async () => {
    const docker = new FakeDocker();
    const dir = mkdtempSync(join(tmpdir(), "round5-record-race-"));
    const path = join(dir, "evidence.json");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    try {
      await runRestoreChecks(path, async (_check: (name: string) => void, record: (value: object) => void) => record({ manifestSha256: "a" }));
      const text = readFileSync(path, "utf8");
      const recording = withRestoreLock(T, "record", async () => {
        const read = readFileSync(path, "utf8");
        await gate;
        return read === readFileSync(path, "utf8") ? "consistent record" : "stale record";
      }, { env: {}, docker: docker.run });
      await expect(withRestoreLock(T, "verify", async () => runRestoreChecks(path, async () => {}), { env: {}, docker: docker.run })).rejects.toThrow(/Another run/);
      expect(readFileSync(path, "utf8")).toBe(text);
      finish();
      expect(await recording).toBe("consistent record");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("releases on success and on failure; does not run the work when the lock is held", async () => {
    const docker = new FakeDocker();
    await expect(withRestoreLock(T, "ok", async () => { expect(docker.containers.size).toBe(1); return 7; }, { env: {}, docker: docker.run })).resolves.toBe(7);
    expect(docker.containers.size).toBe(0);
    await expect(withRestoreLock(T, "fail", async () => { throw new Error("late check failed"); }, { env: {}, docker: docker.run })).rejects.toThrow("late check failed");
    expect(docker.containers.size).toBe(0);
    acquireRestoreLock(T, "other run", { docker: docker.run });
    const work = vi.fn();
    await expect(withRestoreLock(T, "second", work, { env: {}, docker: docker.run })).rejects.toThrow(RestoreLockError);
    expect(work).not.toHaveBeenCalled();
  });

  it("a release failure after successful work fails the command; after failed work the original error wins", async () => {
    const docker = new FakeDocker();
    await expect(withRestoreLock(T, "x", async () => { docker.failRm = true; }, { env: {}, docker: docker.run })).rejects.toThrow(/could not be removed/);
    docker.containers.clear(); docker.failRm = false;
    const warn = vi.fn();
    await expect(withRestoreLock(T, "x", async () => { docker.failRm = true; throw new Error("original"); }, { env: {}, docker: docker.run, warn })).rejects.toThrow("original");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be removed"));
  });

  it("a destructive child not confirmed stopped (leaseAbandoned) keeps the lock and lease; the abandoned operation stays fail-closed", async () => {
    const abandoned = () => Object.assign(new Error("reset timed out; tree not confirmed terminated"), { leaseAbandoned: true });
    // Standalone exclusive run (`node scripts/backup.mjs verify`): neither the database lock nor its lease is released.
    const docker = new FakeDocker();
    const warn = vi.fn();
    await expect(withRestoreLock(T, "verify", async () => { throw abandoned(); }, { env: {}, docker: docker.run, exclusive: true, warn })).rejects.toThrow("not confirmed terminated");
    expect([...docker.containers.values()].map((c) => c.labels[`${LOCK_LABEL}.kind`]).sort()).toEqual(["database", "operation"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("left in place (fail closed)"));
    await expect(withRestoreLock(T, "next run", vi.fn(), { env: {}, docker: docker.run })).rejects.toThrow(/Another run holds the restore lock/);
    // Inherited (a test run's child): its lease stays, so the parent run cannot release the database lock.
    const parentDocker = new FakeDocker();
    const parent = acquireRestoreLock(T, "vitest run", { docker: parentDocker.run });
    const env = { [INHERIT_ENV.id]: parent.id, [INHERIT_ENV.token]: parent.token };
    await expect(withRestoreLock(T, "child verify", async () => { throw abandoned(); }, { env, docker: parentDocker.run, exclusive: true, table: () => new Map([[process.pid, parent.pid]]), running: () => true, warn: vi.fn() })).rejects.toThrow("not confirmed terminated");
    expect([...parentDocker.containers.values()].some((c) => c.labels[`${LOCK_LABEL}.kind`] === "operation")).toBe(true);
    expect(() => releaseRestoreLock(parent, { docker: parentDocker.run })).toThrow(/exclusive operation lease/);
    expect(parentDocker.find(parent.id)).toBeTruthy();
  });
});

describe("child inheritance", () => {
  const parent = (docker: FakeDocker, overrides: Record<string, string> = {}) => {
    const owner = acquireRestoreLock(T, "integration run", { docker: docker.run });
    Object.assign(docker.find(owner.name)!.labels, overrides);
    return owner;
  };
  const env = (owner: { id: string; token: string }) => ({ [INHERIT_ENV.id]: owner.id, [INHERIT_ENV.token]: owner.token });
  const ancestry = (owner: number) => () => new Map([[process.pid, 4242], [4242, owner], [owner, 1]]);

  it("accepts the live lock of this database whose running owner is an ancestor, and never releases it", async () => {
    const docker = new FakeDocker();
    const owner = parent(docker, { [`${LOCK_LABEL}.pid`]: "777" });
    const inherited = inheritRestoreLock(T, env(owner), { docker: docker.run, table: ancestry(777), running: (pid: number) => pid === 777 });
    expect(inherited).toMatchObject({ id: owner.id, inherited: true, pid: 777 });
    expect(releaseRestoreLock(inherited, { docker: docker.run })).toBe(false);
    expect(docker.containers.size).toBe(1);
    const ran = await withRestoreLock(T, "child", async (lock: { inherited: boolean }) => lock.inherited, { env: env(owner), docker: docker.run, table: ancestry(777), running: () => true });
    expect(ran).toBe(true);
    expect(docker.containers.size).toBe(1);
    expect(docker.calls.some((args) => args[1] === "rm")).toBe(false);
  });

  it.each([
    ["a wrong token", (o: { id: string; token: string }) => ({ [INHERIT_ENV.id]: o.id, [INHERIT_ENV.token]: "forged" }), {}, /token mismatch/],
    ["only one variable", (o: { id: string; token: string }) => ({ [INHERIT_ENV.token]: o.token }), {}, /needs both/],
    ["an unknown container", () => ({ [INHERIT_ENV.id]: "f".repeat(64), [INHERIT_ENV.token]: "t" }), {}, /no such lock container/],
    ["a lock from another host", env, { [`${LOCK_LABEL}.host`]: "other-host" }, /another host/],
    ["an owner that is not running", env, { [`${LOCK_LABEL}.pid`]: "778" }, /not running/],
    ["an owner that is not an ancestor", env, { [`${LOCK_LABEL}.pid`]: "999" }, /not an ancestor/],
  ])("refuses %s", (_name, envFor, overrides, message) => {
    const docker = new FakeDocker();
    const owner = parent(docker, { [`${LOCK_LABEL}.pid`]: "777", ...overrides });
    expect(() => inheritRestoreLock(T, envFor(owner), { docker: docker.run, table: ancestry(777), running: (pid: number) => pid === 777 || pid === 999 })).toThrow(message);
  });

  it("refuses a container that is not this database's lock (another target, or not a lock at all)", () => {
    const docker = new FakeDocker();
    docker.dbContainers.add("other_db");
    const foreign = acquireRestoreLock("other_db", "x", { docker: docker.run, imageSource: T });
    expect(() => inheritRestoreLock(T, env(foreign), { docker: docker.run, table: ancestry(process.pid), running: () => true })).toThrow(/is not the lock of supabase_db_shopkhata/);
    const plain = docker.plant("some_app", { [`${LOCK_LABEL}.token`]: "t" });
    expect(() => inheritRestoreLock(T, { [INHERIT_ENV.id]: plain, [INHERIT_ENV.token]: "t" }, { docker: docker.run, table: ancestry(process.pid), running: () => true })).toThrow(/not the lock/);
  });

  it("G6-B: a reset that recreates the database on the same image keeps the lock; one onto another image is refused", () => {
    const docker = new FakeDocker();
    const owner = parent(docker, { [`${LOCK_LABEL}.pid`]: "777" });
    const inherit = () => inheritRestoreLock(T, env(owner), { docker: docker.run, table: ancestry(777), running: (pid: number) => pid === 777 });
    docker.databaseId = "e".repeat(64);
    docker.volume = "recreated-volume";
    expect(inherit()).toMatchObject({ id: owner.id, inherited: true });
    docker.databaseId = "f".repeat(64);
    docker.serviceImage = "public.ecr.aws/supabase/postgres:17.11.0.004";
    docker.image = `sha256:${"4".repeat(64)}`;
    expect(inherit).toThrow(/engine or database service identity mismatch/);
    expect(docker.find(owner.id)).toBeDefined();
  });

  it("the replaced lock (same name, new container) cannot be inherited with the old id", () => {
    const docker = new FakeDocker();
    const owner = parent(docker, { [`${LOCK_LABEL}.pid`]: "777" });
    docker.containers.clear();
    docker.plant(owner.name, { [LOCK_LABEL]: "1", [`${LOCK_LABEL}.token`]: owner.token, [`${LOCK_LABEL}.pid`]: "777", [`${LOCK_LABEL}.host`]: hostname() });
    expect(() => inheritRestoreLock(T, env(owner), { docker: docker.run, table: ancestry(777), running: () => true })).toThrow(/no such lock container/);
  });

  it("withRestoreLock never falls back to acquiring when an inheritance is claimed but invalid", async () => {
    const docker = new FakeDocker();
    const work = vi.fn();
    await expect(withRestoreLock(T, "x", work, { env: { [INHERIT_ENV.id]: "f".repeat(64), [INHERIT_ENV.token]: "t" }, docker: docker.run })).rejects.toThrow(RestoreLockError);
    expect(work).not.toHaveBeenCalled();
    expect(docker.calls.some((args) => args[1] === "create")).toBe(false);
  });
});

describe("participation: every entry point that resets or changes the local database holds the lock", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  const configs = readdirSync(".").filter((name) => /^vitest\..*\.mts$/.test(name));
  const lockConfigs = configs.filter((name) => name !== "vitest.config.mts");
  const testFiles = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? testFiles(join(root, entry.name)) : [join(root, entry.name).replace(/\\/g, "/")]);
  const includes = (config: string) => [...read(config).matchAll(/include: \[([^\]]*)\]/g)].flatMap((match) => [...match[1].matchAll(/"([^"]+)"/g)].map((glob) => glob[1]));

  it("every vitest config except the unit one spreads the shared restore-lock setup", () => {
    expect(lockConfigs.length).toBeGreaterThanOrEqual(11);
    for (const config of lockConfigs) {
      expect(read(config), config).toContain('import { restoreLock } from "./tests/integration/restore-lock.config";');
      expect(read(config), config).toMatch(/test: \{[^]*\.\.\.restoreLock,/);
    }
    expect(read("tests/integration/restore-lock.config.ts")).toContain('globalSetup: ["tests/integration/restore-lock.global-setup.ts"]');
    expect(read("tests/integration/restore-lock.config.ts")).toContain('setupFiles: ["tests/integration/restore-lock.inherit.ts"]');
  });

  it("Playwright's whole run holds it", () => {
    expect(read("playwright.config.ts")).toContain('globalSetup: "./tests/e2e/restore-lock.global-setup.ts"');
  });

  it("the retained local harness locks before reset; CI lifecycle is disposable and sequential", () => {
    const harness = read("docs/release/evidence/ops-01b-slice1-final-invariants/harness/e2e-run.ps1");
    expect(harness.indexOf("with-restore-lock.mjs\" --assert")).toBeLessThan(harness.indexOf('cmd /c "pnpm.cmd exec supabase --agent no db reset'));
    const ci = read(".github/workflows/ci.yml").split("  integration:")[1];
    expect(ci).toContain("runs-on: ubuntu-latest");
    expect(ci).not.toMatch(/runs-on:.*self-hosted|DOCKER_HOST:|DOCKER_CONTEXT:|strategy:/);
    // Server startup runs application commands only; no destructive setup is hidden before globalSetup.
    const commands = [...read("playwright.config.ts").matchAll(/command: "([^"]+)"/g)].map((m) => m[1]);
    expect(commands).toEqual(["pnpm dev", "pnpm build && pnpm exec next start -p 3100"]);
    const scripts = JSON.parse(read("package.json")).scripts;
    for (const hook of ["predev", "postdev", "prebuild", "postbuild", "prestart", "poststart"]) expect(scripts[hook]).toBeUndefined();
  });

  it("every test file that resets, restores or seeds the database is included by a locked config; unit tests never do", () => {
    const destructive = /db", "reset"|db reset|resetLocal\(|scripts\/backup\.mjs|backupTool\(|localDbQuery\(|truncate |delete from /;
    const covered = lockConfigs.flatMap(includes);
    const offenders = [...testFiles("tests/integration"), ...testFiles("tests/perf")]
      .filter((file) => /\.test\.ts$/.test(file) && destructive.test(read(file)))
      .filter((file) => !covered.some((glob) => matchesGlob(file, glob)));
    expect(offenders).toEqual([]);
    const unitOffenders = testFiles("tests/unit").filter((file) => /db", "reset"|db reset|localDbQuery\(|psql\(/.test(read(file)) && !file.endsWith("restore-lock.test.ts"));
    expect(unitOffenders).toEqual([]);
    expect(includes("vitest.config.mts")).toEqual(["tests/unit/**/*.test.ts"]);
  });
});

describe("process ancestry", () => {
  it("walks parent links, including the process itself, and stops on cycles and gaps", () => {
    const table = new Map([[10, 5], [5, 1], [1, 0], [20, 21], [21, 20]]);
    expect(isAncestor(10, 10, table)).toBe(true);
    expect(isAncestor(1, 10, table)).toBe(true);
    expect(isAncestor(5, 1, table)).toBe(false);
    expect(isAncestor(99, 20, table)).toBe(false);
    expect(isAncestor(99, 30, table)).toBe(false);
  });

  it("reads the real process table: this process's parent is its ancestor", () => {
    const table = processTable();
    expect(table.get(process.pid)).toBe(process.ppid);
    expect(isAncestor(process.ppid, process.pid, table)).toBe(true);
  }, 60_000);
});

// Real Docker engine, throwaway targets only (the lock name is derived from the target, so these can never collide with
// the local database's own lock). Skipped where the local stack (whose image they borrow) does not exist.
const docker = (args: string[]) => spawnSync("docker", args, { encoding: "utf8", windowsHide: true });
const realStack = process.env.SHOPKHATA_LOCK_DOCKER_TESTS === "1" && docker(["container", "inspect", "--format", "{{.Image}}", T]).status === 0;
const testTargets: string[] = [];
const testTarget = () => { const target = `shopkhata_locktest_${randomBytes(4).toString("hex")}`; testTargets.push(target); return target; };
const locksOf = (target: string) => docker(["ps", "-a", "--filter", `label=${LOCK_LABEL}.target=${target}`, "--format", "{{.ID}}"]).stdout.trim().split(/\s+/).filter(Boolean);

describe.skipIf(!realStack)("real Docker engine (throwaway lock targets)", () => {
  afterAll(() => { for (const target of testTargets) for (const id of locksOf(target)) docker(["container", "rm", id]); });
  const moduleUrl = pathToFileURL(resolve("scripts/restore-lock.mjs")).href;
  const child = (code: string, env: NodeJS.ProcessEnv = process.env, cwd?: string) => spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"], env, cwd });
  const output = (proc: ReturnType<typeof child>) => new Promise<string>((done) => { let out = ""; proc.stdout.on("data", (d) => { out += d; }); proc.on("close", () => done(out.trim())); });

  it("the daemon's unique container names let exactly one of many concurrent processes hold the lock", async () => {
    const target = testTarget();
    const code = `import { acquireRestoreLock, releaseRestoreLock } from ${JSON.stringify(moduleUrl)};
      let owner; try { owner = acquireRestoreLock(${JSON.stringify(target)}, "race " + process.pid, { imageSource: ${JSON.stringify(T)} }); console.log("GOT"); } catch (e) { console.log(e.constructor.name); }
      await new Promise((r) => setTimeout(r, 4000)); if (owner) releaseRestoreLock(owner);`;
    const results = await Promise.all(Array.from({ length: 6 }, () => output(child(code))));
    expect(results.filter((line) => line === "GOT")).toHaveLength(1);
    expect(results.filter((line) => line === "RestoreLockError")).toHaveLength(5);
    expect(locksOf(target)).toEqual([]);
  }, 120_000);

  it("different user profiles and directories resolve the same lock, and one blocks the other", async () => {
    const target = testTarget();
    const elsewhere = mkdtempSync(join(tmpdir(), "shopkhata-profile-"));
    try {
      const nameIn = (env: NodeJS.ProcessEnv, cwd?: string) => output(child(`import { lockIdentity } from ${JSON.stringify(moduleUrl)}; console.log(lockIdentity(${JSON.stringify(target)}, { imageSource: ${JSON.stringify(T)} }).name);`, env, cwd));
      const other = { ...process.env, USERPROFILE: elsewhere, HOME: elsewhere, TEMP: elsewhere, TMP: elsewhere, HOMEPATH: "\\elsewhere" };
      const [mine, theirs] = await Promise.all([nameIn(process.env), nameIn(other, elsewhere)]);
      expect(mine).toMatch(/^shopkhata-restore-lock\./);
      expect(theirs).toBe(mine);
      const owner = acquireRestoreLock(target, "profile A", { imageSource: T });
      try {
        const attempt = await output(child(`import { acquireRestoreLock } from ${JSON.stringify(moduleUrl)}; try { acquireRestoreLock(${JSON.stringify(target)}, "profile B", { imageSource: ${JSON.stringify(T)} }); console.log("GOT"); } catch (e) { console.log(e.constructor.name); }`, other, elsewhere));
        expect(attempt).toBe("RestoreLockError");
      } finally {
        releaseRestoreLock(owner);
      }
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 120_000);

  it("a crashed holder leaves the lock; it is refused as abandoned, never removed automatically, until removed by hand", async () => {
    const target = testTarget();
    await output(child(`import { acquireRestoreLock } from ${JSON.stringify(moduleUrl)}; acquireRestoreLock(${JSON.stringify(target)}, "crashing run", { imageSource: ${JSON.stringify(T)} }); process.exit(9);`));
    const [abandoned] = locksOf(target);
    expect(abandoned).toBeTruthy();
    expect(() => acquireRestoreLock(target, "next", { imageSource: T })).toThrow(/crashing run; that process is NOT running \(abandoned\?\)[^]*never removed automatically/);
    expect(locksOf(target)).toEqual([abandoned]);
    expect(docker(["container", "rm", abandoned]).status).toBe(0); // the operator's manual step
    releaseRestoreLock(acquireRestoreLock(target, "next", { imageSource: T }));
    expect(locksOf(target)).toEqual([]);
  }, 120_000);

  it("the lock container is created, never started, offline and without mounts", () => {
    const target = testTarget();
    const owner = acquireRestoreLock(target, "inspect", { imageSource: T });
    try {
      const info = JSON.parse(docker(["container", "inspect", "--format", "{{json .}}", owner.id]).stdout);
      expect(info.State.Status).toBe("created");
      expect(info.HostConfig.NetworkMode).toBe("none");
      expect(info.Mounts).toEqual([]);
      expect(info.HostConfig.Binds ?? []).toEqual([]);
      expect(info.HostConfig.Privileged).toBe(false);
    } finally {
      releaseRestoreLock(owner);
    }
  });
});
