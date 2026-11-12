// The ONE guarded way to reset the local Supabase database (`supabase db reset --local`), shared by
// `node scripts/backup.mjs verify` and the OPS-01B operations integration tests (release-helpers.resetLocal).
//
// A reset recreates the PostgreSQL and Storage containers on the images the Supabase CLI resolves from the project's
// supabase/.temp version pins, falling back to the CLI's built-in defaults (G6-B: a staged project without pins reset
// the database onto postgres 17.11.0.004 instead of the running 17.11.0.003). So, while the caller holds an EXCLUSIVE
// operation lease of the restore lock (scripts/restore-lock.mjs):
//   1. the project is snapshotted into a private staging folder (everything in supabase/ except .temp, plus only the
//      validated version pins: never link state); the check and the reset both read that snapshot, nothing else;
//   2. the CLI is asked which PostgreSQL and Storage images that snapshot resolves; each must carry the running
//      container's tag in the running container's repository, AND that reference must name the running container's
//      exact local image ID (a different image under the same tag is refused); PostgreSQL must also be the lock's image;
//   3. the lease is re-verified, then the reset runs as a tracked child process tree (PID + creation time). It returns
//      only once the whole tree is CONFIRMED gone by a complete listing; on timeout the tree is killed first. If termination cannot be confirmed, the error carries
//      `leaseAbandoned` and the lease must be left in place (withRestoreLock and resetLocal do), so the lock cannot be
//      released while a reset may still be running: fail closed, recovered only by the abandoned-lock procedure.
//      A process whose creation time cannot be read has an UNKNOWN identity: it is never taken for "a different
//      process" (so never for a terminated one) and never killed; while one holds a tracked PID, or is the child of
//      one, nothing is confirmed. Such a child is itself tracked (by PID), so ITS descendants stay tracked after it and
//      its parent exit: they are inferred, never killed, and keep the tree unconfirmed while alive.
//      Reset, kill, listing and confirmation share ONE absolute deadline.
// Residual (Docker level, documented in docs/operations/backup-restore.md): between step 2 and the CLI's own image
// lookup a local tag could be re-pointed by another `docker pull/tag`, and container operations the CLI already sent
// to the daemon complete even if the CLI is killed. The restore lock is advisory against non-participants. A process
// that leaves the tree on purpose (re-parented by a service, or a new session on Linux) is not tracked; the CLI and
// Docker CLI do not do that. Windows kills are bound to the process handle (PID + creation time re-checked on the
// handle that is terminated); on Linux a PID could still be reused between a listing and its kill.
import { execFile, spawn, spawnSync } from "node:child_process";
import { closeSync, cpSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { assertRestoreLockHeld, dockerCli } from "./restore-lock.mjs";

const execFileP = promisify(execFile);

export const CLI = resolve(import.meta.dirname, "..", "node_modules", "supabase", "dist", "supabase.js");
export const DB_CONTAINER = "supabase_db_shopkhata";
export const STORAGE_CONTAINER = "supabase_storage_shopkhata";
const SERVICES = [["postgres", DB_CONTAINER], ["storage-api", STORAGE_CONTAINER]];

export class LocalResetError extends Error {}
const refuse = (message, extra = {}) => Object.assign(new LocalResetError(`${message}; nothing was reset (fail closed).`), extra);

// ---- 1. pins and the private snapshot ------------------------------------------------------------------------------
// The CLI's local version pins in supabase/.temp (written by `supabase link`). Link state (project-ref, pooler-url,
// linked-project.json, start-secrets) and anything else in .temp is never copied.
const TAG = /^v?\d[0-9A-Za-z._-]{0,63}$/;
export const SUPABASE_PINS = Object.freeze({
  "postgres-version": /^\d{1,3}(\.\d{1,6}){2,3}$/, "storage-version": TAG, "storage-migration": /^[a-z0-9][a-z0-9-]{0,99}$/,
  "gotrue-version": TAG, "rest-version": TAG, "realtime-version": TAG, "pgmeta-version": TAG, "studio-version": TAG,
  "edge-runtime-version": TAG, "logflare-version": TAG, "pooler-version": TAG,
});
export const PIN_MAX_BYTES = 128;
const notPin = (name, why) => new LocalResetError(`supabase/.temp/${name} is not a valid Supabase CLI pin (${why}); refusing to stage a project that would reset onto other images.`);

/** False when absent; throws unless a plain directory (a symlink or junction could point the pins outside the project). */
function plainDir(path, label) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new LocalResetError(`${label} is not a plain directory (symlink, junction or file); refusing to stage Supabase CLI pins from it.`);
  return true;
}

