// Vitest setup file (each test worker) of every integration and performance config: hands the run's restore lock to the
// processes the tests start, in particular `node scripts/backup.mjs` (release-helpers.backupTool, the acceptance drill),
// through the environment only (never a command line). backup.mjs does not trust these values alone: it re-checks the
// live lock container and that its owner is its own ancestor (scripts/restore-lock.mjs inheritRestoreLock).
import { inject } from "vitest";

import { INHERIT_ENV, inheritRestoreLock } from "../../scripts/restore-lock.mjs";

const lock = inject("shopkhataRestoreLock");
if (!lock?.id || !lock?.token) throw new Error("The integration run holds no restore lock (tests/integration/restore-lock.global-setup.ts did not run).");
process.env[INHERIT_ENV.id] = lock.id;
process.env[INHERIT_ENV.token] = lock.token;
// Workers may have their own environment. Verify the ancestor's exact engine/database and pin
// Docker before any test module can run destructive setup through the Supabase CLI.
inheritRestoreLock("supabase_db_shopkhata", process.env);
