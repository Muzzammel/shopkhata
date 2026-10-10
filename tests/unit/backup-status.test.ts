import { describe, expect, it } from "vitest";

import { formatBytes, summarizeBackups, type BackupRecord } from "@/lib/backup-status";

const now = new Date("2026-10-09T12:00:00Z");
const record = (over: Partial<BackupRecord>): BackupRecord => ({
  id: crypto.randomUUID(), backup_created_at: "2026-10-09T06:00:00Z", environment: "production", source: "db.example", app_version: "0.1.0", git_commit: "abc1234",
  latest_migration: "20261009090100", dump_bytes: 2_097_152, receipt_count: 3, manifest_sha256: "a".repeat(64),
  restore_verified_at: null, restore_verified_ok: null, recorded_at: "2026-10-09T06:05:00Z", ...over,
});

describe("backup status", () => {
  it("reports that nothing is recorded rather than implying a backup exists", () => {
    expect(summarizeBackups([], now)).toEqual({ entries: [], latest: null, freshness: "none", ageHours: null, latestRehearsed: null });
  });

  it("treats a backup recorded again after its rehearsal as one backup carrying the rehearsal result", () => {
    const summary = summarizeBackups([
      record({}),
      record({ restore_verified_at: "2026-10-09T08:00:00Z", restore_verified_ok: true, recorded_at: "2026-10-09T08:01:00Z" }),
    ], now);
    expect(summary.entries).toHaveLength(1);
    expect(summary.latest).toMatchObject({ rehearsal: { at: "2026-10-09T08:00:00Z", ok: true }, integrityCheckedAt: "2026-10-09T08:01:00Z", dumpBytes: 2_097_152 });
    expect(summary.freshness).toBe("current");
    expect(summary.ageHours).toBe(6);
  });

  it("flags an old latest backup as overdue and never offers a failed rehearsal as the recovery point", () => {
    const summary = summarizeBackups([
      record({ manifest_sha256: "b".repeat(64), backup_created_at: "2026-10-07T20:00:00Z", restore_verified_at: "2026-10-07T21:00:00Z", restore_verified_ok: false }),
      record({ manifest_sha256: "c".repeat(64), backup_created_at: "2026-10-05T20:00:00Z", restore_verified_at: "2026-10-05T21:00:00Z", restore_verified_ok: true }),
    ], now);
    expect(summary.freshness).toBe("overdue");
    expect(summary.entries.map((entry) => entry.manifestSha256[0])).toEqual(["b", "c"]);
    expect(summary.latest?.rehearsal).toEqual({ at: "2026-10-07T21:00:00Z", ok: false });
    expect(summary.latestRehearsed?.manifestSha256).toBe("c".repeat(64));
  });

  it("formats sizes", () => {
    expect(formatBytes(2_097_152)).toBe("2.0 MB");
    expect(formatBytes(230_596)).toBe("225 KB");
    expect(formatBytes(10)).toBe("1 KB");
  });
});