/** The project's pins as exact bytes: absent ones are skipped (the CLI default applies to both); anything else throws.
 *  A value is one line, optionally ending in ONE newline (which the CLI trims). @returns {[string, Buffer][]} */
export function sourcePins(root) {
  if (!plainDir(join(root, "supabase"), "supabase/") || !plainDir(join(root, "supabase", ".temp"), "supabase/.temp")) return [];
  return Object.entries(SUPABASE_PINS).flatMap(([name, valid]) => {
    const file = join(root, "supabase", ".temp", name);
    let stat;
    try { stat = lstatSync(file); } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    if (!stat.isFile()) throw notPin(name, "not a regular file");
    if (stat.size > PIN_MAX_BYTES) throw notPin(name, `larger than ${PIN_MAX_BYTES} bytes`);
    const buffer = Buffer.alloc(PIN_MAX_BYTES + 1); // bounded read, even if the file grows after lstat
    const fd = openSync(file, "r");
    let size;
    try { size = readSync(fd, buffer, 0, buffer.length, 0); } finally { closeSync(fd); }
    if (size > PIN_MAX_BYTES) throw notPin(name, `larger than ${PIN_MAX_BYTES} bytes`);
    const bytes = Buffer.from(buffer.subarray(0, size));
    const value = bytes.toString("utf8").replace(/\r?\n$/, ""); // JS `$` without /m matches only at the end of input
    if (!valid.test(value)) throw notPin(name, "one allowed value in a regular file");
    return [[name, bytes]];
  });
}

/** Writes the project's validated pins, byte for byte, into the staged project `dir`. */
export function stagePins(dir, root) {
  const pins = sourcePins(root);
  if (pins.length) mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
  for (const [name, bytes] of pins) writeFileSync(join(dir, "supabase", ".temp", name), bytes);
}

/** A private snapshot of `root`'s Supabase project: supabase/ without .temp (no symlinks anywhere), plus the pins. */
export function snapshotProject(root) {
  const pins = sourcePins(root); // validated before anything is created
  const from = resolve(root, "supabase");
  const dir = mkdtempSync(join(tmpdir(), "shopkhata-reset-"));
  cpSync(from, join(dir, "supabase"), {
    recursive: true, errorOnExist: true, force: false,
    filter: (path) => {
      const rel = relative(from, path);
      if (rel === ".temp" || rel.startsWith(`.temp${sep}`)) return false;
      if (lstatSync(path).isSymbolicLink()) throw new LocalResetError(`supabase/${rel} is a symlink or junction; refusing to stage it.`);
      return true;
    },
  });
  if (pins.length) mkdirSync(join(dir, "supabase", ".temp"));
  for (const [name, bytes] of pins) writeFileSync(join(dir, "supabase", ".temp", name), bytes);
  return dir;
}

// ---- 2. image identity ---------------------------------------------------------------------------------------------
/** The parts of an official Supabase image reference for `name` (postgres, storage-api): optional public.ecr.aws or
 *  docker.io registry, the `supabase/<name>` repository, a required tag, an optional digest. Anything else: null. */
