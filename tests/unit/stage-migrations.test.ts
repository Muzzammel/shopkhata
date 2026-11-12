import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stageCheckout } from "../integration/operations/fingerprint-gates";
import { boundedDocker, CLEANUP_RESERVE, cliServices, confirmTreeGone, defaultKill, guardedLocalReset, KILL_CAP, windowsKill, WINDOWS_LIST, listLinuxProcesses, listProcesses, parseWindowsProcesses, ProcessTree, runTree } from "../../scripts/local-reset.mjs";
import { assertStagedImages, LOCAL_API, localBackup, localOnlyEnv, PIN_MAX_BYTES, RELEASE_RESERVE, resetLocal, VERIFY_TIMEOUT, stageMigrations, supabaseImage, SUPABASE_PINS } from "../integration/operations/release-helpers";

// G6-B: a staged --workdir must make the Supabase CLI resolve the source project's service images, or a reset from it
// recreates the local database on another image. Fixture projects and injected fakes only; the database and Docker are
// never touched.

type Temp = Record<string, string | Buffer>;
const PINS: Temp = { "postgres-version": "17.99.0.042\n", "storage-version": "v1.99.7", "storage-migration": "some-freeze-point\r\n", "gotrue-version": "v2.999.1", "rest-version": "v99.1" };
const UNRELATED: Temp = { "project-ref": "abcdefghijklmnopqrst", "pooler-url": "postgresql://x@pooler.example/postgres", "linked-project.json": "{\"ref\":\"x\"}", "start-secrets": "secret", "cli-latest": "v3.0.0", "notes.txt": "x" };

function project(temp: Temp | null = { ...PINS, ...UNRELATED }): string {
  const root = mkdtempSync(join(tmpdir(), "stage-src-"));
  mkdirSync(join(root, "supabase", "migrations"), { recursive: true });
  writeFileSync(join(root, "supabase", "config.toml"), "project_id = \"shopkhata\"\n[db]\nport = 55322\nmajor_version = 17\n");
  for (const v of ["20260101000000_a.sql", "20260102000000_b.sql", "20260103000000_c.sql"]) writeFileSync(join(root, "supabase", "migrations", v), `-- ${v}\n`);
  if (temp) {
    mkdirSync(join(root, "supabase", ".temp"));
    for (const [name, value] of Object.entries(temp)) writeFileSync(join(root, "supabase", ".temp", name), value);
  }
  return root;
}
const staged = (dir: string, ...path: string[]) => readFileSync(join(dir, "supabase", ...path), "utf8");
const stageDirs = () => readdirSync(tmpdir()).filter((f) => f.startsWith("ops01b-stage-")).length;
// File symlinks need privileges on Windows; directory junctions do not (on POSIX "junction" makes a directory symlink).
const canLinkFiles = (() => {
  const dir = mkdtempSync(join(tmpdir(), "stage-link-"));
  try { writeFileSync(join(dir, "t"), ""); symlinkSync(join(dir, "t"), join(dir, "l"), "file"); return true; } catch { return false; } finally { rmSync(dir, { recursive: true, force: true }); }
})();

describe("stageMigrations: Supabase CLI pins", () => {
  it("stages exactly the source's service pins, byte for byte, and nothing else from .temp", () => {
    const dir = stageMigrations("", project());
    // Expected bytes are spelled out here, not derived from the fixture: newlines and all.
    const expected: Record<string, number[]> = {
      "postgres-version": [0x31, 0x37, 0x2e, 0x39, 0x39, 0x2e, 0x30, 0x2e, 0x30, 0x34, 0x32, 0x0a],
      "storage-version": [0x76, 0x31, 0x2e, 0x39, 0x39, 0x2e, 0x37],
      "storage-migration": [...Buffer.from("some-freeze-point", "latin1"), 0x0d, 0x0a],
      "gotrue-version": [...Buffer.from("v2.999.1", "latin1")],
      "rest-version": [...Buffer.from("v99.1", "latin1")],
    };
    expect(readdirSync(join(dir, "supabase", ".temp")).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, bytes] of Object.entries(expected)) expect([...readFileSync(join(dir, "supabase", ".temp", name))], name).toEqual(bytes);
    for (const name of Object.keys(UNRELATED)) expect(Object.keys(SUPABASE_PINS)).not.toContain(name);
  });

  it("keeps migration staging unchanged: config.toml and the migrations up to `last` only", () => {
    const root = project();
    expect(readdirSync(join(stageMigrations("", root), "supabase", "migrations"))).toEqual([]);
    const dir = stageMigrations("20260102000000", root);
    expect(readdirSync(join(dir, "supabase", "migrations"))).toEqual(["20260101000000_a.sql", "20260102000000_b.sql"]);
    expect(staged(dir, "config.toml")).toBe(readFileSync(join(root, "supabase", "config.toml"), "utf8"));
    expect(staged(dir, "migrations", "20260101000000_a.sql")).toBe("-- 20260101000000_a.sql\n");
  });

  it("a source without pins stages none, so both resolve the same CLI defaults", () => {
    const dir = stageMigrations("", project(null));
    expect(readdirSync(join(dir, "supabase"))).toEqual(["config.toml", "migrations"]);
  });

  it.each([
    ["empty", "postgres-version", ""],
    ["a bare newline", "postgres-version", "\n"],
    ["two lines", "postgres-version", "17.11.0.003\n17.11.0.004"],
    ["two trailing newlines", "postgres-version", "17.11.0.003\n\n"],
    ["a leading newline", "postgres-version", "\n17.11.0.003"],
    ["surrounding spaces", "postgres-version", " 17.11.0.003 "],
    ["a non-version", "postgres-version", "latest"],
    ["an unbounded numeric component", "postgres-version", "17.11.0.0000003"],
    ["a five-part version", "postgres-version", "17.11.0.3.1"],
    ["a command", "storage-version", "v1.90.0; rm -rf /"],
    ["an image reference", "storage-version", "public.ecr.aws/supabase/storage-api:v1.90.0"],
    ["a digest", "storage-version", "v1.90.0@sha256:abc"],
    ["an over-long tag", "rest-version", `v1${"0".repeat(64)}`],
    ["a bad freeze point", "storage-migration", "../x"],
    ["a NUL byte", "gotrue-version", "v2.1\u0000"],
  ])("refuses %s in %s before creating anything", (_what, name, value) => {
    const root = project({ ...PINS, [name]: value });
    const before = stageDirs();
    expect(() => stageMigrations("", root)).toThrow(`supabase/.temp/${name} is not a valid Supabase CLI pin`);
    expect(stageDirs()).toBe(before);
  });

  it(`refuses a pin larger than ${PIN_MAX_BYTES} bytes, and accepts one at the limit`, () => {
    const atLimit = `a${"b".repeat(99)}\n`; // the longest allowed freeze point plus a newline: well under the limit
    expect(() => stageMigrations("", project({ "storage-migration": atLimit }))).not.toThrow();
    const before = stageDirs();
    expect(() => stageMigrations("", project({ "storage-migration": "a".repeat(PIN_MAX_BYTES + 1) }))).toThrow(`larger than ${PIN_MAX_BYTES} bytes`);
    expect(() => stageMigrations("", project({ "postgres-version": Buffer.alloc(1024 * 1024, 0x31) }))).toThrow(`larger than ${PIN_MAX_BYTES} bytes`);
    expect(stageDirs()).toBe(before);
  });

  it("refuses a pin that is not a regular file", () => {
    const root = project(UNRELATED);
    mkdirSync(join(root, "supabase", ".temp", "postgres-version"));
    expect(() => stageMigrations("", root)).toThrow("supabase/.temp/postgres-version is not a valid Supabase CLI pin (not a regular file)");
  });

  it("refuses a .temp that is a junction or symlink to a directory outside the project", () => {
    const root = project(null);
    const outside = mkdtempSync(join(tmpdir(), "stage-outside-"));
    writeFileSync(join(outside, "postgres-version"), "17.11.0.003");
    symlinkSync(outside, join(root, "supabase", ".temp"), "junction");
    const before = stageDirs();
    expect(() => stageMigrations("", root)).toThrow("supabase/.temp is not a plain directory");
    expect(stageDirs()).toBe(before);
  });

  it("refuses a supabase/ folder that is a junction or symlink", () => {
    const other = project();
    const root = mkdtempSync(join(tmpdir(), "stage-src-"));
    symlinkSync(join(other, "supabase"), join(root, "supabase"), "junction");
    expect(() => stageMigrations("", root)).toThrow("supabase/ is not a plain directory");
  });

  it.skipIf(!canLinkFiles)("refuses a pin file that is a symlink, even to a valid value", () => {
    const root = project(UNRELATED);
    const outside = join(mkdtempSync(join(tmpdir(), "stage-outside-")), "postgres-version");
    writeFileSync(outside, "17.11.0.003");
    symlinkSync(outside, join(root, "supabase", ".temp", "postgres-version"), "file");
    expect(() => stageMigrations("", root)).toThrow("supabase/.temp/postgres-version is not a valid Supabase CLI pin (not a regular file)");
  });

  it("stageCheckout (the fingerprint suites' workdir) carries this checkout's pins exactly", () => {
    const dir = stageCheckout("20260101000000", "lf");
    for (const name of Object.keys(SUPABASE_PINS)) {
      const source = join("supabase", ".temp", name);
      expect(existsSync(join(dir, "supabase", ".temp", name)), name).toBe(existsSync(source));
      if (existsSync(source)) expect(readFileSync(join(dir, "supabase", ".temp", name)).equals(readFileSync(source)), name).toBe(true);
    }
    for (const name of ["project-ref", "pooler-url", "linked-project.json", "start-secrets"]) expect(existsSync(join(dir, "supabase", ".temp", name)), name).toBe(false);
  });
});

