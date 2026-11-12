// Restore lock: ONE per local Supabase database, held in the Docker engine that runs that database.
//
// Anything that resets, restores or destructively changes the local database takes it first: `node scripts/backup.mjs
// verify`, `restore`/`restore-receipts` into a local target, and every integration / performance / e2e test run (their
// global setup, tests/integration/restore-lock.*). Whoever can reset the database can reach this Docker engine, so the
// lock coordinates participating users/checkouts using this verified local daemon. Unrelated engines do not coordinate.
//
// Identity: the container NAME `shopkhata-restore-lock.<db service>.<hash of engine ID + db service>`. Docker refuses
// a second container with the same name, so acquisition is one atomic step (no check-then-create). The container is only
// created, never started: no network, no mounts, no credentials; it uses the database container's own image (already
// local, never pulled). Its labels hold the owner: a random token, host, pid, purpose and start time. The labels go in
// through a temporary --label-file, so the token never appears on a command line or in a log.
//
// Release removes the container by its ID, and only after checking that the ID still carries this owner's token. Any
// Docker failure, a missing database service, or ownership that cannot be verified fails closed. The verified engine,
// Supabase project, database service and image are stable across resets; container IDs and volumes are observations,
// never ownership keys. A reset may replace them while this lock remains held. Validation during the missing/stopped
// interval still fails closed; callers must wait for reset completion before resuming database work or finalization.
//
// Child processes (a test that runs `node scripts/backup.mjs verify` while its run holds the lock) inherit it through
// SHOPKHATA_RESTORE_LOCK_ID / SHOPKHATA_RESTORE_LOCK_TOKEN. The token alone is not trusted: the live container must be
// this database's lock, carry that token, belong to this host, and its owner pid must be running and be the child's own
// ancestor. An inherited lock is never released by the child.
//
// ADVISORY: only the participants above honour it; a manual `supabase db reset`, psql session or `docker exec` does not.
// ABANDONED LOCK (the holder crashed or was killed): never removed automatically, however old. See abandonedHelp().
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { releaseReceiptPath, writeJsonAtomic } from "./backup-verification.mjs";

export class RestoreLockError extends Error {}

export const LOCK_LABEL = "com.shopkhata.restore-lock";
export const INHERIT_ENV = Object.freeze({ id: "SHOPKHATA_RESTORE_LOCK_ID", token: "SHOPKHATA_RESTORE_LOCK_TOKEN" });