export function supabaseImage(ref, name) {
  const match = new RegExp(`^((?:public\\.ecr\\.aws/|docker\\.io/)?supabase/${name.replace(/[.-]/g, "\\$&")}):([0-9A-Za-z_][0-9A-Za-z._-]{0,127})(@sha256:[0-9a-f]{64})?$`).exec(String(ref));
  return match ? { repository: match[1], tag: match[2], digest: match[3]?.slice(1) ?? null } : null;
}

const inspectJson = (docker, args, what) => {
  const result = docker(args);
  if (!result.ok) throw refuse(`${what} could not be inspected (${result.stderr})`);
  try { return JSON.parse(result.stdout); } catch { throw refuse(`${what} returned an unreadable description`); }
};

/** The CLI's resolved local image tags for a staged project: { "supabase/postgres": "17.11.0.003", ... }.
 * @param {string} dir @param {{ run?: typeof runTree, timeoutMs?: number, cleanupMs?: number, deadline?: number }} [options] @returns {Promise<Record<string, string>>} */
export async function cliServices(dir, { run = runTree, timeoutMs = 60_000, cleanupMs = undefined, deadline = undefined } = {}) {
  const out = await run(process.execPath, [CLI, "--agent", "no", "--workdir", dir, "services", "--output-format", "json"], { timeoutMs, cleanupMs, deadline });
  let parsed = null;
  try { parsed = JSON.parse(out.stdout.split(/\r?\n/).filter((line) => line.startsWith("{")).pop() ?? "null"); } catch { /* refused below */ }
  return Object.fromEntries((parsed?.services ?? []).map((s) => [s.name, s.local]));
}

/** Throws unless the staged project resolves, for PostgreSQL and Storage, the running containers' exact images.
 *  @returns {Promise<Record<string, string>>} service -> local image ID */
export async function assertResetImages(dir, { services = cliServices, docker = dockerCli } = {}) {
  const resolved = await services(dir);
  const ids = {};
  for (const [name, container] of SERVICES) {
    const info = inspectJson(docker, ["container", "inspect", "--format", "{{json .}}", container], container);
    const running = supabaseImage(info?.Config?.Image, name);
    const staged = resolved[`supabase/${name}`];
    if (info?.Name !== `/${container}` || info?.State?.Running !== true || info?.Config?.Labels?.["com.supabase.cli.project"] !== "shopkhata") throw refuse(`${container} is not the running local ShopKhata service`);
    if (!running) throw refuse(`${container} runs an unrecognised image (${info?.Config?.Image})`);
    if (!/^sha256:[0-9a-f]{64}$/.test(info.Image ?? "")) throw refuse(`${container} reports no local image ID`);
    if (!staged || staged !== running.tag) throw refuse(`the staged project would reset supabase/${name} onto ${staged ?? "an unknown image"}, but ${container} runs ${running.tag} (check the supabase/.temp pins)`);
    // Same tag is not enough: the reference the reset will use must be the very image the container runs.
    const ref = `${running.repository}:${staged}`;
    const image = docker(["image", "inspect", "--format", "{{.Id}}", ref]);
    if (!image.ok || image.stdout.trim() !== info.Image) throw refuse(`${ref} is ${image.ok ? `image ${image.stdout.trim()}` : "not a local image"}, but ${container} runs image ${info.Image}`);
    if (running.digest) {
      const digests = inspectJson(docker, ["image", "inspect", "--format", "{{json .RepoDigests}}", ref], ref);
      if (!Array.isArray(digests) || !digests.some((d) => String(d).endsWith(`@${running.digest}`))) throw refuse(`${ref} does not carry ${container}'s digest ${running.digest}`);
    }
    ids[name] = info.Image;
  }
  return ids;
}