// The real installed CLI, only when explicitly enabled (SHOPKHATA_CLI_CONTRACT_TESTS=1): fixture projects without link
// state, in a sanitized environment (no SUPABASE_*, SHOPKHATA_*, DOCKER_* or proxy variables). No database, no Docker.
const KEEP = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA)$/i;
const sanitized = Object.fromEntries(Object.entries(process.env).filter(([key]) => KEEP.test(key))) as NodeJS.ProcessEnv;
describe.skipIf(process.env.SHOPKHATA_CLI_CONTRACT_TESTS !== "1")("Supabase CLI contract (opt-in)", () => {
  it("the installed CLI resolves PostgreSQL and Storage from the staged pins, and its defaults without them", async () => {
    const services = (dir: string) => cliServices(dir, { run: (command, args, options) => runTree(command, args, { ...options, env: sanitized }) });
    const pinned = await services(stageMigrations("", project()));
    expect(pinned["supabase/postgres"]).toBe("17.99.0.042");
    expect(pinned["supabase/storage-api"]).toBe("v1.99.7");
    const bare = await services(stageMigrations("", project(null)));
    expect(bare["supabase/postgres"]).not.toBe("17.99.0.042");
    expect(bare["supabase/storage-api"]).not.toBe("v1.99.7");
  }, 60_000);
});

describe("supabaseImage: official Supabase image references only", () => {
  const D = `sha256:${"a".repeat(64)}`;
  it.each([
    ["public.ecr.aws/supabase/postgres:17.11.0.003", { repository: "public.ecr.aws/supabase/postgres", tag: "17.11.0.003", digest: null }],
    ["supabase/postgres:17.11.0.003", { repository: "supabase/postgres", tag: "17.11.0.003", digest: null }],
    ["docker.io/supabase/postgres:17.11.0.003", { repository: "docker.io/supabase/postgres", tag: "17.11.0.003", digest: null }],
    [`public.ecr.aws/supabase/postgres:17.11.0.003@${D}`, { repository: "public.ecr.aws/supabase/postgres", tag: "17.11.0.003", digest: D }],
  ])("%s", (ref, parts) => {
    expect(supabaseImage(ref, "postgres")).toEqual(parts);
  });

  it.each([
    [`supabase/postgres@${D}`, "digest only: no tag to compare"],
    ["supabase/postgres", "untagged"],
    ["localhost:5000/supabase/postgres:17.11.0.003", "an unofficial registry"],
    ["x/supabase/postgres:17.11.0.003", "a foreign namespace ending in supabase/postgres"],
    ["evil/postgres:17.11.0.003", "another namespace"],
    ["mysupabase/postgres:17.11.0.003", "a look-alike repository"],
    ["public.ecr.aws/supabase/storage-api:17.11.0.003", "another service"],
    [`supabase/postgres:17.11.0.003@sha256:${"a".repeat(63)}`, "a malformed digest"],
  ])("%s is refused (%s)", (ref) => {
    expect(supabaseImage(ref, "postgres")).toBeNull();
  });
});

// ---- fakes: an in-memory Docker engine and CLI; nothing real is inspected, run or reset ---------------------------
const PG = "public.ecr.aws/supabase/postgres:17.11.0.003";
const ST = "public.ecr.aws/supabase/storage-api:v1.90.0";
const PG_ID = `sha256:${"1".repeat(64)}`;
const ST_ID = `sha256:${"2".repeat(64)}`;
const OTHER_ID = `sha256:${"9".repeat(64)}`;
type Running = { ref: string; id: string; running?: boolean };
function fakeDocker({ db = { ref: PG, id: PG_ID } as Running, storage = { ref: ST, id: ST_ID } as Running, images = { [PG]: PG_ID, [ST]: ST_ID } as Record<string, string>, digests = {} as Record<string, string[]> } = {}) {
  return vi.fn((args: string[]) => {
    const ref = args.at(-1)!;
    if (args[0] === "container" && args[1] === "inspect") {
      const c = ref === "supabase_db_shopkhata" ? db : ref === "supabase_storage_shopkhata" ? storage : null;
      return c ? { ok: true, stdout: JSON.stringify({ Name: `/${ref}`, Image: c.id, Config: { Image: c.ref, Labels: { "com.supabase.cli.project": "shopkhata" } }, State: { Running: c.running ?? true } }), stderr: "" } : { ok: false, stdout: "", stderr: `Error: No such container: ${ref}` };
    }
    if (args[0] === "image" && args[3] === "{{.Id}}") return ref in images ? { ok: true, stdout: images[ref], stderr: "" } : { ok: false, stdout: "", stderr: `Error: No such image: ${ref}` };
    if (args[0] === "image" && args[3] === "{{json .RepoDigests}}") return { ok: true, stdout: JSON.stringify(digests[ref] ?? []), stderr: "" };
    return { ok: false, stdout: "", stderr: `unexpected docker ${args.join(" ")}` };
  });
}
const resolves = (postgres: string, storage: string) => vi.fn<(dir: string) => Promise<Record<string, string>>>(async () => ({ "supabase/postgres": postgres, "supabase/storage-api": storage }));