// docker <args> -> { ok, stdout, stderr }. Injected in tests.
export function dockerCli(args) {
  const run = spawnSync("docker", args, { encoding: "utf8", timeout: 60_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  return { ok: !run.error && run.status === 0, stdout: (run.stdout ?? "").trim(), stderr: (run.stderr || run.error?.message || `exit ${run.status}`).trim() };
}

// Only a local daemon endpoint is supported. Pin it for ALL child Docker/Supabase commands;
// a later `docker context use` in another terminal must not redirect destructive work.
/** @param {Record<string, string | undefined>} [env] @param {typeof dockerCli} [docker] */
export function pinLocalDocker(env = process.env, docker = dockerCli) {
  const context = env.DOCKER_HOST ? null : docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  const endpoint = env.DOCKER_HOST || (context?.ok ? context.stdout : "");
  if (!/^npipe:\/\/\/\/\.\/pipe\/docker(?:DesktopLinuxEngine|_engine)$/.test(endpoint)
      && endpoint !== "unix:///var/run/docker.sock") throw closed("unsupported or ambiguous Docker engine endpoint; use the local Docker daemon");
  env.DOCKER_HOST = endpoint;
  delete env.DOCKER_CONTEXT;
  return endpoint;
}

const closed = (what, detail) => new RestoreLockError(`${what}; the restore lock cannot be used, so nothing was changed (fail closed)${detail ? `: ${detail}` : "."}`);
const label = (key) => `${LOCK_LABEL}.${key}`;

// The lock of one local database container on this Docker engine. `imageSource` exists only for tests (a throwaway
// target borrowing the database image); the lock name never depends on it.
export function lockIdentity(target, { docker = dockerCli, imageSource = target } = {}) {
  if (typeof target !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(target)) throw closed(`"${target}" is not a container name`);
  const info = docker(["info", "--format", "{{.ID}}"]);
  if (!info.ok) throw closed("Docker is not reachable", info.stderr);
  const engine = info.stdout;
  if (!engine || engine === "<no value>") throw closed("the Docker engine reports no identity");
  const image = docker(["container", "inspect", "--format", "{{.Image}}", imageSource]);
  if (!image.ok) throw closed(`the local database container ${imageSource} was not found`, image.stderr);
  if (!/^sha256:[0-9a-f]{64}$/.test(image.stdout)) throw closed(`unexpected image of ${imageSource}`, image.stdout);
  const inspected = docker(["container", "inspect", "--format", "{{json .}}", imageSource]);
  let database;
  try { database = JSON.parse(inspected.stdout); } catch { throw closed("unreadable database container identity"); }
  if (!inspected.ok || !/^[0-9a-f]{64}$/.test(database.Id) || database.Name !== `/${imageSource}`
      || imageSource !== "supabase_db_shopkhata"
      || database.Config?.Labels?.["com.supabase.cli.project"] !== "shopkhata"
      || database.Config?.Labels?.["com.docker.compose.project"] !== "shopkhata"
      || !/^(?:public\.ecr\.aws\/supabase|supabase)\/postgres:[a-zA-Z0-9_.-]+$/.test(database.Config?.Image ?? "")
      || database.Image !== image.stdout
      || !database.NetworkSettings?.Ports?.["5432/tcp"]?.some((port) => ["127.0.0.1", "0.0.0.0"].includes(port.HostIp) && port.HostPort === "55322")
      || database.State?.Running !== true) {
    throw closed("wrong or stopped local database container");
  }
  const hash = createHash("sha256").update(`${engine}\n${target}`).digest("hex").slice(0, 16);
  return { engine, target, imageSource, project: "shopkhata", service: "postgres", databaseId: database.Id, name: `shopkhata-restore-lock.${target}.${hash}`, image: image.stdout };
}

// Versioned labels prohibit inheritance from an older container-ID-bound lock. Keep the same atomic name so an old
// abandoned lock continues to exclude new acquisition until an operator safely removes it.
function matchesIdentity(live, identity) {
  return live.labels[LOCK_LABEL] === "1" && live.labels[label("identityVersion")] === "2"
    && live.labels[label("engine")] === identity.engine && live.labels[label("target")] === identity.target
    && live.labels[label("project")] === identity.project && live.labels[label("service")] === identity.service
    && live.labels[label("imageSource")] === identity.imageSource && live.labels[label("image")] === identity.image;
}

// The live lock container by name or ID, or null when there is none. Docker errors other than "no such container" throw.
function inspectLock(docker, ref) {
  const result = docker(["container", "inspect", "--format", "{{json .}}", ref]);
  if (!result.ok) {
    if (/no such (container|object)/i.test(result.stderr)) return null;
    throw closed("Docker could not inspect the restore lock", result.stderr);
  }
  let container;
  try { container = JSON.parse(result.stdout); } catch { throw closed("Docker returned an unreadable lock description"); }
  const labels = container?.Config?.Labels ?? {};
  return {
    id: container?.Id, name: String(container?.Name ?? "").replace(/^\//, ""), labels,
    token: labels[label("token")], host: labels[label("host")], pid: Number(labels[label("pid")]),
    purpose: labels[label("purpose")], startedAt: labels[label("startedAt")],
  };
}

export const abandonedHelp = (name) => "If its holder crashed or was killed, first make sure NOTHING is still using the local database: "
  + "no `node scripts/backup.mjs` (verify / restore), no vitest integration, performance or Playwright e2e run, no `supabase db reset`, "
  + "`supabase start` or `supabase stop`, and no psql / `docker exec supabase_db_shopkhata` session (check "
  + "`select pid, application_name, state, query from pg_stat_activity where pid <> pg_backend_pid()` in the database). "
  + `Inspect ${name}, verify its full ID, labels, owner token, creation time and completed-run provenance, and check all operation leases. `
  + "If anything is uncertain, leave it in place. Recheck identity and inactivity immediately before removing only that full ID by hand: docker rm <verified-full-id>. The lock is never removed automatically; `docker container prune` "
  + "would also remove it, so treat a prune as the same manual step.";

const isRunning = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};

function describe(holder) {
  if (!holder) return "the holder vanished while being inspected";
  const here = holder.host === hostname();
  const state = here ? (isRunning(holder.pid) ? "that process IS running" : "that process is NOT running (abandoned?)") : "held from another host";
  return `pid ${holder.pid} on ${holder.host} since ${holder.startedAt}, ${holder.purpose}; ${state}`;
}

/** @typedef {(args: string[]) => { ok: boolean, stdout: string, stderr: string }} Docker */

/** @param {string} target @param {string} purpose @param {{ docker?: Docker, imageSource?: string }} [options] */
export function acquireRestoreLock(target, purpose, { docker = dockerCli, imageSource = undefined } = {}) {
  if (docker === dockerCli) pinLocalDocker();
  const identity = lockIdentity(target, { docker, imageSource });
  const result = createInertLock(identity, purpose, { docker });
  assertRestoreLockHeld(result, { docker });
  mkdirSync(completionDir(result), { mode: 0o700 });
  return result;
}

function createInertLock(identity, purpose, { docker, parentId = null }) {
  const { target } = identity;
  const owner = { token: randomUUID(), pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), purpose: String(purpose).replace(/[\r\n]+/g, " ") };
  const labels = { [LOCK_LABEL]: "1", [label("identityVersion")]: "2", [label("project")]: identity.project, [label("service")]: identity.service, [label("imageSource")]: identity.imageSource, [label("image")]: identity.image, [label("kind")]: parentId ? "operation" : "database", [label("parentId")]: parentId ?? "", [label("engine")]: identity.engine, [label("databaseId")]: identity.databaseId, [label("target")]: target, ...Object.fromEntries(Object.entries(owner).map(([key, value]) => [label(key), String(value)])) };
  const dir = mkdtempSync(join(tmpdir(), "shopkhata-lock-"));
  let created;
  try {
    const labelFile = join(dir, "labels");
    writeFileSync(labelFile, `${Object.entries(labels).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
    created = docker(["container", "create", "--name", identity.name, "--label-file", labelFile, "--network", "none", "--pull", "never",
      "--restart", "no", "--entrypoint", "/bin/true", identity.image]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!created.ok) {
    if (/already in use|conflict/i.test(created.stderr)) {
      throw new RestoreLockError(`Another run holds the ${parentId ? "exclusive operation lease" : "restore lock"} of the local database ${target} (Docker container ${identity.name}: ${describe(inspectLock(docker, identity.name))}). Nothing was changed. ${abandonedHelp(identity.name)}`);
    }
    throw closed("Docker could not create the restore lock", created.stderr);
  }
  const id = created.stdout.split(/\r?\n/).pop();
  const live = inspectLock(docker, id);
  if (!live || live.name !== identity.name || live.token !== owner.token
      || !matchesIdentity(live, identity)
      || live.labels[label("parentId")] !== (parentId ?? "") || live.labels[label("kind")] !== (parentId ? "operation" : "database")) {
    throw closed(`the restore lock ${identity.name} was created but its ownership cannot be verified; it is left in place`, abandonedHelp(identity.name));
  }
  return { ...owner, ...identity, id: live.id, parentId, inherited: false };
}

// Parent DB ownership is shareable by verified descendants; operation ownership NEVER is.
// Every sibling contends on the same daemon-atomic container name, independent of backup folder.
export function acquireRestoreOperation(parent, purpose, { docker = dockerCli } = {}) {
  assertRestoreLockHeld(parent, { docker });
  const { engine, target, imageSource, databaseId, image, project, service } = parent;
  const lease = createInertLock({ engine, target, imageSource, databaseId, image, project, service, name: `${parent.name}.operation` }, purpose, { docker, parentId: parent.id });
  assertRestoreLockHeld(parent, { docker });
  return lease;
}

export function releaseRestoreOperation(lease, { docker = dockerCli } = {}) {
  assertRestoreLockHeld(lease, { docker });
  const live = inspectLock(docker, lease.id);
  if (live.labels[label("kind")] !== "operation" || live.labels[label("parentId")] !== lease.parentId) throw closed("operation lease ownership mismatch");
  const removed = docker(["container", "rm", lease.id]);
  if (!removed.ok) throw new RestoreLockError(`The exclusive operation lease ${lease.name} could not be removed; it is left in place. ${abandonedHelp(lease.name)}`);
}

// Proves `owner` still holds the lock (its container exists under the lock name with its token).
export function assertRestoreLockHeld(owner, { docker = dockerCli } = {}) {
  const identity = lockIdentity(owner.target, { docker, imageSource: owner.imageSource });
  if (identity.engine !== owner.engine || identity.project !== owner.project || identity.service !== owner.service
      || identity.imageSource !== owner.imageSource || identity.image !== owner.image) throw closed("Docker engine or database service identity changed");
  const live = inspectLock(docker, owner.id);
  if (!live || live.name !== owner.name || live.token !== owner.token) {
    throw new RestoreLockError(`The restore lock ${owner.name} is no longer held by this run (removed or replaced while it worked); its database work was not protected.`);
  }
  if (!matchesIdentity(live, identity)) throw closed("restore lock identity mismatch");
  if (!owner.parentId && (live.labels[label("kind")] !== "database" || live.labels[label("parentId")] !== "")) throw closed("database lock ownership mismatch");
  if (owner.parentId && (live.labels[label("parentId")] !== owner.parentId || live.labels[label("kind")] !== "operation")) throw closed("operation lease ownership mismatch");
}

export function releaseRestoreLock(owner, { docker = dockerCli, operation = null } = {}) {
  if (owner.inherited) return false; // the parent run releases it
  assertRestoreLockHeld(owner, { docker });
  // Teardown also contends atomically: it cannot release a parent DB lock under an active child.
  const lease = operation ?? acquireRestoreOperation(owner, "database lock finalization", { docker });
  assertRestoreLockHeld(lease, { docker });
  if (lease.parentId !== owner.id) throw closed("operation lease belongs to another parent");
  const pending = existsSync(completionDir(owner)) ? readdirSync(completionDir(owner)).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(readFileSync(join(completionDir(owner), file), "utf8"))) : [];
  if (pending.some((entry) => entry.operationId && entry.operationId !== lease.id && entry.operationReleased !== true)) throw closed("an operation did not finalize its release; no success evidence can be published");
  // Finish fallible queue cleanup while still locked; after rm, only run-specific receipts are written.
  rmSync(completionDir(owner), { recursive: true, force: true });
  const removed = docker(["container", "rm", owner.id]);
  if (!removed.ok) throw new RestoreLockError(`The restore lock ${owner.name} could not be removed (${removed.stderr}); it is left in place. ${abandonedHelp(owner.name)}`);
  releaseRestoreOperation(lease, { docker });
  // Success evidence is inert until this receipt exists. A crash or failed rm cannot create it.
  // Immutable, run-specific receipts cannot overwrite a newer run's evidence after unlocking.
  for (const { path, evidence } of pending) writeJsonAtomic(releaseReceiptPath(path, evidence.runId), { runId: evidence.runId, manifestSha256: evidence.manifestSha256, released: true });
  return true;
}

const completionDir = (owner) => join(tmpdir(), `shopkhata-lock-finalize-${owner.id}`);
export function queueRestoreCompletion(owner, path, evidence, { docker = dockerCli } = {}) {
  assertRestoreLockHeld(owner, { docker });
  if (owner.operation) assertRestoreLockHeld(owner.operation, { docker });
  if (!existsSync(completionDir(owner))) throw closed("the owning process has no finalization directory");
  writeJsonAtomic(join(completionDir(owner), `${evidence.runId}.json`), { path, evidence, operationId: owner.operation?.id ?? null, operationReleased: false });
}

function finalizeInheritedOperation(owner, operation, deps) {
  assertRestoreLockHeld(owner, deps);
  releaseRestoreOperation(operation, deps);
  // Only immutable per-run queue entries are changed after release. Another operation may
  // now run, but these entries cannot overwrite its canonical evidence or match its run ID.
  for (const file of readdirSync(completionDir(owner)).filter((file) => file.endsWith(".json"))) {
    const path = join(completionDir(owner), file);
    const entry = JSON.parse(readFileSync(path, "utf8"));
    if (entry.operationId === operation.id) writeJsonAtomic(path, { ...entry, operationReleased: true });
  }
}

function discardOperationCompletion(owner, operation) {
  // Called while the failing callback still owns its operation lease. Never discard a
  // sibling's entry, and never publish a receipt for a callback that failed after queueing.
  for (const file of readdirSync(completionDir(owner)).filter((file) => file.endsWith(".json"))) {
    const path = join(completionDir(owner), file);
    const entry = JSON.parse(readFileSync(path, "utf8"));
    if (entry.operationId === operation.id) rmSync(path);
  }
}

// pid -> parent pid for every process on this machine. `timeoutMs` bounds the listing (callers with a deadline).
export function processTable({ timeoutMs = 60_000 } = {}) {
  const run = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    : spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: timeoutMs });
  if (run.error || run.status !== 0) throw closed("the process table could not be read", run.stderr || run.error?.message);
  const rows = process.platform === "win32"
    ? [JSON.parse(run.stdout)].flat().map((row) => [row.ProcessId, row.ParentProcessId])
    : run.stdout.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number));
  return new Map(rows);
}

export function isAncestor(ancestor, pid, table) {
  for (let current = pid, steps = 0; Number.isInteger(current) && current > 0 && steps < 256; steps += 1) {
    if (current === ancestor) return true;
    const parent = table.get(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

/**
 * @param {string} target @param {Record<string, string | undefined>} env
 * @param {{ docker?: Docker, imageSource?: string, table?: () => Map<number, number>, running?: (pid: number) => boolean }} [options]
 */
export function inheritRestoreLock(target, env, { docker = dockerCli, imageSource = undefined, table = processTable, running = isRunning } = {}) {
  if (docker === dockerCli) pinLocalDocker();
  const id = env[INHERIT_ENV.id];
  const token = env[INHERIT_ENV.token];
  if (!id || !token) throw closed(`an inherited restore lock needs both ${INHERIT_ENV.id} and ${INHERIT_ENV.token}`);
  const identity = lockIdentity(target, { docker, imageSource });
  const live = inspectLock(docker, id);
  const refuse = (why) => closed(`the inherited restore lock is not valid (${why})`);
  if (!live) throw refuse("no such lock container");
  if (live.name !== identity.name || live.labels[LOCK_LABEL] !== "1") throw refuse(`container ${live.name} is not the lock of ${target} on this Docker engine`);
  if (!matchesIdentity(live, identity)) throw refuse("engine or database service identity mismatch");
  if (live.labels[label("kind")] !== "database" || live.labels[label("parentId")] !== "") throw refuse("not a database ownership lock");
  if (live.token !== token) throw refuse("token mismatch");
  if (live.host !== hostname()) throw refuse("held from another host");
  if (!running(live.pid)) throw refuse(`its owner pid ${live.pid} is not running`);
  if (!isAncestor(live.pid, process.pid, table())) throw refuse(`its owner pid ${live.pid} is not an ancestor of this process`);
  return { ...identity, id: live.id, name: live.name, token, pid: live.pid, host: live.host, purpose: live.purpose, startedAt: live.startedAt, target, inherited: true };
}

// Runs fn(owner) holding the lock of `target`: inherited when the environment carries one (never released here),
// otherwise acquired and released afterwards. A failed release fails the command (unless fn already failed).
/**
 * @template T
 * @param {string} target @param {string} purpose @param {(owner: any) => Promise<T>} fn
 * @param {{ env?: Record<string, string | undefined>, warn?: (message: string) => void, docker?: Docker, imageSource?: string, table?: () => Map<number, number>, running?: (pid: number) => boolean, exclusive?: boolean }} [options]
 * @returns {Promise<T>}
 */
export async function withRestoreLock(target, purpose, fn, { env = process.env, warn = console.error, exclusive = false, ...deps } = {}) {
  const inherit = env[INHERIT_ENV.id] !== undefined || env[INHERIT_ENV.token] !== undefined;
  const owner = inherit ? inheritRestoreLock(target, env, deps) : acquireRestoreLock(target, purpose, deps);
  // Fail-fast acquisition happens BEFORE the callback, so refusal cannot invalidate evidence.
  let operation = null;
  try {
    operation = exclusive ? acquireRestoreOperation(owner, purpose, deps) : null;
  } catch (error) {
    // A fresh standalone parent has never escaped to fn/children. If an older run's finalization lease still
    // occupies the operation name, roll back ONLY this new parent, not that existing lease. Normal teardown
    // cannot be used here because it would need the very operation name whose collision caused the refusal.
    if (!owner.inherited) {
      try {
        const docker = deps.docker ?? dockerCli;
        assertRestoreLockHeld(owner, { docker });
        const liveOperation = inspectLock(docker, `${owner.name}.operation`);
        if (liveOperation?.labels[label("parentId")] === owner.id || readdirSync(completionDir(owner)).length !== 0) {
          throw closed("new parent may already own operation work; it is left in place");
        }
        rmdirSync(completionDir(owner));
        const removed = docker(["container", "rm", owner.id]);
        if (!removed.ok) throw closed("unused new parent could not be removed; it is left in place", removed.stderr);
      } catch (cleanupError) { warn(`[restore-lock] ${cleanupError.message}`); }
    }
    throw error;
  }
  if (operation) owner.operation = operation;
  const release = () => owner.inherited && operation ? finalizeInheritedOperation(owner, operation, deps) : releaseRestoreLock(owner, { ...deps, operation });
  let result;
  try {
    result = await fn(owner);
  } catch (error) {
    // A destructive child that could not be confirmed stopped (scripts/local-reset.mjs) keeps every lease and lock.
    if (error?.leaseAbandoned === true) {
      warn(`[restore-lock] a destructive child process may still be running; ${owner.inherited ? "its operation lease" : "the restore lock and its operation lease"} are left in place (fail closed). ${abandonedHelp(operation?.name ?? owner.name)}`);
      throw error;
    }
    try {
      if (operation) { assertRestoreLockHeld(operation, deps); discardOperationCompletion(owner, operation); }
      release();
    } catch (releaseError) { warn(`[restore-lock] ${releaseError.message}`); }
    throw error;
  }
  assertRestoreLockHeld(owner, deps);
  release();
  return result;
}