// ---- 3. bounded child process trees, identified by PID + creation time -------------------------------------------
// Timeout hierarchy (all derived from ONE deadline per guarded reset; see docs/operations/backup-restore.md):
//   process listing <= LIST_CAP and the time left; Docker call <= DOCKER_CAP and the time left; `services` <= 60 s;
//   the reset gets what is left minus CLEANUP_RESERVE; killing + confirming the tree gets CLEANUP_RESERVE, ending at
//   that same absolute deadline (it is fixed when the command starts and never restarted: a kill is capped by KILL_CAP
//   and by the time left, and none is attempted once the deadline has passed). Termination
//   counts as CONFIRMED only from a complete, successful listing in which no tracked process (same PID AND creation
//   time) and no descendant of one is alive, and no process of unknown identity holds a tracked PID or is the child
//   of one. A failed, timed-out, malformed or incomplete listing confirms nothing; if
//   the reserve runs out unconfirmed, the error carries `leaseAbandoned` and the operation lease must stay.
export const LIST_CAP = 15_000;
export const DOCKER_CAP = 20_000;
export const KILL_CAP = 5_000;
export const CLEANUP_RESERVE = 30_000;
/** Clock allowance (ms) between Date.now() and a listing's creation times (Linux: boot time in whole seconds). */
export const CLOCK_SLACK = 1_000;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const left = (deadline) => deadline - Date.now();

/** A Docker runner whose every call is bounded by `cap` and by the time left before `deadline` (fails when none is).
 * @param {number} deadline @param {{ cap?: number, spawn?: (command: string, args: string[], options: object) => { status: number | null, stdout?: string, stderr?: string, error?: Error } }} [options]
 * @returns {(args: string[]) => { ok: boolean, stdout: string, stderr: string }} */
export function boundedDocker(deadline, { cap = DOCKER_CAP, spawn: run = /** @type {any} */ (spawnSync) } = {}) {
  return (args) => {
    const timeout = Math.min(cap, left(deadline));
    if (timeout <= 0) return { ok: false, stdout: "", stderr: "the operation deadline is exhausted" };
    const result = run("docker", args, { encoding: "utf8", timeout, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: !result.error && result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr || result.error?.message || `exit ${result.status}`).trim() };
  };
}

/** Windows listing (PowerShell/CIM, creation time as Unix ms). Throws on anything but a complete, well-formed table
 *  that contains this process itself. A row whose CreationDate is missing or unreadable is kept with `created: null`:
 *  its identity is UNKNOWN, which is never "a different process" (see ProcessTree.uncertain).
 *  @returns {Map<number, ProcessRow>} */
export function parseWindowsProcesses(stdout, self = process.pid) {
  let rows;
  try { rows = [JSON.parse(stdout)].flat(); } catch { throw new LocalResetError("the process listing is not valid JSON"); }
  const table = new Map();
  for (const row of rows) {
    const [pid, ppid, raw] = [row?.ProcessId, row?.ParentProcessId, row?.Created];
    const created = raw === undefined || raw === null || raw === 0 ? null : raw; // missing, null or 0: unknown
    if (!Number.isInteger(pid) || pid < 0 || !Number.isInteger(ppid) || ppid < 0 || (created !== null && (typeof created !== "number" || !Number.isFinite(created) || created < 0))) throw new LocalResetError("the process listing has a malformed row");
    table.set(pid, { pid, ppid, created });
  }
  if (!table.has(self)) throw new LocalResetError("the process listing is incomplete (this process is missing)");
  return table;
}
// Any error stops the command (a row is never silently dropped); only an unreadable CreationDate becomes null.
export const WINDOWS_LIST = "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | ForEach-Object { $created = $null; "
  + "try { if ($_.CreationDate) { $created = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } } catch { $created = $null }; "
  + "[pscustomobject]@{ ProcessId = [int]$_.ProcessId; ParentProcessId = [int]$_.ParentProcessId; Created = $created } } | ConvertTo-Json -Compress";

/** Linux listing from /proc (pid, ppid, process group, creation time). A process that exits while being read is
 *  skipped (it is no longer alive); any other read failure throws.
 * @param {{ readdir?: (path: string) => string[], read?: (path: string) => string, self?: number }} [options]
 * @returns {Map<number, ProcessRow>} */
