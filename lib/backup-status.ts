// Read model for Admin > Backup & Recovery. Rows come from public.backup_records, which only the
// operator's `node scripts/backup.mjs record` writes; the application reads it and nothing more.

export type BackupRecord = {
  id: string; backup_created_at: string; environment: string; source: string; app_version: string | null; git_commit: string | null;
  latest_migration: string; dump_bytes: number; receipt_count: number; manifest_sha256: string;
  restore_verified_at: string | null; restore_verified_ok: boolean | null; recorded_at: string;
};

export type BackupEntry = {
  manifestSha256: string; createdAt: string; environment: string; source: string; appVersion: string | null; gitCommit: string | null;
  latestMigration: string; dumpBytes: number; receiptCount: number;
  /** When the operator's tool last re-checked every file against its recorded SHA-256. */
  integrityCheckedAt: string;
  /** Latest restore rehearsal of this backup, if one was run. */
  rehearsal: { at: string; ok: boolean } | null;
};

// The runbook asks for a backup after every trading day's close; a day and a half without one is late.
export const BACKUP_OVERDUE_HOURS = 36;

export type BackupSummary = {
  entries: BackupEntry[];
  latest: BackupEntry | null;
  freshness: "none" | "current" | "overdue";
  ageHours: number | null;
  /** Newest backup that passed a restore rehearsal: the one a recovery should start from. */
  latestRehearsed: BackupEntry | null;
};

/** One entry per backup (a backup recorded again after a rehearsal is the same backup), newest first. */
export function summarizeBackups(rows: readonly BackupRecord[], now: Date): BackupSummary {
  const byManifest = new Map<string, BackupEntry>();
  for (const row of rows) {
    const entry = byManifest.get(row.manifest_sha256) ?? {
      manifestSha256: row.manifest_sha256, createdAt: row.backup_created_at, environment: row.environment, source: row.source,
      appVersion: row.app_version, gitCommit: row.git_commit, latestMigration: row.latest_migration, dumpBytes: row.dump_bytes,
      receiptCount: row.receipt_count, integrityCheckedAt: row.recorded_at, rehearsal: null,
    };
    if (row.recorded_at > entry.integrityCheckedAt) entry.integrityCheckedAt = row.recorded_at;
    if (row.restore_verified_at && row.restore_verified_ok !== null && (!entry.rehearsal || row.restore_verified_at > entry.rehearsal.at)) {
      entry.rehearsal = { at: row.restore_verified_at, ok: row.restore_verified_ok };
    }
    byManifest.set(row.manifest_sha256, entry);
  }
  const entries = [...byManifest.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = entries[0] ?? null;
  const ageHours = latest ? Math.max(0, (now.getTime() - new Date(latest.createdAt).getTime()) / 3_600_000) : null;
  return {
    entries, latest, ageHours,
    freshness: ageHours === null ? "none" : ageHours > BACKUP_OVERDUE_HOURS ? "overdue" : "current",
    latestRehearsed: entries.find((entry) => entry.rehearsal?.ok) ?? null,
  };
}

export function formatBytes(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