describe("assertStagedImages: tag AND local image identity, before any reset", () => {
  it("accepts the running images (and returns their local image IDs)", async () => {
    const docker = fakeDocker();
    await expect(assertStagedImages("/stage", { services: resolves("17.11.0.003", "v1.90.0"), docker })).resolves.toEqual({ postgres: PG_ID, "storage-api": ST_ID });
    expect(docker).toHaveBeenCalledWith(["image", "inspect", "--format", "{{.Id}}", PG]);
  });

  it("accepts a running reference pinned by digest when the image carries that digest", async () => {
    const digest = `sha256:${"c".repeat(64)}`;
    const docker = fakeDocker({ db: { ref: `${PG}@${digest}`, id: PG_ID }, digests: { [PG]: [`public.ecr.aws/supabase/postgres@${digest}`] } });
    await expect(assertStagedImages("/stage", { services: resolves("17.11.0.003", "v1.90.0"), docker })).resolves.toBeTruthy();
  });

  it.each([
    ["the G6-B PostgreSQL default", resolves("17.11.0.004", "v1.90.0"), fakeDocker(), /supabase\/postgres onto 17\.11\.0\.004, but supabase_db_shopkhata runs 17\.11\.0\.003/],
    ["a Storage default", resolves("17.11.0.003", "v1.82.1"), fakeDocker(), /supabase\/storage-api onto v1\.82\.1, but supabase_storage_shopkhata runs v1\.90\.0/],
    ["a different image under the same tag (digest/ID mismatch)", resolves("17.11.0.003", "v1.90.0"), fakeDocker({ images: { [PG]: OTHER_ID, [ST]: ST_ID } }), /public\.ecr\.aws\/supabase\/postgres:17\.11\.0\.003 is image sha256:9+, but supabase_db_shopkhata runs image sha256:1+/],
    ["a staged tag that is not a local image", resolves("17.11.0.003", "v1.90.0"), fakeDocker({ images: { [PG]: PG_ID } }), /storage-api:v1\.90\.0 is not a local image/],
    ["a running digest the image does not carry", resolves("17.11.0.003", "v1.90.0"), fakeDocker({ db: { ref: `${PG}@sha256:${"d".repeat(64)}`, id: PG_ID }, digests: { [PG]: [`public.ecr.aws/supabase/postgres@sha256:${"e".repeat(64)}`] } }), /does not carry supabase_db_shopkhata's digest/],
    ["a look-alike running repository", resolves("17.11.0.003", "v1.90.0"), fakeDocker({ storage: { ref: "x/supabase/storage-api:v1.90.0", id: ST_ID } }), /supabase_storage_shopkhata runs an unrecognised image \(x\/supabase\/storage-api:v1\.90\.0\)/],
    ["a digest-only running image", resolves("17.11.0.003", "v1.90.0"), fakeDocker({ db: { ref: `supabase/postgres@sha256:${"f".repeat(64)}`, id: PG_ID } }), /runs an unrecognised image/],
    ["a stopped database", resolves("17.11.0.003", "v1.90.0"), fakeDocker({ db: { ref: PG, id: PG_ID, running: false } }), /not the running local ShopKhata service/],
    ["unreadable CLI output", vi.fn(async () => ({})), fakeDocker(), /onto an unknown image/],
  ])("refuses %s", async (_what, services, docker, message) => {
    await expect(assertStagedImages("/stage", { services, docker })).rejects.toThrow(message);
  });

  it("refuses when a container cannot be inspected", async () => {
    await expect(assertStagedImages("/stage", { services: resolves("17.11.0.003", "v1.90.0"), docker: vi.fn((args: string[]) => args.at(-1) === "supabase_db_shopkhata" ? { ok: false, stdout: "", stderr: "Error: No such container: supabase_db_shopkhata" } : fakeDocker()(args)) })).rejects.toThrow(/supabase_db_shopkhata could not be inspected/);
    await expect(assertStagedImages("/stage", { services: resolves("17.11.0.003", "v1.90.0"), docker: vi.fn(() => ({ ok: false, stdout: "", stderr: "daemon down" })) })).rejects.toThrow(/could not be inspected \(daemon down\)/);
  });
});

describe("resetLocal: the only reset path of the operations suites", () => {
  type Lease = { parentId: string; image: string };
  const harness = (over: { services?: ReturnType<typeof resolves>; docker?: ReturnType<typeof fakeDocker>; run?: ReturnType<typeof vi.fn>; lease?: Lease } = {}) => {
    const lease = over.lease ?? { parentId: "parent", image: PG_ID };
    const run = over.run ?? vi.fn<(command: string, args: string[], options: { timeoutMs: number }) => Promise<{ status: number; stdout: string; stderr: string }>>(async () => ({ status: 0, stdout: "reset done", stderr: "" }));
    const deps = { services: over.services ?? resolves("17.11.0.003", "v1.90.0"), docker: over.docker ?? fakeDocker(), run, held: vi.fn(), acquireLease: vi.fn(() => lease), releaseLease: vi.fn() };
    const resets = () => run.mock.calls.map(([, args]) => args as string[]).filter((args) => args.includes("reset"));
    return { deps, run, resets, lease };
  };

  it("holds an exclusive lease, checks a private snapshot, then resets that very snapshot within the budget", async () => {
    const root = project();
    const { deps, resets } = harness();
    let checked = "";
    deps.services = vi.fn(async (dir: string) => { checked = dir; return { "supabase/postgres": "17.11.0.003", "supabase/storage-api": "v1.90.0" }; });
    await expect(resetLocal(["--no-seed"], { workdir: root, timeoutMs: 60_000, ...deps })).resolves.toBe("reset done");
    expect(deps.acquireLease).toHaveBeenCalledTimes(1);
    expect(deps.held).toHaveBeenCalledTimes(2); // before the snapshot, and again immediately before the reset
    const [reset] = resets();
    expect(reset.slice(-3)).toEqual(["reset", "--local", "--no-seed"]);
    expect(reset[reset.indexOf("--workdir") + 1]).toBe(checked);
    expect(checked).not.toBe(root);
    expect(readdirSync(join(checked, "supabase", ".temp")).sort()).toEqual(["gotrue-version", "postgres-version", "rest-version", "storage-migration", "storage-version"]);
    expect(readdirSync(join(checked, "supabase", "migrations"))).toHaveLength(3);
    expect(deps.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("the reset uses the snapshot that was checked, even if the source pins change after the check", async () => {
    const root = project();
    const { deps, run } = harness();
    deps.services = vi.fn(async () => { writeFileSync(join(root, "supabase", ".temp", "postgres-version"), "17.11.0.004"); return { "supabase/postgres": "17.11.0.003", "supabase/storage-api": "v1.90.0" }; });
    await resetLocal([], { workdir: root, timeoutMs: 60_000, ...deps });
    const args = run.mock.calls[0][1] as string[];
    expect(readFileSync(join(args[args.indexOf("--workdir") + 1], "supabase", ".temp", "postgres-version"), "utf8")).toBe("17.99.0.042\n");
  });

  it.each([
    ["PostgreSQL tag", { services: resolves("17.11.0.004", "v1.90.0") }],
    ["Storage tag", { services: resolves("17.11.0.003", "v1.82.1") }],
    ["PostgreSQL image under the same tag", { docker: fakeDocker({ images: { [PG]: OTHER_ID, [ST]: ST_ID } }) }],
    ["database image other than the lock's", { lease: { parentId: "parent", image: OTHER_ID } }],
  ])("an unexpected %s is refused before anything is reset, and the lease is released", async (_what, over) => {
    const { deps, resets } = harness(over);
    await expect(resetLocal([], { workdir: project(), timeoutMs: 60_000, ...deps })).rejects.toThrow(/nothing was reset/);
    expect(resets()).toEqual([]);
    expect(deps.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("a reset whose process tree was not confirmed terminated keeps its lease; a confirmed kill releases it", async () => {
    const abandoned = harness({ run: vi.fn(async (_c: string, args: string[]) => { if (args.includes("reset")) throw Object.assign(new Error("not confirmed terminated"), { leaseAbandoned: true }); return { status: 0, stdout: "", stderr: "" }; }) });
    await expect(resetLocal([], { workdir: project(), timeoutMs: 60_000, ...abandoned.deps })).rejects.toThrow("not confirmed terminated");
    expect(abandoned.deps.releaseLease).not.toHaveBeenCalled();
    const killed = harness({ run: vi.fn(async () => { throw new Error("timed out; confirmed terminated"); }) });
    await expect(resetLocal([], { workdir: project(), timeoutMs: 60_000, ...killed.deps })).rejects.toThrow("confirmed terminated");
    expect(killed.deps.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("passes the remaining budget, not a fresh one, to the reset", async () => {
    const { deps, run } = harness();
    await resetLocal([], { workdir: project(), timeoutMs: 90_000, ...deps });
    expect((run.mock.calls[0][2] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(90_000 - RELEASE_RESERVE - CLEANUP_RESERVE);
  });

  it("refuses without an exclusive operation lease", async () => {
    await expect(guardedLocalReset({ root: project(), lease: { image: PG_ID }, timeoutMs: 1000 })).rejects.toThrow(/exclusive operation lease/);
  });

  it("every local reset in the operations suites goes through resetLocal (source scan)", () => {
    const dir = join("tests", "integration", "operations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    const text = (f: string) => readFileSync(join(dir, f), "utf8");
    // A CLI argument "reset" anywhere in these suites would bypass the guarded path.
    expect(files.filter((f) => /["'`]reset["'`]/.test(text(f)))).toEqual([]);
    expect(text("release-helpers.ts")).toContain("guardedLocalReset({ root: workdir, args, lease,");
    expect(files.filter((f) => /resetLocal\(/.test(text(f)) && f !== "release-helpers.ts").sort()).toEqual([
      "authorization-chain.test.ts", "fingerprint-line-endings.test.ts", "invoice-operations.test.ts", "invoice-void.test.ts", "locked-restore.test.ts",
      "maintenance.test.ts", "p03-maintenance-controller.test.ts", "release-gates.test.ts", "release-window-rehearsal.test.ts",
    ]);
    // Hooks bound their reset below the hook timeout (prerequisite check + reset budget + kill confirmation).
    for (const f of ["invoice-operations.test.ts", "invoice-void.test.ts", "maintenance.test.ts"]) {
      expect(text(f)).toContain("const SUITE_TIMEOUT = 210_000;");
      expect(text(f)).toContain("const RESET_BUDGET = 150_000;");
      expect(text(f)).not.toMatch(/resetLocal\(\)/);
    }
  });

  it("the only reset in the shared module runs after the image check and the second lease check", () => {
    const source = readFileSync("scripts/local-reset.mjs", "utf8");
    const body = source.slice(source.indexOf("export async function guardedLocalReset("));
    expect(source.match(/["'`]reset["'`]/g)).toHaveLength(1);
    const check = body.indexOf("await assertResetImages(");
    const reheld = body.indexOf("check(lease); // still ours");
    expect(check).toBeGreaterThan(body.indexOf("snapshotProject(root)"));
    expect(reheld).toBeGreaterThan(check);
    expect(body.indexOf('"reset"')).toBeGreaterThan(reheld);
  });
});

describe("process lifecycle: termination is confirmed only from a complete listing, by PID + creation time", () => {
  type P = { pid: number; ppid: number; created: number; pgrp?: number };
  const table = (...rows: P[]) => new Map(rows.map((r) => [r.pid, r]));
  const self = { pid: process.pid, ppid: 1, created: 1 };
  const T0 = 1_000_000;
  /** A fake machine: `kill` removes a process (when `obeys`), `list` returns the current table. */
  const machine = (rows: P[], { obeys = true } = {}) => {
    const procs = table(self, ...rows);
    const killed: string[] = [];
    return {
      procs, killed,
      list: vi.fn(async () => new Map(procs)),
      kill: vi.fn((p: { pid: number; created: number }) => { killed.push(`${p.pid}@${p.created}`); if (obeys && procs.get(p.pid)?.created === p.created) procs.delete(p.pid); }),
    };
  };
  const soon = () => Date.now() + 2_000;

  it("process-listing command failure confirms nothing", async () => {
    await expect(listProcesses({ timeoutMs: 1_000, exec: vi.fn(async () => { throw Object.assign(new Error("powershell failed"), { code: 1 }); }) })).rejects.toThrow("powershell failed");
    const tree = new ProcessTree(10, T0).absorb(table({ pid: 10, ppid: 1, created: T0 + 5 }));
    expect(await confirmTreeGone(tree, { deadline: Date.now() + 400, list: vi.fn(async () => { throw new Error("listing failed"); }), kill: vi.fn() })).toBe(false);
  });

  it("process-listing timeout confirms nothing and stays within the deadline", async () => {
    await expect(listProcesses({ timeoutMs: 0 })).rejects.toThrow(/no time left/);
    const slow = vi.fn((o: { timeoutMs: number }) => new Promise<Map<number, P>>((_, reject) => setTimeout(() => reject(new Error("listing timed out")), o.timeoutMs)));
    const started = Date.now();
    expect(await confirmTreeGone(new ProcessTree(10, T0), { deadline: started + 600, list: slow, kill: vi.fn() })).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    for (const [options] of slow.mock.calls) expect(options.timeoutMs).toBeLessThanOrEqual(600);
  });

  it.each([
    ["not JSON", "<html>"],
    ["a row without a parent", JSON.stringify([{ ProcessId: process.pid, Created: 5 }])],
    ["a string PID", JSON.stringify([{ ProcessId: String(process.pid), ParentProcessId: 1, Created: 5 }])],
    ["a non-numeric creation time", JSON.stringify([{ ProcessId: process.pid, ParentProcessId: 1, Created: "yesterday" }])],
    ["an incomplete table (this process missing)", JSON.stringify([{ ProcessId: 4, ParentProcessId: 0, Created: 0 }])],
  ])("a malformed or incomplete Windows listing is refused: %s", (_what, stdout) => {
    expect(() => parseWindowsProcesses(stdout)).toThrow(/process listing/);
  });

  it("a well-formed Windows listing parses PID, parent and creation time", () => {
    const parsed = parseWindowsProcesses(JSON.stringify([{ ProcessId: process.pid, ParentProcessId: 7, Created: 1794248279341 }, { ProcessId: 0, ParentProcessId: 0, Created: 0 }]));
    expect(parsed.get(process.pid)).toEqual({ pid: process.pid, ppid: 7, created: 1794248279341 });
  });

  it("Linux: a process that exits during inspection is skipped; malformed or incomplete listings are refused", () => {
    const stat = (pid: number, ppid: number, ticks: number) => `${pid} (node (x)) S ${ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 0 0`;
    const files: Record<string, string> = { "/proc/stat": "cpu 1\nbtime 1700000000\n", [`/proc/${process.pid}/stat`]: stat(process.pid, 1, 500) };
    const read = (path: string) => { if (path === "/proc/77/stat") throw Object.assign(new Error("gone"), { code: "ENOENT" }); if (!(path in files)) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return files[path]; };
    const parsed = listLinuxProcesses({ readdir: () => ["self", "77", String(process.pid)], read });
    expect([...parsed.keys()]).toEqual([process.pid]);
    expect(parsed.get(process.pid)).toMatchObject({ ppid: 1, created: 1700000000 * 1000 + 500 * 10 });
    expect(() => listLinuxProcesses({ readdir: () => [String(process.pid)], read: (p: string) => (p === "/proc/stat" ? "no boot time" : files[p]) })).toThrow(/incomplete/);
    expect(() => listLinuxProcesses({ readdir: () => [String(process.pid)], read: (p: string) => (p === "/proc/stat" ? files[p] : "1 (x) S y z") })).toThrow(/malformed/);
    expect(() => listLinuxProcesses({ readdir: () => ["5"], read: (p: string) => (p === "/proc/stat" ? files[p] : stat(5, 1, 9)) })).toThrow(/incomplete/);
    expect(() => listLinuxProcesses({ readdir: () => ["88", String(process.pid)], read })).toThrow(/EACCES/);
  });

  it("PID reuse: a different process now holding a member's PID is neither killed nor waited for, nor are its children", async () => {
    const m = machine([{ pid: 10, ppid: 1, created: T0 + 5 }, { pid: 11, ppid: 10, created: T0 + 6 }]);
    const tree = new ProcessTree(10, T0).absorb(new Map(m.procs));
    m.procs.delete(10); m.procs.delete(11); // the tree ends ...
    m.procs.set(10, { pid: 10, ppid: 1, created: T0 + 900 }); // ... and its PIDs are reused by unrelated processes
    m.procs.set(12, { pid: 12, ppid: 10, created: T0 + 950 });
    expect(await confirmTreeGone(tree, { deadline: soon(), list: m.list, kill: m.kill })).toBe(true);
    expect(m.killed).toEqual([]);
    // The root is identified only while Node reports it running: a PID seen after it exited is never adopted.
    expect(new ProcessTree(10, T0, () => false).absorb(table({ pid: 10, ppid: 1, created: T0 + 900 })).members.size).toBe(0);
  });

  it("a child that survives its parent (and a grandchild never seen before) is killed and confirmed gone", async () => {
    const m = machine([{ pid: 10, ppid: 1, created: T0 + 5 }, { pid: 11, ppid: 10, created: T0 + 6 }]);
    const tree = new ProcessTree(10, T0).absorb(new Map(m.procs));
    m.procs.delete(10); // the parent exits; 11 lives on and starts 12
    m.procs.set(12, { pid: 12, ppid: 11, created: T0 + 7 });
    expect(await confirmTreeGone(tree, { deadline: soon(), list: m.list, kill: m.kill })).toBe(true);
    expect(m.killed.sort()).toEqual([`11@${T0 + 6}`, `12@${T0 + 7}`]);
  });

  it("a root that exited before any listing: look-alike children are tracked by inference, keep the tree unconfirmed and are NEVER killed", async () => {
    const m = machine([{ pid: 11, ppid: 10, created: T0 + 6 }, { pid: 13, ppid: 10, created: T0 - 50_000 }]);
    const tree = new ProcessTree(10, T0, () => false);
    expect(await confirmTreeGone(tree, { deadline: Date.now() + 500, list: m.list, kill: m.kill })).toBe(false); // 11 is alive and cannot be shown to be ours
    expect([...tree.members.values()].map((p) => p.pid)).toEqual([11]); // 13 predates the spawn: not even tracked
    expect(m.killed).toEqual([]);
    m.procs.delete(11); // once it is gone, the tree is confirmed
    expect(await confirmTreeGone(tree, { deadline: soon(), list: m.list, kill: m.kill })).toBe(true);
  });

  it("a root that exited before any listing: a look-alike child created after the root exited is not adopted", async () => {
    const tree = new ProcessTree(10, T0, () => false); tree.rootExited = T0 + 100;
    tree.absorb(table({ pid: 11, ppid: 10, created: T0 + 50 }, { pid: 12, ppid: 10, created: T0 + 100 + 60_000 }));
    expect([...tree.members.values()].map((p) => p.pid)).toEqual([11]);
  });

  it("termination that cannot be confirmed (kills ignored or failing) is reported as such at the deadline", async () => {
    const m = machine([{ pid: 10, ppid: 1, created: T0 + 5 }], { obeys: false });
    const tree = new ProcessTree(10, T0).absorb(new Map(m.procs));
    expect(await confirmTreeGone(tree, { deadline: Date.now() + 500, list: m.list, kill: m.kill })).toBe(false);
    expect(await confirmTreeGone(tree, { deadline: Date.now() + 500, list: m.list, kill: () => { throw new Error("Access is denied"); } })).toBe(false);
  });

  it("runTree: an unconfirmable tree is leaseAbandoned; the overrun of cleanup is bounded", async () => {
    const started = Date.now();
    const error = await runTree(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 300, cleanupMs: 800, list: async () => { throw new Error("listing failed"); } }).catch((e) => e);
    expect(error.leaseAbandoned).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    // A command that finished but whose tree cannot be confirmed is not a success either.
    const finished = await runTree(process.execPath, ["-e", "0"], { timeoutMs: 20_000, cleanupMs: 500, list: async () => { throw new Error("listing failed"); } }).catch((e) => e);
    expect(finished.leaseAbandoned).toBe(true);
  }, 30_000);

  it("runTree: the real whole tree (node -> node) is killed on timeout and confirmed gone; a finished one returns", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "stage-tree-")), "grandchild");
    const script = `const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true, windowsHide: true }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setInterval(() => {}, 1000);`;
    await expect(runTree(process.execPath, ["-e", script], { timeoutMs: 4_000 })).rejects.toThrow(/killed and confirmed terminated/);
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
    await expect(runTree(process.execPath, ["-e", "console.log('ok')"], { timeoutMs: 30_000 })).resolves.toMatchObject({ status: 0, stdout: expect.stringContaining("ok") });
  }, 90_000);

  it("boundedDocker never runs past the deadline and caps each call", () => {
    const spawn = vi.fn((_c: string, _a: string[], o: { timeout: number }) => ({ status: 0, stdout: String(o.timeout), stderr: "", error: undefined }));
    expect(boundedDocker(Date.now() - 1, { spawn: spawn as never })(["info"])).toEqual({ ok: false, stdout: "", stderr: "the operation deadline is exhausted" });
    expect(spawn).not.toHaveBeenCalled();
    expect(Number(boundedDocker(Date.now() + 600_000, { cap: 20_000, spawn: spawn as never })(["info"]).stdout)).toBe(20_000);
    expect(Number(boundedDocker(Date.now() + 5_000, { spawn: spawn as never })(["info"]).stdout)).toBeLessThanOrEqual(5_000);
  });
});

describe("lease lifecycle around a guarded reset", () => {
  const lease = { parentId: "parent", image: PG_ID };
  const base = () => ({ services: resolves("17.11.0.003", "v1.90.0"), docker: fakeDocker(), held: vi.fn() });

  it("uncertain termination of a REAL reset child keeps the lease (no release call)", async () => {
    const releaseLease = vi.fn();
    // Instead of the CLI, a harmless sleeper; its tree cannot be confirmed because every listing fails.
    const run = (_c: string, _a: string[], o: { timeoutMs: number; cleanupMs?: number }) => runTree(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { ...o, timeoutMs: 300, cleanupMs: 600, list: async () => { throw new Error("listing failed"); } });
    await expect(resetLocal([], { workdir: project(), timeoutMs: 120_000, ...base(), run, acquireLease: () => lease, releaseLease })).rejects.toMatchObject({ leaseAbandoned: true });
    expect(releaseLease).not.toHaveBeenCalled();
  }, 30_000);

  it("the lease is released only after the reset (and its tree confirmation) completed", async () => {
    const order: string[] = [];
    const run = vi.fn(async () => { await new Promise((r) => setTimeout(r, 50)); order.push("reset finished, tree confirmed"); return { status: 0, stdout: "", stderr: "" }; });
    await resetLocal([], { workdir: project(), timeoutMs: 120_000, ...base(), run, acquireLease: () => { order.push("lease"); return lease; }, releaseLease: () => order.push("release") });
    expect(order).toEqual(["lease", "reset finished, tree confirmed", "release"]);
  });

  it("an outer budget too small for the reset plus its cleanup starts nothing", async () => {
    const run = vi.fn();
    const releaseLease = vi.fn();
    await expect(resetLocal([], { workdir: project(), timeoutMs: RELEASE_RESERVE + CLEANUP_RESERVE, ...base(), run, acquireLease: () => lease, releaseLease })).rejects.toThrow(/cleanup reserve; nothing was reset/);
    expect(run).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledTimes(1); // nothing ran, so nothing can outlive the lease
    await expect(guardedLocalReset({ root: project(), lease, timeoutMs: CLEANUP_RESERVE, ...base(), run })).rejects.toThrow(/cleanup reserve/);
  });

  it("every inner deadline fits inside the outer one: services and reset get only what is left minus the cleanup reserve", async () => {
    const run = vi.fn<(c: string, a: string[], o: { timeoutMs: number; cleanupMs: number }) => Promise<{ status: number; stdout: string; stderr: string }>>(async () => ({ status: 0, stdout: "", stderr: "" }));
    const started = Date.now();
    await guardedLocalReset({ root: project(), lease, timeoutMs: 90_000, ...base(), run });
    const [, , options] = run.mock.calls[0];
    expect(options.cleanupMs).toBe(CLEANUP_RESERVE);
    expect(started + options.timeoutMs + options.cleanupMs).toBeLessThanOrEqual(started + 90_000);
    // The outer supervisors: verify outlives backup.mjs's reset budget; the hooks outlive their reset budget.
    const backup = readFileSync("scripts/backup.mjs", "utf8");
    const inner = Number(/const BACKUP_RESET_BUDGET = (\d+)_(\d+);/.exec(backup)!.slice(1).join(""));
    expect(VERIFY_TIMEOUT).toBeGreaterThanOrEqual(inner + 300_000);
    expect(backup).toContain("timeoutMs: BACKUP_RESET_BUDGET });");
  });
});

// ---- Review 9: unknown identities fail closed; ONE absolute cleanup deadline ----------------------------------------------
describe("unknown process identities never confirm termination", () => {
  type P = { pid: number; ppid: number; created: number | null };
  const T0 = 1_000_000;
  const self: P = { pid: process.pid, ppid: 1, created: 1 };
  const listing = (...rows: P[]) => new Map([self, ...rows].map((r) => [r.pid, r]));

  it("a missing, zero or null CreationDate parses as an UNKNOWN identity, never as a time; garbage is still malformed", () => {
    const parsed = parseWindowsProcesses(JSON.stringify([{ ProcessId: process.pid, ParentProcessId: 1, Created: 5 }, { ProcessId: 20, ParentProcessId: 10, Created: null }, { ProcessId: 21, ParentProcessId: 10, Created: 0 }]));
    expect(parsed.get(20)).toEqual({ pid: 20, ppid: 10, created: null });
    expect(parsed.get(21)?.created).toBeNull();
    for (const created of ["x", -1, true, {}]) expect(() => parseWindowsProcesses(JSON.stringify([{ ProcessId: process.pid, ParentProcessId: 1, Created: 5 }, { ProcessId: 20, ParentProcessId: 1, Created: created }]))).toThrow(/malformed/);
    expect(WINDOWS_LIST).not.toMatch(/else \{ 0 \}/); // the listing no longer substitutes 0 for an unreadable time
    expect(WINDOWS_LIST).toContain("$ErrorActionPreference = 'Stop'");
  });

  it("a tracked surviving child that now reports no creation time is NOT classified as terminated, and is never killed", async () => {
    const tree = new ProcessTree(10, T0).absorb(listing({ pid: 10, ppid: 1, created: T0 + 5 }, { pid: 11, ppid: 10, created: T0 + 6 }));
    const kill = vi.fn();
    const survivors = listing({ pid: 11, ppid: 10, created: null }); // the root is gone; 11 lives on, identity unreadable
    expect(tree.alive(survivors)).toEqual([]); // the old code stopped here and confirmed
    expect(tree.uncertain(survivors).map((p) => p.pid)).toEqual([11]);
    expect(await confirmTreeGone(tree, { deadline: Date.now() + 400, list: async () => new Map(survivors), kill })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    // ...and once it really is gone, termination is confirmed.
    expect(await confirmTreeGone(tree, { deadline: Date.now() + 400, list: async () => listing(), kill })).toBe(true);
  });

  it("a child of a tracked process, or a holder of a tracked PID, with unknown identity also blocks confirmation", async () => {
    const tree = new ProcessTree(10, T0).absorb(listing({ pid: 10, ppid: 1, created: T0 + 5 }));
    for (const row of [{ pid: 30, ppid: 10, created: null }, { pid: 10, ppid: 1, created: null }]) {
      expect(await confirmTreeGone(tree, { deadline: Date.now() + 300, list: async () => listing(row), kill: vi.fn() }), JSON.stringify(row)).toBe(false);
    }
    // An unobserved root's PID, held by an unknown-identity process, is uncertain too.
    expect(await confirmTreeGone(new ProcessTree(10, T0, () => false), { deadline: Date.now() + 300, list: async () => listing({ pid: 10, ppid: 1, created: null }), kill: vi.fn() })).toBe(false);
  });

  it("an unrelated unknown-identity process does not block (no tracked PID, no tracked parent)", async () => {
    const tree = new ProcessTree(10, T0).absorb(listing({ pid: 10, ppid: 1, created: T0 + 5 }));
    expect(await confirmTreeGone(tree, { deadline: Date.now() + 400, list: async () => listing({ pid: 99, ppid: 1, created: null }), kill: vi.fn() })).toBe(true);
  });

  it("unknown-identity processes are tracked by PID only: never alive by identity, so never killed as members", () => {
    const table = listing({ pid: 10, ppid: 1, created: T0 + 5 }, { pid: 40, ppid: 10, created: null });
    const tree = new ProcessTree(10, T0).absorb(table);
    expect([...tree.members.values()].map((p) => [p.pid, !!p.unknown])).toEqual([[10, false], [40, true]]);
    expect(tree.alive(table).map((p) => p.pid)).toEqual([10]);
  });

  it("a REAL surviving grandchild whose creation time is unreadable makes runTree leaseAbandoned, and resetLocal keeps the lease", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-unknown-"));
    const pidFile = join(dir, "grandchild");
    const script = `const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true, windowsHide: true }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setInterval(() => {}, 1000);`;
    // The real listing, except that the grandchild's CreationDate is reported as unreadable.
    const blind = async (o: { timeoutMs: number }) => {
      const table = await listProcesses(o);
      const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
      const row = table.get(pid);
      if (row) table.set(pid, { ...row, created: null as never });
      return table;
    };
    const run = (_c: string, _a: string[], o: { timeoutMs: number; cleanupMs?: number; deadline?: number }) => runTree(process.execPath, ["-e", script], { ...o, timeoutMs: 3_000, cleanupMs: 4_000, list: blind });
    const releaseLease = vi.fn();
    try {
      await expect(resetLocal([], { workdir: project(), timeoutMs: 120_000, services: resolves("17.11.0.003", "v1.90.0"), docker: fakeDocker(), held: vi.fn(), run, acquireLease: () => ({ parentId: "parent", image: PG_ID }), releaseLease })).rejects.toMatchObject({ leaseAbandoned: true });
      expect(releaseLease).not.toHaveBeenCalled();
      expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), "the unknown-identity grandchild really survived").not.toThrow();
    } finally {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* gone */ }
    }
  }, 60_000);
});

// ---- Review 10 MAJOR-1: ancestry is preserved THROUGH an unknown-identity intermediate --------------------------------
describe("unknown-identity intermediates keep their descendants tracked", () => {
  type P = { pid: number; ppid: number; created: number | null };
  const T0 = 1_000_000;
  const self: P = { pid: process.pid, ppid: 1, created: 1 };
  const listing = (...rows: P[]) => new Map([self, ...rows].map((r) => [r.pid, r]));
  const R: P = { pid: 10, ppid: 1, created: T0 + 5 };
  const C: P = { pid: 20, ppid: 10, created: null };
  const G: P = { pid: 30, ppid: 20, created: T0 + 7 };
  const confirm = (tree: ProcessTree, rows: P[], kill = vi.fn()) => confirmTreeGone(tree, { deadline: Date.now() + 400, list: async () => listing(...rows), kill });

  it("R -> C(unknown) -> G(alive): after R and C exit, G still blocks confirmation and is never killed", async () => {
    const tree = new ProcessTree(10, T0).absorb(listing(R, C, G));
    const kill = vi.fn();
    expect(await confirm(tree, [G], kill)).toBe(false); // the old code forgot G here and confirmed
    expect(tree.alive(listing(G)).map((p) => [p.pid, p.inferred])).toEqual([[30, true]]);
    expect(kill).not.toHaveBeenCalled(); // reached only through an unknown identity: inferred, never killed
    expect(await confirm(tree, [])).toBe(true); // once G is really gone
  });

  it("R -> C(unknown) -> G(exited): nothing is confirmed while C may live; only an empty lineage confirms", async () => {
    const tree = new ProcessTree(10, T0).absorb(listing(R, C, G));
    const kill = vi.fn();
    expect(await confirm(tree, [C], kill)).toBe(false); // R and G gone, C (unknown) still there
    expect(kill).not.toHaveBeenCalled();
    expect(await confirm(tree, [])).toBe(true);
  });

  it("a G first seen only AFTER its unknown parent exited is still adopted (by inference)", async () => {
    const tree = new ProcessTree(10, T0).absorb(listing(R, C));
    expect(await confirm(tree, [G])).toBe(false);
  });

  it("chains of unknowns, and an unknown child of a root no listing saw, are followed too", async () => {
    const C2: P = { pid: 24, ppid: 20, created: null };
    const chained = new ProcessTree(10, T0).absorb(listing(R, C, C2));
    expect(await confirm(chained, [{ pid: 31, ppid: 24, created: T0 + 9 }])).toBe(false);
    const unseen = new ProcessTree(10, T0, () => false).absorb(listing(C));
    expect(await confirm(unseen, [G])).toBe(false);
  });

  it("an intermediate whose Created property is MISSING (not null, not 0) is an unknown identity, end to end", async () => {
    const parsed = parseWindowsProcesses(JSON.stringify([
      { ProcessId: process.pid, ParentProcessId: 1, Created: 1 }, { ProcessId: 10, ParentProcessId: 1, Created: T0 + 5 },
      { ProcessId: 20, ParentProcessId: 10 }, { ProcessId: 30, ParentProcessId: 20, Created: T0 + 7 },
    ]));
    expect(parsed.get(20)).toEqual({ pid: 20, ppid: 10, created: null });
    const tree = new ProcessTree(10, T0).absorb(parsed);
    const kill = vi.fn();
    expect(await confirm(tree, [G], kill)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("PID reuse: an unrelated process now holding C's PID, and its child, are neither killed nor waited for", async () => {
    const tree = new ProcessTree(10, T0).absorb(listing(R, C));
    const X: P = { pid: 20, ppid: 1, created: T0 + 900 }; // C's PID, reused after the tree ended
    const Y: P = { pid: 31, ppid: 20, created: T0 + 950 };
    const kill = vi.fn();
    expect(await confirm(tree, [X, Y], kill)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    // A known descendant reached through an unknown holder is never killed, even while it lives with the tree.
    const t2 = new ProcessTree(10, T0).absorb(listing(R, C, G));
    const k2 = vi.fn();
    expect(await confirmTreeGone(t2, { deadline: Date.now() + 300, list: async () => listing(R, C, G), kill: k2 })).toBe(false);
    expect(k2.mock.calls.map(([p]) => p.pid)).toEqual(expect.arrayContaining([10]));
    expect(k2.mock.calls.every(([p]) => p.pid === 10)).toBe(true); // only R, the identified member
  });

  it("a failed or timed-out listing still confirms nothing with an unknown intermediate in the tree", async () => {
    const tree = new ProcessTree(10, T0).absorb(listing(R, C, G));
    expect(await confirmTreeGone(tree, { deadline: Date.now() + 300, list: async () => { throw new Error("listing failed"); }, kill: vi.fn() })).toBe(false);
    const slow = (o: { timeoutMs: number }) => new Promise<Map<number, P>>((_, reject) => setTimeout(() => reject(new Error("timed out")), o.timeoutMs));
    const started = Date.now();
    expect(await confirmTreeGone(tree, { deadline: started + 400, list: slow, kill: vi.fn() })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  // A REAL root R (a node process) with a mocked listing: R and its unknown child C while R runs, G as told.
  const scripted = (pidFile: string, gAlive: () => boolean) => {
    let rCreated = 0;
    return async () => {
      const r = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
      let rAlive = false;
      if (r) { try { process.kill(r, 0); rAlive = true; } catch { /* exited */ } }
      if (r && !rCreated) rCreated = Date.now();
      const rows: P[] = [];
      if (rAlive) rows.push({ pid: r, ppid: process.pid, created: rCreated }, { pid: 2_000_000_001, ppid: r, created: null });
      if (gAlive() && rCreated) rows.push({ pid: 2_000_000_003, ppid: 2_000_000_001, created: rCreated + 2 });
      return listing(...rows);
    };
  };
  const lifecycle = async (gAlive: () => boolean) => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "stage-r10-")), "root");
    const kill = vi.fn();
    const releaseLease = vi.fn();
    const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 1_500);`;
    const run = (_c: string, _a: string[], o: { timeoutMs: number; cleanupMs?: number; deadline?: number }) => runTree(process.execPath, ["-e", script], { ...o, timeoutMs: 20_000, cleanupMs: 1_500, watchMs: 100, list: scripted(pidFile, gAlive), kill });
    const result = await resetLocal([], { workdir: project(), timeoutMs: 120_000, services: resolves("17.11.0.003", "v1.90.0"), docker: fakeDocker(), held: vi.fn(), run, acquireLease: () => ({ parentId: "parent", image: PG_ID }), releaseLease }).then(() => "ok", (e) => e);
    return { result, kill, releaseLease };
  };

  it("guarded reset: R -> C(unknown) -> G surviving R and C makes runTree leaseAbandoned, and the lease is kept", async () => {
    const { result, kill, releaseLease } = await lifecycle(() => true);
    expect(result).toMatchObject({ leaseAbandoned: true });
    expect(releaseLease).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled(); // neither C (unknown) nor G (inferred through C)
  }, 30_000);

  it("guarded reset: the same tree terminating normally (C and G gone with R) releases the lease once", async () => {
    const { result, releaseLease } = await lifecycle(() => false);
    expect(result).toBe("ok");
    expect(releaseLease).toHaveBeenCalledTimes(1);
  }, 30_000);
});

describe("one absolute cleanup deadline", () => {
  type P = { pid: number; ppid: number; created: number | null };
  const T0 = 1_000_000;
  const self: P = { pid: process.pid, ppid: 1, created: 1 };
  const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  it("sequential stalled kills cannot outrun the deadline: each is capped by the time left, and none starts after it", async () => {
    const rows: P[] = [{ pid: 10, ppid: 1, created: T0 + 1 }, ...Array.from({ length: 12 }, (_, i) => ({ pid: 11 + i, ppid: 10, created: T0 + 2 + i }))];
    const table = () => new Map([self, ...rows].map((r) => [r.pid, r]));
    const tree = new ProcessTree(10, T0).absorb(table());
    const budgets: number[] = [];
    const kill = vi.fn((_p: unknown, o: { timeoutMs: number }) => { budgets.push(o.timeoutMs); block(150); }); // a stalled taskkill: burns 150 ms, kills nothing
    const started = Date.now();
    expect(await confirmTreeGone(tree, { deadline: started + 600, list: async () => table(), kill })).toBe(false);
    expect(Date.now() - started).toBeLessThan(600 + 400);
    expect(kill.mock.calls.length).toBeLessThan(13); // far fewer than the 13 live members
    for (const b of budgets) { expect(b).toBeLessThanOrEqual(KILL_CAP); expect(b).toBeGreaterThan(0); expect(b).toBeLessThanOrEqual(600); }
    const attempts = kill.mock.calls.length;
    expect(await confirmTreeGone(tree, { deadline: Date.now() - 1, list: async () => { throw new Error("must not list"); }, kill })).toBe(false);
    expect(kill.mock.calls.length).toBe(attempts); // an exhausted budget attempts nothing more
  });

  it("an exhausted budget lists nothing, kills nothing, confirms nothing", async () => {
    const list = vi.fn(); const kill = vi.fn();
    expect(await confirmTreeGone(new ProcessTree(10, T0), { deadline: Date.now(), list, kill })).toBe(false);
    expect(list).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
  });

  it("the default kill refuses a process without a usable identity", () => {
    expect(KILL_CAP).toBeLessThanOrEqual(5_000);
    expect(() => defaultKill({ pid: process.pid, created: Number.NaN } as never)).not.toThrow(); // returns without killing: this test is still running
    expect(() => defaultKill({ pid: -1, created: 1 } as never)).not.toThrow();
  });

  it.skipIf(process.platform !== "win32")("Windows kill is bound to the process handle: a different creation time kills nothing, the right one does", () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    try {
      const stamp = Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `([DateTimeOffset](Get-CimInstance Win32_Process -Filter "ProcessId=${child.pid}").CreationDate).ToUnixTimeMilliseconds()`], { encoding: "utf8" }).trim());
      defaultKill({ pid: child.pid!, created: stamp + 5_000 });
      expect(() => process.kill(child.pid!, 0), "wrong creation time: untouched").not.toThrow();
      defaultKill({ pid: child.pid!, created: stamp });
      const end = Date.now() + 5_000; let alive = true;
      while (alive && Date.now() < end) { try { process.kill(child.pid!, 0); block(100); } catch { alive = false; } }
      expect(alive, "right creation time: terminated").toBe(false);
      expect(windowsKill({ pid: 1, created: 2 })).toMatch(/\$p\.Handle[\s\S]*StartTime[\s\S]*\$p\.Kill\(\)/);
    } finally { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  }, 30_000);

  it("runTree: stalled kills of a REAL surviving grandchild end at the one absolute deadline, with the lease flag set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-deadline-"));
    const pidFile = join(dir, "grandchild");
    const script = `const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true, windowsHide: true }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setInterval(() => {}, 1000);`;
    const stalls: number[] = [];
    const kill = vi.fn((_p: unknown, o: { timeoutMs: number }) => { stalls.push(o.timeoutMs); block(400); }); // never kills anything
    const started = Date.now();
    try {
      const error = await runTree(process.execPath, ["-e", script], { timeoutMs: 3_000, cleanupMs: 3_000, kill }).catch((e) => e);
      expect(error.leaseAbandoned).toBe(true);
      // timeout 3 s + cleanup 3 s is ONE budget: the stalled kills and listings never restart it.
      expect(Date.now() - started).toBeLessThan(6_000 + 2_500);
      for (const b of stalls) expect(b).toBeLessThanOrEqual(3_000);
    } finally {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* gone */ }
    }
  }, 60_000);

  it("guardedLocalReset hands the SAME absolute deadline to the services check and the reset", async () => {
    const lease = { parentId: "parent", image: PG_ID };
    const calls: { args: string[]; deadline?: number; cleanupMs?: number; timeoutMs: number }[] = [];
    const run = vi.fn(async (_c: string, args: string[], o: { deadline?: number; cleanupMs?: number; timeoutMs: number }) => { calls.push({ args, ...o }); return { status: 0, stdout: "", stderr: "" }; });
    const started = Date.now();
    await guardedLocalReset({ root: project(), lease, timeoutMs: 90_000, services: async (dir: string, o: object) => { await cliServices(dir, { ...o, run: (async (...x: unknown[]) => { await (run as never as (...y: unknown[]) => unknown)(...x); return { status: 0, stdout: "", stderr: "" }; }) as never }); return { "supabase/postgres": "17.11.0.003", "supabase/storage-api": "v1.90.0" }; }, docker: fakeDocker(), held: vi.fn(), run });
    expect(calls.some((c) => c.args.includes("services")) && calls.some((c) => c.args.includes("reset"))).toBe(true);
    const deadlines = new Set(calls.map((c) => c.deadline));
    expect(deadlines.size).toBe(1);
    const [deadline] = [...deadlines] as number[];
    expect(deadline).toBeGreaterThanOrEqual(started + 90_000 - 1_000);
    expect(deadline).toBeLessThanOrEqual(started + 90_000 + 1_000);
    for (const c of calls) expect(started + c.timeoutMs + (c.cleanupMs ?? 0)).toBeLessThanOrEqual(deadline + 5);
  });

  it("runTree never lets its end exceed a given absolute deadline", async () => {
    const started = Date.now();
    const error = await runTree(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 60_000, cleanupMs: 600, deadline: started + 1_500, list: async () => { throw new Error("listing failed"); } }).catch((e) => e);
    expect(error.leaseAbandoned).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_500 + 800);
  }, 30_000);
});

// ---- Review 9: G6-B backup creation reads the LOCAL stack only -----------------------------------------------------------
describe("G6-B backup source is strictly local", () => {
  const HOSTED = {
    SHOPKHATA_BACKUP_DB_URL: "postgresql://postgres:hosted-secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
    SHOPKHATA_BACKUP_ENV: "production", SHOPKHATA_BACKUP_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SHOPKHATA_BACKUP_SERVICE_ROLE_KEY: "hosted-service-key",
    SHOPKHATA_RESTORE_DB_URL: "postgresql://postgres:x@db.abcdefghijklmnopqrst.supabase.co:5432/postgres", SHOPKHATA_RESTORE_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SHOPKHATA_RESTORE_SERVICE_ROLE_KEY: "hosted-restore-key",
    SUPABASE_ACCESS_TOKEN: "sbp_hosted", SUPABASE_DB_PASSWORD: "hosted", PGHOST: "db.abcdefghijklmnopqrst.supabase.co", PGPASSWORD: "hosted", DOCKER_CONTEXT: "remote", HTTPS_PROXY: "http://proxy.example:8080",
  };
  const base = { ...HOSTED, PATH: "/bin", SystemRoot: "C:\\Windows", DOCKER_HOST: "unix:///var/run/docker.sock", SHOPKHATA_RESTORE_LOCK_ID: "id1", SHOPKHATA_RESTORE_LOCK_TOKEN: "tok1" };
  const dockerOk = () => ({ ok: true, stdout: "", stderr: "" });

  it("a launching shell full of hosted backup variables yields an environment with none of them", () => {
    const env = localOnlyEnv({ SHOPKHATA_BACKUP_DIR: "/tmp/b" }, base, dockerOk);
    for (const name of Object.keys(HOSTED)) expect(env, name).not.toHaveProperty(name);
    expect(JSON.stringify(env)).not.toMatch(/hosted|supabase\.co|abcdefghijklmnopqrst/);
    expect(env).toMatchObject({ PATH: "/bin", SHOPKHATA_BACKUP_DIR: "/tmp/b", DOCKER_HOST: "unix:///var/run/docker.sock", SHOPKHATA_RESTORE_LOCK_ID: "id1", SHOPKHATA_RESTORE_LOCK_TOKEN: "tok1" });
  });

  it("anything passed explicitly that routes to a remote or non-local source is refused before a process starts", () => {
    for (const extra of [
      { SHOPKHATA_BACKUP_DB_URL: HOSTED.SHOPKHATA_BACKUP_DB_URL }, { SHOPKHATA_BACKUP_ENV: "production" }, { SHOPKHATA_BACKUP_SUPABASE_URL: HOSTED.SHOPKHATA_BACKUP_SUPABASE_URL },
      { SHOPKHATA_BACKUP_SERVICE_ROLE_KEY: "k" }, { SHOPKHATA_RESTORE_DB_URL: HOSTED.SHOPKHATA_RESTORE_DB_URL }, { SHOPKHATA_RESTORE_SUPABASE_URL: HOSTED.SHOPKHATA_RESTORE_SUPABASE_URL },
      { SHOPKHATA_RESTORE_DB_URL: "postgresql://postgres@localhost:55322/postgres" }, { SHOPKHATA_RESTORE_SUPABASE_URL: "http://localhost:55321" },
    ] as Record<string, string>[]) expect(() => localOnlyEnv(extra, base, dockerOk), JSON.stringify(extra)).toThrow(/local|target/i);
    expect(() => localOnlyEnv({ SHOPKHATA_RESTORE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55322/postgres", SHOPKHATA_RESTORE_SUPABASE_URL: LOCAL_API, SHOPKHATA_RESTORE_SERVICE_ROLE_KEY: "local" }, base, dockerOk)).not.toThrow();
  });

  it("a Docker endpoint that is not the local daemon is refused", () => {
    expect(() => localOnlyEnv({}, { PATH: "/bin", DOCKER_HOST: "tcp://203.0.113.7:2375" }, dockerOk)).toThrow(/Docker/);
  });

  const container = (name: string, port: number, internal: number) => JSON.stringify({ Id: "d".repeat(64), Name: `/${name}`, State: { Running: true }, Config: { Labels: { "com.supabase.cli.project": "shopkhata" } }, NetworkSettings: { Ports: { [`${internal}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(port) }] } } });
  const localDocker = (args: string[]) => ({ ok: true, stdout: args.at(-1) === "supabase_db_shopkhata" ? container("supabase_db_shopkhata", 55322, 5432) : container("supabase_kong_shopkhata", 55321, 8000), stderr: "" });
  const statusOut = (api: string, db: string) => `API_URL="${api}"\nDB_URL="${db}"\n`;
  const LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

  it("localBackup with hosted variables in the launching shell: the CLI check and backup.mjs get only local endpoints", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-backup-"));
    const seen: { args: string[]; env: Record<string, string | undefined> }[] = [];
    const run = vi.fn(async (_c: string, args: string[], o: { env?: Record<string, string | undefined> }) => {
      seen.push({ args, env: o.env ?? {} });
      if (args.includes("status")) return { status: 0, stdout: statusOut(LOCAL_API, LOCAL_DB), stderr: "" };
      const out = join(dir, "shopkhata-local-x"); mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "manifest.json"), JSON.stringify({ environment: "local", source: "local Supabase stack" }));
      return { status: 0, stdout: `[backup] Backup complete: ${out}\n`, stderr: "" };
    });
    const backup = await localBackup(dir, {}, { base, docker: localDocker, run: run as never });
    expect(backup).toContain("shopkhata-local-x");
    expect(seen).toHaveLength(2);
    for (const { env } of seen) {
      for (const name of Object.keys(HOSTED)) expect(env, name).not.toHaveProperty(name);
      expect(JSON.stringify(env)).not.toMatch(/hosted|supabase\.co/);
    }
    expect(seen[1].args[0]).toBe("scripts/backup.mjs");
  });

  it("an ambiguous or non-local source is rejected BEFORE the backup command is spawned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-backup-"));
    const cases: [string, string, (args: string[]) => { ok: boolean; stdout: string; stderr: string }][] = [
      ["CLI reports a hosted API", statusOut("https://abcdefghijklmnopqrst.supabase.co", LOCAL_DB), localDocker],
      ["CLI reports a hosted database", statusOut(LOCAL_API, "postgresql://postgres:x@db.abcdefghijklmnopqrst.supabase.co:5432/postgres"), localDocker],
      ["CLI reports nothing", "", localDocker],
      ["local containers are not the running ShopKhata stack", statusOut(LOCAL_API, LOCAL_DB), () => ({ ok: false, stdout: "", stderr: "no such container" })],
    ];
    for (const [what, stdout, docker] of cases) {
      const run = vi.fn(async (..._a: unknown[]) => ({ status: 0, stdout, stderr: "" }));
      await expect(localBackup(dir, {}, { base, docker, run: run as never }), what).rejects.toThrow();
      expect(run.mock.calls.filter((call) => (call[1] as unknown as string[])[0] === "scripts/backup.mjs"), what).toEqual([]);
    }
  });

  it("a backup whose manifest is not local is rejected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-backup-"));
    const run = vi.fn(async (_c: string, args: string[]) => {
      if (args.includes("status")) return { status: 0, stdout: statusOut(LOCAL_API, LOCAL_DB), stderr: "" };
      const out = join(dir, "x"); mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "manifest.json"), JSON.stringify({ environment: "production", source: "db.abcdefghijklmnopqrst.supabase.co" }));
      return { status: 0, stdout: `Backup complete: ${out}`, stderr: "" };
    });
    await expect(localBackup(dir, {}, { base, docker: localDocker, run: run as never })).rejects.toThrow(/not taken from the local stack/);
  });

  it("the G6-B and rehearsal tests create their backups only through localBackup", () => {
    for (const f of ["locked-restore.test.ts", "release-window-rehearsal.test.ts"]) {
      const text = readFileSync(join("tests", "integration", "operations", f), "utf8");
      expect(text, f).not.toMatch(/sh\(\["backup:db"\]/);
      expect(text, f).toContain("localBackup(");
    }
  });
});