export function listLinuxProcesses({ readdir = (path) => readdirSync(path), read = (path) => readFileSync(path, "utf8"), self = process.pid } = {}) {
  const btime = Number(/^btime (\d+)$/m.exec(read("/proc/stat"))?.[1]);
  if (!Number.isFinite(btime)) throw new LocalResetError("the process listing is incomplete (no boot time)");
  const table = new Map();
  for (const name of readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try { stat = read(`/proc/${name}/stat`); } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") continue; throw error; }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // after "pid (comm) "
    const [ppid, pgrp, ticks] = [Number(fields[1]), Number(fields[2]), Number(fields[19])];
    if (!Number.isInteger(ppid) || !Number.isInteger(pgrp) || !Number.isFinite(ticks)) throw new LocalResetError(`the process listing has a malformed row (${name})`);
    table.set(Number(name), { pid: Number(name), ppid, pgrp, created: btime * 1000 + ticks * 10 }); // USER_HZ = 100
  }
  if (!table.has(self)) throw new LocalResetError("the process listing is incomplete (this process is missing)");
  return table;
}

/** @typedef {{ pid: number, ppid: number, created: number | null, pgrp?: number }} ProcessRow `created: null` = unknown identity */
/** @typedef {{ pid: number, ppid?: number, created: number, pgrp?: number, inferred?: boolean, unknown?: boolean }} Member `unknown`: tracked by PID only, `created` is a lower bound */
/** @typedef {(options: { timeoutMs: number }) => Promise<Map<number, ProcessRow>>} ListProcesses */
/** Every process on this machine, within `timeoutMs`. Rejects (never returns a partial table) on any failure.
 * @param {{ timeoutMs: number, exec?: (file: string, args: string[], options: object) => Promise<{ stdout: string }> }} options
 * @returns {Promise<Map<number, ProcessRow>>} */
export async function listProcesses({ timeoutMs, exec = /** @type {any} */ (execFileP) }) {
  if (!(timeoutMs > 0)) throw new LocalResetError("no time left to list processes");
  if (process.platform === "win32") {
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LIST], { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
    return parseWindowsProcesses(stdout);
  }
  if (process.platform === "linux") return listLinuxProcesses();
  throw new LocalResetError(`process trees cannot be confirmed on ${process.platform}`);
}

const key = (p) => `${p.pid}@${p.created}`;
/** The processes of one child's tree, as PID + creation-time identities. A process joins when its parent is a
 *  member, it was created no earlier than that parent, and its parent PID is not now held by a different (reused)
 *  process created before it; on Linux also when it is in the child's process group.
 *  The ROOT is the spawned child itself: while Node reports it running, the process holding its PID IS the child (its
 *  PID cannot be reused then), whatever the clocks say. A root that exited before any listing saw it has no known
 *  identity, so processes that only LOOK like its children (parent PID = its PID, created between the spawn and its
 *  exit) join by inference (`inferred`), as do their descendants and a child whose parent PID is now held by a process
 *  of unknown identity. A process of unknown identity whose parent PID is a member's joins by PID only (`unknown`), so
 *  that its children join too (inferred), even after it and its parent are gone. Inferred members keep the tree
 *  unconfirmed while alive and their lineage is followed, but they are NEVER killed: they might belong to an earlier or
 *  later holder of that PID. */
