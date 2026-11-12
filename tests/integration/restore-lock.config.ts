// Spread into `test` of every vitest config that touches the local Supabase database (all vitest.integration.*.config.mts
// and vitest.perf.config.mts; tests/unit/backup-verification.test.ts checks that none is missing).
export const restoreLock = {
  globalSetup: ["tests/integration/restore-lock.global-setup.ts"],
  setupFiles: ["tests/integration/restore-lock.inherit.ts"],
};
