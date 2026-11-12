import { describe, expect, it } from "vitest";
import { assertLocalEndpoint, classifyDatabaseTarget, validateRestoreEndpoints } from "../../scripts/backup-target.mjs";

describe("database target policy", () => {
  it.each([
    "postgres://postgres@localhost:55322/postgres",
    "postgres://postgres@192.168.1.5:55322/postgres",
    "postgres://postgres@host.docker.internal:55322/postgres",
    "postgres://postgres@127.0.0.1:5432/postgres",
    "postgres://postgres@127.0.0.1:55322/other",
    "postgres://postgres@127.0.0.1:55322/postgres?host=other",
    "postgres://postgres@tunnel.example.com:55322/postgres",
    "postgres://postgres@127.1:55322/postgres",
  ])("rejects ambiguous or unsupported target %s", (url) => {
    expect(() => classifyDatabaseTarget(url)).toThrow(/target/i);
  });
  it("recognizes only the exact supported local URL", () => {
    expect(classifyDatabaseTarget("postgres://postgres:local@127.0.0.1:55322/postgres")).toBe("local");
  });
  it("retains hosted Supabase direct and pooler targets", () => {
    expect(classifyDatabaseTarget("postgres://postgres@db.abcdefghijklmnopqrst.supabase.co:5432/postgres")).toBe("hosted");
    expect(classifyDatabaseTarget("postgres://postgres.abcdefghijklmnopqrst@aws-0-us-east-1.pooler.supabase.com:5432/postgres")).toBe("hosted");
  });

  it("refuses mismatched hosted API/database projects before connecting", () => {
    expect(() => validateRestoreEndpoints("postgres://postgres@db.abcdefghijklmnopqrst.supabase.co:5432/postgres", "https://otherprojectabcdefgh.supabase.co")).toThrow(/target/);
    expect(validateRestoreEndpoints("postgres://postgres@db.abcdefghijklmnopqrst.supabase.co:5432/postgres", "https://abcdefghijklmnopqrst.supabase.co")).toBe("hosted");
  });

  const container = () => ({ Id: "d".repeat(64), Name: "/supabase_db_shopkhata", State: { Running: true },
    Config: { Labels: { "com.supabase.cli.project": "shopkhata" } },
    NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55322" }] } },
  });
  it.each(["correct", "wrong project", "wrong name", "wrong port", "stopped", "unreachable"])("validates the actual database container: %s", (scenario) => {
    const info = container();
    if (scenario === "wrong project") info.Config.Labels["com.supabase.cli.project"] = "other";
    if (scenario === "wrong name") info.Name = "/other";
    if (scenario === "wrong port") info.NetworkSettings.Ports["5432/tcp"][0].HostPort = "9999";
    if (scenario === "stopped") info.State.Running = false;
    const action = () => assertLocalEndpoint("supabase_db_shopkhata", 55322, 5432, { docker: () => ({ ok: scenario !== "unreachable", stdout: JSON.stringify(info), stderr: "" }) });
    if (scenario === "correct") expect(action()).toBe("d".repeat(64));
    else expect(action).toThrow(/target/);
  });
});