export class ProcessTree {
  /** @param {number} rootPid @param {number} notBefore @param {() => boolean} [rootRunning] */
  constructor(rootPid, notBefore, rootRunning = () => true) {
    this.rootPid = rootPid; this.notBefore = notBefore; this.rootRunning = rootRunning;
    /** @type {Map<string, Member>} */
    this.members = new Map();
    /** @type {Member | null} */
    this.root = null;
    /** Date.now() when the root exited (set by runTree): it has no child created later. @type {number | null} */
    this.rootExited = null;
  }
  /** @param {Map<number, ProcessRow>} table a listing STARTED after the root was spawned */
  absorb(table) {
    const root = table.get(this.rootPid);
    if (!this.root && root && root.created !== null && this.rootRunning()) { this.root = /** @type {Member} */ (root); this.members.set(key(root), this.root); }
    // Until the root is seen, its PID over its lifetime (spawn .. exit) stands for it: by inference only.
    /** @type {Member[]} */
    const seed = this.root ? [] : [{ pid: this.rootPid, created: this.notBefore, inferred: true }];
    const seedEnd = this.rootExited === null ? Infinity : this.rootExited + CLOCK_SLACK;
    for (let grew = true; grew;) {
      grew = false;
      for (const p of table.values()) {
        const created = p.created;
        if (created === null) {
          // An unknown identity whose parent PID is a member's is tracked by PID alone (key `pid@?`), so its children
          // are still followed through it. Its creation time is unknown: the parent's is kept as its LOWER bound, it is
          // never "alive" by identity and never killed (see alive() and uncertain()), and all its descendants are inferred.
          if (this.members.has(`${p.pid}@?`)) continue;
          const via = [...this.members.values(), ...seed].filter((m) => m.pid === p.ppid).sort((a, b) => b.created - a.created)[0];
          if (via) { this.members.set(`${p.pid}@?`, { pid: p.pid, ppid: p.ppid, created: via.created, inferred: true, unknown: true }); grew = true; }
          continue;
        }
        if (this.members.has(key(p))) continue;
        if (p.pgrp !== undefined && p.pgrp === this.rootPid && created >= this.notBefore) { this.members.set(key(p), { ...p, created }); grew = true; continue; }
        // Its parent: the latest member (or seed) with its parent PID created no later than it.
        const parent = [...this.members.values(), ...seed].filter((m) => m.pid === p.ppid && m.created <= created).sort((a, b) => b.created - a.created)[0];
        if (!parent || (parent === seed[0] && created > seedEnd)) continue;
        // ...unless that PID was meanwhile reused by a non-member created before this process: then that one is its parent.
        const holder = table.get(p.ppid);
        if (holder && holder.created !== null && !this.members.has(key(holder)) && holder.created > parent.created && holder.created <= created) continue;
        this.members.set(key(p), { ...p, created, ...(parent.inferred || holder?.created === null ? { inferred: true } : {}) }); grew = true;
      }
    }
    return this;
  }
  /** Members alive in `table`: the same PID with the same creation time.
   * @param {Map<number, ProcessRow>} table */
  alive(table) { return [...this.members.values()].filter((m) => !m.unknown && table.get(m.pid)?.created === m.created); }
  /** Processes of UNKNOWN identity (unreadable creation time) that hold a tracked PID (including an unknown member's)
   *  or are the child of one. They are not shown to be anything else, so they keep the tree unconfirmed; never killed.
   * @param {Map<number, ProcessRow>} table */
  uncertain(table) {
    const pids = new Set([...this.members.values()].map((m) => m.pid));
    if (!this.root) pids.add(this.rootPid);
    return [...table.values()].filter((p) => p.created === null && (pids.has(p.pid) || pids.has(p.ppid)));
  }
}

// Windows: ONE handle is opened for the PID (.NET caches Process.Handle; StartTime and Kill() use it), the creation
// time is read from that handle and that same handle is terminated: a PID reused since the listing is never killed.
export const windowsKill = (p) => `$ErrorActionPreference = 'Stop'; $p = [Diagnostics.Process]::GetProcessById(${p.pid}); $null = $p.Handle; `
  + `if ([Math]::Abs(([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() - ${p.created}) -gt 1) { exit 3 }; $p.Kill()`;
