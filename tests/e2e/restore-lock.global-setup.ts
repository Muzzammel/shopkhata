// Playwright global setup: the e2e suite changes the local database destructively (maintenance on/off, truncating
// backup_records, removing shop assignments), so the whole run holds the local database's restore lock
// (scripts/restore-lock.mjs) and releases it in the returned teardown. No e2e test starts backup.mjs, so nothing inherits.
import { acquireRestoreLock, inheritRestoreLock, INHERIT_ENV, releaseRestoreLock } from "../../scripts/restore-lock.mjs";

export default async function globalSetup() {
  const inherited = process.env[INHERIT_ENV.id] !== undefined || process.env[INHERIT_ENV.token] !== undefined;
  const owner = inherited ? inheritRestoreLock("supabase_db_shopkhata", process.env)
    : acquireRestoreLock("supabase_db_shopkhata", `playwright e2e (${process.argv.slice(2).join(" ")})`);
  return async () => { releaseRestoreLock(owner); };
}
