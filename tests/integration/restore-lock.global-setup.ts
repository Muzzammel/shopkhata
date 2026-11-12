// Vitest global setup of EVERY integration and performance config (tests/integration/restore-lock.config.ts): the run
// takes the local database's restore lock (scripts/restore-lock.mjs) before any test file loads, so before any
// `supabase db reset` or destructive setup, and releases it after the last file and its teardown. Exactly one owner:
// this process. Test workers and the `node scripts/backup.mjs` they start inherit it (restore-lock.inherit.ts) instead
// of taking it again, so there is no nested acquisition and no deadlock.
import type { TestProject } from "vitest/node";

import { acquireRestoreLock, releaseRestoreLock } from "../../scripts/restore-lock.mjs";

declare module "vitest" {
  export interface ProvidedContext {
    shopkhataRestoreLock: { id: string; token: string };
  }
}

export const LOCAL_DB_CONTAINER = "supabase_db_shopkhata";

export default function setup(project: TestProject) {
  const owner = acquireRestoreLock(LOCAL_DB_CONTAINER, `vitest ${project.config.name || project.config.root} (${process.argv.slice(2).join(" ")})`);
  project.provide("shopkhataRestoreLock", { id: owner.id, token: owner.token });
  return () => { releaseRestoreLock(owner); };
}