/** @param {Member} p @param {{ timeoutMs?: number }} [options] */
export function defaultKill(p, { timeoutMs = KILL_CAP } = {}) {
  if (!Number.isInteger(p.pid) || p.pid <= 0 || !Number.isInteger(p.created)) return; // no identity, no kill
  if (process.platform === "win32") spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsKill(p)], { windowsHide: true, stdio: "ignore", timeout: timeoutMs });
  else { try { process.kill(p.pid, "SIGKILL"); } catch { /* already gone */ } }
}

/** Kills the tree's live members and confirms, before the absolute `deadline`, that none is alive. A kill's success is
 *  never taken as proof; only a later successful listing is. Each kill gets at most KILL_CAP and the time left; once
 *  the deadline has passed no further kill is attempted. Returns false when termination cannot be shown in time.
 * @param {ProcessTree} tree @param {{ deadline: number, list?: ListProcesses, kill?: (p: Member, options: { timeoutMs: number }) => void }} options */
export async function confirmTreeGone(tree, { deadline, list = listProcesses, kill = defaultKill }) {
  for (;;) {
    const time = Math.min(LIST_CAP, left(deadline));
    if (time <= 0) return false;
    let table;
    try { table = await list({ timeoutMs: time }); } catch { await pause(Math.min(250, Math.max(0, left(deadline)))); continue; }
    const live = tree.absorb(table).alive(table);
    if (!live.length && !tree.uncertain(table).length) return true;
    for (const p of live) { // identities matched in this very listing
      if (p.inferred) continue;
      const budget = Math.min(KILL_CAP, left(deadline));
      if (budget <= 0) return false;
      try { kill(p, { timeoutMs: budget }); } catch { /* a failed kill proves nothing; the next listing decides */ }
    }
    // Linux: the child's own process group, only while a member is seen in it (a finished group's ID could be reused).
    if (process.platform !== "win32" && kill === defaultKill && live.some((p) => p.pgrp === tree.rootPid)) { try { process.kill(-tree.rootPid, "SIGKILL"); } catch { /* group gone */ } }
    await pause(Math.min(250, Math.max(0, left(deadline))));
  }
}

/**
 * Runs a command as a tracked process tree. It resolves only after the command closed AND its whole tree is confirmed
 * gone. ONE absolute end is fixed at the start: `deadline` if given, and never later than start + `timeoutMs` +
 * `cleanupMs`. The command may run until `cleanupMs` before that end; then it is stopped, and stopping, listing and
 * confirming all finish by that same end (the cleanup budget is never restarted). Unconfirmed: rejects with
 * `leaseAbandoned: true`.
 * @param {string} command @param {string[]} args
 * @param {{ timeoutMs: number, cleanupMs?: number, deadline?: number, cwd?: string, env?: NodeJS.ProcessEnv, list?: ListProcesses, kill?: (p: Member, options: { timeoutMs: number }) => void, watchMs?: number }} options
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
export function runTree(command, args, { timeoutMs, cleanupMs = CLEANUP_RESERVE, deadline = undefined, cwd = undefined, env = process.env, list = listProcesses, kill = defaultKill, watchMs = 3_000 }) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const end = Math.min(deadline ?? Infinity, started + Math.max(0, timeoutMs) + cleanupMs);
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    const running = () => child.exitCode === null && child.signalCode === null;
    const tree = new ProcessTree(child.pid ?? -1, started - CLOCK_SLACK, running);
    child.on("exit", () => { tree.rootExited = Date.now(); });
    let stdout = ""; let stderr = ""; let settled = false;
    child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
    // Identify the root (PID + creation time) at once, while Node holds it, then keep watching the tree while it runs, so
    // a member whose parent exits early is still known (best effort; the final proof is confirmTreeGone).
    const observe = () => list({ timeoutMs: Math.max(1, Math.min(LIST_CAP, watchMs * 2, left(end))) }).then((t) => { tree.absorb(t); }, () => undefined);
    void observe();
    const watch = setInterval(observe, watchMs);
    const finish = async (timedOut, status) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearInterval(watch);
      const until = Math.min(end, Date.now() + cleanupMs);
      let confirmed = child.pid === undefined;
      if (!confirmed) {
        if (timedOut) {
          // A root no listing has seen yet is listed once more while it still runs, so its tree is known by identity;
          // then it is stopped through Node's own handle of it (never by PID).
          if (!tree.root && left(until) > 0) await list({ timeoutMs: Math.min(LIST_CAP, left(until)) }).then((t) => { tree.absorb(t); }, () => undefined);
          if (running()) child.kill("SIGKILL");
        }
        confirmed = await confirmTreeGone(tree, { deadline: until, list, kill });
      }
      if (!confirmed) {
        reject(Object.assign(new LocalResetError(`${timedOut ? `timed out after ${timeoutMs} ms and its` : "it finished but its"} process tree could NOT be confirmed terminated by its deadline (cleanup reserve ${cleanupMs} ms); the operation lease is left in place (fail closed).`), { leaseAbandoned: true }));
      } else if (timedOut) reject(new LocalResetError(`timed out after ${timeoutMs} ms; its process tree was killed and confirmed terminated.`));
      else resolvePromise({ status, stdout, stderr });
    };
    const timer = setTimeout(() => { void finish(true, null); }, Math.max(0, end - cleanupMs - started));
    child.on("error", (error) => { if (child.pid === undefined && !settled) { settled = true; clearTimeout(timer); clearInterval(watch); reject(error); } });
    child.on("close", (status) => { void finish(false, status); });
  });
}

// ---- the reset ----------------------------------------------------------------------------------------------------
/**
 * `supabase db reset --local <args>` of `root`'s project, under `lease` (an exclusive operation lease of the restore
 * lock, held by the caller), all within `timeoutMs`. Throws a LocalResetError before anything is reset unless the
 * images are proven and enough time remains for the reset AND its cleanup; `leaseAbandoned` on the error means the
 * caller must NOT release the lease.
 * @param {{ root: string, args?: string[], lease: any, timeoutMs: number, docker?: any, services?: any, run?: any, held?: (lease: any) => void, cleanupMs?: number }} options
 */
export async function guardedLocalReset({ root, args = [], lease, timeoutMs, docker = undefined, services = cliServices, run = runTree, held = undefined, cleanupMs = CLEANUP_RESERVE }) {
  const deadline = Date.now() + timeoutMs;
  const dock = docker ?? boundedDocker(deadline);
  const check = held ?? ((l) => assertRestoreLockHeld(l, { docker: dock }));
  if (!lease?.parentId) throw refuse("a local reset needs an exclusive operation lease of the restore lock");
  if (left(deadline) <= cleanupMs) throw refuse(`the budget of ${timeoutMs} ms leaves no time beyond the ${cleanupMs} ms cleanup reserve`);
  check(lease);
  const stage = snapshotProject(root);
  const ids = await assertResetImages(stage, { docker: dock, services: (dir) => services(dir, { run, cleanupMs, deadline, timeoutMs: Math.min(60_000, left(deadline) - cleanupMs) }) });
  if (ids.postgres !== lease.image) throw refuse(`the running database image ${ids.postgres} is not the restore lock's ${lease.image}`);
  check(lease); // still ours, on the same engine/project/service/image, immediately before the reset
  const remaining = left(deadline) - cleanupMs;
  if (remaining <= 0) throw refuse("no time left for the reset and its cleanup within the budget");
  const result = await run(process.execPath, [CLI, "--agent", "no", "--workdir", stage, "db", "reset", "--local", ...args], { timeoutMs: remaining, cleanupMs, deadline });
  if (result.status !== 0) throw new LocalResetError(`supabase db reset failed (exit ${result.status}): ${result.stderr.trim().split(/\r?\n/).slice(-5).join(" | ")}`);
  return result.stdout;
}
